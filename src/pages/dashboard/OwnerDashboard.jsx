import { npr } from '../../shared/nepalMoney'
import { useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { TriangleAlert } from 'lucide-react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { chartMotion } from '../../shared/chartMotion'
import { COST_BREAKDOWN_COLORS } from '../../shared/chartColors'
import { TOOLTIP_CHROME } from '../../shared/tooltipChrome'
import { useAuth } from '../../context/AuthContext'
import { useTheme } from '../../context/ThemeContext'
import { supabase } from '../../supabaseClient'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../shared/fetchAllRows'
import { settleWithin } from '../../utils/withTimeout'
import { BS_MONTHS, bsDayBoundaryIso } from '../../utils/bsCalendar'
import { useSettings } from '../../context/SettingsContext'
import { fcBand } from '../../shared/imsFormulas'
import { lcBand, pcBand, nmBand, bandFigure } from '../../shared/operatingBands'
import Tip from '../../components/Tip'
import SuiteGate, { SUITE_PAGES, useSuiteAccess } from '../../components/SuiteGate'
import ChartCard from '../../components/ChartCard'
import ActionError, { asActionError } from '../../components/ActionError'
import SupportContactLine from '../../components/SupportContactLine'
import { explodeRecipeIngredients, loadRecipeBook } from '../../utils/recipeCost'
import { loadDeltaExplosion } from '../../utils/orderLineIngredients'
import { buildStockRows, summarizeReorder } from '../../modules/ims/stockcount/stockReportCalc'
import { periodWastageValue, WASTAGE_VALUE_SELECT } from '../../modules/ims/reports/periodCost'
import { SPEND_SO_FAR_LABEL, SPEND_SO_FAR_TIP } from '../../modules/ims/reports/foodCostBasis'
import { readPeriodTransfers } from '../../modules/ims/transfers/transferFlows'
import { FEATURE_TIER } from '../../shared/featureCatalog'
import { splitOverheadBuckets, resolveOutletLabour, outletLabourNotes, labourNotJudgedText } from '../../modules/dashboard/labourSource'
import { loadOutletLabour } from '../../modules/dashboard/loadOutletLabour'
import { mtdClock, countedDaysText } from '../../modules/dashboard/mtdClock'
import {
  tileState, revenueOf, netSpendOf, operatingFigures, cashCreditSplit, loadOverdueCreditBills, trendWithBasis,
} from '../../modules/dashboard/ownerDashboardData'
import { loadDeliveryCommission, bsMonthWindow } from '../../shared/deliveryCommission'

// Cost & Margin trend series. Fixed hex, for the reason DESIGN.md states by name: the semantic
// token set is five ROLES, not five distinguishable hues (accent and purple are the same value on
// Dracula, Catppuccin Mocha and Latte, so Food Cost and Labor drew as one line there). Food Cost, Labor
// and Net Margin take their slots from COST_BREAKDOWN_COLORS (shared/chartColors.js, brute-forced
// against the CVD floors), so each keeps the colour the Dashboard's cost pie gives it. Prime Cost is
// the SUM of two lines above it, so it keeps a local violet and a dash rather than a peer's colour.
const TREND_COLORS = {
  fc:     COST_BREAKDOWN_COLORS['Food Cost'],  // gold — the Food Cost slice
  labor:  COST_BREAKDOWN_COLORS['Labor'],      // blue — the Labor slice
  prime:  '#8b5cf6',                           // violet, dashed (a derived total, not a peer)
  margin: COST_BREAKDOWN_COLORS['Net Margin'], // green — profit reads as good
}

// Every read settles within this; a timeout is that section's failure (OWNER-DASHBOARD-16).
const READ_TIMEOUT_MS = 20000
// Spend % so far, Prime and True Net Margin carry stock purchases, which arrive in lumps (a month's
// rice bought on day 3), so they earn a verdict from day 10, ClientDashboard's threshold. Fixed costs
// are prorated and labour is accrued to yesterday, so neither is lumpy any more (S849).
const SETTLE_DAY = 10

// One union read per table for the month (OWNER-DASHBOARD-9): the IMS figures and the reorder tile
// used to read five of these twice.
const PURCHASE_COLS = 'id, item_id, qty, rate, bs_day, payment_method, discount_amount, purchase_group_id, vendor_id, invoice_ref, vat_inclusive, vat_is_cost'
const RETURN_COLS = 'item_id, qty, rate, bs_day, payment_method, purchase_entry_id, purchase_entries(vat_inclusive, vat_is_cost)'
// `source` is SELECTED and comps are filtered in JS (revenueOf), never `.neq('source','pos_comp')`:
// the column is nullable and `NULL <> 'pos_comp'` dropped every legacy row from revenue (S734).
const SALES_COLS = 'recipe_id, qty_sold, unit_price, discount, source, bs_day, ingredient_deltas'

// The page's sections. A tile renders a figure only when every section it depends on is `ok`.
const SECTION_NAMES = ['period', 'ims', 'reorder', 'payables', 'labour', 'commission', 'trend']
const PERIOD_DEPENDENT = ['ims', 'reorder', 'labour', 'commission']
const initialSections = () => Object.fromEntries(SECTION_NAMES.map(n => [n, { status: 'loading', error: null, data: null }]))

// What each failed section takes off the page, said before the technical reason (error-messages.md).
const SECTION_CONSEQUENCE = {
  period: 'Could not check which month is open, so this month\'s figures are not shown.',
  ims: 'Sales, purchases and fixed costs could not be loaded, so Revenue, Spend % so far, the margins, Wastage and Cash / Credit are not shown.',
  reorder: 'The stock position could not be loaded, so Items Below Par is not shown.',
  payables: 'Unpaid supplier bills could not be loaded, so Overdue Payables is not shown.',
  labour: 'Labour could not be loaded, so Labor Cost %, Prime Cost % and True Net Margin % are not shown.',
  commission: 'Delivery-partner commission could not be loaded, so True Net Margin % is not shown.',
}

// Owner Dashboard — the cross-module month-to-date view: Crest IMS + HR, with till sales arriving
// through sales entries (every closed POS bill posts a sales_entries row). Every figure is for the
// client's single open monthly_periods row; ratios count the days already finished (mtdClock).
export default function OwnerDashboard() {
  const { profile, clientId, hasFeature, loading: authLoading, isAdmin, isOwner, imsEnabled, hrEnabled, posEnabled } = useAuth()
  const canOverheads = hasFeature('overheads')
  // 'growth' → 'Growth' — the plan Overheads is sold on, for the upsell line under True Net Margin.
  const overheadsTier = (t => (t ? t[0].toUpperCase() + t.slice(1) : ''))(FEATURE_TIER.overheads)
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const navigate = useNavigate()
  const { colors } = useTheme()
  // The FC verdict colour comes from the client's OWN Settings thresholds via fcBand().
  const { settings } = useSettings()
  const fcCardBand = pct => fcBand(pct, settings)

  // OWNER-DASHBOARD-15 (ACCESS C3): nothing is read until the same test SuiteGate renders from has
  // passed, and only for the Owner or the operator. A staff login or an Owner without Suite reads
  // nothing. The page needs both modules (its labour comes from HR); the operator passes the gate
  // whatever the modules, so the module test is repeated here for the load.
  const suite = useSuiteAccess(SUITE_PAGES.ownerDashboard)
  const modulesOn = !!imsEnabled && !!hrEnabled
  const posOn = !!posEnabled
  const canLoad = !authLoading && suite.allowed && (isAdmin || isOwner) && modulesOn

  const [sections, setSections] = useState(initialSections)
  // { open: row|null, latest: row|null, clock } — the clock is fixed for one load, so every section of
  // it counts the same finished days.
  const [periodInfo, setPeriodInfo] = useState(null)
  // Banners the reader closed, by section → the error object closed. A new failure shows again.
  const [hiddenBanners, setHiddenBanners] = useState({})

  // One request counter PER SECTION (OWNER-DASHBOARD-6). Retry on one section bumps only its own
  // counter and re-runs only its loader; a loader checks its own counter after every await before any
  // setter, so a stale response never repaints a tile and a retry never freezes the others. A client
  // switch restarts every section, which supersedes everything in flight (S734's view-as race).
  const reqRef = useRef({})
  const periodRef = useRef(null)
  const begin = name => { const id = (reqRef.current[name] || 0) + 1; reqRef.current[name] = id; return id }
  const isCurrent = (name, id) => reqRef.current[name] === id
  const setSection = (name, value) => setSections(prev => ({ ...prev, [name]: { error: null, data: null, ...value } }))
  const read = (promise, label) => settleWithin(promise, READ_TIMEOUT_MS, label)

  useEffect(() => {
    if (!canLoad || !effectiveClientId) return
    loadEverything()
  }, [canLoad, effectiveClientId, posOn]) // eslint-disable-line react-hooks/exhaustive-deps

  function loadEverything() {
    // The recipe book starts beside the period read; the reorder walk reads it from memory (S793).
    const bookPromise = loadRecipeBook(scopedFrom)
    bookPromise.catch(() => {}) // a failure is the reorder section's, reported where it is awaited
    loadPayables()
    loadTrend()
    loadPeriod(bookPromise)
  }

  function retry(section) {
    const p = periodRef.current
    if (section === 'period') loadEverything()
    else if (section === 'payables') loadPayables()
    else if (section === 'trend') loadTrend()
    else if (section === 'ims' && p?.open) loadPeriodSections(p.open, ['ims'], null, p.clock)
    else if (section === 'reorder' && (p?.open || p?.latest)) {
      const book = loadRecipeBook(scopedFrom); book.catch(() => {})
      loadPeriodSections(p.open || p.latest, ['reorder'], book, p.clock)
    }
    else if (section === 'labour' && p?.open) loadLabour(p.open, p.clock)
    else if (section === 'commission' && p?.open) loadCommission(p.open, p.clock)
  }

  // ── The month: the open period, else the latest one (the reorder tile's fallback) ──
  async function loadPeriod(bookPromise) {
    const id = begin('period')
    // Claim every dependent section now, so nothing in flight for an earlier load can land.
    const depIds = Object.fromEntries(PERIOD_DEPENDENT.map(n => [n, begin(n)]))
    setSection('period', { status: 'loading' })
    PERIOD_DEPENDENT.forEach(n => setSection(n, { status: 'loading' }))
    // The previous load's month leaves the header with it (a client switch, a Retry).
    periodRef.current = null
    setPeriodInfo(null)
    // Tens of rows at most: one per month the client has run. The newest first.
    const res = await read(scopedFrom('monthly_periods', 'id, bs_year, bs_month, status')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false }).limit(24), 'Months')
    if (!isCurrent('period', id)) return
    if (res.error) {
      // The dependents wait on the month: their tiles say "Couldn't load" through the period section.
      setSection('period', { status: 'failed', error: res.error })
      PERIOD_DEPENDENT.forEach(n => { if (isCurrent(n, depIds[n])) setSection(n, { status: 'none', data: { blocked: true } }) })
      return
    }
    const rows = res.data || []
    const open = rows.find(r => r.status === 'open') || null
    const latest = rows[0] || null
    const clock = mtdClock(open)
    const info = { open, latest, clock }
    periodRef.current = info
    setPeriodInfo(info)
    setSection('period', { status: 'ok', data: info })

    if (!open) {
      // OWNER-DASHBOARD-10: no open month. The month's figures are "none" (a dash and "No open month"),
      // never every item counted below par. The reorder tile falls back to the latest month, as the
      // Reorder Report does, and says which.
      ;['ims', 'labour', 'commission'].forEach(n => setSection(n, { status: 'none' }))
      if (latest) loadPeriodSections(latest, ['reorder'], bookPromise, mtdClock(latest))
      else setSection('reorder', { status: 'none' })
      return
    }
    loadPeriodSections(open, ['ims', 'reorder'], bookPromise, clock)
    loadLabour(open, clock)
    loadCommission(open, clock)
  }

  // ── The month's batch: IMS figures and the reorder rows from ONE read per table ──
  async function loadPeriodSections(period, which, bookPromise, clock) {
    const ids = Object.fromEntries(which.map(n => [n, begin(n)]))
    which.forEach(n => setSection(n, { status: 'loading' }))
    const wantIms = which.includes('ims')
    const wantReorder = which.includes('reorder')
    const pid = period.id
    const skip = Promise.resolve({ data: [], error: null })
    const [purchases, returns, sales, recipes, wastages, transfers, overheads, opening, closing, items, pars, staffMeals] = await Promise.all([
      // `discount_amount` + the bill keys feed allocateBillDiscounts (net of each bill's discount);
      // `id` and `payment_method` feed the Payment Report's cash/credit split (billPayables).
      read(fetchAllRows(() => supabase.from('purchase_entries').select(PURCHASE_COLS).eq('period_id', pid).order('id')), 'Purchases'),
      // Paged (S734): subtracted from net purchases, so a truncation OVERSTATES Spend % so far.
      read(fetchAllRows(() => scopedFrom('vendor_returns', RETURN_COLS).eq('period_id', pid).order('id')), 'Supplier returns'),
      read(fetchAllRows(() => supabase.from('sales_entries').select(SALES_COLS).eq('period_id', pid).order('id')), 'Sales'),
      // Paged, and a PRODUCER: the price fallback for a sales row with no unit_price (S734).
      read(fetchAllRows(() => scopedFrom('recipes', 'id, selling_price').order('id')), 'Recipes'),
      // Each row carries its item's rate (WASTAGE_VALUE_SELECT): the Wastage Report's own total.
      read(fetchAllRows(() => supabase.from('wastages').select(WASTAGE_VALUE_SELECT).eq('period_id', pid).order('id')), 'Wastage'),
      // Stock received from / sent to the group's other outlets (PNL-8): in adds like a purchase, out
      // comes off like a return. A failed read fails the month's figures, never a spend without it.
      read(readPeriodTransfers(scopedFrom, [pid]), 'Stock transfers'),
      // Deliberately not paged: tens of rows per month. EVERY bucket (S849, GAPS-4): the Labor tab is
      // read so it can be named "not counted" — Crest HR is this page's labour figure.
      wantIms ? read(scopedFrom('overheads', 'amount, bucket').eq('period_id', pid), 'Overheads') : skip,
      // Six paged master/period reads for the reorder tile (S734): a row past a truncated read reads
      // as a zero count and takes an item off the below-par count silently.
      wantReorder ? read(fetchAllRows(() => supabase.from('opening_stock').select('item_id, qty').eq('period_id', pid).order('id')), 'Opening stock') : skip,
      wantReorder ? read(fetchAllRows(() => supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', pid).order('id')), 'Closing stock') : skip,
      wantReorder ? read(fetchAllRows(() => scopedFrom('items', 'id, per_uom_rate, yield_pct').eq('is_active', true).eq('is_sub_recipe', false).order('id')), 'Items') : skip,
      wantReorder ? read(fetchAllRows(() => scopedFrom('par_levels', 'item_id, par_qty').order('id')), 'Par levels') : skip,
      wantReorder ? read(fetchAllRows(() => supabase.from('staff_meals').select('item_id, qty').eq('period_id', pid).order('id')), 'Staff meals') : skip,
    ])

    if (wantIms && isCurrent('ims', ids.ims)) {
      const failed = [purchases, returns, sales, recipes, wastages, transfers, overheads].find(r => r.error)
      if (failed) setSection('ims', { status: 'failed', error: failed.error })
      else {
        const priceMap = {}
        ;(recipes.data || []).forEach(r => { priceMap[r.id] = parseFloat(r.selling_price) || 0 })
        const { overhead, taxFees, labor } = splitOverheadBuckets(overheads.data)
        const cc = cashCreditSplit(purchases.data, returns.data, period)
        setSection('ims', {
          status: 'ok',
          data: {
            revenue: revenueOf(sales.data, priceMap, clock),
            spend: netSpendOf({ purchases: purchases.data, returns: returns.data, transfers: transfers.data, clock }),
            overhead, taxFees, labourBucket: labor,
            // Informational, like every Wastage tile: nothing on this page adds it to a cost.
            wastage: periodWastageValue(wastages.data),
            cash: cc.cash, credit: cc.credit,
          },
        })
      }
    }

    if (!wantReorder || !isCurrent('reorder', ids.reorder)) return
    const failed = [purchases, returns, sales, recipes, wastages, transfers, opening, closing, items, pars, staffMeals].find(r => r.error)
    if (failed) { setSection('reorder', { status: 'failed', error: failed.error }); return }
    // The recipe walk reads the book in memory (`{ book }`, no extra round trips); a customized plate
    // also consumes its options' stock lines (S758). Either one missing means usage was not computed,
    // and without usage on-hand is opening + purchases: the count is withheld (S792, PLANNING-6).
    const recipeIds = (recipes.data || []).map(r => r.id)
    const [walkRes, deltaRes] = await Promise.allSettled([
      recipeIds.length > 0
        ? Promise.resolve(bookPromise).then(book => explodeRecipeIngredients(supabase, recipeIds, book ? { book } : undefined))
        : Promise.resolve({}),
      loadDeltaExplosion(supabase, (sales.data || []).map(s => s.ingredient_deltas)),
    ])
    if (!isCurrent('reorder', ids.reorder)) return
    const walkFailed = [walkRes, deltaRes].find(r => r.status === 'rejected')
    if (walkFailed) {
      console.error('Owner Dashboard: the recipe walk failed', walkFailed.reason)
      setSection('reorder', { status: 'failed', error: walkFailed.reason })
      return
    }
    // The Reorder Report's own on-hand / below-par calculation (S696), stock transfers included.
    const rows = buildStockRows({
      items: items.data, opening: opening.data, closing: closing.data, purchases: purchases.data, returns: returns.data,
      wastages: wastages.data, staffMeals: staffMeals.data, sales: sales.data, breakdown: walkRes.value,
      pars: pars.data, explosion: deltaRes.value, transfers: transfers.data,
    })
    setSection('reorder', { status: 'ok', data: { ...summarizeReorder(rows), period } })
  }

  // ── Labour: the one rule (GAPS-4, SU11 (a)) — finalized payroll, else the HR wage estimate ──
  async function loadLabour(period, clock) {
    const id = begin('labour')
    setSection('labour', { status: 'loading' })
    // Accrued to yesterday (countedDays); a finalized run in the running month is scaled to the
    // finished days (SU4 (a)). The Labor tab is resolved at render from the overheads read.
    const { labour, parts, error } = await loadOutletLabour((t, c) => scopedFrom(t, c), {
      period, hrOn: !!hrEnabled, fenced: false, throughDay: clock.countedDays, scale: clock.fraction, timeoutMs: READ_TIMEOUT_MS,
    })
    if (!isCurrent('labour', id)) return
    if (labour.source === 'failed') setSection('labour', { status: 'failed', error: error || { message: 'Labour could not be loaded' } })
    else setSection('labour', { status: 'ok', data: parts })
  }

  // ── Delivery-partner commission on bills SOLD in the counted days (PNL-1 parity, SU3 (a)) ──
  async function loadCommission(period, clock) {
    const id = begin('commission')
    if (!posOn || clock.firstDay) { setSection('commission', { status: 'ok', data: { amount: 0, unsettledBills: 0 } }); return }
    setSection('commission', { status: 'loading' })
    const startIso = bsDayBoundaryIso(period.bs_year, period.bs_month, 1, false)
    const endIso = clock.running
      ? bsDayBoundaryIso(period.bs_year, period.bs_month, clock.countedDays + 1, false)
      : bsMonthWindow(period.bs_year, period.bs_month).endIso
    const res = await read(loadDeliveryCommission({ scopedFrom }, { startIso, endIso, posEnabled: true }), 'Delivery commission')
    if (!isCurrent('commission', id)) return
    if (res.error) setSection('commission', { status: 'failed', error: res.error })
    else setSection('commission', { status: 'ok', data: { amount: res.amount || 0, unsettledBills: res.unsettledBills || 0 } })
  }

  // ── Overdue vendor payables: cross-period, valued as Outstanding Payables (OWNER-DASHBOARD-7) ──
  async function loadPayables() {
    const id = begin('payables')
    setSection('payables', { status: 'loading' })
    const res = await loadOverdueCreditBills({ supabase, scopedFrom, clientId: effectiveClientId, timeoutMs: READ_TIMEOUT_MS })
    if (!isCurrent('payables', id)) return
    if (res.error) setSection('payables', { status: 'failed', error: res.error })
    else setSection('payables', { status: 'ok', data: res })
  }

  // ── The trend: the last 12 frozen Owner Reports, read, never re-derived ──
  async function loadTrend() {
    const id = begin('trend')
    setSection('trend', { status: 'loading' })
    // Only `combined` is drawn, and the basis helpers read only `combined` (OWNER-DASHBOARD-9).
    const res = await read(scopedFrom('monthly_owner_reports', 'bs_year, bs_month, combined:snapshot->combined')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .limit(12), 'Trend')
    if (!isCurrent('trend', id)) return
    // OWNER-DASHBOARD-11: a failed read is its own card with Retry, never "appears once your first
    // period closes".
    if (res.error) setSection('trend', { status: 'failed', error: res.error })
    else setSection('trend', { status: 'ok', data: trendWithBasis((res.data || []).slice().reverse()) })
  }

  // ── Figures ──
  const clock = periodInfo?.clock || null
  const openPeriod = periodInfo?.open || null
  const ims = sections.ims.status === 'ok' ? sections.ims.data : null
  // The labour figure, re-resolved with the month's Labor tab so an HR outlet's tab is named, never
  // counted (resolveOutletLabour, labourSource.js).
  const labour = sections.labour.status === 'ok' && clock
    ? resolveOutletLabour({ ...sections.labour.data, labourBucket: ims?.labourBucket || 0, scale: clock.fraction })
    : null
  const labourNotes = outletLabourNotes(labour)
  const commission = posOn ? (sections.commission.status === 'ok' ? sections.commission.data : null) : { amount: 0, unsettledBills: 0 }
  const figs = ims && clock ? operatingFigures({
    revenue: ims.revenue.counted, spend: ims.spend.counted, labour: labour?.amount ?? null,
    overhead: ims.overhead, taxFees: ims.taxFees, commission: commission ? commission.amount : null, clock,
  }) : null

  const periodLabel = openPeriod ? `${BS_MONTHS[openPeriod.bs_month - 1]} ${openPeriod.bs_year}` : '—'
  const monthName = openPeriod ? BS_MONTHS[openPeriod.bs_month - 1] : ''
  const daysText = countedDaysText(clock)
  const periodTooEarly = !!clock?.running && clock.today < SETTLE_DAY
  // A festival, incentive or settlement lump is paid on one day, not accrued with revenue, so while
  // the month runs it sits over part of the month's sales: no verdict on the labour tiles (S798 3c).
  // A finalized run is no longer such a case: it is scaled to the finished days (S849).
  const lumpAheadOfRevenue = !!labour?.other && !!clock?.running
  const labourWithheld = !!labour?.verdictWithheld || lumpAheadOfRevenue

  // The banded figure, with both the colour AND the ✓/△/▲ withheld when the figure has not earned a
  // verdict — a mark on a day-4 spend figure is the same claim in a quieter voice.
  const settledFigure = (pct, bander, withhold) => {
    const f = bandFigure(pct, bander)
    if (pct == null) return { color: 'var(--theme-text2)', title: undefined, text: f.text }
    if (withhold) return { color: 'var(--theme-text1)', title: undefined, text: `${pct.toFixed(1)}%` }
    return { color: f.style.color, title: f.title, text: f.text }
  }
  const spendFigure = settledFigure(figs?.spendPct ?? null, fcCardBand, periodTooEarly)
  const labourFigure = settledFigure(figs?.labourPct ?? null, lcBand, labourWithheld)
  const primeFigure = settledFigure(figs?.primePct ?? null, pcBand, periodTooEarly || labourWithheld)
  const marginFigure = settledFigure(figs?.marginPct ?? null, nmBand, periodTooEarly || labourWithheld || !!figs?.fixedMissing)

  const T = deps => tileState(sections, deps)
  const tRevenue = T(['period', 'ims'])
  const tLabour = T(['period', 'ims', 'labour'])
  const tMargin = T(['period', 'ims', 'labour', posOn ? 'commission' : null])
  const tReorder = T(['period', 'reorder'])
  const tPayables = T(['payables'])
  const reorder = sections.reorder.status === 'ok' ? sections.reorder.data : null
  const reorderFallback = reorder && !openPeriod && reorder.period
  const payables = sections.payables.status === 'ok' ? sections.payables.data : null
  const transfersLine = ims && (ims.spend.transfers.inCounted || ims.spend.transfers.outCounted)
    ? `includes transfers in ${npr(ims.spend.transfers.inCounted)} · out ${npr(ims.spend.transfers.outCounted)}`
    : ''

  const trend = sections.trend.status === 'ok' ? sections.trend.data : null
  const trendChartData = trend?.points || []
  const hasTrendData = trendChartData.some(d => d.prime != null || d.margin != null)
  // The chart in words, figures included (S852), as Home's Food Cost trend gives them: a screen
  // reader heard which lines were drawn and none of the numbers on them.
  const trendPct = v => (v == null ? 'not recorded' : `${v}%`)
  const trendSummary = `Cost and margin trend over the last ${trendChartData.length} closed month${trendChartData.length === 1 ? '' : 's'}, each from the figures frozen on the Owner Report for that month. `
    + trendChartData.map(d => `${d.label}: Food Cost ${trendPct(d.fc)}, Labor Cost ${trendPct(d.labor)}, Prime Cost ${trendPct(d.prime)}, Net Margin ${trendPct(d.margin)}`).join('; ')
    + '.'
    + ((trend?.marks || []).length > 0 ? ` The method changed at ${trend.marks.map(m => m.label).join(', ')}.` : '')

  const failedSections = SECTION_NAMES.filter(n => sections[n].status === 'failed')
  const stillLoading = SECTION_NAMES.some(n => sections[n].status === 'loading')

  // Label / value / subtext styles, one definition for every card (sizes from the DESIGN.md ramp).
  const kpiLabelStyle = { fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }
  const kpiSubtextStyle = { fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }
  // tabular-nums: five percentages sit in one row to be compared against each other.
  const kpiValueStyle = (size, weight = 700) => ({ fontSize: size, fontWeight: weight, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' })
  const skeleton = <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} />

  // One KPI card. A card that opens a page holds a Tip (a control of its own), so it cannot be
  // role="button" (OWNER-DASHBOARD-16, page-layout.md): the card keeps the mouse click and the figure
  // is the real button, named "<label>: <value>". A tile whose section failed shows a dash and
  // "Couldn't load · Retry", the Retry reloading only that section (OWNER-DASHBOARD-2/-6).
  // Called as a function, not mounted as a JSX element: a component declared inside the page would be a
  // new type on every render, remounting each card (and dropping focus from a pressed Retry).
  function kpiCard({ label, tip, tipWidth = 260, srLabel, onOpen, tile, value, valueStyle, valueTitle, size = 24, sub, extra = [], noneText = 'No open month' }) {
    const state = tile.state
    const shown = state === 'loading' ? skeleton : state === 'ok' ? value : '—'
    const style = { ...kpiValueStyle(size), ...(state === 'ok' ? valueStyle : { color: 'var(--theme-text2)' }) }
    return (
      <div className={onOpen ? 'stat-card interactive-card' : 'stat-card'} onClick={onOpen} style={onOpen ? { cursor: 'pointer' } : undefined}>
        <div style={kpiLabelStyle}>{tip ? <Tip text={tip} width={tipWidth}>{label}</Tip> : label}</div>
        {onOpen ? (
          <button type="button" className="stat-card__open" onClick={e => { e.stopPropagation(); onOpen() }}>
            <span className="sr-only">{srLabel || label}: </span>
            <span style={style} title={state === 'ok' ? valueTitle : undefined}>{shown}</span>
          </button>
        ) : (
          <div style={style} title={state === 'ok' ? valueTitle : undefined}>{shown}</div>
        )}
        <div style={kpiSubtextStyle}>
          {state === 'failed' ? (
            // A real button with the touch floor (S852): an 11px underlined word was the only way to
            // reload a failed tile on a phone.
            <>Couldn't load · <button type="button" className="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); retry(tile.failed) }}>Retry</button></>
          ) : state === 'none' ? noneText : state === 'loading' ? ' ' : sub}
        </div>
        {state === 'ok' && extra.filter(Boolean).map((line, i) => <div key={i} style={kpiSubtextStyle}>{line}</div>)}
      </div>
    )
  }

  // Owner-or-admin only, matching this page's nav entry in Layout.js (S601/S617): neither
  // ProtectedRoute nor SuiteGate checks a ROLE. After every hook (rules of hooks).
  if (!isAdmin && !isOwner) return <Navigate to="/dashboard" replace />

  const firstDayNote = 'Ratios start after today — the first full day'
  const ratioValue = (fig, firstDay) => (firstDay ? '—' : fig.text)

  return (
    <div>
      {/* The visible loading state is a shimmer per tile, which says nothing to a screen reader. */}
      <div role="status" aria-live="polite" className="sr-only">
        {!canLoad ? '' : stillLoading ? 'Loading dashboard data…'
          : failedSections.length > 0 ? `Dashboard loaded — ${failedSections.length} section${failedSections.length === 1 ? '' : 's'} could not load`
          : 'Dashboard data loaded'}
      </div>
      <div className="page-header">
        <h1 className="page-title">Owner Dashboard</h1>
        <p className="page-subtitle">
          Cross-module month-to-date view — Crest IMS + HR, till sales included
          {openPeriod && ` · ${periodLabel} · Open`}
          {' · '}
          <button className="btn-linklike" onClick={() => navigate('/owner-report')}>
            View Full Monthly Report →
          </button>
        </p>
      </div>

      {/* A render prop: nothing in the tile tree is evaluated behind the upsell card (OD-15). */}
      <SuiteGate page={SUITE_PAGES.ownerDashboard}>{() => (
        <>
          {/* One banner per failed section, with its error object, through ActionError (sentence +
              code · message fine print). × hides the banner only; the tiles keep their dashes. The
              trend reports its own failure in its card. */}
          {failedSections.filter(n => n !== 'trend' && hiddenBanners[n] !== sections[n].error).map(n => {
            const a = asActionError(sections[n].error, 'operator')
            return (
              <div key={n} className="card dash-row" style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16,
                borderColor: 'color-mix(in srgb, var(--theme-red) 25%, transparent)',
                background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)',
              }}>
                <ActionError error={{ text: `${SECTION_CONSEQUENCE[n]} ${a.text}`, detail: a.detail }} />
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => retry(n)}>Retry</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setHiddenBanners(prev => ({ ...prev, [n]: sections[n].error }))} aria-label="Hide this message">×</button>
                </div>
              </div>
            )
          })}

          {/* The operator passes the Suite gate whatever the modules; the load needs both. */}
          {!modulesOn && (
            <div className="card dash-row" style={{ borderColor: 'color-mix(in srgb, var(--theme-amber) 15%, transparent)', background: 'color-mix(in srgb, var(--theme-amber) 5%, transparent)' }}>
              <p style={{ color: 'var(--theme-amber-text)', margin: 0, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                <TriangleAlert size={15} aria-hidden="true" /> Owner Dashboard needs both Crest IMS and Crest HR enabled — this property has {imsEnabled ? 'only IMS' : hrEnabled ? 'only HR' : 'neither'}.
              </p>
            </div>
          )}

          {/* OWNER-DASHBOARD-10 + DOCS-5: only after a SUCCESSFUL period read (a failed one shows its
              banner alone). Crest opens months, so the card says who to contact; the Periods link is
              the operator's. */}
          {modulesOn && sections.period.status === 'ok' && !openPeriod && (
            <div className="card dash-row" style={{ borderColor: 'color-mix(in srgb, var(--theme-accent) 30%, transparent)' }}>
              <p style={{ color: 'var(--theme-text1)', margin: '0 0 8px', fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                <TriangleAlert size={15} aria-hidden="true" /> No month is open. Crest opens the next month when the last one is closed. If none is open, contact Crest support.
              </p>
              <SupportContactLine variant="buttons" />
              {isAdmin && (
                <p style={{ margin: '8px 0 0' }}>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/periods')}>Open Periods →</button>
                </p>
              )}
            </div>
          )}

          {modulesOn && (<>
          <h2 className="sr-only">Profitability (month-to-date)</h2>
          <div className="stat-grid dash-section">
            {kpiCard({
              label: "Revenue (MTD)",
              onOpen: () => navigate('/sales'),
              tile: tRevenue,
              tip: "Sales before VAT and after discounts; comped dishes left out; till bills included, one row per bill line. The POS Dashboard's Revenue includes VAT, so it reads about 13% higher.",
              value: npr(ims?.revenue.all),
              valueStyle: { color: 'var(--theme-text1)' },
              sub: "Before VAT · from sales entries →",
            })}

            {kpiCard({
              label: SPEND_SO_FAR_LABEL,
              srLabel: SPEND_SO_FAR_LABEL,
              onOpen: () => navigate('/variance'),
              tile: tRevenue,
              tipWidth: 280,
              tip: `${SPEND_SO_FAR_TIP} Purchases here are net of bill discounts and returns, plus stock received from your other outlets and less stock sent to them, over the days already finished. Coloured against your food cost target as a guide — watch above ${fcBand(null, settings).warn}%, too high above ${fcBand(null, settings).critical}%, set in Settings → Thresholds.`,
              value: ratioValue(spendFigure, figs?.firstDay),
              valueStyle: { color: figs?.firstDay ? 'var(--theme-text2)' : spendFigure.color },
              valueTitle: spendFigure.title,
              sub: figs?.firstDay ? firstDayNote : clock?.running ? `${daysText} · your target ≤${fcBand(null, settings).warn}% →` : `Your target ≤${fcBand(null, settings).warn}% →`,
              extra: [transfersLine],
            })}

            {kpiCard({
              label: "Labor Cost % (MTD)",
              onOpen: () => navigate('/hr/payroll'),
              tile: tLabour,
              tipWidth: 300,
              tip: "Labour as a % of revenue over the days already finished. When this month's Payroll Run is finalized, it is that run's Cost to business — pay earned + overtime + employer SSF — counted for the days that have passed while the month runs. Until then it is an estimate: each person's pay for the days that have passed — monthly staff less unpaid days on the attendance sheet; daily and hourly staff for the days or hours on the sheet, and a full day for any day not yet marked — plus overtime from approved entries and from the attendance sheet (an approved entry replaces the sheet on its day), plus employer SSF for staff enrolled with an SSF number. The Overheads Labor tab is never added. Festival allowance, incentives and leavers' final settlements finalized for this month are added in full and named; while the month runs that lump carries no verdict. Healthy range for Nepal F&B: 25-30% of revenue.",
              value: ratioValue(labourFigure, figs?.firstDay),
              valueStyle: { color: figs?.firstDay ? 'var(--theme-text2)' : labourFigure.color },
              valueTitle: labourFigure.title,
              sub: figs?.firstDay ? firstDayNote
                : labour?.verdictWithheld ? `${labourNotJudgedText(labour)} · ${labourNotes.short}`
                : lumpAheadOfRevenue ? `Lump-sum pay counted · not judged while the month runs · ${labourNotes.short}`
                : `Target 25-30% · ${labourNotes.short} →`,
              extra: labourNotes.long,
            })}

            {kpiCard({
              label: "Prime Cost % (MTD)",
              tile: tLabour,
              tipWidth: 280,
              tip: "Spend % so far + Labor Cost % — the two controllable costs combined, the number operators actually benchmark against. For the running month the food half is what you have spent on stock, not what you used, because the month has not been counted yet. Industry standard: 60-65% of revenue.",
              value: ratioValue(primeFigure, figs?.firstDay),
              valueStyle: { color: figs?.firstDay ? 'var(--theme-text2)' : primeFigure.color },
              valueTitle: primeFigure.title,
              // The labour basis is disclosed where the figure is read, never only in a hover (S660).
              sub: figs?.firstDay ? firstDayNote : `${clock?.running ? daysText : 'Target ≤60-65%'} · ${labourNotes.short}`,
            })}

            {/* `canOverheads` gates the FIGURE, not just its colour: without Overheads this is not a
                margin at all. */}
            {kpiCard({
              label: "True Net Margin % (MTD)",
              onOpen: canOverheads ? () => navigate('/overheads') : null,
              tile: canOverheads ? tMargin : { state: 'ok' },
              tip: `Revenue minus what you have spent on stock so far (net purchases, stock moved between your outlets included), labour, overheads and tax & fees (card and bank fees, the accountant, licences)${posOn ? ', and delivery-partner commission (Foodmandu, Pathao) on bills sold this month' : ''}, as a % of revenue — what the business keeps. For the month in progress, rent and other fixed costs are counted for the days that have passed, so the margin is the month's real rate. The stock half is spend, not stock used, until the month's count closes it.`,
              value: !canOverheads ? '—' : ratioValue(marginFigure, figs?.firstDay),
              valueStyle: { color: !canOverheads || figs?.firstDay ? 'var(--theme-text2)' : marginFigure.color },
              valueTitle: canOverheads ? marginFigure.title : undefined,
              sub: !canOverheads ? `Requires Overheads (${overheadsTier}) →`
                : figs?.firstDay ? firstDayNote
                : figs?.fixedMissing ? `Not judged — no fixed costs entered for ${monthName} yet · Overheads →`
                : clock?.running ? `Fixed costs for ${daysText.replace(/^Days?/, m => m.toLowerCase())} · ${labourNotes.short}`
                : `After food, labour & overhead · ${labourNotes.short}`,
              extra: canOverheads ? [
                labour?.verdictWithheld ? labourNotJudgedText(labour) : '',
                posOn && commission && (commission.amount > 0 || commission.unsettledBills > 0)
                  ? `after delivery commission ${npr(commission.amount)}${commission.unsettledBills > 0 ? ` · ${commission.unsettledBills} delivery bill${commission.unsettledBills === 1 ? '' : 's'} not settled yet` : ''}`
                  : '',
              ] : [],
            })}
          </div>

          <h2 className="sr-only">Operations</h2>
          <div className="stat-grid dash-section">
            {kpiCard({
              label: "Wastage Value (MTD)",
              onOpen: () => navigate('/wastage-report'),
              tile: tRevenue,
              size: 22,
              tip: "Everything logged as waste this month, valued at each item's rate: raw items, prep (sub-recipes) and hidden items alike — the same total as the Wastage Report and the main Dashboard.",
              value: npr(ims?.wastage),
              valueStyle: { color: 'var(--theme-text1)' },
              sub: "This period →",
            })}

            {/* "below", not "at or below" (S696): an item exactly at par has what you want on hand. */}
            {kpiCard({
              label: "Items Below Par",
              onOpen: () => navigate('/reorder'),
              tile: tReorder,
              size: 22,
              tip: "Items whose current stock is below their par level — an item exactly at par is fine. A live inventory position, not a monthly total; the same count as the Reorder Report.",
              value: reorder ? reorder.count : '—',
              valueStyle: { color: reorder?.count > 0 ? 'var(--theme-red-text)' : 'var(--theme-text1)' },
              noneText: "No month to count",
              sub: reorderFallback ? `As at the end of ${BS_MONTHS[reorder.period.bs_month - 1]} ${reorder.period.bs_year} →`
                : reorder?.estValueTotal > 0 ? `${npr(reorder.estValueTotal)} to restock →` : 'Full Report →',
            })}

            {kpiCard({
              label: "Overdue Payables",
              onOpen: () => navigate('/payables'),
              tile: tPayables,
              size: 22,
              tipWidth: 280,
              tip: "Credit bills with money still owed more than 60 days after the bill date — what the supplier invoiced, after discounts and returns, VAT included; the same figure as Outstanding Payables.",
              value: npr(payables?.overdueTotal),
              valueStyle: { color: payables?.overdueTotal > 0 ? 'var(--theme-red-text)' : 'var(--theme-text1)' },
              sub: payables?.overdueCount > 0 ? `${payables.overdueCount} bill${payables.overdueCount === 1 ? '' : 's'} →` : 'Full Report →',
            })}

            {kpiCard({
              label: "Purchases · Cash / Credit",
              onOpen: () => navigate('/payments'),
              tile: tRevenue,
              size: 18,
              tipWidth: 280,
              tip: "What this month's bills cost by how they were paid, VAT included and after bill discounts; each return comes off the method it was paid by — the Payment Report's figures. FonePay counts with Cash.",
              value: // Each amount is the unbreakable atom; the slash is where a break belongs.
                <>
                  <span style={{ whiteSpace: 'nowrap' }}>{npr(ims?.cash)}</span>
                  {' / '}
                  <span style={{ whiteSpace: 'nowrap' }}>{npr(ims?.credit)}</span>
                </>,
              valueStyle: { color: 'var(--theme-text1)' },
              sub: "Cash / Credit →",
            })}
          </div>

          {sections.trend.status === 'loading' ? (
            <div className="card card--compact">
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Cost &amp; Margin — Trend</div>
              <span className="skeleton" style={{ display: 'inline-block', width: '100%', height: '4em' }} />
            </div>
          ) : sections.trend.status === 'failed' ? (
            <div className="card card--compact">
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Cost &amp; Margin — Trend</div>
              <ActionError error={(() => { const a = asActionError(sections.trend.error, 'operator'); return { text: `The trend could not be loaded. ${a.text}`, detail: a.detail } })()} />
              <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => retry('trend')}>Retry</button>
            </div>
          ) : !hasTrendData ? (
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
                {/* The series colour sits on the swatch only: as 10px TEXT the palette measured
                    1.9–2.5:1 on the Light card (S682). */}
                {[['fc', 'Food Cost %'], ['labor', 'Labor Cost %'], ['prime', 'Prime Cost %'], ['margin', 'Net Margin %']].map(([k, label]) => (
                  <span key={k}><span aria-hidden="true" style={{ color: TREND_COLORS[k] }}>●</span> {label}</span>
                ))}
              </>}
              // Visible, not sr-only: each point is the figure FROZEN on that month's Owner Report, and
              // reports already made keep their method. A dashed vertical line marks each month whose
              // method differs from the month before (OWNER-DASHBOARD-11).
              footer={<>
                <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--theme-text2)', lineHeight: 1.5 }}>
                  Each month shows the figures frozen on its Owner Report. Where a dashed line crosses the chart
                  the method changed: Food Cost and Prime Cost moved to stock used ÷ sales, Net Margin began taking
                  off Tax &amp; Fees and then wasted stock, staff meals and delivery commission, and Labour moved to
                  pay earned plus bonuses and final pay — so a line can step there with nothing in the kitchen having
                  changed.
                </p>
                <p className="sr-only">{trendSummary}</p>
              </>}
              renderChart={h => (
                <ResponsiveContainer width="100%" height={h}>
                  <LineChart data={trendChartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke={colors.border} strokeDasharray="3 3" vertical={false} />
                    {/* Ticks thin out when they would touch (S852): `interval={0}` drew every month
                        and the labels ran into each other at 390px. The first and last stay. */}
                    <XAxis dataKey="label" tick={{ fill: colors.text3, fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={12} />
                    <YAxis tick={{ fill: colors.text3, fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={v => `${v}%`} domain={['auto', 'auto']} width={40} />
                    <RTooltip
                      contentStyle={{ ...TOOLTIP_CHROME, color: 'var(--theme-text1)' }}
                      labelStyle={{ color: 'var(--theme-text1)' }}
                      formatter={(v, name) => [v != null ? `${v}%` : '—', name]}
                    />
                    {(trend?.marks || []).map(m => (
                      <ReferenceLine key={m.label} x={m.label} stroke={colors.text3} strokeDasharray="4 4" />
                    ))}
                    <Line type="monotone" dataKey="fc" name="Food Cost %" stroke={TREND_COLORS.fc} strokeWidth={2} connectNulls dot={{ r: 2 }} {...chartMotion()} />
                    <Line type="monotone" dataKey="labor" name="Labor Cost %" stroke={TREND_COLORS.labor} strokeWidth={2} connectNulls dot={{ r: 2 }} {...chartMotion()} />
                    <Line type="monotone" dataKey="prime" name="Prime Cost %" stroke={TREND_COLORS.prime} strokeWidth={2.5} strokeDasharray="6 3" connectNulls dot={{ r: 3 }} {...chartMotion()} />
                    <Line type="monotone" dataKey="margin" name="Net Margin %" stroke={TREND_COLORS.margin} strokeWidth={2} connectNulls dot={{ r: 2 }} {...chartMotion()} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            />
          )}
          </>)}
        </>
      )}</SuiteGate>
    </div>
  )
}
