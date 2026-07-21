import { useState, useEffect, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import { TriangleAlert } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { supabase } from '../../supabaseClient'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { BS_MONTHS } from '../../utils/bsCalendar'
import SuiteGate from '../../components/SuiteGate'
import Tip from '../../components/Tip'
import { printWithTitle } from '../../utils/printTitle'
import { generateMonthlyReport, saveGeneratedReport, regenerateReport } from '../../modules/ownerReport/generateMonthlyReport'
import { exportMonthlyReportExcel } from '../../modules/ownerReport/monthlyReportExcel'
import { buildExecutiveSummary } from '../../modules/ownerReport/reportNarrative'

const fmt = n => (n == null ? '—' : `NPR ${Math.round(n).toLocaleString('en-NP')}`)
const pct = n => (n == null ? '—' : `${n.toFixed(1)}%`)
const num = n => (n == null ? '—' : Math.round(n).toLocaleString('en-NP'))

const sectionTitleStyle = {
  fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
  color: 'var(--theme-accent)', margin: '0 0 10px', paddingBottom: 6, borderBottom: '1px solid var(--theme-border-lt)',
}

// A two-column "Label ... Value" line item — the document convention used throughout this
// report instead of dashboard-style KPI tiles (see CLAUDE.md's Monthly Owner/Manager Report
// section for why: a frozen artifact meant to be read/printed as a report, not glanced at live).
function Row({ label, value, tip, color }) {
  return (
    <tr>
      <td style={{ color: 'var(--theme-text2)' }}>{tip ? <Tip text={tip} width={260}>{label}</Tip> : label}</td>
      <td style={{ textAlign: 'right', fontWeight: 600, color: color || 'var(--theme-text1)' }}>{value}</td>
    </tr>
  )
}

// The frozen, exportable artifact version of Owner Dashboard's live KPIs — one snapshot per
// closed period, generated at close time (see Periods.js) or lazily on first view for a
// pre-existing closed period. Sections render per the SNAPSHOT's own recorded modules_included,
// not live clientModules — a historical report never grows a section retroactively just because
// a module got enabled later. See CLAUDE.md's Monthly Owner/Manager Report section.
export default function MonthlyOwnerReport() {
  const { clientId, profile, isAdmin, isOwner, hasFeature } = useAuth()
  const canOverheads = hasFeature('overheads')
  const { scopedFrom } = useScopedDb()

  const [periods, setPeriods] = useState([])
  const [selectedPeriodId, setSelectedPeriodId] = useState(null)
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [generatorName, setGeneratorName] = useState('')
  const [genError, setGenError] = useState('')
  const [bizInfo, setBizInfo] = useState({ name: '', vat: '', address: '', vatReg: true })

  useEffect(() => {
    if (!clientId) return
    loadPeriods()
    Promise.all([
      supabase.from('clients').select('name').eq('id', clientId).single(),
      supabase.from('settings').select('vat_number, property_address, is_vat_registered').eq('client_id', clientId).maybeSingle(),
    ]).then(([{ data: client }, { data: settings }]) => {
      setBizInfo({
        name: client?.name || '', vat: settings?.vat_number || '',
        address: settings?.property_address || '', vatReg: settings?.is_vat_registered ?? true,
      })
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId])

  async function loadPeriods() {
    const { data } = await scopedFrom('monthly_periods', 'id, bs_year, bs_month, status')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
    const rows = data || []
    setPeriods(rows)
    setSelectedPeriodId(prev => prev || rows.find(p => p.status === 'closed')?.id || rows[0]?.id || null)
  }

  const loadReport = useCallback(async () => {
    const period = periods.find(p => p.id === selectedPeriodId)
    if (!period) { setReport(null); setLoading(false); return }
    setLoading(true)
    setGenError('')

    const { data: existing } = await scopedFrom('monthly_owner_reports', '*').eq('period_id', period.id).maybeSingle()
    if (existing) {
      setReport(existing)
      if (existing.generated_by) {
        const { data: names } = await supabase.rpc('get_client_profile_names', { p_client_id: clientId })
        setGeneratorName((names || []).find(n => n.id === existing.generated_by)?.full_name || '—')
      } else {
        setGeneratorName('—')
      }
      setLoading(false)
      return
    }

    if (period.status !== 'closed') { setReport(null); setLoading(false); return }

    // Lazy-generate — a closed period from before this feature shipped, or a report-gen call
    // that failed at close time (see Periods.js's non-blocking try/catch).
    setGenerating(true)
    try {
      const { snapshot, modulesIncluded } = await generateMonthlyReport({ clientId, period })
      await saveGeneratedReport({ clientId, period, snapshot, modulesIncluded, actorId: profile?.id, source: 'backfill' })
      const { data: fresh } = await scopedFrom('monthly_owner_reports', '*').eq('period_id', period.id).maybeSingle()
      setReport(fresh)
      setGeneratorName(profile?.full_name || '—')
    } catch (e) {
      console.error('Report generation failed:', e)
      setGenError('Could not generate the report for this period. Try again, or contact support if this keeps happening.')
      setReport(null)
    } finally {
      setGenerating(false)
      setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPeriodId, periods, clientId])

  useEffect(() => { if (selectedPeriodId) loadReport() }, [selectedPeriodId, loadReport])

  async function handleRegenerate() {
    const period = periods.find(p => p.id === selectedPeriodId)
    if (!period) return
    if (!window.confirm(`This overwrites the frozen figures for ${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}. Continue?`)) return
    setRegenerating(true)
    try {
      const { snapshot, modulesIncluded } = await generateMonthlyReport({ clientId, period })
      await regenerateReport({ clientId, periodId: period.id, snapshot, modulesIncluded, actorId: profile?.id })
      const { data: fresh } = await scopedFrom('monthly_owner_reports', '*').eq('period_id', period.id).maybeSingle()
      setReport(fresh)
      setGeneratorName(profile?.full_name || '—')
    } catch (e) {
      window.alert('Regeneration failed: ' + e.message)
    } finally {
      setRegenerating(false)
    }
  }

  // RLS already blocks every staff-account type from monthly_owner_reports (see migration
  // 20260721010000) — this guard just keeps a staff account from landing on a page that would
  // otherwise show nothing but load errors, and matches Layout.js's own (isAdmin || isOwner)
  // visibility condition for the Owner Dashboard nav link.
  if (!isAdmin && !isOwner) return <Navigate to="/dashboard" replace />

  const selectedPeriod = periods.find(p => p.id === selectedPeriodId)
  const snapshot = report?.snapshot
  const periodLabel = report ? `${BS_MONTHS[report.bs_month - 1]} ${report.bs_year}` : ''
  const execSummary = snapshot ? buildExecutiveSummary(snapshot, periodLabel) : ''

  // Color bands match Owner Dashboard's live KPI cards exactly, so the same rough magnitude
  // never reads as a different "health" color depending on which page you're looking at.
  const fcColor = v => (v == null ? undefined : v <= 35 ? 'var(--theme-green)' : v <= 45 ? 'var(--theme-accent)' : 'var(--theme-red)')
  const lcColor = v => (v == null ? undefined : v <= 37 ? 'var(--theme-green)' : v <= 45 ? 'var(--theme-accent)' : 'var(--theme-red)')
  const pcColor = v => (v == null ? undefined : v <= 60 ? 'var(--theme-green)' : v <= 65 ? 'var(--theme-accent)' : 'var(--theme-red)')
  const nmColor = v => (!canOverheads || v == null ? undefined : v >= 20 ? 'var(--theme-green)' : v >= 10 ? 'var(--theme-accent)' : 'var(--theme-red)')

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Monthly Owner/Manager Report</h1>
        <p className="page-subtitle">Frozen figures generated when each period closes — Crest IMS, HR &amp; POS combined.</p>
      </div>

      <SuiteGate minTier="growth" featureKey="monthly_owner_report" featureLabel="Monthly Owner/Manager Report" requireModules={['ims']}>
        <div className="no-print card" style={{ marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            className="form-select" style={{ maxWidth: 220 }}
            value={selectedPeriodId || ''} onChange={e => setSelectedPeriodId(e.target.value)}
          >
            {periods.length === 0 && <option value="">No periods yet</option>}
            {periods.map(p => (
              <option key={p.id} value={p.id}>
                {BS_MONTHS[p.bs_month - 1]} {p.bs_year}{p.status === 'open' ? ' (Open)' : ''}
              </option>
            ))}
          </select>
          {report && (
            <>
              <button className="btn btn-ghost" onClick={() => exportMonthlyReportExcel(report, bizInfo)}>Export Excel</button>
              <button
                className="btn btn-ghost"
                onClick={() => printWithTitle(`Owner Report — ${periodLabel} — ${bizInfo.name}`)}
              >
                Print / Save as PDF
              </button>
              {isAdmin && (
                <button className="btn btn-ghost" onClick={handleRegenerate} disabled={regenerating}>
                  {regenerating ? 'Regenerating…' : 'Regenerate Snapshot'}
                </button>
              )}
            </>
          )}
        </div>

        {(loading || generating) && (
          <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13, margin: 0 }}>
            {generating ? 'Generating report for this period…' : 'Loading…'}
          </p></div>
        )}

        {!loading && !generating && genError && (
          <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--theme-red) 25%, transparent)', background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)' }}>
            <p style={{ color: 'var(--theme-red)', margin: 0, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
              <TriangleAlert size={14} aria-hidden="true" /> {genError}
            </p>
          </div>
        )}

        {!loading && !generating && !genError && selectedPeriod?.status !== 'closed' && !report && (
          <div className="card">
            <p style={{ color: 'var(--theme-text2)', fontSize: 13, margin: 0 }}>
              This period is still open — a report generates automatically once it's closed.
            </p>
          </div>
        )}

        {!loading && !generating && report && snapshot && (
          <div className="card" style={{ maxWidth: 760, margin: '0 auto', padding: '32px 40px' }}>
            {/* Letterhead */}
            <div style={{ textAlign: 'center', marginBottom: 24, paddingBottom: 18, borderBottom: '2px solid var(--theme-border)' }}>
              <h2 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 800, letterSpacing: '0.02em' }}>{bizInfo.name || '—'}</h2>
              <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--theme-text2)' }}>
                {bizInfo.vatReg ? 'VAT No' : 'PAN No'}: {bizInfo.vat || '—'}{bizInfo.address ? ` · ${bizInfo.address}` : ''}
              </p>
              <div style={{ fontSize: 15, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', margin: '0 0 6px' }}>
                Monthly Owner/Manager Report
              </div>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--theme-text3)' }}>
                Period: {periodLabel} &nbsp;|&nbsp; Generated: {new Date(report.generated_at).toLocaleString()} by {generatorName || '—'}
                &nbsp;|&nbsp; Source: <span style={{ textTransform: 'capitalize' }}>{report.generation_source.replace(/_/g, ' ')}</span>
              </p>
            </div>

            {/* Executive Summary — the one narrative paragraph in the report; everything below
                this point is pure data tables, per the hybrid format chosen for this report. */}
            {execSummary && (
              <div style={{ marginBottom: 26 }}>
                <h3 style={sectionTitleStyle}>Executive Summary</h3>
                <p style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--theme-text1)', margin: 0 }}>{execSummary}</p>
              </div>
            )}

            {/* Financial Summary — Metric / Actual / Target, matching the "KPI, target, actual"
                shape a real restaurant management report uses, not a KPI-tile dashboard. */}
            <div style={{ marginBottom: 26 }}>
              <h3 style={sectionTitleStyle}>Financial Summary</h3>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>Metric</th><th style={{ textAlign: 'right' }}>Actual</th><th style={{ textAlign: 'right' }}>Target</th></tr></thead>
                  <tbody>
                    <tr>
                      <td>Revenue</td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(snapshot.combined?.revenueTotal)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>—</td>
                    </tr>
                    {snapshot.ims && (
                      <tr>
                        <td><Tip text="Net purchases ÷ revenue × 100." width={220}>Food Cost %</Tip></td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: fcColor(snapshot.combined?.foodCostPct) }}>{pct(snapshot.combined?.foodCostPct)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>28–35%</td>
                      </tr>
                    )}
                    {snapshot.hr && (
                      <tr>
                        <td><Tip text="Gross + overtime + employer SSF, as a % of revenue — the actual final figure for a closed period, not a proration." width={280}>Labor Cost %</Tip></td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: lcColor(snapshot.combined?.laborCostPct) }}>{pct(snapshot.combined?.laborCostPct)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>25–30%</td>
                      </tr>
                    )}
                    {snapshot.ims && snapshot.hr && (
                      <tr>
                        <td><Tip text="Food Cost % + Labor Cost % — the number operators benchmark against." width={240}>Prime Cost %</Tip></td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: pcColor(snapshot.combined?.primeCostPct) }}>{pct(snapshot.combined?.primeCostPct)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>≤60–65%</td>
                      </tr>
                    )}
                    {snapshot.ims && snapshot.hr && (
                      <tr>
                        <td><Tip text="Revenue minus food cost, labor cost, and overheads, as a % of revenue." width={260}>Net Margin %</Tip></td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: nmColor(snapshot.combined?.netMarginPct) }}>{!canOverheads ? 'Requires Overheads (Pro)' : pct(snapshot.combined?.netMarginPct)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>≥20%</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {snapshot.ims && (
              <div style={{ marginBottom: 26 }}>
                <h3 style={sectionTitleStyle}>Crest IMS</h3>
                <div className="table-wrap">
                  <table className="data-table"><tbody>
                    <Row label="Purchases" value={fmt(snapshot.ims.purchaseTotal)} />
                    <Row label="Wastage Value" value={fmt(snapshot.ims.wastageValueTotal)} color={snapshot.ims.wastageValueTotal > 0 ? 'var(--theme-red)' : undefined} />
                    <Row label="Cash Purchases" value={fmt(snapshot.ims.cashNet)} />
                    <Row label="Credit Purchases" value={fmt(snapshot.ims.creditNet)} />
                    <Row label="Items Below Par (at close)" value={num(snapshot.ims.reorder?.count)}
                      tip="Items whose stock at period close was at or below par level." />
                    <Row label="Unpaid Credit (this period)" value={fmt(snapshot.ims.payables?.unpaidTotal)}
                      tip="This period's Credit purchases still unpaid as of generation — a period-bound figure, not a live 'days overdue' count." />
                  </tbody></table>
                </div>
              </div>
            )}

            {snapshot.hr && (
              <div style={{ marginBottom: 26 }}>
                <h3 style={sectionTitleStyle}>Crest HR</h3>
                <div className="table-wrap" style={{ marginBottom: snapshot.hr.leave?.length > 0 ? 12 : 0 }}>
                  <table className="data-table"><tbody>
                    <Row label="Gross Payroll" value={fmt(snapshot.hr.payroll?.gross)} />
                    <Row label="Overtime" value={`${num(snapshot.hr.payroll?.ot?.hours)} hrs — ${fmt(snapshot.hr.payroll?.ot?.amount)}`} />
                    <Row label="Employer SSF" value={fmt(snapshot.hr.payroll?.ssfEmployer)} />
                    <Row label="Total Payroll Cost" value={fmt(snapshot.hr.payroll?.total)} color="var(--theme-accent)" />
                    <Row label="Active Headcount" value={num(snapshot.hr.headcount?.active)} />
                    <Row label="New Hires / Terminations" value={`${num(snapshot.hr.headcount?.newHires)} / ${num(snapshot.hr.headcount?.terminations)}`} />
                    <Row label="Attendance Rate" value={snapshot.hr.attendance ? pct(snapshot.hr.attendance.rate) : 'N/A'}
                      tip="Best-effort — only meaningful for clients using the daily Attendance Sheet." />
                  </tbody></table>
                </div>
                {snapshot.hr.leave?.length > 0 && (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead><tr><th>Leave Type</th><th style={{ textAlign: 'right' }}>Requests</th><th style={{ textAlign: 'right' }}>Days Taken</th></tr></thead>
                      <tbody>
                        {snapshot.hr.leave.map((l, i) => (
                          <tr key={i}><td>{l.leaveTypeId || 'Unspecified'}</td><td style={{ textAlign: 'right' }}>{l.requestCount}</td><td style={{ textAlign: 'right' }}>{l.days}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {snapshot.pos && (
              <div>
                <h3 style={sectionTitleStyle}>Crest POS</h3>
                <div className="table-wrap" style={{ marginBottom: 12 }}>
                  <table className="data-table"><tbody>
                    <Row label="Net Sales" value={fmt(snapshot.pos.totalNetSales)}
                      tip="Independently derived from the Bill Register — will not tie out to the penny with Revenue above, which comes from Sales Entries instead. Different discount/VAT rounding basis, same underlying bills." />
                    <Row label="Bills / Qty Sold" value={`${num(snapshot.pos.billCount)} / ${num(snapshot.pos.totalQty)}`} />
                    <Row label="Discount Given" value={fmt(snapshot.pos.totalDiscount)} />
                    <Row label="Comped Bills" value={`${num(snapshot.pos.compedBillsTotal?.count)} — ${fmt(snapshot.pos.compedBillsTotal?.potentialValue)} potential value`} />
                    <Row label="Voids / Write-offs" value={`${num(snapshot.pos.voidsWriteoffsTotal?.count)} — ${fmt(snapshot.pos.voidsWriteoffsTotal?.amount)}`}
                      color={snapshot.pos.voidsWriteoffsTotal?.count > 0 ? 'var(--theme-red)' : undefined} />
                    <Row label="Avg Check / Cover" value={fmt(snapshot.pos.covers?.avgCheckPerCover)} />
                    <Row label="Avg Bill Value" value={fmt(snapshot.pos.covers?.avgBillValue)} />
                  </tbody></table>
                </div>

                {snapshot.pos.categoryBreakdown?.length > 0 && (
                  <div className="table-wrap" style={{ marginBottom: 12 }}>
                    <table className="data-table">
                      <thead><tr><th>Category</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Net Sales</th></tr></thead>
                      <tbody>
                        {snapshot.pos.categoryBreakdown.map((c, i) => (
                          <tr key={i}><td>{c.category}</td><td style={{ textAlign: 'right' }}>{num(c.qty)}</td><td style={{ textAlign: 'right' }}>{fmt(c.net)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {snapshot.pos.paymentMix?.length > 0 && (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead><tr><th>Payment Method</th><th style={{ textAlign: 'right' }}>Net Sales</th><th style={{ textAlign: 'right' }}>% of Net</th></tr></thead>
                      <tbody>
                        {snapshot.pos.paymentMix.map((p, i) => (
                          <tr key={i}><td>{p.method}</td><td style={{ textAlign: 'right' }}>{fmt(p.net)}</td><td style={{ textAlign: 'right' }}>{pct(p.pctOfNet)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </SuiteGate>
    </div>
  )
}
