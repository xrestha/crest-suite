import { npr } from '../../shared/nepalMoney'
import { useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { TriangleAlert } from 'lucide-react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ResponsiveContainer,
} from 'recharts'
import { chartMotion } from '../../shared/chartMotion'
import { useAuth } from '../../context/AuthContext'
import { useTheme } from '../../context/ThemeContext'
import { supabase } from '../../supabaseClient'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { fetchAllRows, fetchAllRowsChunked } from '../../shared/fetchAllRows'
import { getBsToday, BS_MONTHS, BS_MONTHS_SHORT, daysInBsMonth, bsToAd } from '../../utils/bsCalendar'
import { useSettings } from '../../context/SettingsContext'
import { fcBand } from '../../shared/imsFormulas'
import { lcBand, pcBand, nmBand, bandFigure } from '../../shared/operatingBands'
import Tip from '../../components/Tip'
import SuiteGate from '../../components/SuiteGate'
import ChartCard from '../../components/ChartCard'
import { calcAmount, hourlyRateOf } from '../../modules/hr/payroll/payrollCompute'
import {
  SSF_CAP, SSF_EMPLOYER_PCT, OT_MULTIPLIER, OT_HOLIDAY_MULTIPLIER, STANDARD_HOURS_PER_DAY,
} from '../../modules/hr/payrollConstants'
import { explodeRecipeIngredients } from '../../utils/recipeCost'
import { buildStockRows, summarizeReorder } from '../../modules/ims/stockcount/stockReportCalc'

// Cost & Margin trend series. Fixed hex, for the reason DESIGN.md states by name: the semantic
// token set is five ROLES, not five distinguishable hues. These four lines were
// accent/purple/red/green — and accent and purple are literally the same value on Dracula
// (#bd93f9), Catppuccin Mocha (#cba6f7) and Latte (#8839ef), so on those three presets Food Cost
// and Labor Cost drew as one indistinguishable line, with matching legend swatches above them.
// That is the whole proposition of this chart: seeing which of the two is the one climbing.
//
// Values are the set already brute-forced against the CVD and normal-vision floors for
// ClientDashboard's COST_BREAKDOWN_COLORS (worst pair ΔE 16.8 normal / 8.6 deutan), reused here
// so Food Cost keeps one identity across every surface that draws it. Duplicated locally rather
// than shared, since that constant lives in a page file, not a shared module.
//
// Prime Cost additionally carries a dash: it is the SUM of the two lines above it, not a fifth
// peer measure, and it previously took red — which on the KPI cards directly above means "over
// threshold", so the Prime line read as permanently alarming whatever its value.
const TREND_COLORS = {
  fc:     '#c9a84c', // gold — same as the Food Cost slice and the FC% trend line (see below)
  labor:  '#60a5fa', // blue — same as the Labor slice
  prime:  '#8b5cf6', // violet, dashed (a derived total, not a peer)
  margin: '#34d399', // green — profit reads as good
}

// Owner Dashboard — Phase 1 (Crest IMS + Crest HR only; POS revenue integration is Phase 2).
// Every figure is Month-to-Date against the client's single currently-open monthly_periods row —
// same scoping as Monthly Summary/Wastage Report/Payroll Run, not a rolling 7-day window (every
// existing report in the codebase is period-bound; a true cross-period rolling window would need
// new multi-period join logic with no precedent, so Phase 1 stays consistent with everything else).
export default function OwnerDashboard() {
  const { profile, clientId, clientModules, hasFeature, loading: authLoading, isAdmin, isOwner } = useAuth()
  const canOverheads = hasFeature('overheads')
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const navigate = useNavigate()
  const { colors } = useTheme()
  // The FC verdict colour comes from the client's OWN Settings thresholds via fcBand(), the same
  // source Variance/Recipes/MenuPricing use — a hardcoded 35/45 here could colour the same month
  // differently from the Variance page this card links to whenever a client customised them.
  const { settings } = useSettings()
  const fcCardBand = pct => fcBand(pct, settings)

  const [loading, setLoading] = useState(true)
  const [activePeriod, setActivePeriod] = useState(null)
  const [stats, setStats] = useState(null)
  const [reorderStats, setReorderStats] = useState(null)
  const [payablesStats, setPayablesStats] = useState(null)
  const [laborCostTotal, setLaborCostTotal] = useState(null)
  // Historical trend, sourced from the already-frozen monthly_owner_reports snapshots (one per
  // closed period) rather than re-deriving figures live — cheap (no new queries beyond this one),
  // and matches how the report page's own Trend section already reads prior snapshots directly.
  const [trendReports, setTrendReports] = useState([])
  const [trendLoading, setTrendLoading] = useState(true)
  // Every sub-loader used to destructure only { data } and silently discard { error } — a failed
  // query zeroed out its stat, indistinguishable from "this figure is genuinely zero," on the one
  // dashboard whose whole purpose is making these numbers trustworthy enough to act on. Keyed per
  // sub-loader so one section's failure doesn't clobber another's message.
  const [loadErrors, setLoadErrors] = useState({})

  // Guards against a stale response overwriting the current view (S734). This page had NO
  // cancellation check at all — the only one of the five dashboards without one, while both
  // ClientDashboard and HrDashboard carry a `loadIdRef` and say why. Its five loaders each run
  // several seconds of queries, so an admin switching "view as" client (or an owner switching
  // outlet) while one was in flight let the PREVIOUS tenant's revenue, payroll and payables land
  // last and repaint the page — under the new client's name in the header, with no tell. That is
  // worse here than on the pages that already guard: these are cross-module money figures on the
  // surface an owner acts on, and the two tenants' numbers are indistinguishable once mixed.
  // Each loader captures the id current at its own start and re-checks it after every await.
  const loadIdRef = useRef(0)

  function retryLoad(section) {
    const myId = ++loadIdRef.current
    if (section === 'period') { loadAll(myId); loadTrend(myId) }
    else if (section === 'ims') loadImsFigures(activePeriod, myId)
    else if (section === 'reorder') loadReorderStats(activePeriod, myId)
    else if (section === 'payables') loadOverduePayables(myId)
    else if (section === 'labor' && activePeriod) loadLaborCost(activePeriod, myId)
    else if (section === 'trend') loadTrend(myId)
  }

  useEffect(() => {
    if (authLoading || !effectiveClientId) return
    const myId = ++loadIdRef.current
    if (clientModules.ims && clientModules.hr) { loadAll(myId); loadTrend(myId) } else { setLoading(false); setTrendLoading(false) }
  }, [authLoading, effectiveClientId, clientModules.ims, clientModules.hr]) // eslint-disable-line react-hooks/exhaustive-deps

  // Last 12 closed periods' frozen combined metrics (Food/Labor/Prime Cost %, Net Margin %) —
  // same 'combined' shape computeMonthlyReport.js already writes, read directly rather than
  // re-derived, so this trend can never disagree with what the Monthly Owner Report itself shows
  // for the same periods.
  async function loadTrend(myId) {
    setTrendLoading(true)
    const { data, error } = await scopedFrom('monthly_owner_reports', 'bs_year, bs_month, snapshot')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .limit(12)
    if (loadIdRef.current !== myId) return // superseded by a newer client switch
    setLoadErrors(prev => ({ ...prev, trend: error ? 'Trend chart failed to load — may be incomplete or stale.' : '' }))
    setTrendReports((data || []).slice().reverse())
    setTrendLoading(false)
  }

  async function loadAll(myId) {
    setLoading(true)
    // .single() reports error.code 'PGRST116' when the result set isn't exactly one row — for
    // this query that just means "no open period right now," a normal state, not a failure.
    const { data: period, error: periodErr } = await scopedFrom('monthly_periods')
      .eq('status', 'open')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .limit(1).single()
    if (loadIdRef.current !== myId) return // superseded by a newer client switch
    setActivePeriod(period)
    setLoadErrors(prev => ({ ...prev, period: (periodErr && periodErr.code !== 'PGRST116') ? 'Could not check for an open period — figures below may be wrong.' : '' }))

    await Promise.all([
      loadImsFigures(period, myId),
      loadReorderStats(period, myId),
      loadOverduePayables(myId),
      period ? loadLaborCost(period, myId) : Promise.resolve(setLaborCostTotal(null)),
    ])
    if (loadIdRef.current !== myId) return
    setLoading(false)
  }

  // ── IMS figures: Revenue, Food Cost (net purchases), Wastage, Overheads, Cash/Credit split ──
  // Same tables/formulas as ClientDashboard.jsx's loadStats() — Revenue excludes comps
  // (source='pos_comp', never actually paid for). Overheads query here is scoped to
  // bucket='overhead' only (unlike ClientDashboard's), since this page's True Net Margin
  // also subtracts a separately-computed HR-payroll laborCostTotal — without the bucket
  // filter, the Overheads page's "Labor Costs" tab rows would get subtracted a second time.
  async function loadImsFigures(period, myId) {
    const results = await Promise.all([
      period ? fetchAllRows(() => supabase.from('purchase_entries').select('item_id, qty, rate, payment_method').eq('period_id', period.id).order('id')) : { data: [] },
      // Paged (S734): subtracted from net purchases, so a truncation OVERSTATES Food Cost %
      // and understates True Net Margin — the wrong direction on a banded tile.
      period ? fetchAllRows(() => supabase.from('vendor_returns').select('item_id, qty, rate').eq('period_id', period.id).order('id')) : { data: [] },
      // `source` is SELECTED and comps are filtered in JS below, never `.neq('source','pos_comp')`
      // (S734). `sales_entries.source` is nullable (DEFAULT 'manual', no NOT NULL), and in SQL
      // `NULL <> 'pos_comp'` evaluates to NULL rather than true — so the server-side form silently
      // dropped every legacy row whose source predates the column from REVENUE. That is the
      // denominator of all five figures in the row above: Food Cost %, Labor Cost % and Prime Cost
      // % each read HIGH against a short revenue base and True Net Margin % read LOW, on the one
      // page whose whole purpose is figures trustworthy enough to act on — and each disagreed with
      // ClientDashboard's own figure for the very same month, which has always filtered in JS.
      // Same defect class as the reorder read below, and the last of the two on this page.
      period ? fetchAllRows(() => supabase.from('sales_entries').select('recipe_id, qty_sold, unit_price, discount, source').eq('period_id', period.id).order('id')) : { data: [] },
      // Paged (S734), and it is a PRODUCER: this is the price fallback for any sales row with
      // no `unit_price`, so a recipe past the 1000-row cap prices its sales at zero. That is
      // the denominator of all five tiles in the Profitability row — the same failure the
      // `.neq` on the sales read had, arriving by a different route.
      fetchAllRows(() => scopedFrom('recipes', 'id, selling_price').order('id')),
      // Deliberately NOT paged: one row per named fixed cost per period, tens of rows.
      period ? supabase.from('overheads').select('amount').eq('period_id', period.id).eq('bucket', 'overhead') : { data: [] },
      period ? fetchAllRows(() => supabase.from('wastages').select('item_id, qty').eq('period_id', period.id).order('id')) : { data: [] },
      // Paged (S734): itemRateMap values Wastage Value, and an item past the cut is valued at
      // RATE 0 rather than dropped — so the tile reads LOW and looks like a good month.
      fetchAllRows(() => scopedFrom('items', 'id, per_uom_rate').order('id')),
    ])
    if (loadIdRef.current !== myId) return // superseded by a newer client switch
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
      if (r.source === 'pos_comp') return s // a comped dish was never paid for; see the read above
      const price = r.unit_price != null ? parseFloat(r.unit_price) : (priceMap[r.recipe_id] || 0)
      return s + parseFloat(r.qty_sold || 0) * price - (parseFloat(r.discount) || 0)
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
  async function loadReorderStats(period, myId) {
    const results = await Promise.all([
      period ? fetchAllRows(() => supabase.from('purchase_entries').select('item_id, qty').eq('period_id', period.id).order('id')) : { data: [] },
      // Six paged reads (S734). `buildStockRows` looks every transaction row up in these, so
      // a truncated master list does not shorten the below-par count — it removes items from
      // it silently, and an opening or closing row past the cut reads as a ZERO count, which
      // makes the item look freshly restocked rather than empty. This tile links to the
      // Reorder Report, which S696 aligned it with precisely so the two could not disagree.
      period ? fetchAllRows(() => supabase.from('vendor_returns').select('item_id, qty').eq('period_id', period.id).order('id')) : { data: [] },
      period ? fetchAllRows(() => supabase.from('opening_stock').select('item_id, qty').eq('period_id', period.id).order('id')) : { data: [] },
      period ? fetchAllRows(() => supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', period.id).order('id')) : { data: [] },
      fetchAllRows(() => scopedFrom('items', 'id, per_uom_rate, yield_pct').eq('is_active', true).eq('is_sub_recipe', false).order('id')),
      fetchAllRows(() => scopedFrom('par_levels', 'item_id, par_qty').order('id')),
      fetchAllRows(() => scopedFrom('recipes', 'id, selling_price').order('id')),
      // Every source, with bs_day + source for the shared depletion rule (S696). This read used
      // to carry `.neq('source', 'pos_comp')`, which was wrong twice over: a comped dish still
      // consumed its ingredients, and a .neq on a NULLABLE column also drops every legacy manual
      // row whose source is NULL — so consumption was understated and the tile under-counted.
      period ? fetchAllRows(() => supabase.from('sales_entries').select('recipe_id, qty_sold, bs_day, source').eq('period_id', period.id).order('id')) : { data: [] },
      // Wastage and staff meals come off the shelf in the shared calculation (S696); this tile
      // deducted neither, so it disagreed with the Reorder Report it summarises.
      period ? fetchAllRows(() => supabase.from('wastages').select('item_id, qty').eq('period_id', period.id).order('id')) : { data: [] },
      // Paged for the same reason `wastages` directly above it is (S734) — one row per item per
      // day crosses 1000 inside one month, and an under-read here UNDER-deducts staff meals, so
      // on-hand reads high and items drop off the below-par count this tile reports.
      period ? fetchAllRows(() => supabase.from('staff_meals').select('item_id, qty').eq('period_id', period.id).order('id')) : { data: [] },
    ])
    if (loadIdRef.current !== myId) return // superseded by a newer client switch
    setLoadErrors(prev => ({ ...prev, reorder: results.some(r => r.error) ? 'Reorder figures failed to load — may be incomplete or stale.' : '' }))
    const [{ data: purchases }, { data: returns }, { data: opening }, { data: closing }, { data: items }, { data: parLevels }, { data: recipes }, { data: sales }, { data: wastages }, { data: staffMeals }] = results

    const dashRecipeIds = (recipes || []).map(r => r.id)
    // explodeRecipeIngredients recurses through sub-recipe ingredients and applies yield_pct —
    // the previous direct recipe_ingredients read only picked up rows with a direct item_id,
    // silently dropping any ingredient that was itself a sub-recipe (sauces, batters, prepped
    // components) from theoretical usage entirely, so a raw item consumed only through one could
    // show zero usage and never surface as needing reorder even when genuinely out of stock.
    // The recipe walk throws on a failed read (S695). This section's convention is to flag and
    // continue with what it has, so a failed walk is reported the way a failed read in the batch
    // above is — the reorder figures below are then computed without usage and say so.
    let ingredientBreakdown = {}
    try {
      ingredientBreakdown = dashRecipeIds.length > 0 ? await explodeRecipeIngredients(supabase, dashRecipeIds) : {}
    } catch (err) {
      console.error('Owner Dashboard: recipe walk failed', err)
      setLoadErrors(prev => ({ ...prev, reorder: 'Reorder figures failed to load — may be incomplete or stale.' }))
    }

    // The same on-hand / below-par calculation the Reorder Report uses (S696) — this tile used to
    // keep its own copy (no wastage, no staff meals, comps excluded, raw sales), so the count
    // here and the count on that page were different numbers for the same client.
    const rows = buildStockRows({
      items, opening, closing, purchases, returns, wastages, staffMeals,
      sales, breakdown: ingredientBreakdown, pars: parLevels,
    })
    if (loadIdRef.current !== myId) return // superseded again after the recipe walk
    setReorderStats(summarizeReorder(rows))
  }

  // ── Overdue vendor payables (>60 days) — cross-period by nature, doesn't wait on `period` ──
  async function loadOverduePayables(myId) {
    // Paged: every unpaid credit bill across all periods, so this grows without bound as the
    // system is used and would silently stop counting overdue payables past 1000 rows (S529).
    const { data, error } = await fetchAllRows(() => supabase
      .from('purchase_entries')
      .select('id, bs_day, qty, rate, monthly_periods!inner(client_id, bs_year, bs_month)')
      .eq('monthly_periods.client_id', effectiveClientId)
      .eq('payment_method', 'Credit')
      .is('paid_at', null)
      .order('id'))

    const rows = data || []
    const ids = rows.map(e => e.id)
    // Chunked AND paged (S734). `ids` is every unpaid credit bill the client has ever raised —
    // the read above is deliberately paged because it grows without bound — and PostgREST spells
    // an `.in()` list out in the request URL, so a few hundred uuids is already a 414 and the
    // 1000-row cap still applies to the payments underneath. Both failure modes bias the SAME
    // way: a short `paidMap` makes bills look less paid than they are, so Overdue Payables
    // OVERSTATES what is owed, and the 414 zeroes it out entirely.
    const { data: pmts, error: pmtsErr } = ids.length
      ? await fetchAllRowsChunked(ids, chunk => scopedFrom('payable_payments', 'purchase_entry_id, amount').in('purchase_entry_id', chunk).order('id'))
      : { data: [] }
    if (loadIdRef.current !== myId) return // superseded again after the payments read
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
  async function loadLaborCost(period, myId) {
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
    if (loadIdRef.current !== myId) return // superseded by a newer client switch
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
  const fmt = npr

  // HOW FAR INTO THE MONTH WE ARE (S734) — the same guard ClientDashboard has carried since the
  // `periodTooEarly` note was written, and this page had none of it while labelling every tile
  // "(MTD)".
  //
  // Food cost divides a numerator that arrives in LUMPS (a bulk restock) by a denominator that
  // accrues DAILY, so on day 3 an outlet that has just bought the month's rice reads a Food Cost
  // % in the hundreds — and here that lands as a red ▲ under a tooltip inviting the owner to
  // act on it, then reads a healthy 31% ✓ by day 30 with nothing having changed. Prime Cost %
  // and True Net Margin % both CONTAIN food cost, so they inherit it.
  //
  // Labor Cost % deliberately keeps its band throughout: it is prorated by elapsed days against
  // revenue that accrues over the same days, so the ratio is meaningful from day one. Greying a
  // figure that IS settled would be its own lie, and the point of this guard is that a verdict
  // is only shown once it has been earned — not that early-month figures are all suspect. (Its
  // one unprorated input is approved OT for the whole month, a small share of the total; that is
  // noise around a real figure rather than the lumpiness above.)
  const bsNow = getBsToday()
  const isCurrentPeriod = !!activePeriod && activePeriod.bs_year === bsNow.year && activePeriod.bs_month === bsNow.month
  const periodDays = activePeriod ? daysInBsMonth(activePeriod.bs_year, activePeriod.bs_month) : 30
  const dayOfPeriod = isCurrentPeriod ? bsNow.day : periodDays
  const SETTLE_DAY = 10 // matches ClientDashboard's own threshold, deliberately
  const periodTooEarly = isCurrentPeriod && dayOfPeriod < SETTLE_DAY
  const partialNote = periodTooEarly ? `Day ${dayOfPeriod} of ${periodDays} · settles at month end` : null
  // The banded figure, with both the colour AND the ✓/△/▲ withheld before SETTLE_DAY — a mark
  // on a day-4 food cost is the same claim in a quieter voice.
  const settledFigure = (pct, bander) => {
    const f = bandFigure(pct, bander)
    if (pct == null) return { color: 'var(--theme-text2)', title: undefined, text: f.text }
    if (periodTooEarly) return { color: 'var(--theme-text1)', title: undefined, text: `${pct.toFixed(1)}%` }
    return { color: f.style.color, title: f.title, text: f.text }
  }

  const trendChartData = trendReports.map(r => {
    const c = r.snapshot?.combined || {}
    return {
      label: `${BS_MONTHS_SHORT[r.bs_month - 1]} ${r.bs_year}`,
      fc: c.foodCostPct != null ? Number(c.foodCostPct.toFixed(1)) : null,
      labor: c.laborCostPct != null ? Number(c.laborCostPct.toFixed(1)) : null,
      prime: c.primeCostPct != null ? Number(c.primeCostPct.toFixed(1)) : null,
      margin: c.netMarginPct != null ? Number(c.netMarginPct.toFixed(1)) : null,
    }
  })
  const hasTrendData = trendChartData.some(d => d.prime != null || d.margin != null)

  // Returns a spreadable props object so every KPI card gets keyboard support and a visible focus
  // ring. The card itself is .stat-card, not a hand-rolled box: these live in a .stat-grid, which
  // is gap:0 because .stat-card collapses each pair of adjacent borders into one drawn line via
  // its own -1px margins and drops its shadow to do it. The inline copy here reproduced
  // .stat-card's five box properties but neither of those two, so nine KPI cells butted 1px
  // borders into 2px double rules with their shadows overlapping at every join — and drifted to a
  // fourth padding (14x16 against the class's 20) while they were at it. Only the cursor and the
  // interaction props are this call site's business.
  const kpiCard = (onClick) => ({
    className: onClick ? 'stat-card interactive-card' : 'stat-card',
    ...(onClick ? {
      style: { cursor: 'pointer' },
      onClick,
      role: 'button',
      tabIndex: 0,
      onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }
    } : {})
  })

  // The label / value / subtext styles were typed out inline on all nine cards, and had already
  // drifted: the Profitability row used marginBottom 6 / marginTop 5 and the Operations row 4 / 4,
  // with nothing choosing either. Three helpers, same shape as ClientDashboard.jsx's, so the two
  // rows can only differ where a difference is meant. Sizes are the DESIGN.md ramp: 24 is the
  // `stat-value` step the Group Console and Consolidated P&L already render their headline
  // figures at, 22 is `numeral`, 18 is `section-heading`. The old 28px/weight-800 was on neither
  // the size ramp nor the weight set, and made Food Cost % outrank Revenue in a row of peers.
  const kpiLabelStyle = { fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }
  const kpiSubtextStyle = { fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }
  // tabular-nums, because these cards are hand-rolled and so miss the `table.data-table td,
  // .stat-value` rule that gives every other figure in the product aligned digits. Five
  // percentages sit in one row here to be compared against each other, and proportional numerals
  // make 11.1% and 88.8% different widths.
  const kpiValueStyle = (size, weight = 700) => ({ fontSize: size, fontWeight: weight, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' })

  // Owner-or-admin only, matching this page's nav entry in Layout.js. The route sat inside
  // ProtectedRoute + SuiteGate alone, and neither of those checks a ROLE — so any staff account of
  // a Suite Pro client could reach the Owner Dashboard directly by URL. Same lapse as /pnl; the
  // third page behind the same nav condition, MonthlyOwnerReport, has always had this line.
  // Placed after every hook (rules of hooks) and safe against auth timing because ProtectedRoute
  // has already resolved `profile` before this component mounts.
  if (!isAdmin && !isOwner) return <Navigate to="/dashboard" replace />

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
          {/* A real button rather than role="link" on a span with a hand-rolled key handler —
              same affordance, native semantics, and it picks up the shared focus ring. */}
          <button className="btn-linklike" onClick={() => navigate('/owner-report')}>
            View Full Monthly Report →
          </button>
        </p>
      </div>

      <SuiteGate featureKey="owner_dashboard">
        {/* A load failure used to be indistinguishable from "this figure is genuinely zero" —
            every sub-loader silently discarded Supabase's error field. Each one sets its own key
            here and clears it on a successful (re)load, so a real fetch failure shows a
            dismissible, retry-able banner instead of a wrong-looking number on the one dashboard
            whose whole purpose is trustworthy figures. */}
        {Object.entries(loadErrors).filter(([, msg]) => msg).map(([section, msg]) => (
          <div key={section} className="card dash-row" style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16,
            borderColor: 'color-mix(in srgb, var(--theme-red) 25%, transparent)',
            background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)',
          }}>
            <p style={{ color: 'var(--theme-red-text)', margin: 0, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
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
          <div className="card dash-row" style={{ borderColor: 'color-mix(in srgb, var(--theme-amber) 15%, transparent)', background: 'color-mix(in srgb, var(--theme-amber) 5%, transparent)' }}>
            <p style={{ color: 'var(--theme-amber-text)', margin: 0, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
              <TriangleAlert size={15} aria-hidden="true" /> Owner Dashboard needs both Crest IMS and Crest HR enabled — this property has {clientModules.ims ? 'only IMS' : clientModules.hr ? 'only HR' : 'neither'}.
            </p>
          </div>
        )}
        {clientModules.ims && clientModules.hr && !activePeriod && !loading && (
          <div
            className="card interactive-card dash-row" style={{ cursor: 'pointer', borderColor: 'color-mix(in srgb, var(--theme-accent) 30%, transparent)' }}
            onClick={() => navigate('/periods')} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('/periods') } }}
          >
            <p style={{ color: 'var(--theme-accent-ink)', margin: 0, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}><TriangleAlert size={15} aria-hidden="true" /> No open period. Click here to create one in Periods →</p>
          </div>
        )}

        {/* No visible section title for either KPI row in the original design — an sr-only
            heading gives screen-reader users a landmark to navigate by without changing the
            visual layout. */}
        <h2 className="sr-only">Profitability (month-to-date)</h2>
        <div className="stat-grid dash-section">

          <div {...kpiCard(() => navigate('/sales'))}>
            <div style={kpiLabelStyle}>Revenue (MTD)</div>
            <div style={{ ...kpiValueStyle(24), color: 'var(--theme-green-text)' }}>{loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : fmt(revenueTotal)}</div>
            <div style={kpiSubtextStyle}>From sales entries →</div>
          </div>

          <div {...kpiCard(() => navigate('/variance'))}>
            <div style={kpiLabelStyle}>
              <Tip text={`Net purchases ÷ revenue × 100. Coloured against your own Settings thresholds — watch above ${fcBand(fcPct, settings).warn}%, too high above ${fcBand(fcPct, settings).critical}% — the same scale Variance and Recipes use. Nepal F&B benchmark: 28–35%.`} width={260}>Food Cost % (MTD)</Tip>
            </div>
            <div title={settledFigure(fcPct, fcCardBand).title} style={{ ...kpiValueStyle(24), color: settledFigure(fcPct, fcCardBand).color }}>
              {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : settledFigure(fcPct, fcCardBand).text}
            </div>
            <div style={kpiSubtextStyle}>{partialNote || `Your target ≤${fcBand(fcPct, settings).warn}% →`}</div>
          </div>

          <div {...kpiCard(() => navigate('/hr/payroll'))}>
            <div style={kpiLabelStyle}>
              <Tip text="Prorated estimate: gross + overtime + employer SSF, scaled to days elapsed this month. Refines to the exact figure once Payroll Run is finalized. Healthy range for Nepal F&B: 25-30% of revenue." width={280}>Labor Cost % (MTD)</Tip>
            </div>
            {/* Banded through `lcBand`, not an inline ternary. The thresholds were already the
                Monthly Owner Report's 30/37 — but written out a second time here, and WITHOUT the
                ✓/△/▲ mark, so this tile carried its verdict in hue alone while the Food Cost tile
                immediately to its left carried `fcBand`'s mark. Same for Prime Cost and Net Margin
                below (S660). */}
            <div style={{ ...kpiValueStyle(24), color: lcBand(laborPct).color }} title={laborPct != null ? lcBand(laborPct).label : undefined}>
              {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : bandFigure(laborPct, lcBand).text}
            </div>
            <div style={kpiSubtextStyle}>Target 25-30% · estimate →</div>
          </div>

          <div {...kpiCard()}>
            <div style={kpiLabelStyle}>
              <Tip text="Food Cost % + Labor Cost % — the two controllable costs combined, the number operators actually benchmark against. Industry standard: 60-65% of revenue." width={280}>Prime Cost % (MTD)</Tip>
            </div>
            <div style={{ ...kpiValueStyle(24), color: settledFigure(primeCostPct, pcBand).color }} title={settledFigure(primeCostPct, pcBand).title}>
              {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : settledFigure(primeCostPct, pcBand).text}
            </div>
            {/* Prime and True Net Margin both CONTAIN the prorated labour estimate, and both used
                to present themselves as exact — only the Labor card said "Estimate", and only in
                11px text3 with the substance hidden in a hover Tip. A figure carrying a red/amber/
                green verdict has to disclose its basis where it is read, not on hover. Matches how
                the Monthly Owner Report prints "· estimated — no payroll finalized for this
                period" inline. */}
            {/* The labour-estimate disclosure is load-bearing (S660) and must survive the
                partial-period note rather than being replaced by it. */}
            <div style={kpiSubtextStyle}>{partialNote ? `Day ${dayOfPeriod} of ${periodDays} · includes labour estimate` : 'Target ≤60-65% · includes labour estimate'}</div>
          </div>

          {/* The ternary was inverted: a client who HAS Overheads got the non-clickable card (the
              most important number on the page, and the only unclickable one in this row), while a
              client who does NOT got a card that navigated to a page they cannot open. */}
          <div {...kpiCard(canOverheads ? () => navigate('/overheads') : null)}>
            <div style={kpiLabelStyle}>
              <Tip text="Revenue minus food cost, labor cost, and overheads, as a % of revenue. This is what the business actually keeps." width={260}>True Net Margin % (MTD)</Tip>
            </div>
            {/* `canOverheads` gates the FIGURE, not just its colour: without Overheads this is not
                a margin at all, so it must stay unbanded and unmarked rather than being painted a
                verdict on a number the page cannot compute. */}
            <div style={{ ...kpiValueStyle(24), color: canOverheads ? settledFigure(netMarginPct, nmBand).color : 'var(--theme-text2)' }}
              title={canOverheads ? settledFigure(netMarginPct, nmBand).title : undefined}>
              {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : !canOverheads ? '—' : settledFigure(netMarginPct, nmBand).text}
            </div>
            <div style={kpiSubtextStyle}>
              {!canOverheads ? 'Requires Overheads (Pro) →'
                : !loading && overheadTotal === 0 ? 'Excludes overhead — not entered'
                : partialNote ? `Day ${dayOfPeriod} of ${periodDays} · includes labour estimate`
                : 'After food, labour & overhead · includes labour estimate'}
            </div>
          </div>
        </div>

        <h2 className="sr-only">Operations</h2>
        <div className="stat-grid dash-section">

          <div {...kpiCard(() => navigate('/wastage-report'))}>
            <div style={kpiLabelStyle}>Wastage Value (MTD)</div>
            <div style={{ ...kpiValueStyle(22), color: stats?.wastageValueTotal > 0 ? 'var(--theme-red-text)' : 'var(--theme-text1)' }}>
              {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : fmt(stats?.wastageValueTotal)}
            </div>
            <div style={kpiSubtextStyle}>This period →</div>
          </div>

          <div {...kpiCard(() => navigate('/reorder'))}>
            <div style={kpiLabelStyle}>
              <Tip text="Items whose current stock is at or below par level — a live inventory position, not a monthly total." width={260}>Items Below Par</Tip>
            </div>
            <div style={{ ...kpiValueStyle(22), color: reorderStats?.count > 0 ? 'var(--theme-red-text)' : 'var(--theme-text1)' }}>
              {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : (reorderStats?.count ?? 0)}
            </div>
            <div style={kpiSubtextStyle}>
              {!loading && reorderStats?.estValueTotal > 0 ? `${fmt(reorderStats.estValueTotal)} to restock →` : 'Full Report →'}
            </div>
          </div>

          <div {...kpiCard(() => navigate('/payables'))}>
            <div style={kpiLabelStyle}>
              <Tip text="Credit purchases unpaid for more than 60 days." width={220}>Overdue Payables</Tip>
            </div>
            <div style={{ ...kpiValueStyle(22), color: payablesStats?.overdueTotal > 0 ? 'var(--theme-red-text)' : 'var(--theme-text1)' }}>
              {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : fmt(payablesStats?.overdueTotal)}
            </div>
            <div style={kpiSubtextStyle}>
              {!loading && payablesStats?.overdueCount > 0 ? `${payablesStats.overdueCount} bill${payablesStats.overdueCount === 1 ? '' : 's'} →` : 'Full Report →'}
            </div>
          </div>

          <div {...kpiCard(() => navigate('/payments'))}>
            <div style={kpiLabelStyle}>
              <Tip text="Net purchases (this period) split by payment method — not a revenue split." width={260}>Purchases · Cash / Credit</Tip>
            </div>
            <div style={{ ...kpiValueStyle(18), color: 'var(--theme-text1)' }}>
              {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : (
                /* Two figures, so this is the one KPI value on the page that can legitimately take
                   two lines — but it was breaking INSIDE the second amount ("… / NPR" then
                   "1,204,000"). Each amount is the unbreakable atom; the slash is where a break
                   belongs. */
                <>
                  <span style={{ whiteSpace: 'nowrap' }}>{fmt(stats?.cashNet)}</span>
                  {' / '}
                  <span style={{ whiteSpace: 'nowrap' }}>{fmt(stats?.creditNet)}</span>
                </>
              )}
            </div>
            <div style={kpiSubtextStyle}>Cash / Credit →</div>
          </div>
        </div>

        {trendLoading ? (
          <div className="card card--compact">
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Cost &amp; Margin — Trend</div>
            <span className="skeleton" style={{ display: 'inline-block', width: '100%', height: '4em' }} />
          </div>
        ) : !hasTrendData ? (
          /* This used to render `false` — no card, no heading, nothing, just a gap where a chart
             belongs. A Suite Pro client paying for the trend view deserves to be told it fills in
             rather than left to assume the page is broken. */
          <div className="card card--compact">
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Cost &amp; Margin — Trend</div>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
              Your cost and margin history appears here once your first period closes. Each closed
              period adds a point, so the trend builds up month by month.
            </p>
          </div>
        ) : (
          <ChartCard
            title="Cost & Margin — Trend"
            legend={<>
              {/* The series colour sits on the swatch only. As 10px TEXT the chart palette measured
                  1.9–2.5:1 on the Light card (S682) — a chart series may take colour alone, a
                  label a person reads may not. */}
              {[['fc', 'Food Cost %'], ['labor', 'Labor Cost %'], ['prime', 'Prime Cost %'], ['margin', 'Net Margin %']].map(([k, label]) => (
                <span key={k}><span aria-hidden="true" style={{ color: TREND_COLORS[k] }}>●</span> {label}</span>
              ))}
            </>}
            footer={<p className="sr-only">Trend of Food Cost %, Labor Cost %, Prime Cost %, and Net Margin % across the last {trendChartData.length} closed periods, sourced from each period's frozen Monthly Owner Report snapshot.</p>}
            renderChart={h => (
              <ResponsiveContainer width="100%" height={h}>
                <LineChart data={trendChartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={colors.border} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: colors.text3, fontSize: 10 }} tickLine={false} axisLine={false} interval={0} />
                  <YAxis tick={{ fill: colors.text3, fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={v => `${v}%`} domain={['auto', 'auto']} width={40} />
                  <RTooltip
                    contentStyle={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', fontSize: 11, color: 'var(--theme-text1)' }}
                    labelStyle={{ color: 'var(--theme-text1)' }}
                    formatter={(v, name) => [v != null ? `${v}%` : '—', name]}
                  />
                  <Line type="monotone" dataKey="fc" name="Food Cost %" stroke={TREND_COLORS.fc} strokeWidth={2} connectNulls dot={{ r: 2 }} {...chartMotion()} />
                  <Line type="monotone" dataKey="labor" name="Labor Cost %" stroke={TREND_COLORS.labor} strokeWidth={2} connectNulls dot={{ r: 2 }} {...chartMotion()} />
                  <Line type="monotone" dataKey="prime" name="Prime Cost %" stroke={TREND_COLORS.prime} strokeWidth={2.5} strokeDasharray="6 3" connectNulls dot={{ r: 3 }} {...chartMotion()} />
                  <Line type="monotone" dataKey="margin" name="Net Margin %" stroke={TREND_COLORS.margin} strokeWidth={2} connectNulls dot={{ r: 2 }} {...chartMotion()} />
                </LineChart>
              </ResponsiveContainer>
            )}
          />
        )}
      </SuiteGate>
    </div>
  )
}
