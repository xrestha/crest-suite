import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'
import { npr, NPR_LOCALE } from '../../../shared/nepalMoney'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import PeriodScope from '../../../components/PeriodScope'
import ReportLoadError from '../../../components/ReportLoadError'
import NoPeriodState from '../../../components/NoPeriodState'
import { COGS_FORMULA } from '../../../shared/imsFormulas'
import { printWithTitle } from '../../../utils/printTitle'
import { Navigate, Link } from 'react-router-dom'
import { BS_MONTHS, bsToAd, formatBsDay } from '../../../utils/bsCalendar'
import { asOfForWindow, periodMonthIndex } from '../reports/stockAgeingCalc'
import { FilterChips } from '../../../components/Tabs'
import {
  judgeItemPeriod, classifyItem, suggestNextStep,
  DEAD_AFTER_MONTHS, SLOW_THRESHOLD,
} from './deadStockCalc'

// How many months back the page reads to measure a standstill (S756, D20). Dead needs three; the
// rest is so "still for N months" can say how long, up to a year, rather than stopping at three.
const HISTORY_MONTHS = 12

// THIS REPORT CANNOT RUN WITHOUT A CLOSING COUNT, AND USED TO PRETEND OTHERWISE (S717).
//
// Consumption here is the periodic COGS residual — opening + purchases − returns − wastage −
// staff meals − CLOSING — so the closing count is not one input among several, it is the only
// thing standing between "we used it all" and "none of it moved". An uncounted item used to
// compute as fully consumed and drop out, so an uncounted month said "No dead or slow-moving
// stock". A `closing_stock` row with `physical_qty = 0` is a COUNT and no row is not (S695);
// presence is tested per month in `judgeItemPeriod` (deadStockCalc.js, tested).
//
// S756 (D20): the verdict is no longer one month's. See deadStockCalc.js for the rule — Dead after
// three consecutive counted still months, Slow for one or two (or under 20% used), an uncounted
// month breaks the streak — and for the suggested next step.
const num = v => parseFloat(v) || 0
function sumByPeriodItem(rows, field) {
  const out = {}
  for (const r of rows || []) {
    if (!out[r.period_id]) out[r.period_id] = {}
    out[r.period_id][r.item_id] = (out[r.period_id][r.item_id] || 0) + num(r[field])
  }
  return out
}
const monthLabel = p => (p ? `${BS_MONTHS[p.bs_month - 1]} ${p.bs_year}` : '')

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
  // Starts TRUE: the first paint must not render "0 Dead / 0 Slow" before any read (S594/S616).
  const [loading, setLoading]           = useState(true)
  const [loadError, setLoadError]       = useState(null)
  // How many items could not be judged this month, and why — counted and named, never dropped.
  const [uncounted, setUncounted]       = useState(0)
  const [inconsistent, setInconsistent] = useState(0)
  const [assessable, setAssessable]     = useState(0)
  // How many months the history actually covered — a client with two periods cannot show Dead.
  const [historyLength, setHistoryLength] = useState(0)

  useEffect(() => {
    if (!effectiveClientId) return
    scopedFrom('monthly_periods')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .then(({ data, error }) => {
        // A failed read must not impersonate "no periods yet" (S612 silent-zero rule).
        if (error) { setLoadError(error.message); setLoading(false); return }
        setPeriods(data || [])
        // The most recent CLOSED period, else the latest (S756) — this report cannot judge without
        // a closing count, and the open month is almost never counted yet.
        const initial = (data || []).find(p => p.status === 'closed') || data?.[0]
        if (initial) setSelected(initial)
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
    // The selected month and up to eleven before it, newest first (S756, D20). `periods` is
    // newest-first from the load above.
    const at = periods.findIndex(p => p.id === periodId)
    const history = at >= 0 ? periods.slice(at, at + HISTORY_MONTHS) : []
    const ids = history.map(p => p.id)
    const byMonth = (table, cols) => fetchAllRowsChunked(ids, c =>
      supabase.from(table).select(cols).in('period_id', c).order('id'))

    const results = await Promise.all([
      // Every read is paged (S717), and now spans up to twelve months: one row per item per month
      // × 12 crosses the silent 1000-row cap at ~85 items, and a missing closing_stock row is
      // indistinguishable from "not counted" — which here would break a Dead streak silently.
      fetchAllRows(() => scopedFrom('items', 'id, name, uom, per_uom_rate, categories(name)')
        .eq('is_active', true).eq('is_sub_recipe', false).order('id')),
      byMonth('opening_stock', 'period_id, item_id, qty'),
      // bs_day, expiry_date and vendor_id pick the item's latest purchase for the next-step rule.
      byMonth('purchase_entries', 'period_id, item_id, qty, bs_day, expiry_date, vendor_id'),
      fetchAllRowsChunked(ids, c => scopedFrom('vendor_returns', 'period_id, item_id, qty').in('period_id', c).order('id')),
      byMonth('wastages', 'period_id, item_id, qty'),
      // Staff meals count as consumption (imsFormulas.js).
      byMonth('staff_meals', 'period_id, item_id, qty'),
      byMonth('closing_stock', 'period_id, item_id, physical_qty'),
      // Every vendor, not only active ones: this resolves a NAME on history (S708) — an archived
      // supplier still sold you the stock.
      fetchAllRows(() => scopedFrom('vendors', 'id, name').order('id')),
    ])
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    // A failed read must never flow through the `|| []`s below (S612 silent-zero rule).
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setRows([]); setLoading(false); return }
    const [
      { data: itemsData }, { data: openings }, { data: purchases }, { data: rets },
      { data: wastes }, { data: staffMealRows }, { data: closings }, { data: vendors },
    ] = results

    const openMap  = sumByPeriodItem(openings, 'qty')
    const purchMap = sumByPeriodItem(purchases, 'qty')
    const retMap   = sumByPeriodItem(rets, 'qty')
    const wasteMap = sumByPeriodItem(wastes, 'qty')
    const staffMap = sumByPeriodItem(staffMealRows, 'qty')
    // Built directly: presence is the fact this page turns on, and a 0 count must be present.
    const closeMap = {}
    for (const r of closings || []) {
      if (r.physical_qty == null) continue
      if (!closeMap[r.period_id]) closeMap[r.period_id] = {}
      closeMap[r.period_id][r.item_id] = num(r.physical_qty)
    }

    // Each item's latest purchase in the months read.
    const periodById = Object.fromEntries(history.map(p => [p.id, p]))
    const vendorName = Object.fromEntries((vendors || []).map(v => [v.id, v.name]))
    const lastBuy = {}
    for (const p of purchases || []) {
      const per = periodById[p.period_id]
      if (!per || !(num(p.qty) > 0)) continue
      const rank = periodMonthIndex(per) * 40 + (parseInt(p.bs_day, 10) || 0)
      if (!lastBuy[p.item_id] || rank > lastBuy[p.item_id].rank) lastBuy[p.item_id] = { rank, row: p, period: per }
    }

    const selected = history[0]
    const asOf = asOfForWindow(selected, { isNewest: periods[0]?.id === periodId }).date

    const built = []
    let uncountedCount = 0
    let inconsistentCount = 0
    let assessableCount = 0
    for (const item of (itemsData || [])) {
      const monthFigures = pid => ({
        opening:   openMap[pid]?.[item.id] || 0,
        purchased: purchMap[pid]?.[item.id] || 0,
        returned:  retMap[pid]?.[item.id] || 0,
        wasted:    wasteMap[pid]?.[item.id] || 0,
        staffUsed: staffMap[pid]?.[item.id] || 0,
        hasCount:  !!closeMap[pid] && item.id in closeMap[pid],
        closing:   closeMap[pid]?.[item.id] || 0,
      })
      const itemHistory = history.map(p => ({ monthIndex: periodMonthIndex(p), judgement: judgeItemPeriod(monthFigures(p.id)) }))
      const latest = itemHistory[0]?.judgement
      if (!latest || latest.state === 'absent') continue
      if (latest.state === 'uncounted') { uncountedCount += 1; continue }
      if (latest.state === 'inconsistent') { inconsistentCount += 1; continue }
      assessableCount += 1

      const verdict = classifyItem(itemHistory)
      if (!verdict.status) continue

      const f = monthFigures(selected.id)
      const buy = lastBuy[item.id]
      const lastPurchase = buy ? {
        date: bsToAd(buy.period.bs_year, buy.period.bs_month, Math.min(Math.max(parseInt(buy.row.bs_day, 10) || 1, 1), 32)),
        vendorName: buy.row.vendor_id ? vendorName[buy.row.vendor_id] : null,
        expiryDate: buy.row.expiry_date || null,
      } : null
      const suggestion = suggestNextStep({ status: verdict.status, stillMonths: verdict.stillMonths, lastPurchase, asOf })

      const rate = parseFloat(item.per_uom_rate || 0)
      built.push({
        id:          item.id,
        name:        item.name,
        category:    item.categories?.name || 'Uncategorised',
        uom:         item.uom,
        opening:     f.opening,
        purchased:   f.purchased,
        returned:    f.returned,
        wasted:      f.wasted,
        used:        latest.used,
        closing:     f.closing,
        available:   latest.available,
        rate,
        valueAtRisk: f.closing * rate,
        status:      verdict.status,
        stillMonths: verdict.stillMonths,
        atLeast:     verdict.atLeast,
        suggestion:  suggestion?.text || '',
        lastBought:  buy ? `${formatBsDay(buy.row.bs_day, buy.period.bs_month)} ${buy.period.bs_year}` : '',
        supplier:    lastPurchase?.vendorName || '',
      })
    }

    built.sort((a, b) => b.valueAtRisk - a.valueAtRisk)
    setRows(built)
    setUncounted(uncountedCount)
    setInconsistent(inconsistentCount)
    setAssessable(assessableCount)
    setHistoryLength(history.length)
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

  const periodLabel = monthLabel(selectedPeriod)

  // The scope in one line — on screen, in print and in the workbook. It carries the coverage and
  // the rule, not just the month (S594): "3 dead items" means nothing without "dead = 3 months".
  const scopeLine = `${periodLabel} · ${assessable} item${assessable === 1 ? '' : 's'} assessed`
    + (uncounted > 0 ? ` · ${uncounted} not counted` : '')
    + (inconsistent > 0 ? ` · ${inconsistent} with inconsistent figures` : '')
    + ` · Dead = nothing used for ${DEAD_AFTER_MONTHS}+ counted months in a row`

  function fmt(n) {
    return n ? npr(n) : '—'
  }

  // A QUANTITY, not money — keeps its decimals (S721). NPR_LOCALE keeps the Nepali grouping.
  function fmtQty(n) {
    return n ? Number(n).toLocaleString(NPR_LOCALE, { maximumFractionDigits: 3 }) : '—'
  }

  function stillText(r) {
    if (!(r.stillMonths > 0)) return 'Moving slowly'
    return `${r.stillMonths}${r.atLeast ? '+' : ''} month${r.stillMonths === 1 && !r.atLeast ? '' : 's'}`
  }

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const wb   = XLSX.utils.book_new()
    const data = rows.map(r => ({
      'Item':                 r.name,
      'Category':             r.category,
      'UOM':                  r.uom,
      'Status':               r.status,
      'Months Without Use':   r.stillMonths || 0,
      'Suggested Next Step':  r.suggestion,
      'Last Bought':          r.lastBought,
      'Supplier':             r.supplier,
      'Opening Qty':          r.opening   || '',
      'Purchased Qty':        r.purchased || '',
      'Returned Qty':         r.returned  || '',
      'Net Available':        r.available || '',
      'Wasted Qty':           r.wasted    || '',
      'Used Qty':             r.used      || '',
      'Closing Qty':          r.closing   || '',
      'Value at Risk (NPR)':  r.valueAtRisk ? Number(r.valueAtRisk.toFixed(0)) : '',
    }))
    const ws = sheetWithLetterhead(XLSX, {
      title: 'Dead Stock / Slow Movers',
      biz,
      scopeLine,
      rows: data,
      notes: [
        `Consumption is ${COGS_FORMULA}.`,
        `Dead = nothing used for ${DEAD_AFTER_MONTHS} or more months in a row. Slow = nothing used for 1–2 months, or less than ${SLOW_THRESHOLD * 100}% of what was available used this month.`,
        'A month with no closing count for an item is not judged and breaks the run — it is never counted as a month without use.',
        'Only items with a closing count for the selected month can be judged; the rest are excluded and counted in the scope line above.',
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
          <p className="page-subtitle">Items that have stopped moving — capital tied up in stock, and what to do about it</p>
          <div className="page-scope-row">
            {/* provisionalWhenOpen: computed from the closing count, so before the month is counted
                it is mostly blank (S717). */}
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
          {/* biz.error (S756): the export waits rather than send a nameless document. */}
          <button className="btn btn-ghost" onClick={exportExcel} disabled={loading || !!loadError || !rows.length || !!biz.error}>Export Excel</button>
        </div>
      </div>

      {biz.error && (
        <p role="alert" className="no-print" style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
          This outlet's name could not be loaded, so Excel is switched off rather than exporting a sheet
          with a blank company name. The report below is unaffected. Reload the page to try again.
        </p>
      )}

      {/* What the report could NOT judge — above the figures, because it qualifies all of them. */}
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

      {/* The rule, stated before the verdicts (S756, D20) — a Dead count means nothing to a reader
          who does not know Dead now takes three months. Gated like the KPI strip. */}
      {!loading && !loadError && assessable > 0 && (
        <p className="no-print" style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 16px', lineHeight: 1.6 }}>
          <strong>Dead</strong> means nothing was used for {DEAD_AFTER_MONTHS} or more counted months in a row.
          {' '}<strong>Slow</strong> means nothing was used for one or two months, or less than {SLOW_THRESHOLD * 100}% of what was available was used.
          {' '}A month without a stock count for an item is not judged and restarts the run.
          {historyLength < DEAD_AFTER_MONTHS && <> Only {historyLength} month{historyLength === 1 ? '' : 's'} of records exist so far, so nothing can be called Dead yet.</>}
        </p>
      )}

      {/* KPI strip waits for the load and never survives a failure; `assessable > 0` because with
          nothing counted "0 Dead / 0 Slow" is a finding the page has not made (S594/S717). */}
      {!loading && !loadError && assessable > 0 && (
      <div className="stat-grid no-print">
        <div className="stat-card">
          <div className="stat-label">Dead Stock Items</div>
          <div className="stat-value" style={{ color: 'var(--theme-red-text)' }}>{deadCount}</div>
          <div className="stat-label" style={{ marginTop: 4 }}>No use for {DEAD_AFTER_MONTHS}+ months</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Slow Movers</div>
          <div className="stat-value" style={{ color: 'var(--theme-amber-text)' }}>{slowCount}</div>
          <div className="stat-label" style={{ marginTop: 4 }}>Still 1–2 months, or &lt;20% used</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Total closing stock value of all dead and slow-moving items — capital currently tied up in idle inventory." width={260}>Value at Risk</Tip>
          </div>
          <div className="stat-value" style={{ color: 'var(--theme-red-text)' }}>{fmt(totalValueAtRisk)}</div>
        </div>
      </div>
      )}

      {/* Filters — gated exactly like the KPI strip (S720): counts are figures too. */}
      {!loading && !loadError && assessable > 0 && (
      <div className="no-print" style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <FilterChips
          label="Filter by movement"
          options={[
            { key: 'All', label: `All (${rows.length})` },
            { key: 'Dead', label: `Dead (${deadCount})` },
            { key: 'Slow', label: `Slow (${slowCount})` },
          ]}
          active={statusFilter}
          onChange={setStatusFilter}
        />
        {categories.length > 2 && (
          <div style={{ marginLeft: 12 }}>
            <FilterChips
              label="Filter by category"
              options={categories.map(c => ({ key: c, label: c }))}
              active={catFilter}
              onChange={setCatFilter}
            />
          </div>
        )}
      </div>
      )}

      {loading ? (
        <div className="loading-state">Loading...</div>
      ) : loadError ? (
        <ReportLoadError error={loadError} />
      ) : assessable === 0 && uncounted > 0 ? (
        /* "Nothing is dead" and "we could not look" are different facts (S717). */
        <div className="empty-state">
          <div className="empty-state-icon">◷</div>
          <p className="empty-state-text">
            This report needs a stock count. None of the {uncounted} item{uncounted === 1 ? '' : 's'} with
            stock in {periodLabel} has a closing count yet, so there is no way to tell what moved and
            what did not. <Link to="/stock">Enter the closing count</Link> and come back.
          </p>
        </div>
      ) : assessable === 0 ? (
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
                  <Tip text={`Dead = nothing used for ${DEAD_AFTER_MONTHS} or more counted months in a row. Slow = nothing used for 1–2 months, or less than ${SLOW_THRESHOLD * 100}% of the stock available this month used. A month with no stock count for the item is not judged and restarts the run.`} width={300}>Status</Tip>
                </th>
                <th>
                  <Tip text={`How many months in a row, ending with ${periodLabel}, nothing of this item was used. "+" means the run reaches back to the oldest month this report reads, so it may be longer.`} width={280}>Still For</Tip>
                </th>
                <th>
                  <Tip text="A suggested next step. Past its expiry date or still for more than 3 months: write it off. Bought in the last 45 days: ask the supplier to take it back (or buy less, if it is moving). Otherwise: put it on the menu as a special." width={300}>Suggested Next Step</Tip>
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
                  <td style={{ color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>{stillText(r)}</td>
                  <td style={{ color: 'var(--theme-text1)', fontSize: 13 }}>
                    {r.suggestion}
                    {r.lastBought && (
                      <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>
                        Last bought <span style={{ whiteSpace: 'nowrap' }}>{r.lastBought}</span>{r.supplier ? ` · ${r.supplier}` : ''}
                      </div>
                    )}
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
