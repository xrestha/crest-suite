import { npr } from '../../../shared/nepalMoney'
import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import { Navigate } from 'react-router-dom'
import ReportPage from '../../../components/ReportPage'
import PeriodScope from '../../../components/PeriodScope'
import { printWithTitle } from '../../../utils/printTitle'
import { explodeRecipeIngredients } from '../../../utils/recipeCost'
import { selectDepletingSalesAcrossPeriods } from '../sales/salesDepletion'
import { bsToAd, daysInBsMonth, BS_MONTHS } from '../../../utils/bsCalendar'
import {
  AGE_BANDS, ageAllocated, ageInDays, asOfForWindow, splitReturns,
  anchorToCounts, rollingWindow, sumConsumptionByPeriod, countsFromClosedPeriods, periodMonthIndex,
} from './stockAgeingCalc'


// How old stock has to be before the page calls it capital worth acting on. Matches the last
// band's floor so the headline figure and the column a user clicks through to always agree.
const STALE_FROM_DAYS = 91

// How far back the window reaches (S756, D19). See `rollingWindow` for why it is no longer the
// fiscal year.
const WINDOW_MONTHS = 12

// The basis, in the owner's words. It goes on screen, in print and into the workbook verbatim
// (S756, D19): a reader has to know that the quantities are counted and the ages are estimated
// before trusting either.
const BASIS = 'Quantities follow your stock counts; ages are estimated from purchase dates, oldest used first.'

const bsLabel = bs => (bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}` : '—')
const monthLabel = p => (p ? `${BS_MONTHS[p.bs_month - 1]} ${p.bs_year}` : '—')

// The date every batch is aged AGAINST, and the single most important thing this page has to say
// about itself.
//
// WHY (S594): this used to be `new Date()` unconditionally, while the selector accepted any past
// fiscal year — so every surviving batch landed in the 90+ band, the headline turned amber and
// reported the entire stock value. A past window is aged as at the END of its last period.
//
// S756: the NEWEST period is aged to today in Nepal (`asOfForWindow`, tested, shared with FIFO /
// Expiry) — early in a month, before the next period is opened, the newest period is last month.
//
// S756 (D19): the selector is now an AS-AT MONTH, not a fiscal year. The window is the 12 months
// ending with that month, so "which year?" stopped being a question the page can ask; "as at when?"
// is the one it answers. It matches FIFO / Expiry's period selector, which is the least surprising
// thing for a reader moving between the two.

export default function StockAgeing() {
  const { clientId, profile, loading: authLoading, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const biz = useBizInfo()

  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [rows, setRows] = useState([])
  const [totals, setTotals] = useState(null)
  const [itemMeta, setItemMeta] = useState({})
  const [categories, setCategories] = useState([])
  const [filterCat, setFilterCat] = useState('all')
  const [filterBand, setFilterBand] = useState('all')
  // How many days back the window itself reaches. The report cannot see past it (S718).
  const [windowDays, setWindowDays] = useState(0)
  const [windowLabel, setWindowLabel] = useState('')
  // Whether the window held any stock to age in the first place. "Everything was used up" and
  // "nothing was ever bought or carried in" are different facts (S718).
  const [hadBatches, setHadBatches] = useState(false)
  // Which closed month's count each item's quantity follows, and the latest across the report
  // (S756, D19) — named so the basis is a checkable claim, not a slogan.
  const [lastCountByItem, setLastCountByItem] = useState({})
  const [asOf, setAsOf] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  // Overlapping-load guard (S601 class): arrowing the month select fires a 12-month load per
  // keypress, and the last response to land would win the figures while the label — subtitle,
  // print title, workbook scopeLine and filename — is whatever was picked last.
  const periodReq = useLatestRequest()

  // authLoading is a real dependency: a hard load lands here while auth is still resolving (S594).
  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId, authLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  function resetFigures() {
    setRows([]); setTotals(null); setWindowDays(0); setWindowLabel(''); setHadBatches(false); setLastCountByItem({})
  }

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
    // The newest period — the report's default is "as at today" (asOfForWindow).
    const initial = (p || [])[0]
    if (initial) {
      // init() claims the page too — it sets the label, which no guard covers (S698/S709/S718).
      periodReq.begin(initial.id)
      setSelectedPeriod(initial)
      await buildReport(initial.id, p || [])
    }
    setLoading(false)
  }

  async function handlePeriodChange(periodId) {
    periodReq.begin(periodId)   // claim the page before any await
    setSelectedPeriod(periods.find(p => p.id === periodId) || null)
    setLoading(true)
    await buildReport(periodId, periods)
    setLoading(false)
  }

  async function buildReport(periodId, allPeriods) {
    setLoadError(null)
    const selected = (allPeriods || []).find(p => p.id === periodId)
    // Every period in the 12 months ending with the selected one, oldest first (S756, D19).
    const inWindow = rollingWindow(allPeriods, selected, WINDOW_MONTHS)
    const periodIds = inWindow.map(p => p.id)
    if (periodIds.length === 0) { resetFigures(); setAsOf(null); return }
    const closedIds = inWindow.filter(p => p.status === 'closed').map(p => p.id)

    const results = await Promise.all([
      // .eq('is_active', true) per the S436 rule: never value stock off an inactive item.
      // Paged (S717): `itemById` is what admits a batch into the report at all.
      fetchAllRows(() => scopedFrom('items', 'id, name, uom, per_uom_rate, categories(name)')
        .eq('is_active', true).eq('is_sub_recipe', false).order('id')),
      // Every read below spans up to twelve periods, so all of them are paged.
      fetchAllRows(() => supabase.from('purchase_entries')
        .select('id, period_id, item_id, qty, rate, bs_day').in('period_id', periodIds).order('id')),
      // period_id: an off-batch return comes off in ITS month, before that month's count (S756).
      fetchAllRows(() => scopedFrom('vendor_returns', 'purchase_entry_id, item_id, qty, period_id')
        .in('period_id', periodIds).order('id')),
      // period_id: the depletion rule is applied PER PERIOD (S718) and consumption is now summed
      // per period for the count anchoring (S756).
      fetchAllRows(() => supabase.from('sales_entries')
        .select('period_id, recipe_id, qty_sold, bs_day, source').in('period_id', periodIds).order('id')),
      fetchAllRows(() => supabase.from('wastages')
        .select('period_id, item_id, qty').in('period_id', periodIds).order('id')),
      fetchAllRows(() => supabase.from('staff_meals')
        .select('period_id, item_id, qty').in('period_id', periodIds).order('id')),
      // Only the FIRST period's opening count — the stock carried into the window (S717: paged).
      fetchAllRows(() => supabase.from('opening_stock').select('item_id, qty').eq('period_id', periodIds[0]).order('id')),
      // The anchors (S756, D19): closing counts of the window's CLOSED months. One row per item per
      // month × 12 months crosses the 1000-row cap at ~85 items, and a truncated read is
      // indistinguishable from "not counted" — the estimate would silently stand in for the count.
      fetchAllRowsChunked(closedIds, ids => supabase.from('closing_stock')
        .select('period_id, item_id, physical_qty').in('period_id', ids).order('id')),
      scopedFrom('recipes', 'id'),
    ])

    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer selection
    // A failed read must never reach the arithmetic below (S612).
    const failed = firstError(results)
    if (failed) { setLoadError(failed); resetFigures(); return }

    const [
      { data: items }, { data: purchases }, { data: returns },
      { data: sales }, { data: wastages }, { data: staffMeals },
      { data: opening }, { data: closing }, { data: clientRecipes },
    ] = results

    const itemById = Object.fromEntries((items || []).map(i => [i.id, i]))

    const periodById = Object.fromEntries(inWindow.map(p => [p.id, p]))
    const adDateOf = (pid, bsDay) => {
      const p = periodById[pid]
      if (!p) return null
      // bsToAd returns LOCAL midnight — day-count arithmetic only, never serialised (S550).
      return bsToAd(p.bs_year, p.bs_month, Math.min(Math.max(parseInt(bsDay, 10) || 1, 1), 32))
    }

    // Returns come off their own purchase line where that line is in the window; one against a bill
    // from before the window, or with no line, is consumption of the item in its month (S756).
    const { byEntry: returnedByEntry, byPeriodItem: returnedByPeriodItem } =
      splitReturns(returns, new Set((purchases || []).map(p => p.id)))

    const batches = []
    const windowStart = adDateOf(periodIds[0], 1)
    for (const o of opening || []) {
      const qty = parseFloat(o.qty) || 0
      if (qty <= 0 || !itemById[o.item_id]) continue
      batches.push({
        item_id: o.item_id, qty, period_id: periodIds[0],
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
      batches.push({ item_id: p.item_id, qty, rate: parseFloat(p.rate) || 0, date, period_id: p.period_id })
    }

    // The recipe walk throws on a failed read (S695).
    const recipeIds = (clientRecipes || []).map(r => r.id)
    let breakdown = {}
    try {
      breakdown = recipeIds.length > 0 ? await explodeRecipeIngredients(supabase, recipeIds) : {}
    } catch (err) {
      if (!periodReq.isCurrent(periodId)) return
      setLoadError(err); resetFigures(); return
    }
    if (!periodReq.isCurrent(periodId)) return   // superseded while the recipe walk was in flight

    // Consumption per MONTH: recipe-exploded sales (through the shared POS-supersedes-manual rule,
    // partitioned by period — S718), wastage, staff meals, off-batch returns.
    const consumedByPeriod = sumConsumptionByPeriod({
      sales: selectDepletingSalesAcrossPeriods(sales || []),
      breakdown, wastages, staffMeals, returnsByPeriodItem: returnedByPeriodItem,
    })

    // Anchor to the counts (S756, D19) — see anchorToCounts for the walk.
    const { batches: anchored, lastCountByItem: lastCounts } = anchorToCounts({
      periods: inWindow.map(p => ({ id: p.id, endDate: bsToAd(p.bs_year, p.bs_month, daysInBsMonth(p.bs_year, p.bs_month)) })),
      batches,
      consumedByPeriod,
      countsByPeriod: countsFromClosedPeriods(closing, inWindow),
      // A surplus the count found has no purchase line; valued at the master rate, like carried-in
      // stock, and disclosed the same way.
      surplusRateOf: id => parseFloat(itemById[id]?.per_uom_rate) || 0,
      itemIds: new Set(Object.keys(itemById)),
    })

    const isNewest = allPeriods?.[0]?.id === periodId   // init orders newest-first
    const ref = asOfForWindow(selected, { isNewest })
    const { items: aged, totals: agedTotals } = ageAllocated(anchored, ref.date)
    setItemMeta(itemById)
    setAsOf(ref)
    setRows(aged.sort((a, b) => b.bands['90+'].value - a.bands['90+'].value || b.value - a.value))
    setTotals(agedTotals)
    setLastCountByItem(Object.fromEntries(Object.entries(lastCounts).map(([k, pid]) => [k, periodById[pid]])))
    setWindowDays(ageInDays(windowStart, ref.date))
    setWindowLabel(inWindow.length === 1 ? monthLabel(inWindow[0]) : `${monthLabel(inWindow[0])} – ${monthLabel(selected)}`)
    setHadBatches(anchored.length > 0)
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
  // The TOTAL row follows the TABLE (S718); the KPI cards stay whole-report.
  const isFiltered = filterCat !== 'all' || filterBand !== 'all'
  const footTotals = (() => {
    const acc = { value: 0, bands: Object.fromEntries(AGE_BANDS.map(b => [b.key, 0])) }
    for (const r of filtered) {
      acc.value += r.value
      for (const b of AGE_BANDS) acc.bands[b.key] += r.bands[b.key].value
    }
    return acc
  })()
  const cfValue = totals ? totals.carriedForwardValue : 0
  const cfItems = rows.filter(r => r.carriedForwardQty > 0).length
  const surplusValue = totals ? totals.countSurplusValue : 0
  // Carried-in stock (at the window start, or found by a count) sitting in a younger band. While
  // this is above zero the 90+ figure is a FLOOR, not a total, and gets no ✓ (S718).
  const unknownAgeValue = totals ? totals.unknownAgeValue : 0
  const staleIsFloor = unknownAgeValue > 0

  // The latest count any item's quantity follows, and how many on-hand items no count reached.
  const latestCount = Object.values(lastCountByItem).reduce((a, p) => (!a || (p && periodMonthIndex(p) > periodMonthIndex(a)) ? p : a), null)
  const uncountedItems = rows.filter(r => !lastCountByItem[r.item_id]).length
  const countLabel = latestCount ? `counts to end of ${monthLabel(latestCount)}` : 'no closed-month count in the window'

  const periodLabel = monthLabel(selectedPeriod)
  const asOfLabel = asOf ? `${bsLabel(asOf.bs)}${asOf.isToday ? ' (today)' : ''}` : '—'
  const bandLabel = filterBand === 'all' ? 'All ages' : AGE_BANDS.find(b => b.key === filterBand)?.label
  // What the reader is looking at, in one line — on screen, in print and in the workbook.
  const scopeLine = `12 months to ${periodLabel}${windowLabel ? ` (${windowLabel})` : ''} · aged as at ${asOfLabel} · quantities follow ${countLabel} · ${bandLabel} · ${filterCat === 'all' ? 'All categories' : filterCat}`

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const data = filtered.map(r => {
      const meta = itemMeta[r.item_id] || {}
      const counted = lastCountByItem[r.item_id]
      const row = {
        'Item': meta.name || r.item_id,
        'Category': meta.categories?.name || '',
        'UOM': meta.uom || '',
        'On Hand Qty': Number(r.qty.toFixed(3)),
        'Total Value (NPR)': Math.round(r.value),
        'Oldest (days)': r.oldestDays,
        'Quantity Follows': counted ? `Count, end of ${monthLabel(counted)}` : 'Estimate (no count in window)',
        'Unknown-Age Qty': Number(r.carriedForwardQty.toFixed(3)),
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
        BASIS,
        `Ages are measured to ${asOfLabel}${asOf && !asOf.isToday ? ' — the end of the selected month, not today.' : '.'}`,
        `Where a closed month has a stock count, each item's quantity is set to that count: a lower count comes off the oldest stock, a higher count is added as stock of unknown age. ${uncountedItems > 0 ? `${uncountedItems} item(s) had no count in the window and follow the purchase-minus-usage estimate.` : ''}`.trim(),
        `The window reaches back ${windowDays} days. Stock on hand when it began, and any surplus a count found, is of unknown age — at least the age shown, possibly more.`,
        'Batches are valued at the rate actually paid. Stock of unknown age has no purchase line and is valued at the current Item Master rate.',
      ],
    })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Stock Ageing')
    XLSX.writeFile(wb, `stock-ageing-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />

  const actions = (
    <>
      {/* Print and export gated on the load (S756, S728) and export on the client-name read. */}
      <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={loading || !!loadError}
        onClick={() => printWithTitle(`Stock Ageing — ${scopeLine}`)}>🖨 Print</button>
      <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={exportExcel}
        disabled={loading || !!loadError || filtered.length === 0 || !!biz.error}>↓ Export Excel</button>
      <select aria-label="As at month" className="form-select" value={selectedPeriod?.id || ''}
        onChange={e => handlePeriodChange(e.target.value)}>
        {periods.map(p => <option key={p.id} value={p.id}>As at {monthLabel(p)}{p.status === 'open' ? ' (open)' : ''}</option>)}
      </select>
    </>
  )

  const stats = (
    <div className="stat-grid">
      <div className="stat-card">
        <div className="stat-label">
          <Tip width={340} text="Value of stock still on hand as at the date this report is aged to, valued at what you actually paid for each batch. Quantities follow your latest stock count for each item. Stock of unknown age has no purchase line, so it is valued at the current Item Master rate — see the Unknown Age card.">Stock On Hand</Tip>
        </div>
        <div className="stat-value gold" style={{ fontSize: 18 }}>{npr(totals?.value)}</div>
        {/* rows, not filtered: the value above is the whole report's. */}
        <div className="stat-sub">{rows.length} item{rows.length === 1 ? '' : 's'}</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">
          <Tip width={340} text={staleIsFloor
            ? `Money tied up in stock that had been sitting ${STALE_FROM_DAYS}+ days as at ${asOfLabel} — AT LEAST this much. Some stock is of unknown age (on the shelf when the window began, or found by a count) and sits in a younger band only because of the date it had to be given. The Unknown Age card shows how much.`
            : `Money tied up in stock that had been sitting ${STALE_FROM_DAYS}+ days as at ${asOfLabel}. This is the working capital the report exists to surface — it is not yet a loss, but it is cash on a shelf.`}>
            Capital in 90+ Day Stock
          </Tip>
        </div>
        {/* ▲ / △ / ✓ differ by shape as well as colour (deuteranopia, monochrome print). The ✓ is
            withheld while stock of unknown age sits in a younger band (S718). */}
        <div className="stat-value" style={{ fontSize: 18, color: staleValue > 0 || staleIsFloor ? 'var(--theme-amber-text)' : 'var(--theme-green-text)' }}>
          {staleIsFloor ? '≥ ' : ''}{npr(staleValue)} {staleValue > 0 ? '▲' : staleIsFloor ? '△' : '✓'}
        </div>
        <div className="stat-sub">
          {staleIsFloor
            ? `${stalePct.toFixed(1)}% of stock value, plus stock of unknown age`
            : `${stalePct.toFixed(1)}% of stock value`}
        </div>
      </div>
      <div className="stat-card">
        <div className="stat-label">Items 90+ Days Old</div>
        {/* The same floor as the capital card beside it (S756). */}
        <div className="stat-value" style={{ color: staleItems > 0 || staleIsFloor ? 'var(--theme-amber-text)' : 'var(--theme-green-text)' }}>
          {staleIsFloor ? '≥ ' : ''}{staleItems} {staleItems > 0 ? '▲' : staleIsFloor ? '△' : '✓'}
        </div>
        <div className="stat-sub">{staleIsFloor ? 'at least — some stock is of unknown age' : 'worth reviewing first'}</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">
          <Tip width={340} text={`Value of stock whose age the report cannot know: what was already on the shelf when the window began (${windowDays} days back), plus any extra a stock count found beyond what purchases and usage account for${surplusValue > 0 ? ` (${npr(surplusValue)} of it)` : ''}. Its true age is at least what is shown. It carries no purchase line, so it is valued at the current Item Master rate.`}>Unknown Age</Tip>
        </div>
        {/* Value, not quantity (S718): kilograms plus litres plus pieces is not a figure. */}
        <div className="stat-value" style={{ fontSize: 18, color: cfValue > 0 ? 'var(--theme-text1)' : 'var(--theme-text3)' }}>
          {cfValue > 0 ? npr(cfValue) : '—'}
        </div>
        <div className="stat-sub">
          {cfValue > 0 ? `${cfItems} item${cfItems === 1 ? '' : 's'} · carried in or found by a count` : 'none'}
        </div>
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
      <strong style={{ color: 'var(--theme-accent-ink)' }}>How to read this:</strong> {BASIS}{' '}
      Each purchase is a batch. Everything sold, wasted or served as staff meals is taken off the <em>oldest</em> batches
      first, and at every closed month with a stock count the item is set to what was counted — if the count is lower,
      the missing stock comes off the oldest batches; if it is higher, the extra is added as stock of unknown age.
      {latestCount
        ? <> The latest count used is the end of <strong>{monthLabel(latestCount)}</strong>{uncountedItems > 0 ? <>; {uncountedItems} item{uncountedItems === 1 ? ' has' : 's have'} no count in the window and follow the estimate.</> : '.'}</>
        : <> <strong style={{ color: 'var(--theme-amber-text)' }}>No closed month in this window has a stock count</strong>, so every quantity here is an estimate from purchases and recipe usage.</>}
      {' '}The window is the 12 months to {periodLabel}.
      {asOf && !asOf.isToday && (
        <>
          {' '}Ages are measured to <strong style={{ color: 'var(--theme-amber-text)' }}>{asOfLabel}</strong>, the
          end of the month you selected — not to today, which would call every surviving batch stale.
        </>
      )}
      {staleIsFloor && (
        <>
          {' '}<strong style={{ color: 'var(--theme-amber-text)' }}>{npr(unknownAgeValue)} of stock is of unknown age</strong> and
          sits in a younger band only because of the date it had to be given, so treat the 90+ figure as a floor.
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
      {/* The filter bar is no-print, so the scope and the basis print here. */}
      <p className="print-only" style={{ fontSize: 12, marginBottom: 12 }}>{scopeLine}<br />{BASIS}</p>
    </>
  )

  const footnote = (
    <p style={{ marginTop: 10, fontSize: 12, color: 'var(--theme-text3)' }}>
      Age band columns show <strong>quantity</strong>; the TOTAL row shows each band&apos;s <strong>value</strong>,
      so you can see where the money sits. Ages are measured to {asOfLabel}. {BASIS}
    </p>
  )

  return (
    <ReportPage
      title="Stock Ageing"
      subtitle="How long the stock you are still holding has been sitting"
      scope={<PeriodScope label={`12 months to ${periodLabel} · as at ${asOfLabel}`} />}
      banners={biz.error && (
        <p role="alert" className="no-print" style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
          This outlet's name could not be loaded, so Excel is switched off rather than exporting a sheet
          with a blank company name. The report below is unaffected. Reload the page to try again.
        </p>
      )}
      actions={actions}
      noPeriod={!loading && !loadError && periods.length === 0}
      noPeriodWhat="the stock ageing report"
      loading={loading}
      error={loadError}
      empty={filtered.length === 0}
      emptyIcon="◷"
      emptyText={rows.length > 0
        ? 'No items match the current filters.'
        : hadBatches
          ? `No stock on hand as at ${asOfLabel} — everything bought, carried in or counted in the 12 months to ${periodLabel} has been used, wasted or returned.`
          : `Nothing to age in the 12 months to ${periodLabel} — no purchases were recorded, no opening stock was carried in and no stock was counted.`}
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
                <th style={{ textAlign: 'right' }}><Tip text="Quantity still on hand: your latest stock count for the item where a closed month has one, then purchases less usage since. Usage is taken off the oldest batches first." width={280}>On Hand</Tip></th>
                {AGE_BANDS.map(b => (
                  <th key={b.key} style={{ textAlign: 'right' }}>
                    <Tip width={280} text={`Quantity still on hand that was bought ${b.label.replace(' days', '')} days before ${asOfLabel}. These columns are quantities — the TOTAL row at the foot of the table shows each band's value in NPR.`}>
                      {b.label}
                    </Tip>
                  </th>
                ))}
                <th style={{ textAlign: 'right' }}><Tip text={`Age of the oldest batch of this item still on hand, as at ${asOfLabel}.`} width={240}>Oldest</Tip></th>
                <th><Tip text="The stock count this item's quantity follows — the end of the latest closed month in the window that counted it. 'Estimate' means no count reached it, so its quantity is purchases less recipe usage." width={280}>Counted</Tip></th>
                <th style={{ textAlign: 'right' }}>Value</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => {
                const meta = itemMeta[r.item_id] || {}
                const stale = r.bands['90+'].qty > 0
                const counted = lastCountByItem[r.item_id]
                const windowCf = r.carriedForwardQty - r.countSurplusQty
                return (
                  <tr key={r.item_id} style={{ background: stale ? 'color-mix(in srgb, var(--theme-amber) 10%, transparent)' : 'transparent' }}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                      {meta.name || '—'}
                      {windowCf > 1e-9 && (
                        <Tip text="Part of this item's stock was already on the shelf when the 12-month window began. Its true age is at least the figure shown and may be far more, and that part is valued at the current Item Master rate." width={300}>
                          <span className="badge badge-gray" style={{ marginLeft: 6 }}>c/f</span>
                        </Tip>
                      )}
                      {r.countSurplusQty > 1e-9 && (
                        <Tip text="A stock count found more of this item than purchases and usage account for. The extra is shown as stock of unknown age, dated at that count, and valued at the current Item Master rate — no purchase was invented for it. A missing purchase bill is the usual cause." width={300}>
                          <span className="badge badge-gray" style={{ marginLeft: 6 }}>count+</span>
                        </Tip>
                      )}
                    </td>
                    <td><span className="badge badge-yellow">{meta.categories?.name || 'Uncategorised'}</span></td>
                    <td style={{ color: 'var(--theme-text2)' }}>{meta.uom}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{Number(r.qty.toFixed(2)).toLocaleString('en-IN')}</td>
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
                          {cell.qty > 0 ? Number(cell.qty.toFixed(2)).toLocaleString('en-IN') : '—'}
                        </td>
                      )
                    })}
                    {/* The oldest cell carries a ▲ as its non-colour cue — it is the sort column. */}
                    <td style={{ textAlign: 'right', color: r.oldestDays >= STALE_FROM_DAYS ? 'var(--theme-amber-text)' : 'var(--theme-text2)' }}
                        title={r.oldestDays >= STALE_FROM_DAYS ? `Sitting ${STALE_FROM_DAYS}+ days` : undefined}>
                      {r.oldestDays}d{r.oldestDays >= STALE_FROM_DAYS ? ' ▲' : ''}
                    </td>
                    <td style={{ color: counted ? 'var(--theme-text2)' : 'var(--theme-text3)', whiteSpace: 'nowrap' }}>
                      {counted ? monthLabel(counted) : 'Estimate'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)' }}>{npr(r.value)}</td>
                  </tr>
                )
              })}
            </tbody>
            {totals && (
              <tfoot>
                <tr>
                  <td colSpan={3}>
                    {isFiltered
                      ? `TOTAL (${filtered.length} filtered item${filtered.length === 1 ? '' : 's'}, by value)`
                      : 'TOTAL (all items, by value)'}
                  </td>
                  {/* Deliberately not a sum: quantities do not add up across items (S718). */}
                  <td style={{ textAlign: 'right' }}>—</td>
                  {AGE_BANDS.map(b => (
                    <td key={b.key} style={{ textAlign: 'right' }}>{npr(footTotals.bands[b.key])}</td>
                  ))}
                  <td></td>
                  <td></td>
                  <td style={{ textAlign: 'right' }}>{npr(footTotals.value)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </ReportPage>
  )
}
