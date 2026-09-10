import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'
import { npr, NPR_LOCALE } from '../../../shared/nepalMoney'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import PeriodScope from '../../../components/PeriodScope'
import ReportLoadError from '../../../components/ReportLoadError'
import NoPeriodState from '../../../components/NoPeriodState'
import { COGS_FORMULA, computeUsed } from '../../../shared/imsFormulas'
import { printWithTitle } from '../../../utils/printTitle'
import { Navigate, Link } from 'react-router-dom'
import { BS_MONTHS } from '../../../utils/bsCalendar'

// Item is "Slow" if used < 20% of net available
const SLOW_THRESHOLD = 0.2

// THIS REPORT CANNOT RUN WITHOUT A CLOSING COUNT, AND USED TO PRETEND OTHERWISE (S717).
//
// Consumption here is the periodic COGS residual — opening + purchases − returns − wastage −
// staff meals − CLOSING — so the closing count is not one input among several, it is the only
// thing standing between "we used it all" and "none of it moved".
//
// The old code summed `closing` with a filter that returned 0 for an item with no `closing_stock`
// row at all, which is the ordinary state of every item in an open month before the count is
// done. An uncounted item therefore computed as **fully consumed**, failed both the Dead test and
// the Slow test, and was dropped from the report — so an uncounted period rendered zero rows and
// the sentence *"No dead or slow-moving stock this period."* That is the single most reassuring
// thing this page can say, and it was what it said when it knew nothing at all.
//
// It also conflated the two states S695 spent a session separating: a `closing_stock` row with
// `physical_qty = 0` is a COUNT ("we looked and there was none"), and no row is not. Presence is
// tested with `item.id in closeMap` here, as it is in `buildStockRows`.
const num = v => parseFloat(v) || 0
function sumByItem(rows, field) {
  const out = {}
  for (const r of rows || []) out[r.item_id] = (out[r.item_id] || 0) + num(r[field])
  return out
}

export default function DeadStock() {
  const { clientId, profile, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const biz = useBizInfo()
  const periodReq = useLatestRequest()
  const [periods, setPeriods]           = useState([])
  const [selectedPeriod, setSelected]   = useState(null)
  const [rows, setRows]                 = useState([])
  const [statusFilter, setStatusFilter] = useState('All')
  const [catFilter, setCatFilter]       = useState('All')
  // Starts TRUE. It used to start false, so the first paint — before any read had been issued —
  // rendered the KPI strip as `0 Dead / 0 Slow / —` above the empty state's "No dead or slow-moving
  // stock this period." Every one of those is a claim the page had not yet earned (S594/S616).
  const [loading, setLoading]           = useState(true)
  const [loadError, setLoadError]       = useState(null)
  // How many items could not be judged, and why. An item the report cannot assess must be counted
  // and named, never silently dropped into the same absence as an item that is fine.
  const [uncounted, setUncounted]       = useState(0)
  const [inconsistent, setInconsistent] = useState(0)
  const [assessable, setAssessable]     = useState(0)

  useEffect(() => {
    if (!effectiveClientId) return
    scopedFrom('monthly_periods')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .then(({ data, error }) => {
        // A failed read must not impersonate "no periods yet" (S612 silent-zero rule).
        if (error) { setLoadError(error.message); setLoading(false); return }
        setPeriods(data || [])
        if (data?.length) setSelected(data[0])
        else setLoading(false)   // nothing will call fetchData, so nothing else will clear it
      })
  }, [effectiveClientId, scopedFrom])

  useEffect(() => {
    if (selectedPeriod) fetchData(selectedPeriod.id)
  }, [selectedPeriod]) // eslint-disable-line

  async function fetchData(periodId) {
    periodReq.begin(periodId)   // claim the page before any await (S601)
    setLoading(true)
    setLoadError(null)
    const results = await Promise.all([
      // Every read is paged, not just purchases and wastage (S717). `opening_stock`,
      // `closing_stock` and `staff_meals` are one row per item per period, so a client past 1000
      // items truncates silently — and truncation returns NO error, so the firstError() check
      // below walks straight over it. The consequence here is specific and bad: a missing
      // `closing_stock` row is indistinguishable from "not counted", so the tail of a large item
      // book would drop out of the report exactly as if nobody had counted it. Stock Count and
      // Stock Report already page these three; this page and Reorder Report were the two that
      // could still disagree with them about what is on the shelf.
      fetchAllRows(() => scopedFrom('items', 'id, name, uom, per_uom_rate, categories(name)')
        .eq('is_active', true).eq('is_sub_recipe', false).order('id')),
      fetchAllRows(() => supabase.from('opening_stock').select('item_id, qty').eq('period_id', periodId).order('id')),
      fetchAllRows(() => supabase.from('purchase_entries').select('item_id, qty').eq('period_id', periodId).order('id')),
      fetchAllRows(() => scopedFrom('vendor_returns', 'item_id, qty').eq('period_id', periodId).order('id')),
      fetchAllRows(() => supabase.from('wastages').select('item_id, qty').eq('period_id', periodId).order('id')),
      // Staff meals count as consumption (src/shared/imsFormulas.js). Without them an item only
      // ever eaten by staff read as "Dead — no movement", which is the opposite of true.
      fetchAllRows(() => supabase.from('staff_meals').select('item_id, qty').eq('period_id', periodId).order('id')),
      fetchAllRows(() => supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', periodId).order('id')),
    ])
    // A failed read must never flow through the `|| []`s below — every item would read as "Dead"
    // or vanish, both believable (S612 silent-zero rule).
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setRows([]); setLoading(false); return }
    const [
      { data: itemsData },
      { data: openings },
      { data: purchases },
      { data: rets },
      { data: wastes },
      { data: staffMealRows },
      { data: closings },
    ] = results

    // One pass per table instead of a `.filter()` per item per table. The old `sumField` walked
    // every row of all six arrays once for each item — at 800 items and a busy month that is tens
    // of millions of element visits on a page load.
    const openMap  = sumByItem(openings, 'qty')
    const purchMap = sumByItem(purchases, 'qty')
    const retMap   = sumByItem(rets, 'qty')
    const wasteMap = sumByItem(wastes, 'qty')
    const staffMap = sumByItem(staffMealRows, 'qty')
    // Built directly rather than through sumByItem: presence is the fact this page turns on, and
    // an item counted at 0 must be present in the map. There is at most one row per item.
    const closeMap = {}
    for (const r of closings || []) closeMap[r.item_id] = num(r.physical_qty)

    const built = []
    let uncountedCount = 0
    let inconsistentCount = 0
    let assessableCount = 0
    for (const item of (itemsData || [])) {
      const opening   = openMap[item.id]  || 0
      const purchased = purchMap[item.id] || 0
      const returned  = retMap[item.id]   || 0
      const wasted    = wasteMap[item.id] || 0
      const staffUsed = staffMap[item.id] || 0
      const hasCount  = item.id in closeMap
      const closing   = hasCount ? closeMap[item.id] : 0
      const available = opening + purchased - returned

      // Skip items with no stock presence at all — nothing in the data says this item was ever on
      // the shelf this period, so it is neither dead nor unassessed, it is simply absent.
      if (available <= 0 && !hasCount) continue

      // No closing count: consumption is not merely unknown, it is unknowable in this model.
      // Counted, not classified — the banner names how many, because the alternative is a report
      // that quietly gets shorter the less anyone counts.
      if (!hasCount) { uncountedCount += 1; continue }

      // Counted, and the count is zero on an item nothing was available of either: the original
      // "no stock presence" skip, which the hasCount split above would otherwise have let through
      // as a Dead item worth NPR 0 — noise on a report about capital tied up.
      if (available <= 0 && closing <= 0) continue

      // A count larger than what was theoretically available means a purchase is missing or the
      // count is wrong. `used` then goes negative and the old `Math.max(…, 0)` turned that into a
      // flat 0, i.e. **Dead** — the loudest verdict on the page, produced by a data fault. Stock
      // Report already surfaces this class as "negative theoretical stock"; here it is excluded
      // and counted, since "write this stock off" is the wrong thing to say about a bad number.
      const rawUsed = computeUsed({ opening, purchases: purchased, returns: returned, wastage: wasted, staffMeals: staffUsed, closing })
      if (rawUsed < 0) { inconsistentCount += 1; continue }
      assessableCount += 1
      const used = rawUsed

      const status = used === 0
        ? 'Dead'
        : available > 0 && used / available < SLOW_THRESHOLD
          ? 'Slow'
          : null

      if (!status) continue

      const rate = parseFloat(item.per_uom_rate || 0)
      built.push({
        id:          item.id,
        name:        item.name,
        category:    item.categories?.name || 'Uncategorised',
        uom:         item.uom,
        opening,
        purchased,
        returned,
        wasted,
        used,
        closing,
        available,
        rate,
        valueAtRisk: closing * rate,
        status,
      })
    }

    built.sort((a, b) => b.valueAtRisk - a.valueAtRisk)
    setRows(built)
    setUncounted(uncountedCount)
    setInconsistent(inconsistentCount)
    setAssessable(assessableCount)
    setStatusFilter('All')
    setCatFilter('All')
    setLoading(false)
  }

  const deadCount        = rows.filter(r => r.status === 'Dead').length
  const slowCount        = rows.filter(r => r.status === 'Slow').length
  const totalValueAtRisk = rows.reduce((s, r) => s + r.valueAtRisk, 0)
  const categories       = ['All', ...Array.from(new Set(rows.map(r => r.category))).sort()]

  let filtered = rows
  if (statusFilter !== 'All') filtered = filtered.filter(r => r.status === statusFilter)
  if (catFilter !== 'All')   filtered = filtered.filter(r => r.category === catFilter)

  const periodLabel = selectedPeriod
    ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}`
    : ''

  // The scope this report is read under, in one line — on screen, in the print header and in the
  // workbook alike. It has to carry the coverage, not just the month: "3 dead items" means one
  // thing across a fully counted book and something else across 40 of 900 items (S594).
  const scopeLine = `${periodLabel} · ${assessable} item${assessable === 1 ? '' : 's'} assessed`
    + (uncounted > 0 ? ` · ${uncounted} not counted` : '')
    + (inconsistent > 0 ? ` · ${inconsistent} with inconsistent figures` : '')

  function fmt(n) {
    return n ? npr(n) : '—'
  }

  // A QUANTITY, not money — so it keeps its decimals. S717/S719 routed these through nprInt(),
  // which is `Math.round`, so a 0.4 kg count printed as "0" while its own Value at Risk stayed
  // non-zero and the row contradicted itself. nepalMoney.js is for MONEY; the "render money through
  // the shared helper" rule does not extend to quantities. NPR_LOCALE keeps the Nepali grouping.
  function fmtQty(n) {
    return n ? Number(n).toLocaleString(NPR_LOCALE, { maximumFractionDigits: 3 }) : '—'
  }

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const wb   = XLSX.utils.book_new()
    const data = rows.map(r => ({
      'Item':               r.name,
      'Category':           r.category,
      'UOM':                r.uom,
      'Status':             r.status,
      'Opening Qty':        r.opening   || '',
      'Purchased Qty':      r.purchased || '',
      'Returned Qty':       r.returned  || '',
      'Net Available':      r.available || '',
      'Wasted Qty':         r.wasted    || '',
      'Used Qty':           r.used      || '',
      'Closing Qty':        r.closing   || '',
      'Value at Risk (NPR)':r.valueAtRisk ? r.valueAtRisk.toFixed(0) : '',
    }))
    const ws = sheetWithLetterhead(XLSX, {
      title: 'Dead Stock / Slow Movers',
      biz,
      scopeLine,
      rows: data,
      notes: [
        `Consumption is ${COGS_FORMULA}.`,
        'Only items with a closing count for this period can be judged; the rest are excluded and counted in the scope line above.',
      ],
    })
    XLSX.utils.book_append_sheet(wb, ws, 'Dead Stock')
    XLSX.writeFile(wb, `DeadStock-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />
  // !loadError: a failed periods read must not wear NoPeriodState (S612 silent-zero rule).
  if (!loading && !loadError && periods.length === 0) return <NoPeriodState what="the dead stock report" />

  return (
    <div className="page-container">

      {/* Print-only header */}
      <div className="print-only" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Dead Stock / Slow Movers</h2>
        <div style={{ fontSize: 12 }}>{scopeLine}</div>
      </div>

      {/* Screen header */}
      <div className="page-header page-header--split no-print">
        <div>
          <h1 className="page-title">Dead Stock / Slow Movers</h1>
          <p className="page-subtitle">Items with zero or low consumption — capital tied up in stock</p>
          <div className="page-scope-row">
            {/* provisionalWhenOpen: this report is computed from the closing count, so before the
                month is counted it is not merely provisional, it is mostly blank (S717). */}
            <PeriodScope label={periodLabel} status={selectedPeriod?.status} provisionalWhenOpen />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select aria-label="Period" className="form-select" value={selectedPeriod?.id || ''} onChange={e => setSelected(periods.find(p => p.id === e.target.value))}>
            {periods.map(p => (
              <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year}</option>
            ))}
          </select>
          <button className="btn btn-ghost" disabled={loading || !!loadError}
            onClick={() => printWithTitle(`Dead Stock / Slow Movers — ${scopeLine}`)}>Print</button>
          <button className="btn btn-ghost" onClick={exportExcel} disabled={loading || !!loadError || !rows.length}>Export Excel</button>
        </div>
      </div>

      {/* What the report could NOT judge. It goes above the figures because it qualifies all of
          them: "no dead stock" across 12 assessed items out of 900 is not the same sentence as
          "no dead stock" across a counted month, and until S717 the page said both identically. */}
      {!loading && !loadError && (uncounted > 0 || inconsistent > 0) && (
        <div className="no-print" style={{
          background: 'color-mix(in srgb, var(--theme-amber) 6%, transparent)',
          border: '1px solid color-mix(in srgb, var(--theme-amber) 20%, transparent)',
          borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20,
          fontSize: 13, color: 'var(--theme-text2)',
        }}>
          <strong style={{ color: 'var(--theme-amber-text)' }}>△ {assessable} of {assessable + uncounted + inconsistent} items could be judged</strong>
          {uncounted > 0 && <> — <strong>{uncounted}</strong> {uncounted === 1 ? 'has' : 'have'} no closing count for {periodLabel}, and consumption cannot be worked out without one (it is opening + purchases − wastage − staff meals − <em>closing</em>). Enter the count in <strong>Stock Count</strong> and this report fills in.</>}
          {inconsistent > 0 && <> {uncounted > 0 ? 'A further' : '—'} <strong>{inconsistent}</strong> {inconsistent === 1 ? 'item was' : 'items were'} counted higher than the stock available to them, which usually means a purchase bill is missing. Those figures are excluded rather than reported as “never used”.</>}
        </div>
      )}

      {/* KPI strip waits for the load and never survives a failure: unloaded or failed,
          Dead Stock Items / Value at Risk read as a confident 0 (S594). `assessable > 0` is the
          same rule one step further — with nothing counted the page has computed nothing, and
          "0 Dead / 0 Slow" is a finding it has not made (S717). */}
      {!loading && !loadError && assessable > 0 && (
      <div className="stat-grid no-print">
        <div className="stat-card">
          <div className="stat-label">Dead Stock Items</div>
          <div className="stat-value" style={{ color: 'var(--theme-red-text)' }}>{deadCount}</div>
          <div className="stat-label" style={{ marginTop: 4 }}>Zero consumption</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Slow Movers</div>
          <div className="stat-value" style={{ color: 'var(--theme-amber-text)' }}>{slowCount}</div>
          <div className="stat-label" style={{ marginTop: 4 }}>Used &lt;20% of available</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Total closing stock value of all dead and slow-moving items — capital currently tied up in idle inventory." width={260}>Value at Risk</Tip>
          </div>
          <div className="stat-value" style={{ color: 'var(--theme-red-text)' }}>{fmt(totalValueAtRisk)}</div>
        </div>
      </div>
      )}

      {/* Filters. Gated exactly like the KPI strip above (S720). S717 gated the strip and left this
          row forty lines below it ungated, so `All (0) Dead (0) Slow (0)` painted for the whole of
          the seven-query load and stayed there permanently above ReportLoadError's "Could not load
          this report" — three counts saying "no dead stock, no slow movers" about a period the page
          never read. S616's rule is positional and this is the file it was recorded against: the
          guard has to open before the element, and every slot ReportPage would gate needs it, not
          just the stat-grid. */}
      {!loading && !loadError && assessable > 0 && (
      <div className="no-print" style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {['All', 'Dead', 'Slow'].map(s => (
          <button
            key={s}
            className={`tab-btn${statusFilter === s ? ' tab-btn--active' : ''}`}
            onClick={() => setStatusFilter(s)}
          >
            {s} ({s === 'All' ? rows.length : s === 'Dead' ? deadCount : slowCount})
          </button>
        ))}
        {categories.length > 2 && (
          <div style={{ marginLeft: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {categories.map(c => (
              <button key={c} className={`tab-btn${catFilter === c ? ' tab-btn--active' : ''}`} onClick={() => setCatFilter(c)}>{c}</button>
            ))}
          </div>
        )}
      </div>
      )}

      {loading ? (
        <div className="loading-state">Loading...</div>
      ) : loadError ? (
        <ReportLoadError error={loadError} />
      ) : assessable === 0 && uncounted > 0 ? (
        /* "Nothing is dead" and "we could not look" are different facts, and this page used to
           render them with the same sentence — the reassuring one (S717). */
        <div className="empty-state">
          <div className="empty-state-icon">◷</div>
          <p className="empty-state-text">
            This report needs a stock count. None of the {uncounted} item{uncounted === 1 ? '' : 's'} with
            stock in {periodLabel} has a closing count yet, so there is no way to tell what moved and
            what did not. <Link to="/stock">Enter the closing count</Link> and come back.
          </p>
        </div>
      ) : assessable === 0 ? (
        /* A third fact again: no opening, no purchases, no count — there is simply nothing in
           this period to have an opinion about. */
        <div className="empty-state">
          <div className="empty-state-icon">◈</div>
          <p className="empty-state-text">No stock recorded in {periodLabel} yet — nothing to assess.</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">✓</div>
          <p className="empty-state-text">
            No dead or slow-moving stock among the {assessable} item{assessable === 1 ? '' : 's'} counted in {periodLabel}.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">◈</div>
          <p className="empty-state-text">No items match the selected filters.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Category</th>
                <th>UOM</th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Physical stock counted at the start of this period." width={200}>Opening</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Net purchases this period (purchases minus vendor returns)." width={220}>Net Purchased</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Quantity recorded as wastage this period." width={200}>Wasted</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text={`${COGS_FORMULA}. The quantity actually consumed this period.`} width={260}>Used</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Physical stock counted at the end of this period." width={200}>Closing</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Closing stock × per-unit rate. NPR value currently sitting idle in inventory." width={240}>Value at Risk</Tip>
                </th>
                <th>
                  <Tip text="Dead = zero consumption this period. Slow = used less than 20% of net available stock." width={260}>Status</Tip>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.id} style={{ opacity: r.status === 'Dead' ? 1 : 0.85 }}>
                  <td><strong>{r.name}</strong></td>
                  <td><span className="badge badge-yellow">{r.category}</span></td>
                  <td>{r.uom}</td>
                  <td style={{ textAlign: 'right' }}>{fmtQty(r.opening)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtQty(r.purchased - r.returned)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtQty(r.wasted)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtQty(r.used)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtQty(r.closing)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-red-text)', fontWeight: 600 }}>{fmt(r.valueAtRisk)}</td>
                  <td>
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 'var(--radius-xs)',
                      color:      r.status === 'Dead' ? 'var(--theme-red-text)' : 'var(--theme-amber-text)',
                      background: r.status === 'Dead' ? 'color-mix(in srgb, var(--theme-red) 10%, transparent)' : 'color-mix(in srgb, var(--theme-amber) 10%, transparent)',
                      border:     `1px solid ${r.status === 'Dead' ? 'color-mix(in srgb, var(--theme-red) 25%, transparent)' : 'color-mix(in srgb, var(--theme-amber) 25%, transparent)'}`,
                    }}>
                      {r.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
