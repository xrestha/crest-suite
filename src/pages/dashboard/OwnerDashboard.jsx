import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
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

// Owner Dashboard — Phase 1 (Crest IMS + Crest HR only; POS revenue integration is Phase 2).
// Every figure is Month-to-Date against the client's single currently-open monthly_periods row —
// same scoping as Monthly Summary/Wastage Report/Payroll Run, not a rolling 7-day window (every
// existing report in the codebase is period-bound; a true cross-period rolling window would need
// new multi-period join logic with no precedent, so Phase 1 stays consistent with everything else).
export default function OwnerDashboard() {
  const { profile, clientId, clientModules, loading: authLoading } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [activePeriod, setActivePeriod] = useState(null)
  const [stats, setStats] = useState(null)
  const [reorderStats, setReorderStats] = useState(null)
  const [payablesStats, setPayablesStats] = useState(null)
  const [laborCostTotal, setLaborCostTotal] = useState(null)

  useEffect(() => {
    if (authLoading || !effectiveClientId) return
    if (clientModules.ims && clientModules.hr) loadAll(); else setLoading(false)
  }, [authLoading, effectiveClientId, clientModules.ims, clientModules.hr]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAll() {
    setLoading(true)
    const { data: period } = await scopedFrom('monthly_periods')
      .eq('status', 'open')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .limit(1).single()
    setActivePeriod(period)

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
  // (source='pos_comp', never actually paid for).
  async function loadImsFigures(period) {
    const [{ data: purchases }, { data: returns }, { data: salesData }, { data: recipes }, { data: overheadsData }, { data: wastagesData }, { data: items }] = await Promise.all([
      period ? supabase.from('purchase_entries').select('item_id, qty, rate, payment_method').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('vendor_returns').select('item_id, qty, rate').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('sales_entries').select('recipe_id, qty_sold').eq('period_id', period.id).neq('source', 'pos_comp') : { data: [] },
      scopedFrom('recipes', 'id, selling_price'),
      period ? supabase.from('overheads').select('amount').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('wastages').select('item_id, qty').eq('period_id', period.id) : { data: [] },
      scopedFrom('items', 'id, per_uom_rate'),
    ])

    const grossTotal  = (purchases || []).reduce((s, p) => s + parseFloat(p.qty || 0) * parseFloat(p.rate || 0), 0)
    const returnTotal = (returns   || []).reduce((s, r) => s + parseFloat(r.qty || 0) * parseFloat(r.rate || 0), 0)
    const purchaseTotal = grossTotal - returnTotal

    const priceMap = {}; (recipes || []).forEach(r => { priceMap[r.id] = parseFloat(r.selling_price) || 0 })
    const revenueTotal = (salesData || []).reduce((s, r) => s + parseFloat(r.qty_sold || 0) * (priceMap[r.recipe_id] || 0), 0)

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
    const [{ data: purchases }, { data: returns }, { data: opening }, { data: closing }, { data: items }, { data: parLevels }, { data: recipes }, { data: sales }] = await Promise.all([
      period ? supabase.from('purchase_entries').select('item_id, qty').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('vendor_returns').select('item_id, qty').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('opening_stock').select('item_id, qty').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', period.id) : { data: [] },
      scopedFrom('items', 'id, per_uom_rate, yield_pct').eq('is_active', true).eq('is_sub_recipe', false),
      scopedFrom('par_levels', 'item_id, par_qty'),
      scopedFrom('recipes', 'id, selling_price'),
      period ? supabase.from('sales_entries').select('recipe_id, qty_sold').eq('period_id', period.id).neq('source', 'pos_comp') : { data: [] },
    ])

    const dashRecipeIds = (recipes || []).map(r => r.id)
    const { data: recipeIngs } = dashRecipeIds.length
      ? await supabase.from('recipe_ingredients').select('recipe_id, item_id, qty_per_portion').in('recipe_id', dashRecipeIds)
      : { data: [] }

    const soldMap = {}; (sales || []).forEach(s => { soldMap[s.recipe_id] = (soldMap[s.recipe_id] || 0) + parseFloat(s.qty_sold || 0) })
    const yieldMap = {}; (items || []).forEach(i => { yieldMap[i.id] = (parseFloat(i.yield_pct) || 100) / 100 })
    const theoreticalMap = {}
    ;(recipeIngs || []).forEach(ri => {
      if (!ri.item_id) return
      const sold = soldMap[ri.recipe_id] || 0
      const yieldFactor = yieldMap[ri.item_id] || 1
      if (sold > 0) theoreticalMap[ri.item_id] = (theoreticalMap[ri.item_id] || 0) + sold * parseFloat(ri.qty_per_portion) / yieldFactor
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
    const { data } = await supabase
      .from('purchase_entries')
      .select('id, bs_day, qty, rate, monthly_periods!inner(client_id, bs_year, bs_month)')
      .eq('monthly_periods.client_id', effectiveClientId)
      .eq('payment_method', 'Credit')
      .is('paid_at', null)

    const rows = data || []
    const ids = rows.map(e => e.id)
    const { data: pmts } = ids.length ? await scopedFrom('payable_payments').in('purchase_entry_id', ids) : { data: [] }
    const paidMap = {}
    ;(pmts || []).forEach(p => { paidMap[p.purchase_entry_id] = (paidMap[p.purchase_entry_id] || 0) + parseFloat(p.amount || 0) })

    const today = new Date()
    let overdueTotal = 0, overdueCount = 0
    rows.forEach(e => {
      const pr = e.monthly_periods
      const adDate = bsToAd(pr.bs_year, pr.bs_month, e.bs_day || 1)
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

    const [{ data: employees }, { data: components }, { data: otEntries }] = await Promise.all([
      scopedFrom('hr_employees', 'id, status, basic_salary, pay_basis, ssf_enrolled'),
      scopedFrom('hr_salary_components', 'employee_id, type, calc_type, value'),
      scopedFrom('hr_overtime_entries', 'employee_id, ot_hours, ot_type, status, bs_year, bs_month')
        .eq('status', 'approved').eq('bs_year', period.bs_year).eq('bs_month', period.bs_month),
    ])

    const active = (employees || []).filter(e => e.status === 'active' || e.status === 'probation')
    const empMap = Object.fromEntries((employees || []).map(e => [e.id, e]))

    let accruedGross = 0, accruedSsfEmployer = 0
    active.forEach(emp => {
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
      accruedGross += perDay * elapsedDays

      if (emp.ssf_enrolled) {
        const ssfBase = Math.min(monthlyEquivGross, SSF_CAP) * (monthDays > 0 ? elapsedDays / monthDays : 0)
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
  const overheadTotal = stats?.overheadTotal || 0
  const netMarginPct = revenueTotal > 0 && laborCostTotal != null
    ? ((revenueTotal - stats.purchaseTotal - laborCostTotal - overheadTotal) / revenueTotal) * 100
    : null

  const periodLabel = activePeriod ? `${BS_MONTHS[activePeriod.bs_month - 1]} ${activePeriod.bs_year}` : '—'
  const fmt = n => `NPR ${Math.round(n || 0).toLocaleString('en-NP')}`

  // Shared mini card style — matches ClientDashboard.jsx's kpiCard() convention exactly (this
  // page does not use stat-grid/badge-* despite those classes existing, same as ClientDashboard).
  const kpiCard = (onClick) => ({
    background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-lg)',
    boxShadow: 'var(--theme-card-shadow)',
    padding: '14px 16px', cursor: onClick ? 'pointer' : 'default', transition: 'border-color 0.15s',
  })

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Owner Dashboard</h1>
        <p className="page-subtitle">
          Cross-module month-to-date view — Crest IMS + Crest HR
          {activePeriod && ` · ${periodLabel} · Open`}
        </p>
      </div>

      <SuiteGate minTier="growth" featureKey="owner_dashboard">
        {!activePeriod && !loading && (
          <div className="card" style={{ marginBottom: 20, cursor: 'pointer', borderColor: 'rgba(201,168,76,0.3)' }} onClick={() => navigate('/periods')}>
            <p style={{ color: 'var(--theme-accent)', margin: 0, fontSize: 14 }}>⚠ No open period. Click here to create one in Periods →</p>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 14 }}>

          <div style={kpiCard(() => navigate('/sales'))} onClick={() => navigate('/sales')}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Revenue (MTD)</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-green)', lineHeight: 1.1 }}>{loading ? '—' : fmt(revenueTotal)}</div>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>From sales entries →</div>
          </div>

          <div style={kpiCard(() => navigate('/variance'))} onClick={() => navigate('/variance')}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
              <Tip text="Net purchases ÷ revenue × 100. Healthy range: 28–35% for Nepal F&B." width={240}>Food Cost % (MTD)</Tip>
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.1, color: fcPct == null ? 'var(--theme-text2)' : fcPct <= 35 ? 'var(--theme-green)' : fcPct <= 45 ? 'var(--theme-accent)' : 'var(--theme-red)' }}>
              {loading ? '—' : fcPct != null ? `${fcPct.toFixed(1)}%` : '—'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>Target 28–35% →</div>
          </div>

          <div style={kpiCard(() => navigate('/hr/payroll'))} onClick={() => navigate('/hr/payroll')}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
              <Tip text="Prorated estimate: gross + overtime + employer SSF, scaled to days elapsed this month. Refines to the exact figure once Payroll Run is finalized." width={280}>Labor Cost % (MTD)</Tip>
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.1, color: laborPct == null ? 'var(--theme-text2)' : laborPct <= 37 ? 'var(--theme-green)' : laborPct <= 45 ? 'var(--theme-accent)' : 'var(--theme-red)' }}>
              {loading ? '—' : laborPct != null ? `${laborPct.toFixed(1)}%` : '—'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>Estimate →</div>
          </div>

          <div style={kpiCard(null)}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
              <Tip text="Revenue minus food cost, labor cost, and overheads, as a % of revenue. This is what the business actually keeps." width={260}>True Net Margin % (MTD)</Tip>
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.1, color: netMarginPct == null ? 'var(--theme-text2)' : netMarginPct >= 20 ? 'var(--theme-green)' : netMarginPct >= 10 ? 'var(--theme-accent)' : 'var(--theme-red)' }}>
              {loading ? '—' : netMarginPct != null ? `${netMarginPct.toFixed(1)}%` : '—'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>
              {!loading && overheadTotal === 0 ? 'Excludes overhead — not entered' : 'After food, labor & overhead'}
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 20 }}>

          <div style={kpiCard(() => navigate('/wastage-report'))} onClick={() => navigate('/wastage-report')}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Wastage Value (MTD)</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: stats?.wastageValueTotal > 0 ? 'var(--theme-red)' : 'var(--theme-text1)' }}>
              {loading ? '—' : fmt(stats?.wastageValueTotal)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>This period →</div>
          </div>

          <div style={kpiCard(() => navigate('/reorder'))} onClick={() => navigate('/reorder')}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>
              <Tip text="Items whose current stock is at or below par level — a live inventory position, not a monthly total." width={260}>Items Below Par</Tip>
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: reorderStats?.count > 0 ? 'var(--theme-red)' : 'var(--theme-text1)' }}>
              {loading ? '—' : (reorderStats?.count ?? 0)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>
              {!loading && reorderStats?.estValueTotal > 0 ? `${fmt(reorderStats.estValueTotal)} to restock →` : 'Full Report →'}
            </div>
          </div>

          <div style={kpiCard(() => navigate('/payables'))} onClick={() => navigate('/payables')}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>
              <Tip text="Credit purchases unpaid for more than 60 days." width={220}>Overdue Payables</Tip>
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: payablesStats?.overdueTotal > 0 ? 'var(--theme-red)' : 'var(--theme-text1)' }}>
              {loading ? '—' : fmt(payablesStats?.overdueTotal)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>
              {!loading && payablesStats?.overdueCount > 0 ? `${payablesStats.overdueCount} bill${payablesStats.overdueCount === 1 ? '' : 's'} →` : 'Full Report →'}
            </div>
          </div>

          <div style={kpiCard(() => navigate('/payments'))} onClick={() => navigate('/payments')}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>
              <Tip text="Net purchases (this period) split by payment method — not a revenue split." width={260}>Purchases · Cash / Credit</Tip>
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--theme-text1)' }}>
              {loading ? '—' : `${fmt(stats?.cashNet)} / ${fmt(stats?.creditNet)}`}
            </div>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>Cash / Credit →</div>
          </div>
        </div>
      </SuiteGate>
    </div>
  )
}
