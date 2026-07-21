import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TriangleAlert } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { supabase } from '../../supabaseClient'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { getBsToday, BS_MONTHS, daysInBsMonth, bsToAd } from '../../utils/bsCalendar'
import Tip from '../../components/Tip'
import SuiteGate from '../../components/SuiteGate'
import { calcAmount, hourlyRateOf } from '../../modules/hr/payroll/payrollCompute'
import {
  SSF_CAP, SSF_EMPLOYER_PCT, OT_MULTIPLIER, OT_HOLIDAY_MULTIPLIER, STANDARD_HOURS_PER_DAY,
} from '../../modules/hr/payrollConstants'
import { explodeRecipeIngredients } from '../../utils/recipeCost'

// Owner Dashboard — Phase 1 (Crest IMS + Crest HR only; POS revenue integration is Phase 2).
// Every figure is Month-to-Date against the client's single currently-open monthly_periods row —
// same scoping as Monthly Summary/Wastage Report/Payroll Run, not a rolling 7-day window (every
// existing report in the codebase is period-bound; a true cross-period rolling window would need
// new multi-period join logic with no precedent, so Phase 1 stays consistent with everything else).
export default function OwnerDashboard() {
  const { profile, clientId, clientModules, hasFeature, loading: authLoading } = useAuth()
  const canOverheads = hasFeature('overheads')
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [activePeriod, setActivePeriod] = useState(null)
  const [stats, setStats] = useState(null)
  const [reorderStats, setReorderStats] = useState(null)
  const [payablesStats, setPayablesStats] = useState(null)
  const [laborCostTotal, setLaborCostTotal] = useState(null)
  // Every sub-loader used to destructure only { data } and silently discard { error } — a failed
  // query zeroed out its stat, indistinguishable from "this figure is genuinely zero," on the one
  // dashboard whose whole purpose is making these numbers trustworthy enough to act on. Keyed per
  // sub-loader so one section's failure doesn't clobber another's message.
  const [loadErrors, setLoadErrors] = useState({})

  function retryLoad(section) {
    if (section === 'period') loadAll()
    else if (section === 'ims') loadImsFigures(activePeriod)
    else if (section === 'reorder') loadReorderStats(activePeriod)
    else if (section === 'payables') loadOverduePayables()
    else if (section === 'labor' && activePeriod) loadLaborCost(activePeriod)
  }

  useEffect(() => {
    if (authLoading || !effectiveClientId) return
    if (clientModules.ims && clientModules.hr) loadAll(); else setLoading(false)
  }, [authLoading, effectiveClientId, clientModules.ims, clientModules.hr]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAll() {
    setLoading(true)
    // .single() reports error.code 'PGRST116' when the result set isn't exactly one row — for
    // this query that just means "no open period right now," a normal state, not a failure.
    const { data: period, error: periodErr } = await scopedFrom('monthly_periods')
      .eq('status', 'open')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .limit(1).single()
    setActivePeriod(period)
    setLoadErrors(prev => ({ ...prev, period: (periodErr && periodErr.code !== 'PGRST116') ? 'Could not check for an open period — figures below may be wrong.' : '' }))

    await Promise.all([
      loadImsFigures(period),
      loadReorderStats(period),
      loadOverduePayables(),
      period ? loadLaborCost(period) : Promise.resolve(setLaborCostTotal(null)),
    ])
    setLoading(false)
  }

  // ── IMS figures: Revenue, Food Cost (net purchases), Wastage, Overheads, Cash/Credit split ──
  // Same tables/formulas as ClientDashboard.jsx's loadStats() — Revenue excludes comps
  // (source='pos_comp', never actually paid for). Overheads query here is scoped to
  // bucket='overhead' only (unlike ClientDashboard's), since this page's True Net Margin
  // also subtracts a separately-computed HR-payroll laborCostTotal — without the bucket
  // filter, the Overheads page's "Labor Costs" tab rows would get subtracted a second time.
  async function loadImsFigures(period) {
    const results = await Promise.all([
      period ? supabase.from('purchase_entries').select('item_id, qty, rate, payment_method').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('vendor_returns').select('item_id, qty, rate').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('sales_entries').select('recipe_id, qty_sold, unit_price').eq('period_id', period.id).neq('source', 'pos_comp') : { data: [] },
      scopedFrom('recipes', 'id, selling_price'),
      period ? supabase.from('overheads').select('amount').eq('period_id', period.id).eq('bucket', 'overhead') : { data: [] },
      period ? supabase.from('wastages').select('item_id, qty').eq('period_id', period.id) : { data: [] },
      scopedFrom('items', 'id, per_uom_rate'),
    ])
    setLoadErrors(prev => ({ ...prev, ims: results.some(r => r.error) ? 'Revenue/food cost figures failed to load — may be incomplete or stale.' : '' }))
    const [{ data: purchases }, { data: returns }, { data: salesData }, { data: recipes }, { data: overheadsData }, { data: wastagesData }, { data: items }] = results

    const grossTotal  = (purchases || []).reduce((s, p) => s + parseFloat(p.qty || 0) * parseFloat(p.rate || 0), 0)
    const returnTotal = (returns   || []).reduce((s, r) => s + parseFloat(r.qty || 0) * parseFloat(r.rate || 0), 0)
    const purchaseTotal = grossTotal - returnTotal

    // unit_price captured on the row (price actually charged) used per-row when present, else
    // falls back to the recipe's current price — this figure feeds Est. Net Margin, the number
    // this dashboard exists specifically to make trustworthy enough to act on.
    const priceMap = {}; (recipes || []).forEach(r => { priceMap[r.id] = parseFloat(r.selling_price) || 0 })
    const revenueTotal = (salesData || []).reduce((s, r) => {
      const price = r.unit_price != null ? parseFloat(r.unit_price) : (priceMap[r.recipe_id] || 0)
      return s + parseFloat(r.qty_sold || 0) * price
    }, 0)

    const overheadTotal = (overheadsData || []).reduce((s, o) => s + parseFloat(o.amount || 0), 0)

    const itemRateMap = {}; (items || []).forEach(i => { itemRateMap[i.id] = parseFloat(i.per_uom_rate || 0) })
    const wastageValueTotal = (wastagesData || []).reduce((s, w) => s + parseFloat(w.qty || 0) * (itemRateMap[w.item_id] || 0), 0)

    // Cash/Credit split of net purchases (not revenue — Sales Entry has no payment_method field).
    let cashNet = 0, creditNet = 0
    ;(purchases || []).forEach(p => {
      const v = parseFloat(p.qty || 0) * parseFloat(p.rate || 0)
      if (p.payment_method === 'Credit') creditNet += v; else cashNet += v
    })
    ;(returns || []).forEach(r => { cashNet -= parseFloat(r.qty || 0) * parseFloat(r.rate || 0) })

    setStats({ purchaseTotal, revenueTotal, overheadTotal, wastageValueTotal, cashNet, creditNet })
  }

  // ── Items below reorder par — a live inventory position, not a period total ──
  async function loadReorderStats(period) {
    const results = await Promise.all([
      period ? supabase.from('purchase_entries').select('item_id, qty').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('vendor_returns').select('item_id, qty').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('opening_stock').select('item_id, qty').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', period.id) : { data: [] },
      scopedFrom('items', 'id, per_uom_rate, yield_pct').eq('is_active', true).eq('is_sub_recipe', false),
      scopedFrom('par_levels', 'item_id, par_qty'),
      scopedFrom('recipes', 'id, selling_price'),
      period ? supabase.from('sales_entries').select('recipe_id, qty_sold').eq('period_id', period.id).neq('source', 'pos_comp') : { data: [] },
    ])
    setLoadErrors(prev => ({ ...prev, reorder: results.some(r => r.error) ? 'Reorder figures failed to load — may be incomplete or stale.' : '' }))
    const [{ data: purchases }, { data: returns }, { data: opening }, { data: closing }, { data: items }, { data: parLevels }, { data: recipes }, { data: sales }] = results

    const dashRecipeIds = (recipes || []).map(r => r.id)
    // explodeRecipeIngredients recurses through sub-recipe ingredients and applies yield_pct —
    // the previous direct recipe_ingredients read only picked up rows with a direct item_id,
    // silently dropping any ingredient that was itself a sub-recipe (sauces, batters, prepped
    // components) from theoretical usage entirely, so a raw item consumed only through one could
    // show zero usage and never surface as needing reorder even when genuinely out of stock.
    const ingredientBreakdown = dashRecipeIds.length > 0 ? await explodeRecipeIngredients(supabase, dashRecipeIds) : {}

    const soldMap = {}; (sales || []).forEach(s => { soldMap[s.recipe_id] = (soldMap[s.recipe_id] || 0) + parseFloat(s.qty_sold || 0) })
    // ingredientBreakdown rows are already yield_pct-adjusted per one portion — just scale by how
    // many portions actually sold.
    const theoreticalMap = {}
    Object.entries(ingredientBreakdown).forEach(([recipeId, rows]) => {
      const sold = soldMap[recipeId] || 0
      if (sold <= 0) return
      rows.forEach(({ item_id, qty }) => { theoreticalMap[item_id] = (theoreticalMap[item_id] || 0) + sold * qty })
    })

    const purchMap = {}
    ;(purchases || []).forEach(p => { purchMap[p.item_id] = (purchMap[p.item_id] || 0) + parseFloat(p.qty || 0) })
    ;(returns || []).forEach(r => { purchMap[r.item_id] = (purchMap[r.item_id] || 0) - parseFloat(r.qty || 0) })
    const openMap = {}; (opening || []).forEach(r => { openMap[r.item_id] = parseFloat(r.qty) })
    const closeMap = {}; (closing || []).forEach(r => { closeMap[r.item_id] = parseFloat(r.physical_qty) })
    const parMap = {}; (parLevels || []).forEach(p => { parMap[p.item_id] = parseFloat(p.par_qty) || 0 })

    let count = 0, estValueTotal = 0
    ;(items || []).forEach(i => {
      const par = parMap[i.id] || 0
      if (par <= 0) return
      const hasPhysical = closeMap[i.id] !== undefined
      const currentStock = hasPhysical
        ? closeMap[i.id]
        : Math.max(0, (openMap[i.id] || 0) + (purchMap[i.id] || 0) - (theoreticalMap[i.id] || 0))
      const shortfall = par - currentStock
      if (shortfall > 0) {
        count += 1
        estValueTotal += shortfall * parseFloat(i.per_uom_rate || 0)
      }
    })
    setReorderStats({ count, estValueTotal })
  }

  // ── Overdue vendor payables (>60 days) — cross-period by nature, doesn't wait on `period` ──
  async function loadOverduePayables() {
    const { data, error } = await supabase
      .from('purchase_entries')
      .select('id, bs_day, qty, rate, monthly_periods!inner(client_id, bs_year, bs_month)')
      .eq('monthly_periods.client_id', effectiveClientId)
      .eq('payment_method', 'Credit')
      .is('paid_at', null)

    const rows = data || []
    const ids = rows.map(e => e.id)
    const { data: pmts, error: pmtsErr } = ids.length ? await scopedFrom('payable_payments').in('purchase_entry_id', ids) : { data: [] }
    setLoadErrors(prev => ({ ...prev, payables: (error || pmtsErr) ? 'Overdue payables failed to load — may be incomplete or stale.' : '' }))
    const paidMap = {}
    ;(pmts || []).forEach(p => { paidMap[p.purchase_entry_id] = (paidMap[p.purchase_entry_id] || 0) + parseFloat(p.amount || 0) })

    const today = new Date()
    let overdueTotal = 0, overdueCount = 0
    rows.forEach(e => {
      const pr = e.monthly_periods
      // purchase_entries.bs_day is NOT NULL with a CHECK(bs_day >= 1) at the DB level, so it can
      // never actually be missing/falsy — no fallback needed (a `|| 1` here would silently bias
      // every row toward looking more overdue than it is, which was never actually reachable).
      const adDate = bsToAd(pr.bs_year, pr.bs_month, e.bs_day)
      const daysOld = Math.max(0, Math.floor((today - adDate) / (1000 * 60 * 60 * 24)))
      const value = parseFloat(e.qty || 0) * parseFloat(e.rate || 0)
      const remaining = Math.max(0, value - (paidMap[e.id] || 0))
      if (daysOld > 60 && remaining > 0) { overdueTotal += remaining; overdueCount += 1 }
    })
    setPayablesStats({ overdueTotal, overdueCount })
  }

  // ── Labor Cost (MTD) — the genuinely new figure; nothing else computes real employer cost
  // outside a finalized Payroll Run. Prorates each active/probation employee's monthly-equivalent
  // gross by elapsed-days-so-far (same perDay = gross/monthDays idiom payrollCompute.js already
  // uses for its unpaid-day deduction), adds actual approved OT this period (not prorated), and
  // prorated employer SSF. Deliberately a simplification for daily/hourly staff — assumes a
  // standard day/hours every elapsed calendar day rather than looking up real attendance; refined
  // once Payroll Run is finalized for the month. ──
  async function loadLaborCost(period) {
    const monthDays = daysInBsMonth(period.bs_year, period.bs_month)
    const bsToday = getBsToday()
    const isCurrentMonth = period.bs_year === bsToday.year && period.bs_month === bsToday.month
    const elapsedDays = isCurrentMonth ? Math.min(bsToday.day, monthDays) : monthDays

    const results = await Promise.all([
      scopedFrom('hr_employees', 'id, status, basic_salary, pay_basis, ssf_enrolled, join_date, end_date'),
      scopedFrom('hr_salary_components', 'employee_id, type, calc_type, value'),
      scopedFrom('hr_overtime_entries', 'employee_id, ot_hours, ot_type, status, bs_year, bs_month')
        .eq('status', 'approved').eq('bs_year', period.bs_year).eq('bs_month', period.bs_month),
    ])
    setLoadErrors(prev => ({ ...prev, labor: results.some(r => r.error) ? 'Labor cost failed to load — may be incomplete or stale.' : '' }))
    const [{ data: employees }, { data: components }, { data: otEntries }] = results

    const empMap = Object.fromEntries((employees || []).map(e => [e.id, e]))

    // Period boundaries in AD, for comparing against join_date/end_date (both plain AD dates).
    const periodStartAd = bsToAd(period.bs_year, period.bs_month, 1)
    const periodElapsedEndAd = bsToAd(period.bs_year, period.bs_month, elapsedDays)

    // Previously counted every active/probation employee for the FULL elapsedDays regardless of
    // join_date, and dropped a terminated employee from gross entirely (even for days they
    // genuinely worked this period) while their already-approved OT for the same period still
    // counted via empMap below — an internally inconsistent labor-cost % on the one dashboard
    // whose whole purpose is making that number trustworthy. Now prorates by days actually worked
    // within the elapsed window: a mid-month new hire only accrues from join_date; an employee
    // deactivated mid-period is included (not just active/probation) IF end_date is actually set
    // and falls inside this period — the deactivate action only flips status, it doesn't
    // auto-populate end_date, so a stale/unset end_date must NOT be treated as "worked the
    // whole period," hence the two-part condition below rather than trusting end_date alone.
    let accruedGross = 0, accruedSsfEmployer = 0
    ;(employees || []).forEach(emp => {
      const isActiveish = emp.status === 'active' || emp.status === 'probation'
      const endAd = emp.end_date ? new Date(emp.end_date) : null
      const terminatedThisPeriod = !isActiveish && endAd && endAd >= periodStartAd && endAd <= periodElapsedEndAd
      if (!isActiveish && !terminatedThisPeriod) return

      const joinAd = emp.join_date ? new Date(emp.join_date) : null
      if (joinAd && joinAd > periodElapsedEndAd) return // hasn't joined yet as of the elapsed window

      const empStart = joinAd && joinAd > periodStartAd ? joinAd : periodStartAd
      const empEnd    = endAd && endAd < periodElapsedEndAd ? endAd : periodElapsedEndAd
      const daysWorked = Math.max(0, Math.floor((empEnd - empStart) / 86400000) + 1)
      if (daysWorked <= 0) return

      const basic = parseFloat(emp.basic_salary) || 0
      const basis = emp.pay_basis || 'monthly'
      const allowances = basis === 'monthly'
        ? (components || []).filter(c => c.employee_id === emp.id && c.type === 'earning')
            .reduce((s, c) => s + calcAmount(c, basic), 0)
        : 0
      const monthlyEquivGross =
        basis === 'daily'  ? basic * monthDays :
        basis === 'hourly' ? basic * STANDARD_HOURS_PER_DAY * monthDays :
        basic + allowances
      const perDay = monthDays > 0 ? monthlyEquivGross / monthDays : 0
      accruedGross += perDay * daysWorked

      if (emp.ssf_enrolled) {
        const ssfBase = Math.min(monthlyEquivGross, SSF_CAP) * (monthDays > 0 ? daysWorked / monthDays : 0)
        accruedSsfEmployer += ssfBase * SSF_EMPLOYER_PCT
      }
    })

    // OT is an actual figure (approved, this period), not prorated.
    let otTotal = 0
    ;(otEntries || []).forEach(e => {
      const emp = empMap[e.employee_id]
      if (!emp) return
      const hr = hourlyRateOf(emp.pay_basis || 'monthly', parseFloat(emp.basic_salary) || 0, monthDays)
      const mult = e.ot_type === 'holiday' ? OT_HOLIDAY_MULTIPLIER : OT_MULTIPLIER
      otTotal += (parseFloat(e.ot_hours) || 0) * hr * mult
    })

    setLaborCostTotal(accruedGross + otTotal + accruedSsfEmployer)
  }

  const revenueTotal = stats?.revenueTotal || 0
  const fcPct = revenueTotal > 0 ? (stats.purchaseTotal / revenueTotal) * 100 : null
  const laborPct = revenueTotal > 0 && laborCostTotal != null ? (laborCostTotal / revenueTotal) * 100 : null
  // Prime Cost % = Food Cost % + Labor Cost % — the single number restaurant operators actually
  // benchmark against (industry standard ~60-65%), not something anyone reads off two separate
  // cards and adds up themselves. Both inputs already exist above; this is purely their sum.
  const primeCostPct = fcPct != null && laborPct != null ? fcPct + laborPct : null
  const overheadTotal = stats?.overheadTotal || 0
  const netMarginPct = revenueTotal > 0 && laborCostTotal != null
    ? ((revenueTotal - stats.purchaseTotal - laborCostTotal - overheadTotal) / revenueTotal) * 100
    : null

  const periodLabel = activePeriod ? `${BS_MONTHS[activePeriod.bs_month - 1]} ${activePeriod.bs_year}` : '—'
  const fmt = n => `NPR ${Math.round(n || 0).toLocaleString('en-NP')}`

  // Shared mini card style — matches ClientDashboard.jsx's kpiCard() convention exactly (this
  // page does not use stat-grid/badge-* despite those classes existing, same as ClientDashboard).
  // Returns a spreadable props object (style + role/tabIndex/onKeyDown when clickable) so every
  // KPI card gets keyboard support and a visible focus ring, matching ClientDashboard.jsx's fix.
  const kpiCard = (onClick) => ({
    style: {
      background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-lg)',
      boxShadow: 'var(--theme-card-shadow)',
      padding: '14px 16px', cursor: onClick ? 'pointer' : 'default', transition: 'border-color 0.15s',
    },
    ...(onClick ? {
      onClick,
      role: 'button',
      tabIndex: 0,
      className: 'interactive-card',
      onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }
    } : {})
  })

  return (
    <div>
      {/* Screen-reader-only announcement — the visible loading state is a shimmering skeleton
          per KPI, which on its own gives no indication to a screen reader that the page is still
          loading, or when it's finished. */}
      <div role="status" aria-live="polite" className="sr-only">
        {loading ? 'Loading dashboard data…' : 'Dashboard data loaded'}
      </div>
      <div className="page-header">
        <h1 className="page-title">Owner Dashboard</h1>
        <p className="page-subtitle">
          Cross-module month-to-date view — Crest IMS + Crest HR
          {activePeriod && ` · ${periodLabel} · Open`}
          {' · '}
          <span
            role="link" tabIndex={0} onClick={() => navigate('/owner-report')}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('/owner-report') } }}
            style={{ color: 'var(--theme-accent)', cursor: 'pointer' }}
          >
            View Full Monthly Report →
          </span>
        </p>
      </div>

      <SuiteGate minTier="growth" featureKey="owner_dashboard">
        {/* A load failure used to be indistinguishable from "this figure is genuinely zero" —
            every sub-loader silently discarded Supabase's error field. Each one sets its own key
            here and clears it on a successful (re)load, so a real fetch failure shows a
            dismissible, retry-able banner instead of a wrong-looking number on the one dashboard
            whose whole purpose is trustworthy figures. */}
        {Object.entries(loadErrors).filter(([, msg]) => msg).map(([section, msg]) => (
          <div key={section} className="card" style={{
            marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
            borderColor: 'color-mix(in srgb, var(--theme-red) 25%, transparent)',
            background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)',
          }}>
            <p style={{ color: 'var(--theme-red)', margin: 0, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
              <TriangleAlert size={14} aria-hidden="true" /> {msg}
            </p>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: '8px 12px' }} onClick={() => retryLoad(section)}>Retry</button>
              <button
                className="btn btn-ghost" style={{ fontSize: 12, padding: '8px 12px' }}
                onClick={() => setLoadErrors(prev => ({ ...prev, [section]: '' }))} aria-label="Dismiss"
              >×</button>
            </div>
          </div>
        ))}

        {/* SuiteGate bypasses everything for admins, but this page's own data load only runs
            when BOTH clientModules.ims and clientModules.hr are true — a client (or an admin
            viewing as one) with only one of the two modules enabled otherwise saw every KPI as
            "—" plus the "No open period" banner below, which was simply wrong: the real cause is
            the missing module, not a missing period. */}
        {!(clientModules.ims && clientModules.hr) && !loading && (
          <div className="card" style={{ marginBottom: 20, borderColor: 'color-mix(in srgb, var(--theme-amber) 15%, transparent)', background: 'color-mix(in srgb, var(--theme-amber) 5%, transparent)' }}>
            <p style={{ color: 'var(--theme-amber)', margin: 0, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
              <TriangleAlert size={15} aria-hidden="true" /> Owner Dashboard needs both Crest IMS and Crest HR enabled — this property has {clientModules.ims ? 'only IMS' : clientModules.hr ? 'only HR' : 'neither'}.
            </p>
          </div>
        )}
        {clientModules.ims && clientModules.hr && !activePeriod && !loading && (
          <div
            className="card interactive-card" style={{ marginBottom: 20, cursor: 'pointer', borderColor: 'color-mix(in srgb, var(--theme-accent) 30%, transparent)' }}
            onClick={() => navigate('/periods')} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('/periods') } }}
          >
            <p style={{ color: 'var(--theme-accent)', margin: 0, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}><TriangleAlert size={15} aria-hidden="true" /> No open period. Click here to create one in Periods →</p>
          </div>
        )}

        {/* No visible section title for either KPI row in the original design — an sr-only
            heading gives screen-reader users a landmark to navigate by without changing the
            visual layout. */}
        <h2 className="sr-only">Profitability (month-to-date)</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 14 }}>

          <div {...kpiCard(() => navigate('/sales'))}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Revenue (MTD)</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-green)', lineHeight: 1.1 }}>{loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : fmt(revenueTotal)}</div>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>From sales entries →</div>
          </div>

          <div {...kpiCard(() => navigate('/variance'))}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
              <Tip text="Net purchases ÷ revenue × 100. Healthy range: 28–35% for Nepal F&B." width={240}>Food Cost % (MTD)</Tip>
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.1, color: fcPct == null ? 'var(--theme-text2)' : fcPct <= 35 ? 'var(--theme-green)' : fcPct <= 45 ? 'var(--theme-accent)' : 'var(--theme-red)' }}>
              {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : fcPct != null ? `${fcPct.toFixed(1)}%` : '—'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>Target 28–35% →</div>
          </div>

          <div {...kpiCard(() => navigate('/hr/payroll'))}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
              <Tip text="Prorated estimate: gross + overtime + employer SSF, scaled to days elapsed this month. Refines to the exact figure once Payroll Run is finalized." width={280}>Labor Cost % (MTD)</Tip>
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.1, color: laborPct == null ? 'var(--theme-text2)' : laborPct <= 37 ? 'var(--theme-green)' : laborPct <= 45 ? 'var(--theme-accent)' : 'var(--theme-red)' }}>
              {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : laborPct != null ? `${laborPct.toFixed(1)}%` : '—'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>Estimate →</div>
          </div>

          <div {...kpiCard()}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
              <Tip text="Food Cost % + Labor Cost % — the two controllable costs combined, the number operators actually benchmark against. Industry standard: 60-65% of revenue." width={280}>Prime Cost % (MTD)</Tip>
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.1, color: primeCostPct == null ? 'var(--theme-text2)' : primeCostPct <= 60 ? 'var(--theme-green)' : primeCostPct <= 65 ? 'var(--theme-accent)' : 'var(--theme-red)' }}>
              {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : primeCostPct != null ? `${primeCostPct.toFixed(1)}%` : '—'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>Target ≤60-65% →</div>
          </div>

          <div {...kpiCard(canOverheads ? null : () => navigate('/overheads'))}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
              <Tip text="Revenue minus food cost, labor cost, and overheads, as a % of revenue. This is what the business actually keeps." width={260}>True Net Margin % (MTD)</Tip>
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.1, color: !canOverheads || netMarginPct == null ? 'var(--theme-text2)' : netMarginPct >= 20 ? 'var(--theme-green)' : netMarginPct >= 10 ? 'var(--theme-accent)' : 'var(--theme-red)' }}>
              {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : !canOverheads ? '—' : netMarginPct != null ? `${netMarginPct.toFixed(1)}%` : '—'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>
              {!canOverheads ? 'Requires Overheads (Pro) →' : !loading && overheadTotal === 0 ? 'Excludes overhead — not entered' : 'After food, labor & overhead'}
            </div>
          </div>
        </div>

        <h2 className="sr-only">Operations</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 20 }}>

          <div {...kpiCard(() => navigate('/wastage-report'))}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Wastage Value (MTD)</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: stats?.wastageValueTotal > 0 ? 'var(--theme-red)' : 'var(--theme-text1)' }}>
              {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : fmt(stats?.wastageValueTotal)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>This period →</div>
          </div>

          <div {...kpiCard(() => navigate('/reorder'))}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>
              <Tip text="Items whose current stock is at or below par level — a live inventory position, not a monthly total." width={260}>Items Below Par</Tip>
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: reorderStats?.count > 0 ? 'var(--theme-red)' : 'var(--theme-text1)' }}>
              {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : (reorderStats?.count ?? 0)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>
              {!loading && reorderStats?.estValueTotal > 0 ? `${fmt(reorderStats.estValueTotal)} to restock →` : 'Full Report →'}
            </div>
          </div>

          <div {...kpiCard(() => navigate('/payables'))}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>
              <Tip text="Credit purchases unpaid for more than 60 days." width={220}>Overdue Payables</Tip>
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: payablesStats?.overdueTotal > 0 ? 'var(--theme-red)' : 'var(--theme-text1)' }}>
              {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : fmt(payablesStats?.overdueTotal)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>
              {!loading && payablesStats?.overdueCount > 0 ? `${payablesStats.overdueCount} bill${payablesStats.overdueCount === 1 ? '' : 's'} →` : 'Full Report →'}
            </div>
          </div>

          <div {...kpiCard(() => navigate('/payments'))}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>
              <Tip text="Net purchases (this period) split by payment method — not a revenue split." width={260}>Purchases · Cash / Credit</Tip>
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--theme-text1)' }}>
              {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : `${fmt(stats?.cashNet)} / ${fmt(stats?.creditNet)}`}
            </div>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>Cash / Credit →</div>
          </div>
        </div>
      </SuiteGate>
    </div>
  )
}
