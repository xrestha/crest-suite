import { Fragment, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useSettings } from '../../context/SettingsContext'
import { supabase } from '../../supabaseClient'
import Tip from '../../components/Tip'
import { BS_MONTHS, adToBs } from '../../utils/bsCalendar'
import { getSubStatus, getDateStatus } from '../../utils/subscription'
import { DEFAULT_PLAN_PRICES, SUITE_ADDON } from '../../data/pricingPlans'

// Cross-tenant admin overview — every client's periods/profiles in one unscoped read to build
// the platform-wide table, so this stays on raw supabase.from() rather than scopedDb (there is
// no single client to scope to). Rendered only when Dashboard.js resolves showAdminDash === true.
export default function AdminDashboardOverview() {
  const { switchAdminClient } = useAuth()
  const { settings } = useSettings()
  const navigate = useNavigate()

  const [adminClients, setAdminClients]   = useState([])
  const [clientPeriods, setClientPeriods] = useState({})
  const [adminLoading, setAdminLoading]   = useState(true)
  const [activeTodayClients, setActiveTodayClients] = useState([])
  const [search, setSearch]               = useState('')
  // Which attention KPI card is currently narrowing the table below. null = show everything.
  const [filter, setFilter]               = useState(null)

  useEffect(() => { loadAdminStats() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAdminStats() {
    setAdminLoading(true)
    const since24h = new Date(Date.now() - 86400000).toISOString()
    const [{ data: clients }, { data: periods }, { data: recentProfiles }] = await Promise.all([
      supabase.from('clients')
        .select('id, name, plan, suite_plan, is_active, trial_ends_at, subscription_ends_at, ims_ends_at, hr_ends_at, pos_ends_at, suite_ends_at, billing_cycle, location, ims_enabled, hr_enabled, pos_enabled, is_trial, subscribe_requested, trial_expires_at')
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
  // Crest Suite Pro is an add-on on its own axis (clients.suite_plan), not a module flag —
  // which is why it was missing from this strip and from the row pills below entirely, while
  // clientMRR() was quietly billing NPR 2,000/outlet for it. Revenue you cannot see on the
  // screen that reports revenue.
  // Same date resolution as clientMRR's suiteActive (suite_ends_at, falling back to the IMS
  // window) — presence-only counting included lapsed Suites the MRR beside it excludes, so the
  // pill and the money could disagree on the same screen (S574).
  const suiteCount = active.filter(c => {
    if (!c.suite_plan) return false
    const imsEnd = c.ims_ends_at || c.subscription_ends_at
    const imsOk  = c.ims_enabled !== false && imsEnd && new Date(imsEnd) > new Date()
    const suiteEnd = c.suite_ends_at || (imsOk ? imsEnd : null)
    return suiteEnd && new Date(suiteEnd) > new Date()
  }).length

  // Subscription health buckets
  const expiring30  = active.filter(c => { const s = getSubStatus(c); return s.days !== null && s.days >= 0 && s.days <= 30 })
  const churnRisk   = active.filter(c => {
    const endDate = c.ims_ends_at || c.subscription_ends_at
    if (!endDate) return false
    // IMS-specific status, not getSubStatus(c)'s cross-module "farthest expiry" — a client whose
    // IMS lapses in 2 days but HR runs another 90 was previously excluded from churn risk (the
    // gate above correctly used the IMS endDate, but the days check didn't), since HR's later
    // date won the Math.max inside getSubStatus and made s.days look healthy.
    const s = getDateStatus(endDate)
    return s.days !== null && s.days <= 7
  })
  const noPeriod     = active.filter(c => !clientPeriods[c.id] || clientPeriods[c.id].status !== 'open')
  const trialSignups = adminClients.filter(c => c.is_trial)
  const wantToSub    = trialSignups.filter(c => c.subscribe_requested)
  const activeClientIds = new Set(activeTodayClients.map(c => c.id))

  // MRR: IMS (tiered) + HR (flat) + POS (flat), matching the real advertised pricing model in
  // src/data/pricingPlans.js — editable in Settings > Plan Pricing (admin-only global row, falls
  // back to these same defaults if unset).
  const planPrices = settings.plan_prices || DEFAULT_PLAN_PRICES
  const imsPrices = planPrices.ims || DEFAULT_PLAN_PRICES.ims
  const hrPrice = planPrices.hr ?? DEFAULT_PLAN_PRICES.hr
  const posPrice = planPrices.pos ?? DEFAULT_PLAN_PRICES.pos
  // Same 25%-off-monthly conversion as Settings > Plan Pricing's Annual tab and the per-client
  // Billing Cycle toggle ("Annual · Save 25%") — a client billed annually pays this discounted
  // rate, so their MRR contribution should reflect that instead of the full monthly price.
  function monthlyRate(base, billingCycle) {
    return billingCycle === 'annual' ? Math.round(base * 0.75) : base
  }
  function clientMRR(c) {
    // Each branch now also checks the module is actually enabled, not just that an end-date
    // happens to be set in the future — a client who had IMS (or HR/POS) once, then had it
    // toggled off without the corresponding *_ends_at ever being cleared, was still being
    // counted as paying for that module here, overstating MRR/ARR and the per-row Monthly Value.
    const imsEnd = c.ims_ends_at || c.subscription_ends_at
    const imsActive = c.ims_enabled !== false && imsEnd && Math.ceil((new Date(imsEnd) - Date.now()) / 86400000) > 0

    // Crest Suite Pro is an ADD-ON priced on top of the module sum, not a bundle that replaces
    // it. It used to be the latter — three discounted tiers covering IMS+HR+POS together — so
    // this branch returned early and ignored the modules entirely. Now it adds. Tracked by its
    // own suite_ends_at (independent of any single module's expiry), falling back to IMS's
    // active window only for pre-migration rows set before suite_ends_at existed.
    const suiteEnd = c.suite_ends_at || (imsActive ? imsEnd : null)
    const suiteActive = c.suite_plan && suiteEnd && Math.ceil((new Date(suiteEnd) - Date.now()) / 86400000) > 0

    let val = 0
    if (imsActive) val += monthlyRate(imsPrices[c.plan] || 0, c.billing_cycle)
    if (c.hr_enabled && c.hr_ends_at && Math.ceil((new Date(c.hr_ends_at) - Date.now()) / 86400000) > 0) val += monthlyRate(hrPrice, c.billing_cycle)
    if (c.pos_enabled && c.pos_ends_at && Math.ceil((new Date(c.pos_ends_at) - Date.now()) / 86400000) > 0) val += monthlyRate(posPrice, c.billing_cycle)
    if (suiteActive) val += c.billing_cycle === 'annual' ? SUITE_ADDON.annual : SUITE_ADDON.monthly
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
  const searchQ = search.trim().toLowerCase()

  // The KPI cards used to be dead ends: "Expiring ≤30 Days: 4" named a number with no way to find
  // out WHICH four, so an operator had to search the table by names they did not have. Each
  // attention card is now a filter over the same list.
  const FILTERS = {
    expiring:  { label: 'Expiring ≤30 days', test: c => expiring30.some(x => x.id === c.id) },
    churn:     { label: 'Critical ≤7 days',  test: c => churnRisk.some(x => x.id === c.id) },
    noPeriod:  { label: 'No open period',    test: c => noPeriod.some(x => x.id === c.id) },
    activeToday: { label: 'Active today',    test: c => activeTodayClients.some(x => x.id === c.id) },
  }
  const activeFilter = FILTERS[filter]
  const visibleSorted = sorted.filter(c => {
    if (activeFilter && !activeFilter.test(c)) return false
    if (!searchQ) return true
    return c.name.toLowerCase().includes(searchQ) || (c.location || '').toLowerCase().includes(searchQ)
  })

  const statCard = (borderColor) => ({
    background: 'var(--theme-card)', border: `1px solid ${borderColor || 'var(--theme-border)'}`,
    borderRadius: 'var(--radius-lg)', boxShadow: 'var(--theme-card-shadow)', padding: '16px 18px'
  })

  // Props that turn an attention card into a real filter control. A card naming a count the
  // operator cannot act on is a dead end, and these are the counts the whole page exists for.
  const filterCard = (key, borderColor) => ({
    style: { ...statCard(borderColor), cursor: 'pointer', textAlign: 'left', width: '100%', font: 'inherit' },
    className: 'interactive-card',
    onClick: () => setFilter(filter === key ? null : key),
    'aria-pressed': filter === key,
  })
  const planBadge = (plan) => ({
    fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 'var(--radius-sm)',
    color:       plan === 'pro' ? 'var(--theme-accent-ink)'  : plan === 'growth' ? 'var(--theme-green-text)'               : 'var(--theme-text2)',
    background:  plan === 'pro' ? 'rgba(201,168,76,0.12)': plan === 'growth' ? 'rgba(52,211,153,0.10)'            : 'rgba(138,146,163,0.10)',
    border: `1px solid ${plan === 'pro' ? 'rgba(201,168,76,0.25)' : plan === 'growth' ? 'rgba(52,211,153,0.20)' : 'rgba(138,146,163,0.20)'}`,
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

      {adminLoading ? (
        <>
          <div role="status" aria-live="polite" className="sr-only">Loading platform overview…</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14, marginBottom: 20, alignItems: 'start' }}>
            {[0, 1, 2, 3, 4, 5].map(i => (
              <div key={i} style={statCard()}>
                <span className="skeleton" style={{ display: 'block', width: '60%', height: 11, marginBottom: 10 }} />
                <span className="skeleton" style={{ display: 'block', width: '40%', height: 26 }} />
              </div>
            ))}
          </div>
          <div className="card" style={{ padding: 20 }}>
            {[0, 1, 2, 3, 4].map(i => (
              <span key={i} className="skeleton" style={{ display: 'block', width: '100%', height: 34, marginBottom: 8 }} />
            ))}
          </div>
        </>
      ) : (
        <>
          {/* ── 5 KPI cards ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14, marginBottom: 20, alignItems: 'start' }}>

            {/* 1 — Active Properties + module adoption */}
            <div style={statCard()}>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Active Properties</div>
              <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--theme-text1)', lineHeight: 1.1 }}>{active.length}</div>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>{inactive.length} inactive · {adminClients.length} total</div>
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--theme-border)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 'var(--radius-sm)', background: 'rgba(201,168,76,0.10)', color: 'var(--theme-accent-ink)', border: '1px solid rgba(201,168,76,0.25)' }}>IMS {imsCount}</span>
                <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 'var(--radius-sm)', background: 'rgba(52,211,153,0.08)', color: 'var(--theme-green-text)', border: '1px solid rgba(52,211,153,0.18)' }}>HR {hrCount}</span>
                <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 'var(--radius-sm)', background: 'rgba(167,139,250,0.10)', color: 'var(--theme-purple-text)', border: '1px solid rgba(167,139,250,0.2)' }}>POS {posCount}</span>
                {suiteCount > 0 && (
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 'var(--radius-sm)', background: 'rgba(201,168,76,0.20)', color: 'var(--theme-accent-ink)', border: '1px solid rgba(201,168,76,0.45)' }}>★ SUITE {suiteCount}</span>
                )}
              </div>
            </div>

            {/* 2 — Active Today */}
            <button {...filterCard('activeToday', activeTodayClients.length > 0 ? 'rgba(52,211,153,0.25)' : undefined)}>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: activeTodayClients.length > 0 ? 'var(--theme-green)' : 'var(--theme-border)', flexShrink: 0 }} />
                Active Today
              </div>
              <div style={{ fontSize: 32, fontWeight: 800, color: activeTodayClients.length > 0 ? 'var(--theme-green-text)' : 'var(--theme-text2)', lineHeight: 1.1 }}>
                {activeTodayClients.length}
              </div>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5, lineHeight: 1.7 }}>
                {activeTodayClients.length === 0
                  ? 'No logins in last 24 h'
                  : <>
                      {activeTodayClients.slice(0, 4).map(c => <div key={c.id}>· {c.name}</div>)}
                      {activeTodayClients.length > 4 && <div>and {activeTodayClients.length - 4} more</div>}
                    </>}
              </div>
            </button>

            {/* 3 — Expiring ≤30 days + churn risk sub-count */}
            <button {...filterCard(churnRisk.length > 0 ? 'churn' : 'expiring', churnRisk.length > 0 ? 'rgba(248,113,113,0.30)' : expiring30.length > 0 ? 'rgba(217,119,6,0.15)' : undefined)}>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Expiring ≤30 Days</div>
              <div style={{ fontSize: 32, fontWeight: 800, color: churnRisk.length > 0 ? 'var(--theme-red-text)' : expiring30.length > 0 ? 'var(--theme-amber-text)' : 'var(--theme-green-text)', lineHeight: 1.1 }}>
                {expiring30.length}
              </div>
              {churnRisk.length > 0 ? (
                <div style={{ fontSize: 11, color: 'var(--theme-red-text)', fontWeight: 700, marginTop: 5 }}>⚠ {churnRisk.length} critical ≤7 days</div>
              ) : (
                <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>Within 30 days</div>
              )}
            </button>

            {/* 4 — No Open Period */}
            <button {...filterCard('noPeriod', noPeriod.length > 0 ? 'rgba(248,113,113,0.35)' : undefined)}>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>No Open Period</div>
              <div style={{ fontSize: 32, fontWeight: 800, color: noPeriod.length > 0 ? 'var(--theme-red-text)' : 'var(--theme-green-text)', lineHeight: 1.1 }}>{noPeriod.length}</div>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>Active clients — need setup</div>
            </button>

            {/* 5 — MRR + ARR */}
            <div style={statCard()}>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Est. Monthly Revenue</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--theme-accent-ink)', lineHeight: 1.1 }}>
                NPR {estMRR.toLocaleString('en-NP')}
              </div>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>
                {payingCount} paying · ARR{' '}
                <span style={{ color: 'var(--theme-accent-ink)', fontWeight: 700 }}>NPR {estARR.toLocaleString('en-NP')}</span>
              </div>
            </div>

            {/* 6 — Trial Signups */}
            <div
              style={{ ...statCard(wantToSub.length > 0 ? 'rgba(248,113,113,0.5)' : trialSignups.length > 0 ? 'rgba(201,168,76,0.25)' : undefined), cursor: 'pointer' }}
              onClick={() => navigate('/admin/clients')}
            >
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Trial Signups</div>
              <div style={{ fontSize: 32, fontWeight: 800, color: trialSignups.length > 0 ? 'var(--theme-accent-ink)' : 'var(--theme-text2)', lineHeight: 1.1 }}>
                {trialSignups.length}
              </div>
              {wantToSub.length > 0 ? (
                <div style={{ fontSize: 11, color: 'var(--theme-red-text)', fontWeight: 700, marginTop: 5, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--theme-red)', flexShrink: 0 }} />
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
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--theme-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>All Properties</span>
              {/* A placeholder is a last-resort accessible name and disappears the moment you
                  type. type="search" + a real label, per DESIGN.md's every-field-needs-htmlFor. */}
              <label htmlFor="admin-client-search" className="sr-only">Search properties by name or location</label>
              <input
                id="admin-client-search"
                type="search" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search by name or location…"
                className="form-select" style={{ fontSize: 12, maxWidth: 220 }}
              />
              {/* Without this the table just silently shows fewer rows than the operator expects
                  and there is nothing on screen saying why, or how to get back. */}
              {activeFilter && (
                <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => setFilter(null)}>
                  Filtered: {activeFilter.label} ({visibleSorted.length}) · clear ✕
                </button>
              )}
              <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>
                MRR: <span style={{ color: 'var(--theme-accent-ink)', fontWeight: 700 }}>NPR {estMRR.toLocaleString('en-NP')}</span>
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
                  {visibleSorted.length === 0 && (
                    // Three distinct empty states — this used to render `No properties match ""`
                    // on a brand-new platform and after a KPI-card filter, telling the operator
                    // their search failed when they never searched (S574).
                    <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--theme-text2)', padding: 24 }}>
                      {searchQ ? <>No properties match “{search.trim()}”.</>
                        : activeFilter ? <>No properties in “{activeFilter.label}”.</>
                        : <>No properties yet — clients appear here once created in Admin → Clients.</>}
                    </td></tr>
                  )}
                  {visibleSorted.map((c, idx) => {
                    // The rows are ALREADY sorted needs-attention → healthy → inactive, and that
                    // grouping was invisible: no divider, no badge, no header, so an operator
                    // scanning the list could not tell where trouble ended and healthy began. The
                    // page did the analysis and then threw the result away.
                    const bandOf = x => !x.is_active ? 'inactive' : needsAttention.has(x.id) ? 'attention' : 'healthy'
                    const band = bandOf(c)
                    const showBandHeader = idx === 0 || bandOf(visibleSorted[idx - 1]) !== band
                    const bandLabel = { attention: 'Needs attention', healthy: 'Healthy', inactive: 'Inactive' }[band]
                    const bandCount = visibleSorted.filter(x => bandOf(x) === band).length
                    const bandColor = { attention: 'var(--theme-amber-text)', healthy: 'var(--theme-green-text)', inactive: 'var(--theme-text3)' }[band]

                    const mrr     = clientMRR(c)
                    const endDate = c.ims_ends_at || c.subscription_ends_at
                    // IMS-specific status, matching this column's own tooltip ("IMS subscription
                    // countdown") — getSubStatus(c) instead took Math.max across ims/hr/pos/
                    // subscription_ends_at, so a client whose IMS had already lapsed could still
                    // show the healthy green "Subscription" label as long as HR/POS ran longer.
                    const sub     = getDateStatus(endDate)
                    const isPaying = endDate && sub.days !== null && sub.days > 0
                    // The real trial-signup path (admin-user-ops Edge Function) only ever writes
                    // trial_expires_at — trial_ends_at is never set, so every self-service trial
                    // was falling through to "No billing" with a blank expiry below.
                    const isTrial  = !endDate && c.trial_expires_at
                    const isActiveToday = activeClientIds.has(c.id)

                    const expiryIso = endDate || c.trial_expires_at
                    let expiryBs = null
                    if (expiryIso) {
                      const bs = adToBs(new Date(expiryIso))
                      expiryBs = `${BS_MONTHS[bs.month - 1]} ${bs.year}`
                    }

                    let typeLabel, typeColor
                    if (!c.is_active)       { typeLabel = 'Inactive';     typeColor = 'var(--theme-text2)' }
                    else if (isPaying)      { typeLabel = 'Subscription'; typeColor = 'var(--theme-green-text)' }
                    else if (isTrial)       { typeLabel = 'Trial';        typeColor = 'var(--theme-accent-ink)' }
                    else if (sub.days !== null && sub.days < 0) { typeLabel = 'Expired'; typeColor = 'var(--theme-red-text)' }
                    else                    { typeLabel = 'No billing';   typeColor = 'var(--theme-text3)' }

                    const period = clientPeriods[c.id]
                    const isOpen = period?.status === 'open'

                    // HR sub status if different from IMS
                    const hrDays = c.hr_ends_at ? Math.ceil((new Date(c.hr_ends_at) - Date.now()) / 86400000) : null
                    const hrExpiring = hrDays !== null && hrDays <= 30 && hrDays >= 0

                    // Suite Pro rides its own suite_ends_at, falling back to IMS's window for rows
                    // written before that column existed — the same resolution clientMRR() uses, so
                    // the pill and the money always agree about whether Suite is live.
                    const suiteEndIso = c.suite_ends_at || (isPaying ? endDate : null)
                    const suiteDays = suiteEndIso ? Math.ceil((new Date(suiteEndIso) - Date.now()) / 86400000) : null
                    const suiteLive = !!c.suite_plan && suiteDays !== null && suiteDays > 0
                    const suiteExpiring = suiteLive && suiteDays <= 30

                    return (
                      <Fragment key={c.id}>
                      {showBandHeader && (
                        <tr>
                          <td colSpan={9} style={{ padding: '10px 12px 4px', fontSize: 10, fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase', color: bandColor, background: 'var(--theme-bg)' }}>
                            {bandLabel} ({bandCount})
                          </td>
                        </tr>
                      )}
                      <tr style={{ cursor: 'pointer' }}
                        onClick={() => switchAdminClient(c.id, c.name)}>

                        {/* Property + active-today dot */}
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                            {isActiveToday && (
                              <span title="Active today" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--theme-green)', flexShrink: 0 }} />
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
                              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 'var(--radius-sm)', background: 'rgba(201,168,76,0.10)', color: 'var(--theme-accent-ink)', border: '1px solid rgba(201,168,76,0.25)' }}>IMS</span>
                            )}
                            {c.hr_enabled && (
                              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 'var(--radius-sm)', background: 'rgba(52,211,153,0.08)', color: 'var(--theme-green-text)', border: '1px solid rgba(52,211,153,0.18)' }}>HR</span>
                            )}
                            {c.pos_enabled && (
                              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 'var(--radius-sm)', background: 'rgba(167,139,250,0.10)', color: 'var(--theme-purple-text)', border: '1px solid rgba(167,139,250,0.2)' }}>POS</span>
                            )}
                            {/* Suite is an add-on ABOVE the modules, not a fourth one, so it takes
                                the accent rather than a fourth hue — the star and the heavier fill
                                are what separate it from the IMS pill. A lapsed one greys out
                                instead of disappearing, or an expiry looks like a cancellation. */}
                            {c.suite_plan && (
                              <Tip text={suiteLive
                                ? `Crest Suite Pro — Owner Dashboard, Monthly Owner Report, Group Console, Demand Forecast and Fixed Assets. Sold per outlet.${suiteDays !== null ? ` Renews in ${suiteDays}d.` : ''}`
                                : 'Crest Suite Pro has lapsed — the Suite features are locked and this outlet is no longer counted in the Suite MRR.'} width={280}>
                                <span style={{
                                  fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 'var(--radius-sm)',
                                  background: suiteLive ? 'rgba(201,168,76,0.20)' : 'transparent',
                                  color: suiteLive ? 'var(--theme-accent-ink)' : 'var(--theme-text3)',
                                  border: `1px solid ${suiteLive ? 'rgba(201,168,76,0.45)' : 'var(--theme-border)'}`,
                                }}>★ SUITE</span>
                              </Tip>
                            )}
                          </div>
                        </td>

                        {/* Plan badge — IMS tier only. The "HR: pro"/"POS: pro" tags that used to
                            sit beside it advertised tiers neither module sells; HR and POS are
                            yes/no, and their presence is already shown by the module pills. */}
                        <td>
                          <span style={planBadge(c.plan)}>
                            {c.plan === 'pro' ? 'Pro' : c.plan === 'growth' ? 'Growth' : 'Starter'}
                          </span>
                        </td>

                        {/* Monthly Value (IMS + HR + POS). Greyed + annotated on inactive rows:
                            clientMRR never reads is_active, so an archived, locked-out client
                            used to show a live "NPR 5,000 · Monthly" in a column whose total
                            excluded it (S574). */}
                        <td style={{ textAlign: 'right', fontWeight: mrr > 0 && c.is_active ? 700 : 400, color: mrr > 0 && c.is_active ? 'var(--theme-accent-ink)' : 'var(--theme-text3)' }}>
                          {mrr > 0 ? (
                            <>
                              NPR {mrr.toLocaleString('en-NP')}
                              <span style={{ display: 'block', fontSize: 10, fontWeight: 600, color: 'var(--theme-text3)', marginTop: 2 }}>
                                {c.is_active ? (c.billing_cycle === 'annual' ? 'Annual' : 'Monthly') : 'inactive — not billed'}
                              </span>
                            </>
                          ) : '—'}
                        </td>

                        {/* Billing type */}
                        <td>
                          <div>
                            <span style={{ fontSize: 12, color: typeColor }}>{typeLabel}</span>
                            {hrExpiring && c.hr_enabled && (
                              <div style={{ fontSize: 10, color: 'var(--theme-amber-text)', marginTop: 2 }}>HR exp. {hrDays}d</div>
                            )}
                            {/* Suite could lapse silently: this column tracks IMS, and the only
                                other module hint was HR's. Losing Suite is NPR 2,000/outlet. */}
                            {suiteExpiring && (
                              <div style={{ fontSize: 10, color: 'var(--theme-amber-text)', marginTop: 2 }}>Suite exp. {suiteDays}d</div>
                            )}
                            {c.suite_plan && !suiteLive && (
                              <div style={{ fontSize: 10, color: 'var(--theme-red-text)', marginTop: 2 }}>Suite lapsed</div>
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
                            ? <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 'var(--radius-sm)', color: sub.color, background: sub.bg, border: `1px solid ${sub.border}` }}>{sub.label}</span>
                            : <span style={{ color: 'var(--theme-text3)', fontSize: 12 }}>—</span>}
                        </td>

                        {/* Current Period */}
                        <td>
                          {isOpen ? (
                            <span style={{ fontSize: 12, color: 'var(--theme-text1)' }}>
                              {BS_MONTHS[period.bs_month - 1]} {period.bs_year}
                              {' '}<span style={{ fontSize: 10, color: 'var(--theme-green-text)' }}>● Open</span>
                            </span>
                          ) : period ? (
                            <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                              {BS_MONTHS[period.bs_month - 1]} {period.bs_year}
                              {' '}<span style={{ fontSize: 10, color: 'var(--theme-text3)' }}>● Closed</span>
                            </span>
                          ) : (
                            <span style={{ fontSize: 11, color: 'var(--theme-red-text)', fontWeight: 600 }}>⚠ No period</span>
                          )}
                        </td>

                        {/* Actions */}
                        <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                            <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                              onClick={() => switchAdminClient(c.id, c.name)}>
                              View as
                            </button>
                            <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                              onClick={() => { switchAdminClient(c.id, c.name); navigate('/periods') }}>
                              Periods
                            </button>
                            <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px', color: 'var(--theme-accent-ink)', borderColor: 'rgba(201,168,76,0.3)' }}
                              onClick={() => navigate('/admin/clients')}>
                              Manage →
                            </button>
                          </div>
                        </td>
                      </tr>
                      </Fragment>
                    )
                  })}
                </tbody>
                <tfoot>
                  {/* The footer totals the rows ABOVE it. It used to print platform-wide
                      estMRR/payingCount over a body narrowed by KPI filter and search — a total
                      row that was not the total of its own table, on the screen whose whole job
                      is stating what the platform earns (S574). When narrowed, it says "Shown". */}
                  {(() => {
                    const shownActive = visibleSorted.filter(c => c.is_active)
                    const shownMRR = shownActive.reduce((sum, c) => sum + clientMRR(c), 0)
                    const shownPaying = shownActive.filter(c => clientMRR(c) > 0).length
                    const narrowed = !!(activeFilter || searchQ)
                    return (
                      <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                        <td colSpan={3} style={{ padding: '10px 12px', fontWeight: 600, color: 'var(--theme-text2)', fontSize: 12 }}>
                          {narrowed ? 'Shown' : 'Total'} — {shownPaying} paying · {shownActive.length - shownPaying} non-paying
                          {narrowed && <span style={{ fontWeight: 400, color: 'var(--theme-text3)' }}> · platform NPR {estMRR.toLocaleString('en-NP')}</span>}
                        </td>
                        <td style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 800, color: 'var(--theme-accent-ink)', fontSize: 15 }}>
                          NPR {shownMRR.toLocaleString('en-NP')}
                        </td>
                        <td colSpan={5} />
                      </tr>
                    )
                  })()}
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
