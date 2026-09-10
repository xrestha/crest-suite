import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import PeriodScope from '../../../components/PeriodScope'
import ReportLoadError from '../../../components/ReportLoadError'
import { Navigate } from 'react-router-dom'
import NoPeriodState from '../../../components/NoPeriodState'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { BS_MONTHS, formatBsDay } from '../../../utils/bsCalendar'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'
import { PURCHASE_PAYMENT_METHODS } from '../purchases/purchasesHelpers'
import { billPayables } from './purchaseTaxSplit'

const METHODS = PURCHASE_PAYMENT_METHODS
// Two roles, two values: the base token is the FILL (split bar, legend swatch), the -text variant
// is the TEXT (the KPI figure). One value cannot do both — the base tokens fail AA as text on all
// a light preset. Note these are semantic here, not a series palette: Cash/Credit/FonePay
// genuinely mean paid / owed / digital.
// METHODS now tracks PURCHASE_PAYMENT_METHODS rather than a local literal, so these maps can fall
// behind it. A method with no entry would otherwise paint a transparent segment in the split bar
// and an invisible legend swatch — silent, and only on the newest method. Neutral is the floor.
const METHOD_COLORS = { Cash: 'var(--theme-green)', Credit: 'var(--theme-red)', FonePay: 'var(--theme-purple)' }
const METHOD_TEXT   = { Cash: 'var(--theme-green-text)', Credit: 'var(--theme-red-text)', FonePay: 'var(--theme-purple-text)' }
const fillOf = m => METHOD_COLORS[m] || 'var(--theme-text3)'
const textOf = m => METHOD_TEXT[m] || METHOD_COLORS[m] || 'var(--theme-text1)'

export default function PaymentReport() {
  const { clientId, profile, loading: authLoading, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const biz = useBizInfo()
  const periodReq = useLatestRequest()
  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [purchases, setPurchases] = useState([])
  const [returns, setReturns] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [viewMode, setViewMode] = useState('summary')

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    setLoadError(null)
    const { data: p, error } = await scopedFrom('monthly_periods').order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
    if (error) { setLoadError(error.message); setLoading(false); return }
    const list = p || []
    setPeriods(list)
    // Prefer the open period, but FALL BACK to the most recent one. With only closed periods this
    // selected nothing, loaded nothing, and still rendered the full stat grid and summary table —
    // every figure NPR 0, the total row confidently reading 100%, and PeriodScope showing "—".
    // A client between periods saw a complete report of a month that was never chosen.
    const chosen = list.find(x => x.status === 'open') || list[0]
    if (chosen) {
      periodReq.begin(chosen.id)   // an init() that auto-selects must claim the page too
      setSelectedPeriod(chosen)
      await loadData(chosen.id)
    }
    setLoading(false)
  }

  async function handlePeriodChange(periodId) {
    periodReq.begin(periodId)   // claim the page before any await
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setLoading(true)
    await loadData(periodId)
    setLoading(false)
  }

  async function loadData(periodId) {
    setLoadError(null)
    const results = await Promise.all([
      fetchAllRows(() => supabase.from('purchase_entries').select('*, items(name, categories(name)), vendors(name)').eq('period_id', periodId).order('bs_day').order('id')),
      // purchase_entries(vat_inclusive) is what tells a return whether the money coming back
      // carried VAT — vendor_returns has no column of its own for it.
      fetchAllRows(() => scopedFrom('vendor_returns', '*, items(name), vendors(name), purchase_entries(vat_inclusive)').eq('period_id', periodId).order('bs_day').order('id'))
    ])
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    // A failed read must not render as a quiet period of NPR 0 (S612 silent-zero rule).
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setPurchases([]); setReturns([]); return }
    const [{ data: p }, { data: r }] = results
    setPurchases(p || [])
    setReturns(r || [])
  }

  // Everything here is BILL-level and is the money owed: net of the bill discount, plus VAT where
  // the line carried it. The old shape summed `qty x rate` per line — ex-VAT AND pre-discount —
  // which is neither the cost basis nor the amount payable, so the Credit column never agreed with
  // Outstanding Payables and no column agreed with the Purchases register. See purchaseTaxSplit.js.
  const { bills, returns: pricedReturns } = billPayables(purchases, returns, selectedPeriod)

  const summary = METHODS.map(method => {
    const mb = bills.filter(b => b.method === method)
    const mr = pricedReturns.filter(r => r.method === method)
    const gross = mb.reduce((s, b) => s + b.total, 0)
    const returnAmt = mr.reduce((s, r) => s + r.value, 0)
    return { method, gross, returnAmt, net: gross - returnAmt, count: mb.length, returnCount: mr.length }
  })

  const grandGross  = summary.reduce((s, r) => s + r.gross, 0)
  const grandReturn = summary.reduce((s, r) => s + r.returnAmt, 0)
  const grandNet    = grandGross - grandReturn

  // Daily breakdown (net per day per method). A bill has one day — its header's — so it lands
  // whole on that day rather than being spread across its lines.
  const days = [...new Set([...bills.map(b => b.bs_day), ...pricedReturns.map(r => r.bs_day)])].sort((a, b) => a - b)
  const dailyByMethod = days.map(day => {
    const dayBills = bills.filter(b => b.bs_day === day)
    const dayRets  = pricedReturns.filter(r => r.bs_day === day)
    const byMethod = {}
    METHODS.forEach(m => {
      byMethod[m] = dayBills.filter(b => b.method === m).reduce((s, b) => s + b.total, 0)
                  - dayRets.filter(r => r.method === m).reduce((s, r) => s + r.value, 0)
    })
    const dayGross  = dayBills.reduce((s, b) => s + b.total, 0)
    const dayReturn = dayRets.reduce((s, r) => s + r.value, 0)
    return { day, byMethod, dayTotal: dayGross - dayReturn, dayGross, dayReturn }
  })

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : '—'
  const scopeLine = `Period : ${periodLabel}${selectedPeriod?.status === 'open'
    ? ' (PROVISIONAL — period still open, figures can change)'
    : ' (period closed)'}`
  const BASIS_NOTE = 'Amounts are bill totals: net of bill discount, including VAT where charged — the same basis as the Purchases register and Outstanding Payables.'

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    const summaryData = summary.map(s => ({
      'Payment Method': s.method,
      'Gross Purchases': Number(s.gross.toFixed(2)),
      'Returns': Number(s.returnAmt.toFixed(2)),
      'Net Amount (NPR)': Number(s.net.toFixed(2)),
      '% of Net Total': grandNet > 0 ? ((s.net / grandNet) * 100).toFixed(1) + '%' : '0%',
      'Bills': s.count,
      'Return Entries': s.returnCount
    }))
    XLSX.utils.book_append_sheet(wb, sheetWithLetterhead(XLSX, {
      title: 'Payment Summary — Purchase spend by method', biz, scopeLine, rows: summaryData,
      notes: [BASIS_NOTE],
    }), 'Summary')
    const dailyData = dailyByMethod.map(d => ({
      'Day': d.day,
      ...Object.fromEntries(METHODS.map(m => [`${m} Net (NPR)`, Number(d.byMethod[m].toFixed(2))])),
      'Day Total Net (NPR)': Number(d.dayTotal.toFixed(2))
    }))
    XLSX.utils.book_append_sheet(wb, sheetWithLetterhead(XLSX, {
      title: 'Payment Summary — Daily Breakdown', biz, scopeLine, rows: dailyData,
      notes: [BASIS_NOTE],
    }), 'Daily Breakdown')
    XLSX.writeFile(wb, `Payment-Report-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />
  if (!loading && !loadError && periods.length === 0) return <NoPeriodState what="the payment report" />

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Payment Summary</h1>
          <p className="page-subtitle">Purchase spend by payment method — bill totals, net of discount and returns, including VAT</p>
          <div className="page-scope-row">
            <PeriodScope label={periodLabel} status={selectedPeriod?.status} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <select aria-label="Period" className="form-select" value={selectedPeriod?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
            {periods.map(p => <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : ''}</option>)}
          </select>
          <button className="btn btn-ghost" onClick={exportExcel}>Export Excel</button>
        </div>
      </div>

      {loadError && <ReportLoadError error={loadError} />}

      {/* Summary cards — gated on !loading too: a stat computed from rows that have not arrived
          is NPR 0 wearing the confidence of a real figure (S594 rule). */}
      {!loadError && !loading && (
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Total billed by suppliers this period, before returns: bill totals net of discount and including VAT where charged. This is money owed to suppliers — not sales revenue. It ties to the Purchases register and to Outstanding Payables." width={280}>Gross Purchases</Tip>
          </div>
          <div className="stat-value gold" style={{ fontSize: 17 }}>NPR {grandGross.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Value of goods returned to suppliers, subtracted from gross to get net spend." width={250}>Total Returns</Tip>
          </div>
          <div className="stat-value" style={{ fontSize: 17, color: 'var(--theme-red-text)' }}>
            {grandReturn > 0 ? `−NPR ${grandReturn.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}
          </div>
        </div>
        {summary.map(s => (
          <div key={s.method} className="stat-card">
            <div className="stat-label">
              <Tip text={`Net purchase spend settled by ${s.method} this period: bill totals net of discount and returns, including VAT.${s.method === 'Credit' ? ' Credit is billed but not yet paid — Outstanding Payables tracks what is still owed.' : ''}`} width={260}>{s.method} (Net)</Tip>
            </div>
            <div className="stat-value" style={{ fontSize: 17, color: textOf(s.method) }}>
              NPR {s.net.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </div>
            <div className="stat-sub">
              {grandNet > 0 ? ((s.net / grandNet) * 100).toFixed(1) : 0}% · {s.count} entries
              {s.returnCount > 0 && ` · ${s.returnCount} return${s.returnCount > 1 ? 's' : ''}`}
            </div>
          </div>
        ))}
      </div>
      )}

      {/* Visual split */}
      {!loadError && !loading && grandNet > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 10 }}>Payment Method Split (Net)</div>
          <div style={{ display: 'flex', height: 20, borderRadius: 'var(--radius-sm)', overflow: 'hidden', gap: 2 }}>
            {summary.filter(s => s.net > 0).map(s => (
              <div key={s.method} style={{
                width: `${(s.net / grandNet) * 100}%`,
                background: fillOf(s.method),
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }} title={`${s.method}: ${((s.net / grandNet) * 100).toFixed(1)}%`}>
                {/* The percentage moved to the legend below: on the fill it was --theme-bg on a
                    signal colour, 3.14:1 on Rosé Dawn, and there is no one foreground that works
                    on green, red and purple across both presets. */}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
            {summary.map(s => (
              <div key={s.method} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 10, height: 10, borderRadius: 'var(--radius-xs)', background: fillOf(s.method) }} />
                <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{s.method}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--theme-text1)' }}>
                  {grandNet > 0 ? `${((s.net / grandNet) * 100).toFixed(1)}%` : '—'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tabs */}
      {!loadError && (
      <>
      <div className="panel-tab-bar" role="tablist" aria-label="Payment report views">
        {['summary', 'daily'].map(m => (
          <button key={m} type="button" role="tab" aria-selected={viewMode === m}
            className={`panel-tab${viewMode === m ? ' panel-tab--active' : ''}`}
            onClick={() => setViewMode(m)}>{m === 'summary' ? 'Method Summary' : 'Daily Breakdown'}</button>
        ))}
      </div>

      <div className="card">
        {loading ? <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p> :
          viewMode === 'summary' ? (
            <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Payment Method</th>
                  <th style={{ textAlign: 'right' }}>Gross Purchases</th>
                  <th style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>Returns</th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Gross purchases − returns for this method." width={220}>Net Amount</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="This method's net spend as a share of total net purchases." width={230}>% of Net Total</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Number of supplier bills settled by this method. A bill is counted once however many lines it has." width={250}>Bills</Tip>
                  </th>
                </tr>
              </thead>
              <tbody>
                {summary.map(s => (
                  <tr key={s.method}>
                    <td style={{ fontWeight: 600, color: textOf(s.method) }}>{s.method}</td>
                    <td style={{ textAlign: 'right' }}>NPR {s.gross.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>
                      {s.returnAmt > 0 ? `−NPR ${s.returnAmt.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>NPR {s.net.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                      {grandNet > 0 ? ((s.net / grandNet) * 100).toFixed(1) : 0}%
                    </td>
                    <td style={{ textAlign: 'right' }}>{s.count}</td>
                  </tr>
                ))}
                <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                  <td style={{ fontWeight: 700, paddingTop: 12 }}>Total</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, paddingTop: 12 }}>NPR {grandGross.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red-text)', paddingTop: 12 }}>
                    {grandReturn > 0 ? `−NPR ${grandReturn.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)', paddingTop: 12 }}>NPR {grandNet.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                  <td style={{ textAlign: 'right', paddingTop: 12 }}>100%</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, paddingTop: 12 }}>{bills.length}</td>
                </tr>
              </tbody>
            </table>
            </div>
          ) : (
            <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Day</th>
                  {METHODS.map(m => <th key={m} style={{ textAlign: 'right', color: textOf(m) }}>{m} (Net)</th>)}
                  <th style={{ textAlign: 'right' }}>Day Total</th>
                </tr>
              </thead>
              <tbody>
                {dailyByMethod.map(d => (
                  <tr key={d.day}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-accent-ink)', whiteSpace: 'nowrap' }}>{formatBsDay(d.day, selectedPeriod?.bs_month)}</td>
                    {METHODS.map(m => (
                      <td key={m} style={{ textAlign: 'right', color: d.byMethod[m] !== 0 ? textOf(m) : 'var(--theme-text3)' }}>
                        {d.byMethod[m] !== 0 ? `NPR ${d.byMethod[m].toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}
                      </td>
                    ))}
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>NPR {d.dayTotal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
      </div>
      </>
      )}
    </div>
  )
}
