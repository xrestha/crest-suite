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
import { billPayables, summariseUnlinkedReturns, returnLinesOutsidePeriod, priorBillFactors } from './purchaseTaxSplit'
import { applyPriorBillFactors } from './supplierAttribution'
import { readPriorBillLines } from './readPriorBillLines'

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
  const [priorBillLines, setPriorBillLines] = useState([])   // earlier-month bills a return points at (S756, D10)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [viewMode, setViewMode] = useState('summary')

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    setLoadError(null)
    const { data: p, error } = await scopedFrom('monthly_periods').order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
    if (error) { setLoadError(error); setLoading(false); return }
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
    // Only the load that still owns the page may un-gate it (S792, TAX-4). A period picked while
    // this first load was in flight leaves `loadData(chosen)` returning early; clearing `loading`
    // here anyway drew the previous month's figures under the new month's chip and filename.
    if (!chosen || periodReq.isCurrent(chosen.id)) setLoading(false)
  }

  async function handlePeriodChange(periodId) {
    periodReq.begin(periodId)   // claim the page before any await
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setLoading(true)
    await loadData(periodId)
    if (periodReq.isCurrent(periodId)) setLoading(false)   // see init(): only the owner un-gates (TAX-4)
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
    if (failed) { setLoadError(failed); setPurchases([]); setReturns([]); setPriorBillLines([]); return }
    const [{ data: p }, { data: r }] = results

    // S756 (owner decision D10): a return sits in the month the goods went back and may be against a
    // bill from an EARLIER month. That bill is not among this month's purchases, so billPayables has
    // no discount for it and credits the list rate — more money back than was ever paid, and a Net
    // that disagrees with VAT Report for the same month. Read those bills whole, the way VAT and
    // Non-VAT Report do. A failed read is a failed report, never a quiet fall-back to list price.
    const outsideIds = returnLinesOutsidePeriod(p, r)
    let priorLines = []
    if (outsideIds.length > 0) {
      const prior = await readPriorBillLines(outsideIds)
      if (!periodReq.isCurrent(periodId)) return
      if (prior.error) { setLoadError(prior.error); setPurchases([]); setReturns([]); setPriorBillLines([]); return }
      priorLines = prior.data
    }
    setPurchases(p || [])
    setReturns(r || [])
    setPriorBillLines(priorLines)
  }

  // Everything here is BILL-level and is the money owed: net of the bill discount, plus VAT where
  // the line carried it. The old shape summed `qty x rate` per line — ex-VAT AND pre-discount —
  // which is neither the cost basis nor the amount payable, so the Credit column never agreed with
  // Outstanding Payables and no column agreed with the Purchases register. See purchaseTaxSplit.js.
  const { bills, returns: periodPricedReturns } = billPayables(purchases, returns, selectedPeriod)
  // billPayables priced every return against an earlier month's bill at factor 1; scale each by its
  // own bill's discount (VAT rides through the multiplication). Same-month and unlinked returns are
  // untouched. See loadData (S756, D10).
  const pricedReturns = applyPriorBillFactors(periodPricedReturns, purchases, priorBillFactors(priorBillLines))

  // S756 stage 3 — returns whose purchase line is gone (the bill was deleted or re-saved after the
  // return). billPayables still subtracts them from their method, but with no line behind them there
  // is no discount to scale by and no record of VAT, so they are counted at list rate with no VAT
  // added back. VAT and Non-VAT Report name the same rows; this page counted them silently.
  const unlinked = summariseUnlinkedReturns(pricedReturns, {
    dayLabel: r => (r.bs_day ? formatBsDay(r.bs_day, selectedPeriod?.bs_month) : null),
  })
  const unlinkedNote = unlinked.count > 0
    ? `${unlinked.count} return${unlinked.count !== 1 ? 's' : ''} (NPR ${unlinked.value.toFixed(2)}) could not be linked to a purchase bill — the bill was deleted or re-saved after the return — so ${unlinked.count !== 1 ? 'they are' : 'it is'} counted at the price on the return with no VAT added. If VAT was charged, the real refund was higher. ${unlinked.examples.join('; ')}${unlinked.more ? `; and ${unlinked.more} more` : ''}`
    : null

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

  // A method's share of the period's net spend. When returns reach or exceed purchases the total is
  // zero or below, and a share of that means nothing, so it is null and prints as a dash, never 0%.
  const shareOf = v => (grandNet > 0 ? (v / grandNet) * 100 : null)
  const pctText = p => (p == null ? '—' : `${p.toFixed(1)}%`)
  // The totals row adds up the rows above it; its share is computed from them, never asserted
  // (S792, TAX-10). It was a hard-coded "100%", so a month whose returns exceeded its purchases
  // printed 0% on every row above a Total of 100% — the S594/S719/S725 footer, fourth instance.
  const foot = summary.reduce((a, r) => ({
    gross: a.gross + r.gross, returnAmt: a.returnAmt + r.returnAmt, net: a.net + r.net,
    count: a.count + r.count, returnCount: a.returnCount + r.returnCount,
  }), { gross: 0, returnAmt: 0, net: 0, count: 0, returnCount: 0 })
  const footShare = shareOf(foot.net)

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
    const n2 = v => Number(v.toFixed(2))
    const summaryData = summary.map(s => ({
      'Payment Method': s.method,
      'Gross Purchases': n2(s.gross),
      'Returns': n2(s.returnAmt),
      'Net Amount (NPR)': n2(s.net),
      '% of Net Total': pctText(shareOf(s.net)),
      'Bills': s.count,
      'Return Entries': s.returnCount
    }))
    // A TOTAL row on each sheet an accountant reconciles (S792, TAX-9; vendor-payables.md S725),
    // built from the same method totals the page prints, so the sheet ties to the screen.
    summaryData.push({
      'Payment Method': 'TOTAL',
      'Gross Purchases': n2(foot.gross),
      'Returns': n2(foot.returnAmt),
      'Net Amount (NPR)': n2(foot.net),
      '% of Net Total': pctText(footShare),
      'Bills': foot.count,
      'Return Entries': foot.returnCount,
    })
    XLSX.utils.book_append_sheet(wb, sheetWithLetterhead(XLSX, {
      title: 'Payment Summary — Purchase spend by method', biz, scopeLine, rows: summaryData,
      notes: [BASIS_NOTE, ...(unlinkedNote ? [unlinkedNote] : [])],
    }), 'Summary')
    const dailyData = dailyByMethod.map(d => ({
      'Day': d.day,
      ...Object.fromEntries(METHODS.map(m => [`${m} Net (NPR)`, n2(d.byMethod[m])])),
      'Day Total Net (NPR)': n2(d.dayTotal)
    }))
    if (dailyData.length > 0) {
      dailyData.push({
        'Day': 'TOTAL',
        ...Object.fromEntries(summary.map(s => [`${s.method} Net (NPR)`, n2(s.net)])),
        'Day Total Net (NPR)': n2(foot.net),
      })
    }
    XLSX.utils.book_append_sheet(wb, sheetWithLetterhead(XLSX, {
      title: 'Payment Summary — Daily Breakdown', biz, scopeLine, rows: dailyData,
      notes: [BASIS_NOTE, ...(unlinkedNote ? [unlinkedNote] : [])],
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
            {/* provisionalWhenOpen (S792, TAX-10): an open month still moves with every bill and
                return entered, and the scopeLine already says PROVISIONAL in the workbook — the chip
                now says it on screen too, as on VAT, Non-VAT, Vendor Report and the one-lakh report. */}
            <PeriodScope label={periodLabel} status={selectedPeriod?.status} provisionalWhenOpen />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <select aria-label="Period" className="form-select" value={selectedPeriod?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
            {periods.map(p => <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : ''}</option>)}
          </select>
          {/* Gated like every sibling (S792, TAX-5; the S728 rule for a control that emits a FILE).
              It had no gate at all: after a failed read it exported NPR 0 for every method under the
              period's scope line, during a period change the old month's figures under the new
              month's name, and with no outlet name a blank CompanyName line. */}
          <button className="btn btn-ghost" onClick={exportExcel}
            disabled={loading || !!loadError || !!biz.error || !selectedPeriod}>Export Excel</button>
        </div>
      </div>

      {biz.error && (
        <p role="alert" className="no-print" style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
          This outlet's name could not be loaded, so Excel is switched off rather than exporting a sheet
          with a blank company name. The report below is unaffected. Reload the page to try again.
        </p>
      )}

      {loadError && <ReportLoadError error={loadError} />}

      {/* The VAT/Non-VAT banner's shape, with this page's own consequence: here the rows ARE counted. */}
      {!loadError && !loading && unlinked.count > 0 && (
        <div role="alert" className="card" style={{
          marginBottom: 16, padding: '12px 16px',
          borderColor: 'color-mix(in srgb, var(--theme-amber) 35%, transparent)',
          background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)',
        }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--theme-amber-text)' }}>
            ⚠ {unlinked.count} return{unlinked.count !== 1 ? 's are' : ' is'} counted without VAT — NPR {unlinked.value.toLocaleString('en-IN', { maximumFractionDigits: 0 })} at the price on the return
          </p>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
            The bill {unlinked.count !== 1 ? 'these were' : 'this was'} returned against was deleted or re-saved afterwards, so there is
            no record left of its discount or of whether VAT was charged. {unlinked.count !== 1 ? 'They are' : 'It is'} still taken
            off {unlinked.count !== 1 ? 'their' : 'its'} payment method below, but with no VAT added — if the supplier charged VAT, the
            real refund was higher and the Net figures read a little high. {unlinked.examples.join('; ')}
            {unlinked.more ? `; and ${unlinked.more} more` : ''}.
          </p>
        </div>
      )}

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
            <Tip text="Value of goods returned to suppliers, subtracted from gross to get net spend — credited at the price actually paid: net of the bill's discount, plus VAT where charged. A return against a bill from an earlier month is credited at that bill's own discount." width={270}>Total Returns</Tip>
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
              {pctText(shareOf(s.net))} · {s.count} entries
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
                    <Tip text="This method's net spend as a share of total net purchases. Shows — in a month where returns match or exceed purchases, because a share of nothing means nothing." width={250}>% of Net Total</Tip>
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
                      {pctText(shareOf(s.net))}
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
                  <td style={{ textAlign: 'right', paddingTop: 12 }}>{pctText(footShare)}</td>
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
              {/* The month's total (S792, TAX-9). The daily tab had none, on screen or in the
                  workbook, so the only way to tie it to the Method Summary was to add it up by hand.
                  Built from the same method totals, so the two tabs cannot disagree. */}
              {dailyByMethod.length > 0 && (
                <tfoot>
                  <tr>
                    <td>TOTAL</td>
                    {summary.map(s => (
                      <td key={s.method} style={{ textAlign: 'right' }}>
                        {s.net !== 0 ? `NPR ${s.net.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}
                      </td>
                    ))}
                    <td style={{ textAlign: 'right' }}>NPR {foot.net.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                  </tr>
                </tfoot>
              )}
            </table>
            </div>
          )}
      </div>
      </>
      )}
    </div>
  )
}
