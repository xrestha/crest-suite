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

  const [allPeriods, setAllPeriods]     = useState([])
  const [fiscalMode, setFiscalMode]     = useState(false)
  const [yearOptions, setYearOptions]   = useState([])
  const [selectedYear, setSelectedYear] = useState(null)
  const [report, setReport]             = useState(null)
  const [loading, setLoading]           = useState(true)
  const [loadError, setLoadError]       = useState(null)

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line
  useEffect(() => { if (allPeriods.length) rebuildYearOptions() }, [allPeriods, fiscalMode]) // eslint-disable-line
  useEffect(() => { if (selectedYear !== null && allPeriods.length) buildReport() }, [selectedYear, allPeriods]) // eslint-disable-line

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
    const key = yearReq.begin(selectedYear)   // claim the page before any await (S601)
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
      fetchAllRows(() => scopedFrom('items', 'id, per_uom_rate').eq('is_active', true).eq('is_sub_recipe', false).order('id')),
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
      // Revenue excludes comps (source='pos_comp') — a comped dish was never paid for.
      fetchAllRows(() => supabase.from('sales_entries').select('period_id, recipe_id, qty_sold, unit_price, discount').in('period_id', periodIds).neq('source', 'pos_comp').order('id')),
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
    const salesBy  = byPeriod(sales)
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

      return {
        period, openVal, closeVal, grossPurch, discVal, retVal, netPurch, wasteVal, cogs, revenue, fcPct,
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

    setReport({ rows, totRevenue, totCogs, totPurch, totDisc, totRet, totNetPurch, totWaste, totFcPct })
    setLoading(false)
  }

  function fmt(v) { return `NPR ${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}` }

  // Client-configured thresholds, same as every other FC% surface (src/shared/imsFormulas.js).
  const fcColor = pct => fcBand(pct, settings).color
  // The band must not be carried by colour alone (S608) — see fcBand's note.
  const fcLabel = pct => fcBand(pct, settings).label
  const fcMark  = pct => fcBand(pct, settings).mark

  async function exportExcel() {
    if (!report) return
    const XLSX = await import('xlsx')
    const xlRows = report.rows.map(r => ({
      'Month':           r.label,
      'Revenue (NPR)':   r.revenue.toFixed(0),
      'Gross Purchases': r.grossPurch.toFixed(0),
      'Bill Discounts':  r.discVal.toFixed(0),
      'Returns':         r.retVal.toFixed(0),
      'Net Purchases':   r.netPurch.toFixed(0),
      'Wastage':         r.wasteVal.toFixed(0),
      'COGS':            r.cogs.toFixed(0),
      'FC%':             r.fcPct != null ? r.fcPct.toFixed(1) : '',
    }))
    xlRows.push({
      'Month':           'ANNUAL TOTAL',
      'Revenue (NPR)':   report.totRevenue.toFixed(0),
      'Gross Purchases': report.totPurch.toFixed(0),
      'Bill Discounts':  report.totDisc.toFixed(0),
      'Returns':         report.totRet.toFixed(0),
      'Net Purchases':   report.totNetPurch.toFixed(0),
      'Wastage':         report.totWaste.toFixed(0),
      'COGS':            report.totCogs.toFixed(0),
      'FC%':             report.totFcPct != null ? report.totFcPct.toFixed(1) : '',
    })
    const yearLabel = fiscalMode ? `FY${selectedYear}-${selectedYear + 1}` : `${selectedYear}BS`
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(xlRows), 'Annual Summary')
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
              <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => printWithTitle(`Annual Summary - ${selectedLabel}`)}>⎙ Print</button>
              <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={exportExcel}>Export Excel</button>
            </div>
          )}
        </div>
      </div>

      {loadError && <ReportLoadError error={loadError} />}

      {!loading && !loadError && report && (
        <div className="stat-grid">
          {[
            { label: 'Annual Revenue',  value: fmt(report.totRevenue), color: 'var(--theme-green-text)',
              tip: 'Total net sales revenue across all months in this period.' },
            { label: 'Annual COGS',     value: fmt(report.totCogs),    color: 'var(--theme-accent-ink)',
              tip: `Total Cost of Goods Sold: ${COGS_FORMULA}, summed across all months.` },
            { label: 'Annual FC%',      value: report.totFcPct != null ? `${report.totFcPct.toFixed(1)}% ${fcMark(report.totFcPct)}` : '—',
              color: fcColor(report.totFcPct),
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
                    <Tip text={`COGS ÷ Revenue. Green up to ${fcThresholds(settings).warn}%, amber up to ${fcThresholds(settings).critical}%, red above that — set in Settings → Thresholds.`} width={250}>FC%</Tip>
                  </th>
                  <th>Trend</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row, i) => {
                  const prev  = report.rows[i - 1]
                  const trend = prev && prev.fcPct != null && row.fcPct != null ? row.fcPct - prev.fcPct : null
                  return (
                    <tr key={row.period.id}>
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                        {row.label}
                        {row.period.status === 'open' && (
                          <span style={{ fontSize: 10, marginLeft: 6, color: 'var(--theme-green-text)', fontWeight: 700 }}>OPEN</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-green-text)' }}>{row.revenue > 0 ? fmt(row.revenue) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>{row.grossPurch > 0 ? fmt(row.grossPurch) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{row.discVal > 0 ? `−${fmt(row.discVal)}` : <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{row.retVal > 0 ? `−${fmt(row.retVal)}` : <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>{fmt(row.netPurch)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{row.wasteVal > 0 ? fmt(row.wasteVal) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)' }}>{row.cogs !== 0 ? fmt(row.cogs) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: fcColor(row.fcPct) }} title={fcLabel(row.fcPct)}>
                        {row.fcPct != null ? `${row.fcPct.toFixed(1)}% ${fcMark(row.fcPct)}` : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                      </td>
                      <td>
                        {/* A flat month used to render a GREEN ↓ 0.0pp — a verdict on a
                            non-movement. PeriodComparison's trendIcon has always had a 0.3pp dead
                            zone; this column did not (S634's dead-zone rule). */}
                        {trend != null && (Math.abs(trend) < 0.3 ? (
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
                  <td style={{ textAlign: 'right', fontWeight: 800, paddingTop: 14, fontSize: 14, color: fcColor(report.totFcPct) }} title={fcLabel(report.totFcPct)}>
                    {report.totFcPct != null ? `${report.totFcPct.toFixed(1)}% ${fcMark(report.totFcPct)}` : '—'}
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
