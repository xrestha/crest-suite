import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import PeriodScope from '../../../components/PeriodScope'
import ReportLoadError from '../../../components/ReportLoadError'
import { printWithTitle } from '../../../utils/printTitle'
import { COGS_FORMULA, computeUsed, fcBand, fcThresholds } from '../../../shared/imsFormulas'
import { allocateBillDiscounts } from './supplierAttribution'
import { useSettings } from '../../../context/SettingsContext'
import { Navigate } from 'react-router-dom'
import { BS_MONTHS } from '../../../utils/bsCalendar'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { findUncountedItems, mergeGaps, gapNote, unjudgedFcFigure } from '../../../shared/uncountedItems'

// Nepal fiscal year starts Shrawan (month 4)
// bs_month >= 4 → fiscal year = bs_year; else fiscal year = bs_year - 1
function getFiscalYear(bs_year, bs_month) {
  return bs_month >= 4 ? bs_year : bs_year - 1
}

export default function AnnualSummary() {
  const { clientId, profile, loading: authLoading, hasImsAccess } = useAuth()
  const { settings } = useSettings()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const yearReq = useLatestRequest()
  const biz = useBizInfo()

  const [allPeriods, setAllPeriods]     = useState([])
  const [fiscalMode, setFiscalMode]     = useState(false)
  const [yearOptions, setYearOptions]   = useState([])
  const [selectedYear, setSelectedYear] = useState(null)
  const [report, setReport]             = useState(null)
  const [loading, setLoading]           = useState(true)
  const [loadError, setLoadError]       = useState(null)

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line
  useEffect(() => { if (allPeriods.length) rebuildYearOptions() }, [allPeriods, fiscalMode]) // eslint-disable-line
  // `fiscalMode` is a dependency too (S756): toggling Calendar ↔ Fiscal usually leaves selectedYear
  // at the same NUMBER (2082 BS → FY 2082/83), so without it no rebuild ran and the calendar
  // year's figures stayed on screen under the fiscal year's label.
  useEffect(() => { if (selectedYear !== null && allPeriods.length) buildReport() }, [selectedYear, allPeriods, fiscalMode]) // eslint-disable-line

  async function init() {
    setLoading(true)
    setLoadError(null)
    const { data: p, error } = await scopedFrom('monthly_periods')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
    if (error) { setLoadError(error.message); setLoading(false); return }
    setAllPeriods(p || [])
    setLoading(false)
  }

  function rebuildYearOptions() {
    if (fiscalMode) {
      const fySet = new Set(allPeriods.map(p => getFiscalYear(p.bs_year, p.bs_month)))
      const opts = [...fySet].sort((a, b) => b - a).map(fy => ({
        value: fy,
        label: `FY ${fy}/${(fy + 1).toString().slice(-2)}`
      }))
      setYearOptions(opts)
      setSelectedYear(opts[0]?.value ?? null)
    } else {
      const yearSet = new Set(allPeriods.map(p => p.bs_year))
      const opts = [...yearSet].sort((a, b) => b - a).map(y => ({ value: y, label: `${y} BS` }))
      setYearOptions(opts)
      setSelectedYear(opts[0]?.value ?? null)
    }
  }

  async function buildReport() {
    if (selectedYear === null) return
    // The key carries the MODE (S756). `begin(selectedYear)` made Calendar 2082 and FY 2082 the same
    // key, so a calendar-year load still in flight when the reader switched to fiscal passed
    // isCurrent and could land its figures under the FY label.
    const key = yearReq.begin(`${fiscalMode ? 'fy' : 'cal'}:${selectedYear}`)   // claim the page before any await (S601)
    setLoading(true)
    setLoadError(null)

    const yearPeriods = allPeriods.filter(p =>
      fiscalMode
        ? getFiscalYear(p.bs_year, p.bs_month) === selectedYear
        : p.bs_year === selectedYear
    ).sort((a, b) => a.bs_year - b.bs_year || a.bs_month - b.bs_month)

    if (!yearPeriods.length) { setReport(null); setLoading(false); return }
    const periodIds = yearPeriods.map(p => p.id)

    // EVERY read here is paged, and the multiplier is what makes it urgent: each of these tables
    // is one row per item per period, and this page reads TWELVE periods at once. Two hundred
    // items is 2,400 opening rows against PostgREST's silent 1000-row cap, so a client far
    // smaller than one that would trip a single-period page loses whole months of opening and
    // closing stock — and with no `.order()` the months it loses differ between loads. COGS then
    // collapses to net purchases for those months and the FC% column reports it in confident
    // type. S719's rule: multiply rows-per-item-per-period by the window length first.
    const results = await Promise.all([
      fetchAllRows(() => scopedFrom('items', 'id, name, per_uom_rate').eq('is_active', true).eq('is_sub_recipe', false).order('id')),
      fetchAllRows(() => supabase.from('opening_stock').select('period_id, item_id, qty').in('period_id', periodIds).order('id')),
      fetchAllRows(() => supabase.from('closing_stock').select('period_id, item_id, physical_qty').in('period_id', periodIds).order('id')),
      // `discount_amount` and the bill-key columns are selected so allocateBillDiscounts() can run:
      // a bill-level discount is repeated on every line, and until it is deduped and spread this
      // page's COGS sat above MonthlySummary's for the identical month by the whole discount.
      fetchAllRows(() => supabase.from('purchase_entries')
        .select('period_id, item_id, qty, rate, discount_amount, purchase_group_id, vendor_id, invoice_ref, bs_day')
        .in('period_id', periodIds).order('id')),
      fetchAllRows(() => scopedFrom('vendor_returns', 'period_id, item_id, qty, rate').in('period_id', periodIds).order('id')),
      fetchAllRows(() => supabase.from('wastages').select('period_id, item_id, qty').in('period_id', periodIds).order('id')),
      // Staff meals were missing here entirely, so this page's COGS (and therefore its Food Cost %
      // and every trend arrow off it) sat systematically below MonthlySummary's figure for the
      // exact same month, with nothing on either page saying so. See src/shared/imsFormulas.js.
      fetchAllRows(() => supabase.from('staff_meals').select('period_id, item_id, qty').in('period_id', periodIds).order('id')),
      // Revenue excludes comps (source='pos_comp') — a comped dish was never paid for. Filtered in
      // JS below, not with .neq (S756): `source` is nullable and `NULL <> 'pos_comp'` is NULL, so
      // the server-side form dropped every legacy row — Revenue short, FC% high, for twelve months.
      fetchAllRows(() => supabase.from('sales_entries').select('period_id, recipe_id, qty_sold, unit_price, discount, source').in('period_id', periodIds).order('id')),
      scopedFrom('recipes', 'id, selling_price'),
    ])
    // A failed read must not render as a quiet year of NPR 0 (S612 silent-zero rule).
    if (!yearReq.isCurrent(key)) return   // superseded by a newer year selection
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setReport(null); setLoading(false); return }
    const [
      { data: items }, { data: opening }, { data: closing },
      { data: purchases }, { data: returns }, { data: wastages },
      { data: staffMeals }, { data: sales }, { data: recipes }
    ] = results

    // `rateMap` doubles as the ACTIVE, non-sub-recipe item set, and both jobs matter. It valued
    // opening/closing/wastage/staff-meals at 0 for an item deactivated mid-year while
    // grossPurch/retVal read the purchase row's OWN rate and so kept counting that item's spend in
    // full — an internally inconsistent row whose COGS was overstated by exactly the closing value
    // it had just thrown away. MonthlySummary drops such an item from every column (its category
    // loops run over active items only); this page now does the same, so the two agree.
    const rateMap = {}
    ;(items || []).forEach(i => { rateMap[i.id] = parseFloat(i.per_uom_rate || 0) })
    const isTracked = id => Object.prototype.hasOwnProperty.call(rateMap, id)
    const recipeMap = {}
    ;(recipes || []).forEach(r => { recipeMap[r.id] = parseFloat(r.selling_price || 0) })

    // One pass per table instead of one `.filter()` per period per table (12 periods × 7 tables).
    const byPeriod = rows => {
      const m = new Map()
      for (const r of rows || []) {
        const list = m.get(r.period_id); if (list) list.push(r); else m.set(r.period_id, [r])
      }
      return m
    }
    const openBy   = byPeriod(opening)
    const closeBy  = byPeriod(closing)
    const purchBy  = byPeriod(allocateBillDiscounts(purchases))
    const retBy    = byPeriod(returns)
    const wasteBy  = byPeriod(wastages)
    const staffBy  = byPeriod(staffMeals)
    const salesBy  = byPeriod((sales || []).filter(r => r.source !== 'pos_comp'))
    const at = (m, pid) => m.get(pid) || []

    const rows = yearPeriods.map(period => {
      const pid = period.id

      const openVal   = at(openBy,  pid).reduce((s, r) => s + parseFloat(r.qty)          * (rateMap[r.item_id] || 0), 0)
      const closeVal  = at(closeBy, pid).reduce((s, r) => s + parseFloat(r.physical_qty) * (rateMap[r.item_id] || 0), 0)
      // Gross is the invoiced value; `discountVal` is the bill-level discount allocated across the
      // bill's own lines (allocateBillDiscounts, the same helper MonthlySummary and Consolidated
      // P&L use, which is what keeps the three pages' COGS tied).
      const purchRows = at(purchBy, pid).filter(r => isTracked(r.item_id))
      const grossPurch= purchRows.reduce((s, r) => s + r.lineGross, 0)
      const discVal   = grossPurch - purchRows.reduce((s, r) => s + r.lineNet, 0)
      const retVal    = at(retBy,   pid).filter(r => isTracked(r.item_id)).reduce((s, r) => s + parseFloat(r.qty) * parseFloat(r.rate), 0)
      const netPurch  = grossPurch - discVal - retVal
      const wasteVal  = at(wasteBy, pid).reduce((s, r) => s + parseFloat(r.qty) * (rateMap[r.item_id] || 0), 0)
      const staffVal  = at(staffBy, pid).reduce((s, r) => s + parseFloat(r.qty) * (rateMap[r.item_id] || 0), 0)
      const cogs      = computeUsed({ opening: openVal, purchases: netPurch, wastage: wasteVal, staffMeals: staffVal, closing: closeVal })
      // Uses the price captured on the row (unit_price) — the price actually charged that period
      // — falling back to the recipe's current price only for rows recorded before that column
      // existed. Previously always used the current price, so an earlier period's revenue and
      // the ↑/↓pp trend arrows silently reflected today's menu price, not what was charged then.
      const revenue   = at(salesBy, pid).reduce((s, r) => {
        const price = r.unit_price != null ? parseFloat(r.unit_price) : (recipeMap[r.recipe_id] || 0)
        return s + parseFloat(r.qty_sold) * price - (parseFloat(r.discount) || 0)
      }, 0)
      const fcPct     = revenue > 0 ? (cogs / revenue) * 100 : null

      // Uncounted items for THIS month (S756 D6), off the rows already grouped above. A closing row
      // with physical_qty 0 is a count; a NULL or missing one is not. The month's COGS is unchanged;
      // only its FC% verdict is withheld while the gap is material, and every other month keeps its own.
      const openingQty = {}; at(openBy, pid).forEach(r => { openingQty[r.item_id] = (openingQty[r.item_id] || 0) + parseFloat(r.qty || 0) })
      const purchaseQty = {}; const purchaseValue = {}
      purchRows.forEach(r => {
        purchaseQty[r.item_id] = (purchaseQty[r.item_id] || 0) + parseFloat(r.qty || 0)
        purchaseValue[r.item_id] = (purchaseValue[r.item_id] || 0) + r.lineNet
      })
      const countedIds = new Set(at(closeBy, pid).filter(r => r.physical_qty != null).map(r => r.item_id))
      const gap = findUncountedItems({ items, openingQty, purchaseQty, purchaseValue, countedIds, cogs })

      return {
        period, openVal, closeVal, grossPurch, discVal, retVal, netPurch, wasteVal, cogs, revenue, fcPct, gap,
        label: `${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}`
      }
    })

    const totRevenue = rows.reduce((s, r) => s + r.revenue, 0)
    const totCogs    = rows.reduce((s, r) => s + r.cogs, 0)
    const totPurch   = rows.reduce((s, r) => s + r.grossPurch, 0)
    const totDisc    = rows.reduce((s, r) => s + r.discVal, 0)
    const totRet     = rows.reduce((s, r) => s + r.retVal, 0)
    const totNetPurch= totPurch - totDisc - totRet
    const totWaste   = rows.reduce((s, r) => s + r.wasteVal, 0)
    const totFcPct   = totRevenue > 0 ? (totCogs / totRevenue) * 100 : null
    // The year's FC% carries every month's uncounted stock, so it is judged on the year's gap as a
    // whole — item-months against item-months, value against the year's COGS (mergeGaps).
    const totGap     = mergeGaps(rows.map(r => r.gap))

    setReport({ rows, totRevenue, totCogs, totPurch, totDisc, totRet, totNetPurch, totWaste, totFcPct, totGap })
    setLoading(false)
  }

  function fmt(v) { return `NPR ${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}` }

  // Client-configured thresholds, same as every other FC% surface (src/shared/imsFormulas.js).
  const fcColor = pct => fcBand(pct, settings).color
  // The band must not be carried by colour alone (S608) — see fcBand's note.
  const fcLabel = pct => fcBand(pct, settings).label
  const fcMark  = pct => fcBand(pct, settings).mark
  // One cell's FC% — banded, or plain with "not judged" while that month's count gap is material (S756 D6).
  const fcCell = (pct, gap) => {
    if (gap?.material) {
      const f = unjudgedFcFigure(pct)
      return { color: f.style.color, title: f.title, text: pct != null ? `${f.text} · not judged` : '—' }
    }
    return { color: fcColor(pct), title: fcLabel(pct), text: pct != null ? `${pct.toFixed(1)}% ${fcMark(pct)}` : '—' }
  }
  // A month's uncounted items are worth naming once counting has begun, or once it is closed; an open
  // month nobody has started counting has every item uncounted, and listing all of them is noise.
  const gapShown = r => r.gap.uncountedCount > 0 && (r.period.status !== 'open' || r.gap.uncountedCount < r.gap.presentCount)

  async function exportExcel() {
    if (!report) return
    const XLSX = await import('xlsx')
    // NUMBERS, not `.toFixed(0)` strings (S756): a string cell does not sum, sort or format in Excel,
    // on the one sheet in IMS whose whole purpose is a year's arithmetic.
    const n0 = v => Math.round(v || 0)
    const xlRows = report.rows.map(r => ({
      'Month':           `${r.label}${r.period.status === 'open' ? ' (open)' : ''}`,
      'Revenue (NPR)':   n0(r.revenue),
      'Gross Purchases': n0(r.grossPurch),
      'Bill Discounts':  n0(r.discVal),
      'Returns':         n0(r.retVal),
      'Net Purchases':   n0(r.netPurch),
      'Wastage':         n0(r.wasteVal),
      'COGS':            n0(r.cogs),
      'FC%':             r.fcPct != null ? Number(r.fcPct.toFixed(1)) : '',
      // Marked in the sheet as on screen (S756 D6), so a mailed workbook keeps the caveat.
      'Closing count':   r.gap.uncountedCount > 0
        ? `${r.gap.uncountedCount} of ${r.gap.presentCount} items not counted${r.gap.material ? ' — FC% not judged' : ''}`
        : 'complete',
    }))
    xlRows.push({
      'Month':           'ANNUAL TOTAL',
      'Revenue (NPR)':   n0(report.totRevenue),
      'Gross Purchases': n0(report.totPurch),
      'Bill Discounts':  n0(report.totDisc),
      'Returns':         n0(report.totRet),
      'Net Purchases':   n0(report.totNetPurch),
      'Wastage':         n0(report.totWaste),
      'COGS':            n0(report.totCogs),
      'FC%':             report.totFcPct != null ? Number(report.totFcPct.toFixed(1)) : '',
      'Closing count':   report.totGap.uncountedCount > 0
        ? `${report.totGap.uncountedCount} item-months not counted${report.totGap.material ? ' — FC% not judged' : ''}`
        : 'complete',
    })
    const yearLabel = fiscalMode ? `FY${selectedYear}-${selectedYear + 1}` : `${selectedYear}BS`
    const first = report.rows[0]?.label
    const last  = report.rows[report.rows.length - 1]?.label
    // Through the shared letterhead with a required scope line (S756) — the sheet was a bare
    // json_to_sheet that named neither the client nor which year, or which months, it covered.
    const scopeLine = `${selectedLabel}: ${first}${last && last !== first ? ` → ${last}` : ''} (${report.rows.length} period${report.rows.length === 1 ? '' : 's'})`
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, sheetWithLetterhead(XLSX, {
      title: 'Annual Summary', biz, scopeLine, rows: xlRows,
      notes: [
        `COGS = ${COGS_FORMULA} · Net Purchases = Gross − bill discounts − returns · Annual FC% = Total COGS ÷ Total Revenue`,
        ...report.rows.filter(r => r.gap.uncountedCount > 0).map(r => gapNote(r.gap, r.label)),
      ],
    }), 'Annual Summary')
    XLSX.writeFile(wb, `Annual-Summary-${yearLabel}.xlsx`)
  }

  const selectedLabel = yearOptions.find(y => y.value === selectedYear)?.label ?? '—'

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Annual Summary</h1>
          <p className="page-subtitle">Full-year rollup</p>
          <div className="page-scope-row">
            {/* No `status`: this is a fiscal year, not a monthly period, and a year has no
                open/closed state of its own to report. */}
            <PeriodScope label={selectedLabel} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
              {[false, true].map(fm => (
                <button key={String(fm)} onClick={() => setFiscalMode(fm)}
                  style={{ padding: '7px 14px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
                    background: fiscalMode === fm ? 'color-mix(in srgb, var(--theme-accent) 15%, transparent)' : 'transparent',
                    color: fiscalMode === fm ? 'var(--theme-accent-ink)' : 'var(--theme-text2)' }}>
                  {fm ? 'Fiscal Year' : 'Calendar Year'}
                </button>
              ))}
            </div>
            <select aria-label="Fiscal year" className="form-select" value={selectedYear ?? ''} onChange={e => setSelectedYear(Number(e.target.value))}>
              {yearOptions.map(y => <option key={y.value} value={y.value}>{y.label}</option>)}
            </select>
          </div>
          {report && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {/* Gated on the load (S728/S756): `report` is the previous year's for the whole of a
                  year change, while the print title, scope line and filename already name the new one. */}
              <button className="btn btn-ghost" style={{ fontSize: 13 }} disabled={loading || !!loadError} onClick={() => printWithTitle(`Annual Summary - ${selectedLabel}`)}>⎙ Print</button>
              <button className="btn btn-ghost" style={{ fontSize: 13 }} disabled={loading || !!loadError || !!biz.error} onClick={exportExcel}
                title={biz.error ? 'Your business details could not be loaded for the letterhead — reload the page to export' : undefined}>Export Excel</button>
            </div>
          )}
        </div>
      </div>

      {loadError && <ReportLoadError error={loadError} />}

      {/* D6 (S756): the months whose COGS counts uncounted stock as used, each with its items behind a
          disclosure. Months are marked in the table below; only their own verdicts are withheld. */}
      {!loading && !loadError && report && report.rows.some(gapShown) && (
        <div role="alert" className="card" style={{ marginBottom: 16, padding: '12px 16px', fontSize: 13, lineHeight: 1.6, color: 'var(--theme-text2)', borderColor: 'color-mix(in srgb, var(--theme-amber) 35%, transparent)', background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)' }}>
          <strong style={{ color: 'var(--theme-amber-text)' }}>
            △ {report.rows.filter(gapShown).length} month{report.rows.filter(gapShown).length === 1 ? ' has' : 's have'} items with no closing count
          </strong>{' '}
          — their COGS counts that stock as used, so food cost reads high. Totals still include them; a month
          whose gap is material shows its FC% without a verdict.
          {report.rows.filter(gapShown).map(r => (
            <details key={r.period.id} style={{ marginTop: 4 }}>
              <summary style={{ cursor: 'pointer' }}>
                {r.label}: {r.gap.uncountedCount} of {r.gap.presentCount} items not counted{r.gap.material ? ' — not judged' : ''}
              </summary>
              {r.gap.uncounted.map(u => u.name).join(', ')}
            </details>
          ))}
        </div>
      )}

      {!loading && !loadError && report && (
        <div className="stat-grid">
          {[
            { label: 'Annual Revenue',  value: fmt(report.totRevenue), color: 'var(--theme-green-text)',
              tip: 'Total net sales revenue across all months in this period.' },
            { label: 'Annual COGS',     value: fmt(report.totCogs),    color: 'var(--theme-accent-ink)',
              tip: `Total Cost of Goods Sold: ${COGS_FORMULA}, summed across all months.` },
            { label: 'Annual FC%',      value: fcCell(report.totFcPct, report.totGap).text,
              color: fcCell(report.totFcPct, report.totGap).color,
              tip: 'Annual COGS ÷ Annual Revenue. More accurate than averaging monthly FC% figures.' },
            { label: 'Annual Wastage',  value: fmt(report.totWaste),   color: 'var(--theme-red-text)',
              tip: 'Total value of stock logged as wastage across all months in this period.' },
          ].map(s => (
            <div key={s.label} className="stat-card">
              <div className="stat-label"><Tip text={s.tip} width={240}>{s.label}</Tip></div>
              <div className="stat-value" style={{ fontSize: 16, color: s.color }}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {!loadError && (
      <div className="card">
        {loading ? (
          <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Building annual report…</p>
        ) : !report || report.rows.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">◻</div>
            <p className="empty-state-text">No periods found for {selectedLabel}.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th style={{ textAlign: 'right' }}>Revenue</th>
                  <th style={{ textAlign: 'right' }}><Tip text="Bill value before any bill-level discount and before returns — what was invoiced." width={230}>Gross Purchases</Tip></th>
                  <th style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}><Tip text="Bill-level discounts, spread across each bill's lines in proportion to line value — the same allocation Monthly Summary and Consolidated P&L use, which is what keeps the three pages' COGS tied." width={260}>Discount</Tip></th>
                  <th style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>Returns</th>
                  <th style={{ textAlign: 'right' }}><Tip text="Gross purchases minus bill discounts minus returns. What COGS is built from." width={240}>Net Purchases</Tip></th>
                  <th style={{ textAlign: 'right' }}>Wastage</th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text={`${COGS_FORMULA}. Ingredient cost consumed this month.`} width={250}>COGS</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text={`COGS ÷ Revenue. Green up to ${fcThresholds(settings).warn}%, amber up to ${fcThresholds(settings).critical}%, red above that — set in Settings → Thresholds. "Not judged" means too much of that month's stock had no closing count (5% of items, or 5% of COGS by value) for a verdict.`} width={260}>FC%</Tip>
                  </th>
                  <th>Trend</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row, i) => {
                  const prev  = report.rows[i - 1]
                  const trend = prev && prev.fcPct != null && row.fcPct != null ? row.fcPct - prev.fcPct : null
                  // A trend into or out of an unjudged month is a verdict built on the same gap.
                  const trendJudged = !row.gap.material && !prev?.gap.material
                  const fc = fcCell(row.fcPct, row.gap)
                  return (
                    <tr key={row.period.id}>
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                        {row.label}
                        {row.period.status === 'open' && (
                          <span style={{ fontSize: 10, marginLeft: 6, color: 'var(--theme-green-text)', fontWeight: 700 }}>OPEN</span>
                        )}
                        {gapShown(row) && (
                          <span className="badge badge-amber" style={{ marginLeft: 6 }} title={`${row.gap.uncountedCount} of ${row.gap.presentCount} items with stock have no closing count`}>
                            {row.gap.uncountedCount} not counted
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-green-text)' }}>{row.revenue > 0 ? fmt(row.revenue) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>{row.grossPurch > 0 ? fmt(row.grossPurch) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{row.discVal > 0 ? `−${fmt(row.discVal)}` : <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{row.retVal > 0 ? `−${fmt(row.retVal)}` : <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>{fmt(row.netPurch)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{row.wasteVal > 0 ? fmt(row.wasteVal) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)' }}>{row.cogs !== 0 ? fmt(row.cogs) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: fc.color }} title={fc.title}>
                        {row.fcPct != null ? fc.text : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                      </td>
                      <td>
                        {/* A flat month used to render a GREEN ↓ 0.0pp — a verdict on a
                            non-movement. PeriodComparison's trendIcon has always had a 0.3pp dead
                            zone; this column did not (S634's dead-zone rule). */}
                        {trend != null && (!trendJudged ? (
                          <span style={{ fontSize: 11, color: 'var(--theme-text2)' }} title="Not judged: this month or the one before has too much uncounted stock">
                            {trend > 0 ? '↑' : trend < 0 ? '↓' : '→'} {Math.abs(trend).toFixed(1)}pp
                          </span>
                        ) : Math.abs(trend) < 0.3 ? (
                          <span style={{ fontSize: 11, color: 'var(--theme-text2)' }} title="Within 0.3pp of last month — no meaningful change">→</span>
                        ) : (
                          <span style={{ fontSize: 11, fontWeight: 700, color: trend > 0 ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
                            {trend > 0 ? '↑' : '↓'} {Math.abs(trend).toFixed(1)}pp
                          </span>
                        ))}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                  <td style={{ fontWeight: 800, color: 'var(--theme-text1)', paddingTop: 14 }}>ANNUAL TOTAL</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-green-text)', paddingTop: 14 }}>{fmt(report.totRevenue)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)', paddingTop: 14 }}>{fmt(report.totPurch)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red-text)', paddingTop: 14 }}>
                    {report.totDisc > 0 ? `−${fmt(report.totDisc)}` : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red-text)', paddingTop: 14 }}>
                    {report.totRet > 0 ? `−${fmt(report.totRet)}` : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)', paddingTop: 14 }}>{fmt(report.totNetPurch)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red-text)', paddingTop: 14 }}>{fmt(report.totWaste)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 800, color: 'var(--theme-accent-ink)', paddingTop: 14, fontSize: 14 }}>{fmt(report.totCogs)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 800, paddingTop: 14, fontSize: 14, color: fcCell(report.totFcPct, report.totGap).color }} title={fcCell(report.totFcPct, report.totGap).title}>
                    {fcCell(report.totFcPct, report.totGap).text}
                  </td>
                  <td style={{ paddingTop: 14 }} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <div style={{ marginTop: 16, fontSize: 12, color: 'var(--theme-text3)' }}>
          COGS = {COGS_FORMULA} · Net Purchases = Gross − bill discounts − returns · Revenue from sales entries · Annual FC% = Total COGS ÷ Total Revenue
        </div>
      </div>
      )}
    </div>
  )
}
