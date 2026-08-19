import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import { Navigate } from 'react-router-dom'
import ReportPage from '../../../components/ReportPage'
import { printWithTitle } from '../../../utils/printTitle'
import { explodeRecipeIngredients } from '../../../utils/recipeCost'
import { selectDepletingSales } from '../sales/salesDepletion'
import {
  bsToAd, getBsToday, getBsFiscalYear, daysInBsMonth, BS_MONTHS,
} from '../../../utils/bsCalendar'
import { AGE_BANDS, buildAgeing } from './stockAgeingCalc'

const npr = n => `NPR ${Math.round(n || 0).toLocaleString('en-NP')}`

// How old stock has to be before the page calls it capital worth acting on. Matches the last
// band's floor so the headline figure and the column a user clicks through to always agree.
const STALE_FROM_DAYS = 91

const bsLabel = bs => (bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}` : '—')

// The date every batch is aged AGAINST, and the single most important thing this page has to say
// about itself.
//
// WHY (S594): this used to be `new Date()` unconditionally, while the FY selector accepted any
// past fiscal year. Picking FY 2081/82 therefore aged every surviving batch to TODAY — so every
// item landed in the 90+ band, the headline "Capital in 90+ Day Stock" turned amber and reported
// the entire stock value, and every row highlighted. It failed silently, and in the alarming
// direction, which is the direction that provokes action. An ageing schedule without an as-of
// date is the first thing an accountant checks for, and this one did not have one anywhere: not
// in the subtitle, not in the print title, not in the exported workbook.
//
// A past fiscal year is aged as at the END of its last period, which is the only date that makes
// the answer mean anything — "how old was the stock when that year finished".
function asOfForFy(fy, periodsInFy) {
  const today = getBsToday()
  if (fy === getBsFiscalYear(today.year, today.month)) {
    return { date: new Date(), bs: today, isToday: true }
  }
  const last = periodsInFy[periodsInFy.length - 1]
  if (!last) return { date: new Date(), bs: today, isToday: true }
  const day = daysInBsMonth(last.bs_year, last.bs_month)
  return {
    date: bsToAd(last.bs_year, last.bs_month, day),
    bs: { year: last.bs_year, month: last.bs_month, day },
    isToday: false,
  }
}

export default function StockAgeing() {
  const { clientId, profile, loading: authLoading, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const biz = useBizInfo()

  const [periods, setPeriods] = useState([])
  const [fyOptions, setFyOptions] = useState([])
  const [selectedFy, setSelectedFy] = useState('')
  const [rows, setRows] = useState([])
  const [totals, setTotals] = useState(null)
  const [itemMeta, setItemMeta] = useState({})
  const [categories, setCategories] = useState([])
  const [filterCat, setFilterCat] = useState('all')
  const [filterBand, setFilterBand] = useState('all')
  const [carriedForwardTotal, setCarriedForwardTotal] = useState(0)
  const [asOf, setAsOf] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  // authLoading is a real dependency: a hard load lands here while auth is still resolving, and
  // with [clientId] alone the guard fails once and nothing ever re-fires — the page sits on the
  // loading line forever. Caught live on ConsolidatedPnl and backported here (S594).
  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId, authLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    setLoadError(null)
    const results = await Promise.all([
      scopedFrom('monthly_periods').order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      scopedFrom('categories').order('sort_order'),
    ])
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setPeriods([]); setLoading(false); return }
    const [{ data: p }, { data: c }] = results
    setPeriods(p || [])
    setCategories(c || [])
    const fys = [...new Set((p || []).map(x => getBsFiscalYear(x.bs_year, x.bs_month)))]
    setFyOptions(fys)
    if (fys.length > 0) {
      setSelectedFy(fys[0])
      await buildReport(fys[0], p || [])
    }
    setLoading(false)
  }

  async function handleFyChange(fy) {
    setSelectedFy(fy)
    setLoading(true)
    await buildReport(fy, periods)
    setLoading(false)
  }

  async function buildReport(fy, allPeriods) {
    setLoadError(null)
    // Every period in the chosen fiscal year, oldest first — the window this report ages within.
    const inFy = (allPeriods || [])
      .filter(p => getBsFiscalYear(p.bs_year, p.bs_month) === fy)
      .sort((a, b) => a.bs_year - b.bs_year || a.bs_month - b.bs_month)
    const periodIds = inFy.map(p => p.id)
    if (periodIds.length === 0) { setRows([]); setTotals(null); setCarriedForwardTotal(0); setAsOf(null); return }

    const results = await Promise.all([
      // .eq('is_active', true) per the S436 rule: never value stock off an inactive item.
      scopedFrom('items', 'id, name, uom, per_uom_rate, categories(name)')
        .eq('is_active', true).eq('is_sub_recipe', false),
      // Every read below spans a whole fiscal year, so all of them are paged — a year of
      // purchase lines and POS-synced sales is far past the silent 1000-row cap.
      fetchAllRows(() => supabase.from('purchase_entries')
        .select('id, period_id, item_id, qty, rate, bs_day').in('period_id', periodIds).order('id')),
      fetchAllRows(() => scopedFrom('vendor_returns', 'purchase_entry_id, item_id, qty')
        .in('period_id', periodIds).order('id')),
      fetchAllRows(() => supabase.from('sales_entries')
        .select('recipe_id, qty_sold, bs_day, source').in('period_id', periodIds).order('id')),
      fetchAllRows(() => supabase.from('wastages')
        .select('item_id, qty').in('period_id', periodIds).order('id')),
      fetchAllRows(() => supabase.from('staff_meals')
        .select('item_id, qty').in('period_id', periodIds).order('id')),
      // Only the FIRST period's opening count — that is the stock carried into the window.
      supabase.from('opening_stock').select('item_id, qty').eq('period_id', periodIds[0]),
      scopedFrom('recipes', 'id'),
    ])

    // A failed read must never reach the arithmetic below: every one of these results flows
    // through `|| []`, so an RLS rejection or a stalled token would produce a complete, confident
    // report of NPR 0 rather than an error. See shared/queryError.js.
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setRows([]); setTotals(null); setCarriedForwardTotal(0); return }

    const [
      { data: items }, { data: purchases }, { data: returns },
      { data: sales }, { data: wastages }, { data: staffMeals },
      { data: opening }, { data: clientRecipes },
    ] = results

    const itemById = Object.fromEntries((items || []).map(i => [i.id, i]))
    setItemMeta(itemById)

    const periodById = Object.fromEntries(inFy.map(p => [p.id, p]))
    const adDateOf = (periodId, bsDay) => {
      const p = periodById[periodId]
      if (!p) return null
      // bsToAd returns LOCAL midnight — used here only for day-count arithmetic, never serialised
      // (the S550 .toISOString() trap shifts the date by a day at Nepal's +05:45).
      return bsToAd(p.bs_year, p.bs_month, Math.min(Math.max(parseInt(bsDay, 10) || 1, 1), 32))
    }

    // Returns come off their own purchase line where one is named, so a returned batch stops
    // ageing as if it were still on the shelf.
    const returnedByEntry = {}
    const returnedByItem = {}
    for (const r of returns || []) {
      const q = parseFloat(r.qty) || 0
      if (r.purchase_entry_id) returnedByEntry[r.purchase_entry_id] = (returnedByEntry[r.purchase_entry_id] || 0) + q
      else if (r.item_id) returnedByItem[r.item_id] = (returnedByItem[r.item_id] || 0) + q
    }

    const batches = []
    const windowStart = adDateOf(periodIds[0], 1)
    for (const o of opening || []) {
      const qty = parseFloat(o.qty) || 0
      if (qty <= 0 || !itemById[o.item_id]) continue
      batches.push({
        item_id: o.item_id, qty,
        rate: parseFloat(itemById[o.item_id].per_uom_rate) || 0,
        date: windowStart, carriedForward: true,
      })
    }
    for (const p of purchases || []) {
      if (!itemById[p.item_id]) continue
      const qty = Math.max(0, (parseFloat(p.qty) || 0) - (returnedByEntry[p.id] || 0))
      if (qty <= 0) continue
      const date = adDateOf(p.period_id, p.bs_day)
      if (!date) continue
      batches.push({ item_id: p.item_id, qty, rate: parseFloat(p.rate) || 0, date })
    }

    // Consumption over the window: recipe-exploded sales + wastage + staff meals, exactly what
    // FifoReport nets off. Sales go through selectDepletingSales so a client running POS *and*
    // manual bulk entry doesn't count the same dish twice and over-consume its own batches —
    // which here would make real stock vanish from the shelf rather than merely skew a variance.
    const recipeIds = (clientRecipes || []).map(r => r.id)
    const breakdown = recipeIds.length > 0 ? await explodeRecipeIngredients(supabase, recipeIds) : {}
    const soldByRecipe = {}
    for (const s of selectDepletingSales(sales || [])) {
      soldByRecipe[s.recipe_id] = (soldByRecipe[s.recipe_id] || 0) + (parseFloat(s.qty_sold) || 0)
    }
    const consumed = {}
    for (const [recipeId, ingRows] of Object.entries(breakdown)) {
      const sold = soldByRecipe[recipeId] || 0
      if (sold <= 0) continue
      for (const { item_id, qty } of ingRows) consumed[item_id] = (consumed[item_id] || 0) + sold * qty
    }
    for (const w of wastages || []) consumed[w.item_id] = (consumed[w.item_id] || 0) + (parseFloat(w.qty) || 0)
    for (const m of staffMeals || []) consumed[m.item_id] = (consumed[m.item_id] || 0) + (parseFloat(m.qty) || 0)
    // A return with no purchase line to attach to still left the building — take it off the
    // item's stock as consumption rather than letting it age on the shelf forever.
    for (const [itemId, q] of Object.entries(returnedByItem)) consumed[itemId] = (consumed[itemId] || 0) + q

    const ref = asOfForFy(fy, inFy)
    setAsOf(ref)
    const { items: aged, totals: agedTotals } = buildAgeing(batches, consumed, ref.date)
    setRows(aged.sort((a, b) => b.bands['90+'].value - a.bands['90+'].value || b.value - a.value))
    setTotals(agedTotals)
    setCarriedForwardTotal(aged.reduce((s, r) => s + r.carriedForwardQty, 0))
  }

  const filtered = rows.filter(r => {
    const meta = itemMeta[r.item_id]
    if (!meta) return false
    if (filterCat !== 'all' && meta.categories?.name !== filterCat) return false
    if (filterBand !== 'all' && !(r.bands[filterBand].qty > 0)) return false
    return true
  })

  const staleValue = totals ? totals.bands['90+'].value : 0
  const stalePct = totals && totals.value > 0 ? (staleValue / totals.value) * 100 : 0
  const staleItems = rows.filter(r => r.bands['90+'].qty > 0).length

  const asOfLabel = asOf ? `${bsLabel(asOf.bs)}${asOf.isToday ? ' (today)' : ''}` : '—'
  const bandLabel = filterBand === 'all' ? 'All ages' : AGE_BANDS.find(b => b.key === filterBand)?.label
  // What the reader is actually looking at, in one line. It goes into the print output and the
  // workbook as well as on screen: the filter bar is `no-print`, so a printed sheet used to show a
  // filtered table with no record anywhere of which filter produced it.
  const scopeLine = `FY ${selectedFy} · aged as at ${asOfLabel} · ${bandLabel} · ${filterCat === 'all' ? 'All categories' : filterCat}`

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const data = filtered.map(r => {
      const meta = itemMeta[r.item_id] || {}
      const row = {
        'Item': meta.name || r.item_id,
        'Category': meta.categories?.name || '',
        'UOM': meta.uom || '',
        'On Hand Qty': Number(r.qty.toFixed(3)),
        'Total Value (NPR)': Math.round(r.value),
        'Oldest (days)': r.oldestDays,
      }
      for (const b of AGE_BANDS) {
        row[`${b.label} Qty`] = Number(r.bands[b.key].qty.toFixed(3))
        row[`${b.label} Value (NPR)`] = Math.round(r.bands[b.key].value)
      }
      return row
    })
    const ws = sheetWithLetterhead(XLSX, {
      title: 'Stock Ageing',
      biz,
      scopeLine,
      rows: data,
      notes: [
        `Ages are measured to ${asOfLabel}${asOf && !asOf.isToday ? ' — the end of the selected fiscal year, not today.' : '.'}`,
        'FIFO assumption: consumption is taken off the oldest batches first. Not a batch-precise trace.',
      ],
    })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Stock Ageing')
    XLSX.writeFile(wb, `stock-ageing-FY${selectedFy.replace('/', '-')}.xlsx`)
  }

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />

  const actions = (
    <>
      <button className="btn btn-ghost" style={{ fontSize: 12 }}
        onClick={() => printWithTitle(`Stock Ageing — ${scopeLine}`)}>🖨 Print</button>
      <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={exportExcel}
        disabled={loading || !!loadError || filtered.length === 0}>↓ Export Excel</button>
      <select aria-label="Fiscal year" className="form-select" value={selectedFy}
        onChange={e => handleFyChange(e.target.value)}>
        {fyOptions.map(fy => <option key={fy} value={fy}>FY {fy}</option>)}
      </select>
    </>
  )

  const stats = (
    <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 20 }}>
      <div className="stat-card">
        <div className="stat-label">
          <Tip width={300} text="Value of stock still on hand as at the date this report is aged to, valued at what you actually paid for each batch — not the current master rate.">Stock On Hand</Tip>
        </div>
        <div className="stat-value gold" style={{ fontSize: 18 }}>{npr(totals?.value)}</div>
        <div className="stat-sub">{filtered.length} item{filtered.length === 1 ? '' : 's'}</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">
          <Tip width={320} text={`Money tied up in stock that had been sitting ${STALE_FROM_DAYS}+ days as at ${asOfLabel}. This is the working capital the report exists to surface — it is not yet a loss, but it is cash on a shelf.`}>Capital in 90+ Day Stock</Tip>
        </div>
        <div className="stat-value" style={{ fontSize: 18, color: staleValue > 0 ? 'var(--theme-amber-text)' : 'var(--theme-green-text)' }}>
          {npr(staleValue)}
        </div>
        <div className="stat-sub">{stalePct.toFixed(1)}% of stock value</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">Items 90+ Days Old</div>
        <div className="stat-value" style={{ color: staleItems > 0 ? 'var(--theme-amber-text)' : 'var(--theme-green-text)' }}>{staleItems}</div>
        <div className="stat-sub">worth reviewing first</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">
          <Tip width={320} text="Quantity still on hand that was already in stock when this fiscal year began. Its true age is unknown and at least this old — it is aged from the start of the window, never guessed at.">Carried Into This FY</Tip>
        </div>
        <div className="stat-value" style={{ fontSize: 18, color: carriedForwardTotal > 0 ? 'var(--theme-text1)' : 'var(--theme-text3)' }}>
          {carriedForwardTotal > 0 ? Number(carriedForwardTotal.toFixed(1)).toLocaleString() : '—'}
        </div>
        <div className="stat-sub">units, age ≥ FY start</div>
      </div>
    </div>
  )

  const note = (
    <div style={{
      background: 'color-mix(in srgb, var(--theme-accent) 7%, transparent)',
      border: '1px solid color-mix(in srgb, var(--theme-accent) 22%, transparent)',
      borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20,
      fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6,
    }}>
      <strong style={{ color: 'var(--theme-accent-ink)' }}>How to read this:</strong> each purchase is a batch;
      everything you sold, wasted or served as staff meals this year is taken off the <em>oldest</em> batches first,
      and whatever survives is what is still on the shelf, aged from the day it was bought.
      Consumption is not tracked per batch anywhere in the system, so this is the standard FIFO assumption
      rather than a batch-precise trace — the same basis the FIFO / Expiry report uses.
      {asOf && !asOf.isToday && (
        <>
          {' '}Ages are measured to <strong style={{ color: 'var(--theme-amber-text)' }}>{asOfLabel}</strong>, the
          end of the fiscal year you selected — not to today, which would call every surviving batch stale.
        </>
      )}
    </div>
  )

  const filters = (
    <>
      <div className="no-print" style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="tab-bar" role="radiogroup" aria-label="Filter by age band">
          <button className={`tab-btn${filterBand === 'all' ? ' tab-btn--active' : ''}`}
            aria-pressed={filterBand === 'all'} onClick={() => setFilterBand('all')}>All Ages</button>
          {AGE_BANDS.map(b => (
            <button key={b.key} className={`tab-btn${filterBand === b.key ? ' tab-btn--active' : ''}`}
              aria-pressed={filterBand === b.key} onClick={() => setFilterBand(b.key)}>{b.label}</button>
          ))}
        </div>
        <select aria-label="Filter by category" className="form-select" value={filterCat} onChange={e => setFilterCat(e.target.value)}>
          <option value="all">All Categories</option>
          {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
        <span style={{ fontSize: 13, color: 'var(--theme-text2)', marginLeft: 'auto' }}>
          {filtered.length} item{filtered.length === 1 ? '' : 's'}
        </span>
      </div>
      {/* The filter bar above is no-print, so without this a printed sheet showed a filtered table
          with nothing anywhere saying which filter produced it. */}
      <p className="print-only" style={{ fontSize: 12, marginBottom: 12 }}>{scopeLine}</p>
    </>
  )

  const footnote = (
    <p style={{ marginTop: 10, fontSize: 12, color: 'var(--theme-text3)' }}>
      Age band columns show <strong>quantity</strong>; the TOTAL row shows each band&apos;s <strong>value</strong>,
      so you can see where the money sits. Ages are measured to {asOfLabel}.
    </p>
  )

  return (
    <ReportPage
      title="Stock Ageing"
      subtitle={`How long the stock you are still holding has been sitting — FY ${selectedFy || '—'} · aged as at ${asOfLabel}`}
      actions={actions}
      noPeriod={!loading && !loadError && periods.length === 0}
      noPeriodWhat="the stock ageing report"
      loading={loading}
      error={loadError}
      empty={filtered.length === 0}
      emptyIcon="◷"
      emptyText={rows.length === 0
        ? `No stock on hand for FY ${selectedFy} — every batch bought this year has been used, wasted or returned.`
        : 'No items match the current filters.'}
      stats={stats}
      note={note}
      filters={filters}
      footnote={footnote}
    >
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="table-wrap">
          <table className="data-table" style={{ marginBottom: 0 }}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Category</th>
                <th>UOM</th>
                <th style={{ textAlign: 'right' }}><Tip text="Estimated quantity still on hand, after this year's consumption was taken off oldest batches first." width={260}>On Hand</Tip></th>
                {AGE_BANDS.map(b => (
                  <th key={b.key} style={{ textAlign: 'right' }}>
                    <Tip width={280} text={`Quantity still on hand that was bought ${b.label.replace(' days', '')} days before ${asOfLabel}. These columns are quantities — the TOTAL row at the foot of the table shows each band's value in NPR.`}>
                      {b.label}
                    </Tip>
                  </th>
                ))}
                <th style={{ textAlign: 'right' }}><Tip text={`Age of the oldest batch of this item still on hand, as at ${asOfLabel}.`} width={240}>Oldest</Tip></th>
                <th style={{ textAlign: 'right' }}>Value</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => {
                const meta = itemMeta[r.item_id] || {}
                const stale = r.bands['90+'].qty > 0
                return (
                  <tr key={r.item_id} style={{ background: stale ? 'color-mix(in srgb, var(--theme-amber) 10%, transparent)' : 'transparent' }}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                      {meta.name || '—'}
                      {r.carriedForwardQty > 0 && (
                        <Tip text="Part of this item's on-hand stock was already here when the fiscal year began, so its true age is at least the figure shown." width={280}>
                          <span className="badge badge-gray" style={{ marginLeft: 6 }}>c/f</span>
                        </Tip>
                      )}
                    </td>
                    <td><span className="badge badge-yellow">{meta.categories?.name || 'Uncategorised'}</span></td>
                    <td style={{ color: 'var(--theme-text2)' }}>{meta.uom}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{Number(r.qty.toFixed(2)).toLocaleString()}</td>
                    {AGE_BANDS.map(b => {
                      const cell = r.bands[b.key]
                      const isStaleBand = b.key === '90+'
                      return (
                        <td key={b.key} style={{
                          textAlign: 'right',
                          color: !(cell.qty > 0) ? 'var(--theme-text3)'
                            : isStaleBand ? 'var(--theme-amber-text)' : 'var(--theme-text2)',
                          fontWeight: cell.qty > 0 && isStaleBand ? 700 : 400,
                        }}>
                          {cell.qty > 0 ? Number(cell.qty.toFixed(2)).toLocaleString() : '—'}
                        </td>
                      )
                    })}
                    <td style={{ textAlign: 'right', color: r.oldestDays >= STALE_FROM_DAYS ? 'var(--theme-amber-text)' : 'var(--theme-text2)' }}>
                      {r.oldestDays}d
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)' }}>{npr(r.value)}</td>
                  </tr>
                )
              })}
            </tbody>
            {totals && (
              <tfoot>
                <tr>
                  <td colSpan={3}>TOTAL (all items, by value)</td>
                  <td style={{ textAlign: 'right' }}>—</td>
                  {AGE_BANDS.map(b => (
                    <td key={b.key} style={{ textAlign: 'right' }}>{npr(totals.bands[b.key].value)}</td>
                  ))}
                  <td></td>
                  <td style={{ textAlign: 'right' }}>{npr(totals.value)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </ReportPage>
  )
}
