import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { supabase } from '../../supabaseClient'
import Tip from '../../components/Tip'
import { BS_MONTHS, adToBs } from '../../utils/bsCalendar'
import { getSubStatus } from '../../utils/subscription'

// Cross-tenant admin overview — every client's periods/profiles in one unscoped read to build
// the platform-wide table, so this stays on raw supabase.from() rather than scopedDb (there is
// no single client to scope to). Rendered only when Dashboard.js resolves showAdminDash === true.
export default function AdminDashboardOverview() {
  const { switchAdminClient } = useAuth()
  const navigate = useNavigate()

  const [adminClients, setAdminClients]   = useState([])
  const [clientPeriods, setClientPeriods] = useState({})
  const [adminLoading, setAdminLoading]   = useState(true)
  const [activeTodayClients, setActiveTodayClients] = useState([])

  useEffect(() => { loadAdminStats() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAdminStats() {
    setAdminLoading(true)
    const since24h = new Date(Date.now() - 86400000).toISOString()
    const [{ data: clients }, { data: periods }, { data: recentProfiles }] = await Promise.all([
      supabase.from('clients')
        .select('id, name, plan, hr_plan, pos_plan, is_active, trial_ends_at, subscription_ends_at, ims_ends_at, hr_ends_at, pos_ends_at, billing_cycle, location, ims_enabled, hr_enabled, pos_enabled, is_trial, subscribe_requested, trial_expires_at')
        .order('name'),
      supabase.from('monthly_periods')
        .select('client_id, bs_year, bs_month, status')
        .order('bs_year', { ascending: false })
        .order('bs_month', { ascending: false }),
      supabase.from('profiles')
        .select('client_id')
        .not('client_id', 'is', null)
        .gte('last_seen_at', since24h),
    ])
    const openMap = {}, latestMap = {}
    ;(periods || []).forEach(p => {
      if (p.status === 'open') openMap[p.client_id] = p
      if (!latestMap[p.client_id]) latestMap[p.client_id] = p
    })
    const pMap = {}
    ;(clients || []).forEach(c => { pMap[c.id] = openMap[c.id] || latestMap[c.id] || null })
    const activeClientIds = new Set((recentProfiles || []).map(p => p.client_id))
    const activeToday = (clients || []).filter(c => activeClientIds.has(c.id))
    setAdminClients(clients || [])
    setClientPeriods(pMap)
    setActiveTodayClients(activeToday)
    setAdminLoading(false)
  }

  const active   = adminClients.filter(c => c.is_active)
  const inactive = adminClients.filter(c => !c.is_active)

  // Module adoption counts
  const imsCount = active.filter(c => c.ims_enabled !== false).length
  const hrCount  = active.filter(c => c.hr_enabled).length
  const posCount = active.filter(c => c.pos_enabled).length

  // Subscription health buckets
  const expiring30  = active.filter(c => { const s = getSubStatus(c); return s.days !== null && s.days >= 0 && s.days <= 30 })
  const churnRisk   = active.filter(c => {
    const endDate = c.ims_ends_at || c.subscription_ends_at
    if (!endDate) return false
    const s = getSubStatus(c)
    return s.days !== null && s.days <= 7
  })
  const noPeriod     = active.filter(c => !clientPeriods[c.id] || clientPeriods[c.id].status !== 'open')
  const trialSignups = adminClients.filter(c => c.is_trial)
  const wantToSub    = trialSignups.filter(c => c.subscribe_requested)
  const activeClientIds = new Set(activeTodayClients.map(c => c.id))

  // MRR: IMS + HR + POS combined (same plan price table for all three modules)
  const PLAN_MRR = { starter: 5000, growth: 8000, pro: 12000 }
  function clientMRR(c) {
    let val = 0
    const imsEnd = c.ims_ends_at || c.subscription_ends_at
    if (imsEnd && Math.ceil((new Date(imsEnd) - Date.now()) / 86400000) > 0) val += PLAN_MRR[c.plan] || 0
    if (c.hr_ends_at && Math.ceil((new Date(c.hr_ends_at) - Date.now()) / 86400000) > 0) val += PLAN_MRR[c.hr_plan] || 0
    if (c.pos_ends_at && Math.ceil((new Date(c.pos_ends_at) - Date.now()) / 86400000) > 0) val += PLAN_MRR[c.pos_plan] || 0
    return val
  }
  const estMRR = active.reduce((sum, c) => sum + clientMRR(c), 0)
  const estARR  = estMRR * 12
  const payingCount = active.filter(c => clientMRR(c) > 0).length

  // Sort: needs-attention first, then healthy active, then inactive
  const needsAttention = new Set(
    active.filter(c => {
      const s = getSubStatus(c)
      return (s.days !== null && s.days <= 30) || !clientPeriods[c.id] || clientPeriods[c.id].status !== 'open'
    }).map(c => c.id)
  )
  const sorted = [
    ...active.filter(c => needsAttention.has(c.id)),
    ...active.filter(c => !needsAttention.has(c.id)),
    ...inactive,
  ]

  const statCard = (borderColor) => ({
    background: 'var(--theme-card)', border: `1px solid ${borderColor || 'var(--theme-border)'}`,
    borderRadius: 10, padding: '16px 18px'
  })
  const planBadge = (plan) => ({
    fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
    color:       plan === 'pro' ? 'var(--theme-accent)'  : plan === 'growth' ? 'var(--theme-green)'               : 'var(--theme-text2)',
    background:  plan === 'pro' ? 'rgba(201,168,76,0.12)': plan === 'growth' ? 'rgba(52,211,153,0.10)'            : 'rgba(120,113,108,0.10)',
    border: `1px solid ${plan === 'pro' ? 'rgba(201,168,76,0.25)' : plan === 'growth' ? 'rgba(52,211,153,0.20)' : 'rgba(120,113,108,0.20)'}`,
  })

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Admin Dashboard</h1>
          <p className="page-subtitle">{active.length} active · {inactive.length} inactive · {adminClients.length} total properties</p>
        </div>
        <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => navigate('/admin/clients')}>Manage Clients →</button>
      </div>

      {adminLoading ? <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p> : (
        <>
          {/* ── 5 KPI cards ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 14, marginBottom: 20 }}>

            {/* 1 — Active Properties + module adoption */}
            <div style={statCard()}>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Active Properties</div>
              <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--theme-text1)', lineHeight: 1.1 }}>{active.length}</div>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>{inactive.length} inactive · {adminClients.length} total</div>
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--theme-border)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 3, background: 'rgba(96,165,250,0.10)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.2)' }}>IMS {imsCount}</span>
                <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 3, background: 'rgba(52,211,153,0.08)', color: '#34d399', border: '1px solid rgba(52,211,153,0.18)' }}>HR {hrCount}</span>
                <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 3, background: 'rgba(167,139,250,0.10)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.2)' }}>POS {posCount}</span>
              </div>
            </div>

            {/* 2 — Active Today */}
            <div style={statCard(activeTodayClients.length > 0 ? 'rgba(52,211,153,0.25)' : undefined)}>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: activeTodayClients.length > 0 ? '#34d399' : '#374151', flexShrink: 0 }} />
                Active Today
              </div>
              <div style={{ fontSize: 32, fontWeight: 800, color: activeTodayClients.length > 0 ? 'var(--theme-green)' : 'var(--theme-text2)', lineHeight: 1.1 }}>
                {activeTodayClients.length}
              </div>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5, lineHeight: 1.7 }}>
                {activeTodayClients.length === 0
                  ? 'No logins in last 24 h'
                  : activeTodayClients.map(c => <div key={c.id}>· {c.name}</div>)}
              </div>
            </div>

            {/* 3 — Expiring ≤30 days + churn risk sub-count */}
            <div style={statCard(churnRisk.length > 0 ? 'rgba(248,113,113,0.30)' : expiring30.length > 0 ? 'rgba(217,119,6,0.15)' : undefined)}>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Expiring ≤30 Days</div>
              <div style={{ fontSize: 32, fontWeight: 800, color: churnRisk.length > 0 ? 'var(--theme-red)' : expiring30.length > 0 ? 'var(--theme-amber)' : 'var(--theme-green)', lineHeight: 1.1 }}>
                {expiring30.length}
              </div>
              {churnRisk.length > 0 ? (
                <div style={{ fontSize: 11, color: 'var(--theme-red)', fontWeight: 700, marginTop: 5 }}>⚠ {churnRisk.length} critical ≤7 days</div>
              ) : (
                <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>Within 30 days</div>
              )}
            </div>

            {/* 4 — No Open Period */}
            <div style={statCard(noPeriod.length > 0 ? 'rgba(248,113,113,0.35)' : undefined)}>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>No Open Period</div>
              <div style={{ fontSize: 32, fontWeight: 800, color: noPeriod.length > 0 ? 'var(--theme-red)' : 'var(--theme-green)', lineHeight: 1.1 }}>{noPeriod.length}</div>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>Active clients — need setup</div>
            </div>

            {/* 5 — MRR + ARR */}
            <div style={statCard()}>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Est. Monthly Revenue</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--theme-accent)', lineHeight: 1.1 }}>
                NPR {estMRR.toLocaleString('en-NP')}
              </div>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>
                {payingCount} paying · ARR{' '}
                <span style={{ color: 'var(--theme-accent)', fontWeight: 700 }}>NPR {estARR.toLocaleString('en-NP')}</span>
              </div>
            </div>

            {/* 6 — Trial Signups */}
            <div
              style={{ ...statCard(wantToSub.length > 0 ? 'rgba(248,113,113,0.5)' : trialSignups.length > 0 ? 'rgba(201,168,76,0.25)' : undefined), cursor: 'pointer' }}
              onClick={() => navigate('/admin/clients')}
            >
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Trial Signups</div>
              <div style={{ fontSize: 32, fontWeight: 800, color: trialSignups.length > 0 ? 'var(--theme-accent)' : 'var(--theme-text2)', lineHeight: 1.1 }}>
                {trialSignups.length}
              </div>
              {wantToSub.length > 0 ? (
                <div style={{ fontSize: 11, color: 'var(--theme-red)', fontWeight: 700, marginTop: 5, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#f87171', flexShrink: 0 }} />
                  {wantToSub.length} want{wantToSub.length === 1 ? 's' : ''} to subscribe
                </div>
              ) : (
                <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>
                  {trialSignups.length === 0 ? 'No active trials' : '7-day free · Starter'} · View →
                </div>
              )}
            </div>
          </div>

          {/* ── Single merged "All Properties" table ── */}
          <div className="card" style={{ padding: 0 }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--theme-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>All Properties</span>
              <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>
                MRR: <span style={{ color: 'var(--theme-accent)', fontWeight: 700 }}>NPR {estMRR.toLocaleString('en-NP')}</span>
                {' '}· {payingCount} paying
              </span>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Property</th>
                    <th>Modules</th>
                    <th>Plan</th>
                    <th style={{ textAlign: 'right' }}>Monthly Value</th>
                    <th>Billing</th>
                    <th>Expires (BS)</th>
                    <th>
                      <Tip text="IMS subscription countdown. HR expiry shown in the Billing column if different." width={220}>Sub Status</Tip>
                    </th>
                    <th>Period</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(c => {
                    const sub     = getSubStatus(c)
                    const mrr     = clientMRR(c)
                    const endDate = c.ims_ends_at || c.subscription_ends_at
                    const isPaying = endDate && sub.days !== null && sub.days > 0
                    const isTrial  = !endDate && c.trial_ends_at
                    const isActiveToday = activeClientIds.has(c.id)

                    const expiryIso = endDate || c.trial_ends_at
                    let expiryBs = null
                    if (expiryIso) {
                      const bs = adToBs(new Date(expiryIso))
                      expiryBs = `${BS_MONTHS[bs.month - 1]} ${bs.year}`
                    }

                    let typeLabel, typeColor
                    if (!c.is_active)       { typeLabel = 'Inactive';     typeColor = 'var(--theme-text3)' }
                    else if (isPaying)      { typeLabel = 'Subscription'; typeColor = 'var(--theme-green)' }
                    else if (isTrial)       { typeLabel = 'Trial';        typeColor = 'var(--theme-accent)' }
                    else if (sub.days !== null && sub.days < 0) { typeLabel = 'Expired'; typeColor = 'var(--theme-red)' }
                    else                    { typeLabel = 'No billing';   typeColor = 'var(--theme-text3)' }

                    const period = clientPeriods[c.id]
                    const isOpen = period?.status === 'open'

                    // HR sub status if different from IMS
                    const hrDays = c.hr_ends_at ? Math.ceil((new Date(c.hr_ends_at) - Date.now()) / 86400000) : null
                    const hrExpiring = hrDays !== null && hrDays <= 30 && hrDays >= 0

                    return (
                      <tr key={c.id} style={{ opacity: c.is_active ? 1 : 0.45, cursor: 'pointer' }}
                        onClick={() => switchAdminClient(c.id, c.name)}>

                        {/* Property + active-today dot */}
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                            {isActiveToday && (
                              <span title="Active today" style={{ width: 7, height: 7, borderRadius: '50%', background: '#34d399', flexShrink: 0 }} />
                            )}
                            <div>
                              <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{c.name}</div>
                              {c.location && <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{c.location}</div>}
                            </div>
                          </div>
                        </td>

                        {/* Module pills */}
                        <td>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {c.ims_enabled !== false && (
                              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: 'rgba(96,165,250,0.10)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.2)' }}>IMS</span>
                            )}
                            {c.hr_enabled && (
                              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: 'rgba(52,211,153,0.08)', color: '#34d399', border: '1px solid rgba(52,211,153,0.18)' }}>HR</span>
                            )}
                            {c.pos_enabled && (
                              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: 'rgba(167,139,250,0.10)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.2)' }}>POS</span>
                            )}
                          </div>
                        </td>

                        {/* Plan badge(s) */}
                        <td>
                          <span style={planBadge(c.plan)}>
                            {c.plan === 'pro' ? 'Pro' : c.plan === 'growth' ? 'Growth' : 'Starter'}
                          </span>
                          {c.hr_enabled && c.hr_plan && c.hr_plan !== c.plan && (
                            <span style={{ fontSize: 10, color: 'var(--theme-text3)', marginLeft: 5 }}>HR: {c.hr_plan}</span>
                          )}
                          {c.pos_enabled && c.pos_plan && c.pos_plan !== c.plan && (
                            <span style={{ fontSize: 10, color: 'var(--theme-text3)', marginLeft: 5 }}>POS: {c.pos_plan}</span>
                          )}
                        </td>

                        {/* Monthly Value (IMS + HR + POS) */}
                        <td style={{ textAlign: 'right', fontWeight: mrr > 0 ? 700 : 400, color: mrr > 0 ? 'var(--theme-accent)' : 'var(--theme-text3)' }}>
                          {mrr > 0 ? `NPR ${mrr.toLocaleString('en-NP')}` : '—'}
                        </td>

                        {/* Billing type */}
                        <td>
                          <div>
                            <span style={{ fontSize: 12, color: typeColor }}>{typeLabel}</span>
                            {hrExpiring && c.hr_enabled && (
                              <div style={{ fontSize: 10, color: 'var(--theme-amber)', marginTop: 2 }}>HR exp. {hrDays}d</div>
                            )}
                          </div>
                        </td>

                        {/* Expiry date */}
                        <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>
                          {expiryBs || <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                        </td>

                        {/* Subscription badge */}
                        <td>
                          {sub.label
                            ? <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, color: sub.color, background: sub.bg, border: `1px solid ${sub.border}` }}>{sub.label}</span>
                            : <span style={{ color: 'var(--theme-text3)', fontSize: 12 }}>—</span>}
                        </td>

                        {/* Current Period */}
                        <td>
                          {isOpen ? (
                            <span style={{ fontSize: 12, color: 'var(--theme-text1)' }}>
                              {BS_MONTHS[period.bs_month - 1]} {period.bs_year}
                              {' '}<span style={{ fontSize: 10, color: 'var(--theme-green)' }}>● Open</span>
                            </span>
                          ) : period ? (
                            <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                              {BS_MONTHS[period.bs_month - 1]} {period.bs_year}
                              {' '}<span style={{ fontSize: 10, color: 'var(--theme-text3)' }}>● Closed</span>
                            </span>
                          ) : (
                            <span style={{ fontSize: 11, color: 'var(--theme-red)', fontWeight: 600 }}>⚠ No period</span>
                          )}
                        </td>

                        {/* Actions */}
                        <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                            <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                              onClick={() => { switchAdminClient(c.id, c.name); navigate('/periods') }}>
                              Periods
                            </button>
                            <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px', color: 'var(--theme-accent)', borderColor: 'rgba(201,168,76,0.3)' }}
                              onClick={() => navigate('/admin/clients')}>
                              Manage →
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                    <td colSpan={3} style={{ padding: '10px 12px', fontWeight: 600, color: 'var(--theme-text2)', fontSize: 12 }}>
                      Total — {payingCount} paying · {active.length - payingCount} non-paying
                    </td>
                    <td style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 800, color: 'var(--theme-accent)', fontSize: 15 }}>
                      NPR {estMRR.toLocaleString('en-NP')}
                    </td>
                    <td colSpan={5} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
