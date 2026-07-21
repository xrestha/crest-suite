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

const fmt = n => (n == null ? '—' : `NPR ${Math.round(n).toLocaleString('en-NP')}`)
const pct = n => (n == null ? '—' : `${n.toFixed(1)}%`)
const num = n => (n == null ? '—' : Math.round(n).toLocaleString('en-NP'))

// The frozen, exportable artifact version of Owner Dashboard's live KPIs — one snapshot per
// closed period, generated at close time (see Periods.js) or lazily on first view for a
// pre-existing closed period. Sections render per the SNAPSHOT's own recorded modules_included,
// not live clientModules — a historical report never grows a section retroactively just because
// a module got enabled later. See CLAUDE.md's Monthly Owner/Manager Report section.
export default function MonthlyOwnerReport() {
  const { clientId, profile, isAdmin, isOwner } = useAuth()
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
                onClick={() => printWithTitle(`Owner Report — ${BS_MONTHS[report.bs_month - 1]} ${report.bs_year} — ${bizInfo.name}`)}
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
          <div>
            <div className="card" style={{ marginBottom: 16 }}>
              <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>{BS_MONTHS[report.bs_month - 1]} {report.bs_year}</h2>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--theme-text3)' }}>
                Generated {new Date(report.generated_at).toLocaleString()} by {generatorName || '—'}
                {' · '}
                <span style={{ textTransform: 'capitalize' }}>{report.generation_source.replace(/_/g, ' ')}</span>
              </p>
            </div>

            <h3 style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--theme-text2)', margin: '0 0 10px' }}>
              Financial Summary
            </h3>
            <div className="stat-grid" style={{ marginBottom: 24 }}>
              <div className="stat-card">
                <div className="stat-label">Revenue</div>
                <div className="stat-value" style={{ color: 'var(--theme-green)' }}>{fmt(snapshot.combined?.revenueTotal)}</div>
              </div>
              {snapshot.ims && (
                <div className="stat-card">
                  <div className="stat-label"><Tip text="Net purchases ÷ revenue × 100. Healthy range: 28–35% for Nepal F&B." width={240}>Food Cost %</Tip></div>
                  <div className="stat-value">{pct(snapshot.combined?.foodCostPct)}</div>
                </div>
              )}
              {snapshot.hr && (
                <div className="stat-card">
                  <div className="stat-label"><Tip text="Gross + overtime + employer SSF, as a % of revenue. A closed period is fully elapsed, so this is the actual figure, not a proration." width={280}>Labor Cost %</Tip></div>
                  <div className="stat-value">{pct(snapshot.combined?.laborCostPct)}</div>
                </div>
              )}
              {snapshot.ims && snapshot.hr && (
                <div className="stat-card">
                  <div className="stat-label"><Tip text="Food Cost % + Labor Cost % — the number operators benchmark against. Industry standard: 60–65% of revenue." width={280}>Prime Cost %</Tip></div>
                  <div className="stat-value">{pct(snapshot.combined?.primeCostPct)}</div>
                </div>
              )}
              {snapshot.ims && snapshot.hr && (
                <div className="stat-card">
                  <div className="stat-label"><Tip text="Revenue minus food cost, labor cost, and overheads, as a % of revenue." width={260}>Net Margin %</Tip></div>
                  <div className="stat-value">{pct(snapshot.combined?.netMarginPct)}</div>
                </div>
              )}
            </div>

            {snapshot.ims && (
              <>
                <h3 style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--theme-text2)', margin: '0 0 10px' }}>Crest IMS</h3>
                <div className="stat-grid" style={{ marginBottom: 24 }}>
                  <div className="stat-card"><div className="stat-label">Purchases</div><div className="stat-value">{fmt(snapshot.ims.purchaseTotal)}</div></div>
                  <div className="stat-card"><div className="stat-label">Wastage Value</div><div className="stat-value" style={{ color: snapshot.ims.wastageValueTotal > 0 ? 'var(--theme-red)' : undefined }}>{fmt(snapshot.ims.wastageValueTotal)}</div></div>
                  <div className="stat-card"><div className="stat-label">Cash / Credit Purchases</div><div className="stat-value" style={{ fontSize: 14 }}>{fmt(snapshot.ims.cashNet)} / {fmt(snapshot.ims.creditNet)}</div></div>
                  <div className="stat-card"><div className="stat-label"><Tip text="Items whose stock at period close was at or below par level." width={240}>Items Below Par (at close)</Tip></div><div className="stat-value">{num(snapshot.ims.reorder?.count)}</div></div>
                  <div className="stat-card"><div className="stat-label"><Tip text="This period's Credit purchases still unpaid as of generation — a period-bound figure, not a live 'days overdue' count." width={280}>Unpaid Credit (this period)</Tip></div><div className="stat-value">{fmt(snapshot.ims.payables?.unpaidTotal)}</div></div>
                </div>
              </>
            )}

            {snapshot.hr && (
              <>
                <h3 style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--theme-text2)', margin: '0 0 10px' }}>Crest HR</h3>
                <div className="stat-grid" style={{ marginBottom: 12 }}>
                  <div className="stat-card"><div className="stat-label">Gross Payroll</div><div className="stat-value">{fmt(snapshot.hr.payroll?.gross)}</div></div>
                  <div className="stat-card"><div className="stat-label">Overtime</div><div className="stat-value" style={{ fontSize: 14 }}>{num(snapshot.hr.payroll?.ot?.hours)} hrs · {fmt(snapshot.hr.payroll?.ot?.amount)}</div></div>
                  <div className="stat-card"><div className="stat-label">Employer SSF</div><div className="stat-value">{fmt(snapshot.hr.payroll?.ssfEmployer)}</div></div>
                  <div className="stat-card"><div className="stat-label">Total Payroll Cost</div><div className="stat-value" style={{ color: 'var(--theme-accent)' }}>{fmt(snapshot.hr.payroll?.total)}</div></div>
                  <div className="stat-card"><div className="stat-label">Headcount</div><div className="stat-value" style={{ fontSize: 14 }}>{num(snapshot.hr.headcount?.active)} active</div></div>
                  <div className="stat-card"><div className="stat-label">New Hires / Terminations</div><div className="stat-value" style={{ fontSize: 14 }}>{num(snapshot.hr.headcount?.newHires)} / {num(snapshot.hr.headcount?.terminations)}</div></div>
                  <div className="stat-card"><div className="stat-label"><Tip text="Best-effort — only meaningful for clients using the daily Attendance Sheet." width={240}>Attendance Rate</Tip></div><div className="stat-value">{snapshot.hr.attendance ? pct(snapshot.hr.attendance.rate) : 'N/A'}</div></div>
                </div>
                {snapshot.hr.leave?.length > 0 && (
                  <div className="table-wrap" style={{ marginBottom: 24 }}>
                    <table className="data-table">
                      <thead><tr><th>Leave Type</th><th>Requests</th><th>Days Taken</th></tr></thead>
                      <tbody>
                        {snapshot.hr.leave.map((l, i) => (
                          <tr key={i}><td>{l.leaveTypeId || 'Unspecified'}</td><td>{l.requestCount}</td><td>{l.days}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}

            {snapshot.pos && (
              <>
                <h3 style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--theme-text2)', margin: '0 0 10px' }}>Crest POS</h3>
                <div className="stat-grid" style={{ marginBottom: 12 }}>
                  <div className="stat-card"><div className="stat-label"><Tip text="Independently derived from the Bill Register — will not tie out to the penny with Revenue above, which comes from Sales Entries instead. Different discount/VAT rounding basis, same underlying bills." width={280}>POS Net Sales (Bill Register basis)</Tip></div><div className="stat-value">{fmt(snapshot.pos.totalNetSales)}</div></div>
                  <div className="stat-card"><div className="stat-label">Bills / Qty Sold</div><div className="stat-value" style={{ fontSize: 14 }}>{num(snapshot.pos.billCount)} / {num(snapshot.pos.totalQty)}</div></div>
                  <div className="stat-card"><div className="stat-label">Discount Given</div><div className="stat-value">{fmt(snapshot.pos.totalDiscount)}</div></div>
                  <div className="stat-card"><div className="stat-label">Comped Bills</div><div className="stat-value" style={{ fontSize: 14 }}>{num(snapshot.pos.compedBillsTotal?.count)} · {fmt(snapshot.pos.compedBillsTotal?.potentialValue)}</div></div>
                  <div className="stat-card"><div className="stat-label">Voids / Write-offs</div><div className="stat-value" style={{ fontSize: 14, color: snapshot.pos.voidsWriteoffsTotal?.count > 0 ? 'var(--theme-red)' : undefined }}>{num(snapshot.pos.voidsWriteoffsTotal?.count)} · {fmt(snapshot.pos.voidsWriteoffsTotal?.amount)}</div></div>
                  <div className="stat-card"><div className="stat-label">Avg Check / Cover</div><div className="stat-value">{fmt(snapshot.pos.covers?.avgCheckPerCover)}</div></div>
                  <div className="stat-card"><div className="stat-label">Avg Bill Value</div><div className="stat-value">{fmt(snapshot.pos.covers?.avgBillValue)}</div></div>
                </div>

                {snapshot.pos.categoryBreakdown?.length > 0 && (
                  <div className="table-wrap" style={{ marginBottom: 20 }}>
                    <table className="data-table">
                      <thead><tr><th>Category</th><th>Qty</th><th>Net Sales</th></tr></thead>
                      <tbody>
                        {snapshot.pos.categoryBreakdown.map((c, i) => (
                          <tr key={i}><td>{c.category}</td><td>{num(c.qty)}</td><td>{fmt(c.net)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {snapshot.pos.paymentMix?.length > 0 && (
                  <div className="table-wrap" style={{ marginBottom: 24 }}>
                    <table className="data-table">
                      <thead><tr><th>Payment Method</th><th>Net Sales</th><th>% of Net</th></tr></thead>
                      <tbody>
                        {snapshot.pos.paymentMix.map((p, i) => (
                          <tr key={i}><td>{p.method}</td><td>{fmt(p.net)}</td><td>{pct(p.pctOfNet)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </SuiteGate>
    </div>
  )
}
