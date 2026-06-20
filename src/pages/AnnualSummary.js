import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import Tip from '../components/Tip'
import * as XLSX from 'xlsx'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

// Nepal fiscal year starts Shrawan (month 4)
// bs_month >= 4 → fiscal year = bs_year; else fiscal year = bs_year - 1
function getFiscalYear(bs_year, bs_month) {
  return bs_month >= 4 ? bs_year : bs_year - 1
}

export default function AnnualSummary() {
  const { clientId, profile, loading: authLoading } = useAuth()
  const effectiveClientId = clientId || profile?.client_id

  const [allPeriods, setAllPeriods]     = useState([])
  const [fiscalMode, setFiscalMode]     = useState(false)
  const [yearOptions, setYearOptions]   = useState([])
  const [selectedYear, setSelectedYear] = useState(null)
  const [report, setReport]             = useState(null)
  const [loading, setLoading]           = useState(true)

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line
  useEffect(() => { if (allPeriods.length) rebuildYearOptions() }, [allPeriods, fiscalMode]) // eslint-disable-line
  useEffect(() => { if (selectedYear !== null && allPeriods.length) buildReport() }, [selectedYear, allPeriods]) // eslint-disable-line

  async function init() {
    setLoading(true)
    const { data: p } = await supabase
      .from('monthly_periods').select('*')
      .eq('client_id', effectiveClientId)
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
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
    setLoading(true)

    const yearPeriods = allPeriods.filter(p =>
      fiscalMode
        ? getFiscalYear(p.bs_year, p.bs_month) === selectedYear
        : p.bs_year === selectedYear
    ).sort((a, b) => a.bs_year - b.bs_year || a.bs_month - b.bs_month)

    if (!yearPeriods.length) { setReport(null); setLoading(false); return }
    const periodIds = yearPeriods.map(p => p.id)

    const [
      { data: items }, { data: opening }, { data: closing },
      { data: purchases }, { data: returns }, { data: wastages },
      { data: sales }, { data: recipes }
    ] = await Promise.all([
      supabase.from('items').select('id, per_uom_rate').eq('client_id', effectiveClientId).eq('is_active', true),
      supabase.from('opening_stock').select('period_id, item_id, qty').in('period_id', periodIds),
      supabase.from('closing_stock').select('period_id, item_id, physical_qty').in('period_id', periodIds),
      supabase.from('purchase_entries').select('period_id, item_id, qty, rate').in('period_id', periodIds),
      supabase.from('vendor_returns').select('period_id, item_id, qty, rate').in('period_id', periodIds),
      supabase.from('wastages').select('period_id, item_id, qty').in('period_id', periodIds),
      supabase.from('sales_entries').select('period_id, recipe_id, qty_sold').in('period_id', periodIds),
      supabase.from('recipes').select('id, selling_price').eq('client_id', effectiveClientId),
    ])

    const rateMap = {}
    ;(items || []).forEach(i => { rateMap[i.id] = parseFloat(i.per_uom_rate || 0) })
    const recipeMap = {}
    ;(recipes || []).forEach(r => { recipeMap[r.id] = parseFloat(r.selling_price || 0) })

    const rows = yearPeriods.map(period => {
      const pid = period.id

      const openVal   = (opening   || []).filter(r => r.period_id === pid).reduce((s, r) => s + parseFloat(r.qty)          * (rateMap[r.item_id] || 0), 0)
      const closeVal  = (closing   || []).filter(r => r.period_id === pid).reduce((s, r) => s + parseFloat(r.physical_qty) * (rateMap[r.item_id] || 0), 0)
      const grossPurch= (purchases || []).filter(r => r.period_id === pid).reduce((s, r) => s + parseFloat(r.qty) * parseFloat(r.rate), 0)
      const retVal    = (returns   || []).filter(r => r.period_id === pid).reduce((s, r) => s + parseFloat(r.qty) * parseFloat(r.rate), 0)
      const netPurch  = grossPurch - retVal
      const wasteVal  = (wastages  || []).filter(r => r.period_id === pid).reduce((s, r) => s + parseFloat(r.qty) * (rateMap[r.item_id] || 0), 0)
      const cogs      = openVal + netPurch - wasteVal - closeVal
      const revenue   = (sales    || []).filter(r => r.period_id === pid).reduce((s, r) => s + parseFloat(r.qty_sold) * (recipeMap[r.recipe_id] || 0), 0)
      const fcPct     = revenue > 0 ? (cogs / revenue) * 100 : null

      return {
        period, openVal, closeVal, grossPurch, retVal, netPurch, wasteVal, cogs, revenue, fcPct,
        label: `${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}`
      }
    })

    const totRevenue = rows.reduce((s, r) => s + r.revenue, 0)
    const totCogs    = rows.reduce((s, r) => s + r.cogs, 0)
    const totPurch   = rows.reduce((s, r) => s + r.grossPurch, 0)
    const totRet     = rows.reduce((s, r) => s + r.retVal, 0)
    const totWaste   = rows.reduce((s, r) => s + r.wasteVal, 0)
    const totFcPct   = totRevenue > 0 ? (totCogs / totRevenue) * 100 : null

    setReport({ rows, totRevenue, totCogs, totPurch, totRet, totWaste, totFcPct })
    setLoading(false)
  }

  function fmt(v) { return `NPR ${Number(v).toLocaleString('en-NP', { maximumFractionDigits: 0 })}` }

  function fcColor(pct) {
    if (pct == null) return '#6b7280'
    if (pct <= 35) return '#34d399'
    if (pct <= 45) return '#c9a84c'
    return '#f87171'
  }

  function exportExcel() {
    if (!report) return
    const xlRows = report.rows.map(r => ({
      'Month':           r.label,
      'Revenue (NPR)':   r.revenue.toFixed(0),
      'Gross Purchases': r.grossPurch.toFixed(0),
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
      'Returns':         report.totRet.toFixed(0),
      'Net Purchases':   (report.totPurch - report.totRet).toFixed(0),
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

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Annual Summary</h1>
          <p className="page-subtitle">Full-year rollup — {selectedLabel}</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 6, overflow: 'hidden' }}>
            {[false, true].map(fm => (
              <button key={String(fm)} onClick={() => setFiscalMode(fm)}
                style={{ padding: '7px 14px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
                  background: fiscalMode === fm ? 'rgba(201,168,76,0.15)' : 'transparent',
                  color: fiscalMode === fm ? '#c9a84c' : '#6b7280' }}>
                {fm ? 'Fiscal Year' : 'Calendar Year'}
              </button>
            ))}
          </div>
          <select className="form-select" value={selectedYear ?? ''} onChange={e => setSelectedYear(Number(e.target.value))}>
            {yearOptions.map(y => <option key={y.value} value={y.value}>{y.label}</option>)}
          </select>
          {report && <>
            <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => window.print()}>⎙ Print</button>
            <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={exportExcel}>↓ Excel</button>
          </>}
        </div>
      </div>

      {report && (
        <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 24 }}>
          {[
            { label: 'Annual Revenue',  value: fmt(report.totRevenue), color: '#34d399',
              tip: 'Total net sales revenue across all months in this period.' },
            { label: 'Annual COGS',     value: fmt(report.totCogs),    color: '#c9a84c',
              tip: 'Total Cost of Goods Sold: Opening + Net Purchases − Wastage − Closing, summed across all months.' },
            { label: 'Annual FC%',      value: report.totFcPct != null ? `${report.totFcPct.toFixed(1)}%` : '—',
              color: fcColor(report.totFcPct),
              tip: 'Annual COGS ÷ Annual Revenue. More accurate than averaging monthly FC% figures.' },
            { label: 'Annual Wastage',  value: fmt(report.totWaste),   color: '#f87171',
              tip: 'Total value of stock logged as wastage across all months in this period.' },
          ].map(s => (
            <div key={s.label} className="stat-card">
              <div className="stat-label"><Tip text={s.tip} width={240}>{s.label}</Tip></div>
              <div className="stat-value" style={{ fontSize: 16, color: s.color }}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        {loading ? (
          <p style={{ color: '#6b7280', fontSize: 13 }}>Building annual report…</p>
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
                  <th style={{ textAlign: 'right' }}>Gross Purchases</th>
                  <th style={{ textAlign: 'right', color: '#f87171' }}>Returns</th>
                  <th style={{ textAlign: 'right' }}>Net Purchases</th>
                  <th style={{ textAlign: 'right' }}>Wastage</th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Opening + Net Purchases − Wastage − Closing. Ingredient cost consumed this month." width={240}>COGS</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="COGS ÷ Revenue. Green ≤35%, amber 36–45%, red >45%." width={200}>FC%</Tip>
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
                      <td style={{ fontWeight: 600, color: '#e8e0d0' }}>
                        {row.label}
                        {row.period.status === 'open' && (
                          <span style={{ fontSize: 10, marginLeft: 6, color: '#34d399', fontWeight: 700 }}>OPEN</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', color: '#34d399' }}>{row.revenue > 0 ? fmt(row.revenue) : <span style={{ color: '#374151' }}>—</span>}</td>
                      <td style={{ textAlign: 'right', color: '#c9a84c' }}>{row.grossPurch > 0 ? fmt(row.grossPurch) : <span style={{ color: '#374151' }}>—</span>}</td>
                      <td style={{ textAlign: 'right', color: '#f87171' }}>{row.retVal > 0 ? `−${fmt(row.retVal)}` : <span style={{ color: '#374151' }}>—</span>}</td>
                      <td style={{ textAlign: 'right', color: '#c9a84c' }}>{row.netPurch !== 0 ? fmt(row.netPurch) : <span style={{ color: '#374151' }}>—</span>}</td>
                      <td style={{ textAlign: 'right', color: '#f87171' }}>{row.wasteVal > 0 ? fmt(row.wasteVal) : <span style={{ color: '#374151' }}>—</span>}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: '#e8e0d0' }}>{row.cogs !== 0 ? fmt(row.cogs) : <span style={{ color: '#374151' }}>—</span>}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: fcColor(row.fcPct) }}>
                        {row.fcPct != null ? `${row.fcPct.toFixed(1)}%` : <span style={{ color: '#374151' }}>—</span>}
                      </td>
                      <td>
                        {trend != null && (
                          <span style={{ fontSize: 11, fontWeight: 700, color: trend > 0 ? '#f87171' : '#34d399' }}>
                            {trend > 0 ? '↑' : '↓'} {Math.abs(trend).toFixed(1)}pp
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid #2a2f3d' }}>
                  <td style={{ fontWeight: 800, color: '#e8e0d0', paddingTop: 14 }}>ANNUAL TOTAL</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: '#34d399', paddingTop: 14 }}>{fmt(report.totRevenue)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: '#c9a84c', paddingTop: 14 }}>{fmt(report.totPurch)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: '#f87171', paddingTop: 14 }}>
                    {report.totRet > 0 ? `−${fmt(report.totRet)}` : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: '#c9a84c', paddingTop: 14 }}>{fmt(report.totPurch - report.totRet)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: '#f87171', paddingTop: 14 }}>{fmt(report.totWaste)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 800, color: '#c9a84c', paddingTop: 14, fontSize: 15 }}>{fmt(report.totCogs)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 800, paddingTop: 14, fontSize: 15, color: fcColor(report.totFcPct) }}>
                    {report.totFcPct != null ? `${report.totFcPct.toFixed(1)}%` : '—'}
                  </td>
                  <td style={{ paddingTop: 14 }} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <div style={{ marginTop: 16, fontSize: 12, color: '#9ca3af' }}>
          COGS = Opening + (Purchases − Returns) − Wastage − Closing · Revenue from sales entries · Annual FC% = Total COGS ÷ Total Revenue
        </div>
      </div>
    </div>
  )
}
