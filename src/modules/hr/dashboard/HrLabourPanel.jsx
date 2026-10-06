import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { withTimeout } from '../../../utils/withTimeout'
import { npr } from '../../../shared/nepalMoney'
import { lcBand, bandFigure } from '../../../shared/operatingBands'
import { chartMotion } from '../../../shared/chartMotion'
import { TOOLTIP_CHROME } from '../../../shared/tooltipChrome'
import { CHART_COLORS } from '../../../shared/chartColors'
import { BS_MONTHS_SHORT, BS_MONTHS, bsToAd, formatAd, daysInBsMonth, getBsToday } from '../../../utils/bsCalendar'
import { isPayrollFenced, payrollLabourTotal, otherLabourLine, PAYSLIP_LABOUR_COLUMNS } from '../../dashboard/labourSource'
import { loadOtherLabourPay, otherLabourFor } from '../../dashboard/loadOtherLabourPay'
import ChartCard from '../../../components/ChartCard'
import ReportLoadError from '../../../components/ReportLoadError'
import Tip from '../../../components/Tip'

// The HR Dashboard's labour section (S800 stage D): what labour cost, and what share of sales it
// was, for each of the last six FINALIZED payroll months — the half of a hospitality HR home every
// tool the S800 research examined carries (sales against labour) and this page had none of.
//
// Deliberately the settled figure only. Labour is pay earned + overtime + employer SSF
// (`payrollLabourTotal`, the definition every labour reader shares), plus the month's festival,
// incentive and final-settlement pay (S798 3c, `loadOtherLabourPay`), over the month's sales, read
// through `hr_labour_actuals` because an HR login cannot read sales_entries itself. The running
// month is the Roster's Labor Forecast, which knows attendance and the roster; a third estimate
// here would be a third definition of one ratio, so the tile links there instead.

const MONTHS_SHOWN = 6
const PAY_HEX = CHART_COLORS[0], OT_HEX = CHART_COLORS[2], SSF_HEX = CHART_COLORS[1], OTHER_HEX = CHART_COLORS[4]
const MUTED = '#6b7280' // chart-tick, for Recharts SVG props only

export default function HrLabourPanel() {
  const { clientId, isAdmin, isOwner, profile, clientModules } = useAuth()
  const { scopedFrom } = useScopedDb()
  const latest = useLatestRequest()
  const fenced = isPayrollFenced({ hrOn: !!clientModules?.hr, isAdmin, isOwner, imsRole: profile?.ims_role })
  const [months, setMonths] = useState(null)   // [{ key, label, pay, ot, ssf, other, otherInfo, total, revenue, bulk }]
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!clientId || fenced) return
    const id = latest.begin(clientId)
    setError(null)
    try {
      // Runs, newest first. A client finalizes one a month, so a few dozen rows at most.
      const runsRes = await withTimeout(
        scopedFrom('hr_payroll_runs', 'id, monthly_periods(bs_year, bs_month)').eq('status', 'finalized').order('created_at', { ascending: false }).limit(24),
        20000, 'Labour cost')
      if (runsRes.error) throw runsRes.error
      // One run per month (the latest finalized), the six most recent months.
      const byMonth = new Map()
      for (const r of runsRes.data || []) {
        const mp = r.monthly_periods
        if (!mp) continue
        const key = mp.bs_year * 100 + mp.bs_month
        if (!byMonth.has(key)) byMonth.set(key, { key, runId: r.id, bsYear: mp.bs_year, bsMonth: mp.bs_month })
      }
      const picked = [...byMonth.values()].sort((a, b) => b.key - a.key).slice(0, MONTHS_SHOWN).reverse()
      if (picked.length === 0) { if (latest.isCurrent(id)) setMonths([]); return }

      const first = picked[0], last = picked[picked.length - 1]
      const [slipsRes, salesRes, otherRes] = await withTimeout(Promise.all([
        // One payslip per employee per run — paged and chunked like the Owner Dashboard's read.
        fetchAllRowsChunked(picked.map(m => m.runId), ids =>
          scopedFrom('hr_payslips', `id, run_id, ${PAYSLIP_LABOUR_COLUMNS}`).in('run_id', ids).order('id')),
        supabase.rpc('hr_labour_actuals', {
          p_client_id: clientId,
          p_from: formatAd(bsToAd(first.bsYear, first.bsMonth, 1)),
          p_to: formatAd(bsToAd(last.bsYear, last.bsMonth, daysInBsMonth(last.bsYear, last.bsMonth))),
        }),
        // Festival, incentive and final-settlement pay of the same months (S798 3c, H18).
        loadOtherLabourPay((t, c) => scopedFrom(t, c), picked.map(m => ({ bsYear: m.bsYear, bsMonth: m.bsMonth }))),
      ]), 25000, 'Labour cost')
      if (slipsRes.error) throw slipsRes.error
      if (salesRes.error) throw salesRes.error
      if (otherRes.error) throw otherRes.error
      if (!latest.isCurrent(id)) return

      const slipsByRun = new Map()
      for (const s of slipsRes.data || []) slipsByRun.set(s.run_id, [...(slipsByRun.get(s.run_id) || []), s])
      const salesByMonth = new Map()
      for (const d of salesRes.data || []) {
        const key = d.bs_year * 100 + d.bs_month
        const m = salesByMonth.get(key) || { revenue: 0, known: false, bulk: false }
        if (d.bulk_month) m.bulk = true
        if (d.has_period && d.revenue != null) { m.revenue += parseFloat(d.revenue) || 0; m.known = true }
        salesByMonth.set(key, m)
      }
      const sum = (rows, f) => rows.reduce((t, r) => t + (parseFloat(r[f]) || 0), 0)
      // A whole month's payroll finalized while that month is still running sits over part of its
      // sales, so its share is withheld until the month is over (dashboards.md, the S798 rule).
      const today = getBsToday()
      const nowKey = today.year * 100 + today.month
      setMonths(picked.map(m => {
        const slips = slipsByRun.get(m.runId) || []
        const sales = salesByMonth.get(m.key)
        // A month whose sales were entered as one month total (no days) cannot be summed by day,
        // so its share of sales is not judged rather than overstated.
        const running = m.key >= nowKey
        const revenue = sales && sales.known && !sales.bulk && !running ? sales.revenue : null
        const otherInfo = otherLabourFor(otherRes.byKey, m.bsYear, m.bsMonth)
        const total = payrollLabourTotal(slips) + otherInfo.total
        return {
          key: m.key, label: `${BS_MONTHS_SHORT[m.bsMonth - 1]} ${String(m.bsYear).slice(-2)}`,
          longLabel: `${BS_MONTHS[m.bsMonth - 1]} ${m.bsYear}`,
          // Pay is what was EARNED: gross less the absence deduction (unpaid days, days before joining).
          pay: Math.round(sum(slips, 'gross') - sum(slips, 'absence_deduction')), ot: Math.round(sum(slips, 'ot_amount')), ssf: Math.round(sum(slips, 'ssf_employer')),
          other: Math.round(otherInfo.total), otherInfo,
          total, revenue, bulk: !!sales?.bulk, running,
          pct: revenue > 0 ? (total / revenue) * 100 : null,
        }
      }))
    } catch (e) {
      if (latest.isCurrent(id)) setError(e)
    }
  }, [clientId, fenced, scopedFrom, latest])

  useEffect(() => { load() }, [load])

  if (fenced) {
    return (
      <div className="note-banner dash-section">
        <strong>Labour cost is not shown to this login.</strong> A login that also holds an Inventory role cannot read payroll, so
        any figure here would be a zero nobody computed. The Owner and HR-only logins see it.
      </div>
    )
  }
  if (error) return <div className="dash-section"><ReportLoadError error={error} /></div>
  if (months === null) return <div className="card card--compact dash-section"><span className="skeleton" style={{ display: 'inline-block', width: '50%', height: '1.2em' }} /></div>
  if (months.length === 0) return null // the page already says "No finalized payroll yet"

  const latestMonth = months[months.length - 1]
  const fig = latestMonth.pct != null ? bandFigure(latestMonth.pct, lcBand, { decimals: 0 }) : null

  return (
    <>
      <h2 className="dash-heading">Labour against sales</h2>
      <div className="stat-grid stat-grid--compact dash-row">
        <div className="stat-card stat-card--compact">
          <div className="stat-label">
            <Tip text="Pay earned (basic and allowances, less unpaid days and days before joining) plus overtime plus the employer's 20% SSF, from the finalized payroll — the payroll sheet's Cost to business — plus any festival allowance, incentives and leavers' final settlements finalized for that month, divided by that month's sales before VAT. Healthy is up to 30%; above 37% is high. The month you are in is on the Roster's Labor Forecast." width={300}>
              Labour % — {latestMonth.longLabel}
            </Tip>
          </div>
          <div className="stat-value" style={fig ? fig.style : { color: 'var(--theme-text2)' }} title={fig?.title}>
            {fig ? fig.text : '—'}
          </div>
          <div className="stat-sub">
            {fig ? `${npr(latestMonth.total)} labour ÷ ${npr(latestMonth.revenue)} sales`
              : latestMonth.running ? 'Not judged until the month is over — its sales are still coming in'
              : latestMonth.bulk ? 'Not judged — that month’s sales were entered as one total, not by day'
              : 'No sales recorded for that month'}
          </div>
          <Link to="/hr/roster?tab=labor" className="dash-tile-link">This month so far: Labor Forecast →</Link>
        </div>
        <div className="stat-card stat-card--compact">
          <div className="stat-label">Labour cost — {latestMonth.longLabel}</div>
          <div className="stat-value">{npr(latestMonth.total)}</div>
          <div className="stat-sub">pay {npr(latestMonth.pay)} · overtime {npr(latestMonth.ot)} · employer SSF {npr(latestMonth.ssf)}{latestMonth.other ? ` · bonus & final pay ${npr(latestMonth.other)}` : ''}</div>
          {latestMonth.other !== 0 && <div className="stat-sub">{otherLabourLine({ other: latestMonth.otherInfo })}</div>}
        </div>
      </div>
      {months.length > 1 && (
        <div className="dash-section">
          <ChartCard
            title={`Labour cost by month — last ${months.length} finalized`}
            legend={<span style={{ fontSize: 11, color: 'var(--theme-text2)' }}>
              <span aria-hidden="true" style={{ color: PAY_HEX }}>■</span> Pay · <span aria-hidden="true" style={{ color: OT_HEX }}>■</span> Overtime · <span aria-hidden="true" style={{ color: SSF_HEX }}>■</span> Employer SSF
              {months.some(m => m.other) && <> · <span aria-hidden="true" style={{ color: OTHER_HEX }}>■</span> Bonus &amp; final pay</>}
            </span>}
            renderChart={h => (
              <ResponsiveContainer width="100%" height={h}>
                <BarChart data={months} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={MUTED} strokeOpacity={0.2} vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: MUTED, fontSize: 11 }} />
                  <YAxis tick={{ fill: MUTED, fontSize: 11 }} width={56} tickFormatter={v => v >= 1000 ? `${Math.round(v / 1000)}k` : v} />
                  <Tooltip
                    contentStyle={{ ...TOOLTIP_CHROME, fontSize: 12, color: 'var(--theme-text1)' }}
                    labelStyle={{ color: 'var(--theme-text1)' }} itemStyle={{ color: 'var(--theme-text1)' }}
                    labelFormatter={(label, payload) => {
                      const m = payload?.[0]?.payload
                      if (!m) return label
                      return `${m.longLabel} — ${npr(m.total)}${m.pct != null ? ` · ${bandFigure(m.pct, lcBand, { decimals: 0 }).text} of sales` : ''}`
                    }}
                    formatter={(v, name) => [npr(v), name]}
                  />
                  <Bar dataKey="pay" name="Pay" stackId="l" fill={PAY_HEX} {...chartMotion()} />
                  <Bar dataKey="ot" name="Overtime" stackId="l" fill={OT_HEX} {...chartMotion()} />
                  <Bar dataKey="ssf" name="Employer SSF" stackId="l" fill={SSF_HEX} {...chartMotion()} />
                  {months.some(m => m.other) && <Bar dataKey="other" name="Bonus & final pay" stackId="l" fill={OTHER_HEX} {...chartMotion()} />}
                </BarChart>
              </ResponsiveContainer>
            )}
          />
        </div>
      )}
    </>
  )
}
