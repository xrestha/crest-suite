// Consolidated P&L — the formal statement no page was: Revenue → COGS → Gross Profit → operating
// costs → Net Profit, for one BS month or a fiscal year, with every figure sourced from the module that
// owns it. "Consolidated" is meant in both senses: the MODULES (IMS cost, HR labour, overheads, POS/manual
// revenue, delivery commission) in one statement, and the OUTLETS: an outlet in a group gets one column
// per Suite outlet plus a consolidated total, via get_group_pnl() (raw aggregates only — the page derives
// COGS, so the formula stays in one place).
//
// It computes NOTHING of its own. The pure parts — LINES, buildStatement, sumStatements, the colour rule
// and every footnote sentence — live in ./pnl/pnlStatement.js; this file keeps the reads and the render.
//   Revenue  — periodRevenue() (periodCost.js), Monthly Summary's function.
//   COGS     — valuePeriodItems() (periodCost.js), Monthly Summary's, over every non-prep item, hidden
//              ones included (S792, D29), stock transfers between outlets folded in (S849, PNL-8).
//   Delivery commission — loadDeliveryCommission() (shared/deliveryCommission.js), the month the bill was
//              sold (S849, PNL-1). get_group_pnl repeats it in SQL for the group view.
//   Labour   — THE labour rule (labourSource.js, S849 SU11): finalized payroll, else the HR estimate for
//              an HR outlet, else the Labor tab for an outlet without HR; resolved per month and per
//              outlet before anything is summed. A column with no figure prints a dash and no colour.
//   Overheads / Tax & Fees — the 'overhead' and 'tax_fees' buckets, each its own line.
//   Depreciation — a memo under Net Profit, never subtracted (PNL-3).
//
// Defaults to the most recent CLOSED period: COGS subtracts closing stock, so an open month's figure is a
// whole shelf. An open month can still be picked; it renders unjudged (no colour) and provisional. A page
// that sends a month along (the Owner Dashboard's Net Margin tile, S857) opens on that month instead.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { supabase } from '../../supabaseClient'
import { fetchAllRows } from '../../shared/fetchAllRows'
import { firstError } from '../../shared/queryError'
import { npr } from '../../shared/nepalMoney'
import {
  periodRevenue, periodStockMaps, valuePeriodItems, periodRowIds, periodValuationItems, periodGap,
} from '../../modules/ims/reports/periodCost'
import { loadDepreciationMemo } from '../../modules/ims/reports/depreciationMemo'
import { readPeriodTransfers } from '../../modules/ims/transfers/transferFlows'
import { loadDeliveryCommission, bsMonthWindow } from '../../shared/deliveryCommission'
import { sheetWithLetterhead } from '../../shared/excelLetterhead'
import { useBizInfo } from '../../shared/hooks/useBizInfo'
import { useLatestRequest } from '../../shared/hooks/useLatestRequest'
import { UncountedItemsBanner } from '../../shared/uncountedItems'
import SuiteGate, { SUITE_PAGES, useSuiteAccess } from '../../components/SuiteGate'
import Tip from '../../components/Tip'
import MonthStepper, { neighboursOf } from '../../components/MonthStepper'
import ReportPage from '../../components/ReportPage'
import PeriodScope from '../../components/PeriodScope'
import { printWithTitle } from '../../utils/printTitle'
import { withTimeout, settleWithin } from '../../utils/withTimeout'
import { suiteLive } from '../../utils/subscription'
import { BS_MONTHS } from '../../utils/bsCalendar'
import { fiscalYearOf } from '../../modules/hr/payroll/tds'
import {
  groupOutletLabour, isPayrollFenced, labourFigure, resolveOutletLabour,
} from '../../modules/dashboard/labourSource'
import { loadOutletLabour, loadGroupLabourInputs } from '../../modules/dashboard/loadOutletLabour'
import { mtdClock, nepalBsToday } from '../../modules/dashboard/mtdClock'
import {
  LINES, buildStatement, columnMarkers, fmtLine, groupColumn, lineColor, lineWithheld, pctOf, pnlNotes,
  statementRows, sumStatements,
} from './pnl/pnlStatement'

const LOAD_MS = 30000

const monthName = (y, m) => `${BS_MONTHS[m - 1] || `Month ${m}`} ${y}`
const fyLabel = start => `${start}/${String((start + 1) % 100).padStart(2, '0')}`
// The fiscal year's months in order, Shrawan (4) of `start` to Ashadh (3) of the next year.
const fyMonths = start => [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3].map(m => ({ bs_year: m >= 4 ? start : start + 1, bs_month: m }))
const notFuture = (m, today) => m.bs_year < today.year || (m.bs_year === today.year && m.bs_month <= today.month)

// Labour for one outlet-month, once its Labor tab is known: the rule's result plus whether it is a
// figure a statement may print (labourFigure).
function finishLabour(r) {
  const { hasFigure, note } = labourFigure(r)
  return { ...r, amount: hasFigure ? r.amount : null, hasFigure, note }
}

export default function ConsolidatedPnl() {
  const {
    clientId, profile, loading: authLoading, clientModules, clientModulesKnown, outlets, isAdmin, isOwner,
    groupId, viewGroupId, imsRole,
  } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const db = useScopedDb()
  const { scopedFrom } = db
  const biz = useBizInfo()
  const periodReq = useLatestRequest()
  // The selection lives in the address (S858): `?period=<id>` for a month, `?fy=<start>` for a fiscal
  // year, as HR's pages keep theirs (S804). So a reload, Back or a link sent to the accountant opens the
  // same statement, and the Owner Dashboard's Net Margin tile links straight to the month it showed
  // (S857 passed it in navigation state, which a copied link loses). Read once, for the first pick;
  // used only when it names one of this outlet's own months or years, else the closed-month default.
  const [searchParams, setSearchParams] = useSearchParams()
  const askedRef = useRef({ period: searchParams.get('period'), fy: searchParams.get('fy') })

  // In a group the page is the matrix (PNL-13: the client row's group, never a sibling read that can
  // fail). For the operator AuthContext's groupId is the VIEWED client's group (ACCESS-8), read through
  // p_group_id; an operator viewing an ungrouped client gets that outlet's single statement.
  const grouped = !!groupId
  const groupArg = isAdmin ? (viewGroupId || null) : null
  // ACCESS-7: an Owner switched to a branch without Suite still opens the group statement when any outlet
  // of the group has it; the RPC includes only the outlets that do.
  const groupSuiteLive = grouped && (outlets || []).some(o => suiteLive(o))
  const suite = useSuiteAccess(SUITE_PAGES.consolidatedPnl, { entitled: groupSuiteLive })
  // The module switches decide HR (payroll vs Labor tab) and POS (delivery commission, waiting bills).
  // For the operator hrEnabled / posEnabled are always true, so the client's own modules are read.
  const modulesReady = isAdmin ? clientModulesKnown !== false : true
  const canLoad = suite.allowed && (isAdmin || isOwner) && modulesReady
  const hrOn = !!clientModules?.hr
  const posOn = clientModules ? !!clientModules.pos : true
  const fenced = isPayrollFenced({ hrOn, isAdmin, isOwner, imsRole })

  const [periods, setPeriods] = useState([])
  const [selectedKey, setSelectedKey] = useState(null)
  const [result, setResult] = useState(null)      // { builtFor, ... } — figures render only when current
  const [loadError, setLoadError] = useState(null)
  const [loading, setLoading] = useState(true)

  const fyStarts = useMemo(() => {
    const s = new Set(periods.map(p => fiscalYearOf(p.bs_year, p.bs_month).fyStart))
    return [...s].sort((a, b) => b - a)
  }, [periods])

  // A selection key → what it covers. `period:<id>` is one month; `fy:<start>` a fiscal year.
  const describe = useCallback((key, list = periods) => {
    if (!key) return null
    if (key.startsWith('fy:')) {
      const start = Number(key.slice(3))
      const today = nepalBsToday()
      const months = fyMonths(start).filter(m => notFuture(m, today))
      const have = list.filter(p => fiscalYearOf(p.bs_year, p.bs_month).fyStart === start)
        .sort((a, b) => (a.bs_year - b.bs_year) || (a.bs_month - b.bs_month))
      const last = months[months.length - 1]
      return {
        kind: 'fy', key, start, months, periods: have,
        scope: `Fiscal year ${fyLabel(start)}`,
        scopeEnd: last ? monthName(last.bs_year, last.bs_month) : '',
        open: have.some(p => p.status === 'open'),
      }
    }
    const p = list.find(x => x.id === key.slice(7))
    if (!p) return null
    return {
      kind: 'month', key, months: [{ bs_year: p.bs_year, bs_month: p.bs_month }], periods: [p],
      scope: monthName(p.bs_year, p.bs_month), scopeEnd: monthName(p.bs_year, p.bs_month),
      open: p.status === 'open',
    }
  }, [periods])

  /* ── Single outlet: one batch for a month or a fiscal year (PNL-16) ───────────────────────── */
  const loadOutletStatements = useCallback(async (sel) => {
    const list = sel.periods
    const ids = list.map(p => p.id)
    if (ids.length === 0) return { data: { kind: 'single', months: [], stmt: null }, error: null }
    const from = (t, c) => scopedFrom(t, c)
    const clocks = new Map(list.map(p => [p.id, p.status === 'open' ? mtdClock(p) : null]))

    let results
    try {
      results = await withTimeout(Promise.all([
        // Monthly Summary's exact reads, so revenue and COGS tie to that page: every item, hidden ones
        // included (S792, D29), prep excluded, every per-item-per-period read paged on its id.
        fetchAllRows(() => scopedFrom('items', 'id, name, per_uom_rate, is_active').eq('is_sub_recipe', false).order('id')),
        fetchAllRows(() => supabase.from('opening_stock').select('period_id, item_id, qty').in('period_id', ids).order('id')),
        fetchAllRows(() => supabase.from('closing_stock').select('period_id, item_id, physical_qty').in('period_id', ids).order('id')),
        fetchAllRows(() => supabase.from('purchase_entries')
          .select('period_id, item_id, qty, rate, discount_amount, purchase_group_id, vendor_id, invoice_ref, bs_day, vat_inclusive, vat_is_cost')
          .in('period_id', ids).order('id')),
        fetchAllRows(() => scopedFrom('vendor_returns', 'period_id, item_id, qty, rate, purchase_entries(vat_inclusive, vat_is_cost)').in('period_id', ids).order('id')),
        fetchAllRows(() => supabase.from('wastages').select('period_id, item_id, qty').in('period_id', ids).order('id')),
        fetchAllRows(() => supabase.from('staff_meals').select('period_id, item_id, qty').in('period_id', ids).order('id')),
        // `source` selected and comps filtered in JS, never `.neq('source','pos_comp')` (S747).
        fetchAllRows(() => supabase.from('sales_entries')
          .select('period_id, recipe_id, qty_sold, unit_price, discount, source').in('period_id', ids)
          .order('id')),
        fetchAllRows(() => scopedFrom('recipes', 'id, selling_price').order('id')),
        fetchAllRows(() => scopedFrom('overheads', 'id, period_id, bucket, amount').in('period_id', ids).order('id')),
        // Stock moved between outlets (PNL-8): in like a purchase, out like a supplier return.
        readPeriodTransfers(scopedFrom, ids),
        // Delivery commission per month, only for a POS client (an IMS-only one gets 0 without a read).
        Promise.all(list.map(p => loadDeliveryCommission(db, { ...bsMonthWindow(p.bs_year, p.bs_month), posEnabled: posOn })))
          .then(rs => ({ data: rs, error: rs.find(r => r.error)?.error || null })),
        // Till bills and credit notes not in Inventory yet (PNL-11), by month: POS-owned, read only.
        posOn
          ? settleWithin(supabase.rpc('pos_ims_waiting_counts', { p_client_id: effectiveClientId }), LOAD_MS, 'Waiting till bills')
          : Promise.resolve({ data: [], error: null }),
        // Labour through the one rule, per month: HR reads only on an HR outlet a viewer may read.
        Promise.all(list.map(p => {
          const clock = clocks.get(p.id)
          return loadOutletLabour(from, {
            period: p, hrOn, fenced,
            throughDay: clock ? clock.countedDays : undefined,
            scale: clock ? clock.fraction : 1,
            timeoutMs: LOAD_MS,
          })
        })).then(rs => ({ data: rs, error: null })),
      ]), LOAD_MS + 5000, 'Building the statement')
    } catch (e) {
      return { data: null, error: e }
    }
    const failed = firstError(results)
    if (failed) return { data: null, error: results.find(r => r.error)?.error || failed }

    const [
      { data: items }, { data: opening }, { data: closing }, { data: purchases }, { data: returns },
      { data: wastages }, { data: staffMealsData }, { data: salesData }, { data: recipes },
      { data: overheadRows }, { data: transfers }, { data: commissions }, { data: waiting },
      { data: labourLoads },
    ] = results

    // The depreciation memo is its own read (PNL-3): a failed memo never blocks the statement.
    const memos = await Promise.all(list.map(p => withTimeout(loadDepreciationMemo(scopedFrom, p), LOAD_MS, 'Depreciation memo')
      .catch(error => ({ error }))))

    const byPeriod = rows => {
      const m = new Map()
      for (const r of rows || []) {
        const l = m.get(r.period_id)
        if (l) l.push(r); else m.set(r.period_id, [r])
      }
      return m
    }
    const t = {
      opening: byPeriod(opening), closing: byPeriod(closing), purchases: byPeriod(purchases),
      returns: byPeriod(returns), wastages: byPeriod(wastages), staffMeals: byPeriod(staffMealsData),
      sales: byPeriod(salesData), overheads: byPeriod(overheadRows), transfers: byPeriod(transfers),
    }

    const months = list.map((p, i) => {
      const rows = {
        opening: t.opening.get(p.id) || [], closing: t.closing.get(p.id) || [],
        purchases: t.purchases.get(p.id) || [], returns: t.returns.get(p.id) || [],
        wastages: t.wastages.get(p.id) || [], staffMeals: t.staffMeals.get(p.id) || [],
        transfers: t.transfers.get(p.id) || [],
      }
      const sales = t.sales.get(p.id) || []
      const ohRows = t.overheads.get(p.id) || []
      const clock = clocks.get(p.id)
      const buckets = { overhead: 0, labor: 0, tax_fees: 0 }
      for (const r of ohRows) {
        const b = buckets[r.bucket || 'overhead'] !== undefined ? (r.bucket || 'overhead') : 'overhead'
        buckets[b] += parseFloat(r.amount) || 0
      }
      const parts = labourLoads[i]?.parts || { hrOn, fenced }
      const labour = finishLabour(resolveOutletLabour({ ...parts, labourBucket: buckets.labor, scale: clock ? clock.fraction : 1 }))

      // Measured on the ROWS, not the totals: a month with nothing recorded has no statement (S594).
      const hasAnyData = Object.values(rows).some(r => r.length > 0) || sales.length > 0 || ohRows.length > 0
        || parts.payroll != null
      if (!hasAnyData) return { period: p, stmt: null, gapItems: null }

      const maps = periodStockMaps(rows)
      const valued = periodValuationItems(items, periodRowIds(rows))
      const stock = valuePeriodItems(valued, maps)
      const gap = periodGap({ items: valued, maps, closing: rows.closing, cogs: stock.cogsVal })
      const waitRow = (waiting || []).find(w => w.bs_year === p.bs_year && w.bs_month === p.bs_month)
      const memo = memos[i]
      const stmt = buildStatement({
        revenue: periodRevenue(sales, recipes),
        openingVal: stock.openingVal,
        // computeUsed takes purchases net of discount and the returns separately; transfers in add like a
        // purchase, transfers out take off like a return (periodCost.js keeps both supplier-only figures).
        purchasesVal: stock.purchaseVal - stock.discountVal + stock.transferInVal,
        returnsVal: stock.returnVal + stock.transferOutVal,
        wastageVal: stock.wastageVal, staffMealsVal: stock.staffMealsVal, closingVal: stock.closingVal,
        transferInVal: stock.transferInVal, transferOutVal: stock.transferOutVal,
        overheads: buckets.overhead, taxFees: buckets.tax_fees,
        deliveryCommission: commissions[i]?.amount || 0,
        deliveryUnsettled: commissions[i]?.unsettledBills || 0,
        labour,
        open: p.status === 'open',
        hasClosing: rows.closing.some(r => r.physical_qty != null),
        gap,
        depreciation: memo?.error ? { error: memo.error } : memo,
        tillWaiting: { bills: waitRow?.bills, notes: waitRow?.notes },
      })
      return { period: p, stmt, gap, running: !!clock?.running }
    })

    const withData = months.filter(m => m.stmt)
    const stmt = sel.kind === 'fy' ? sumStatements(withData.map(m => m.stmt), { stock: 'last' }) : (withData[0]?.stmt || null)
    return { data: { kind: 'single', months, stmt, running: months.some(m => m.running) }, error: null }
  }, [scopedFrom, db, posOn, hrOn, fenced, effectiveClientId])

  /* ── Grouped: one get_group_pnl + one labour-inputs call per month, derived here ───────────── */
  const loadGroupMonths = useCallback(async (sel) => {
    const rpc = (name, args) => supabase.rpc(name, args)
    let perMonth
    try {
      perMonth = await withTimeout(Promise.all(sel.months.map(m => Promise.all([
        settleWithin(supabase.rpc('get_group_pnl', { p_bs_year: m.bs_year, p_bs_month: m.bs_month, p_group_id: groupArg }),
          LOAD_MS, 'The group statement'),
        loadGroupLabourInputs(rpc, { bsYear: m.bs_year, bsMonth: m.bs_month, groupId: groupArg, timeoutMs: LOAD_MS }),
      ]))), LOAD_MS + 5000, 'Building the group statement')
    } catch (e) {
      return { data: null, error: e }
    }
    // A failed RPC must not masquerade as the no-Suite empty state: "nothing to show" and "could not
    // load" are different facts, and only one of them should send someone to billing.
    for (const [pnl, lab] of perMonth) {
      if (pnl.error) return { data: null, error: pnl.error }
      if (lab.error) return { data: null, error: lab.error }
    }

    const outletsById = new Map()   // client_id → { name, included, months: [{ month, col }] }
    sel.months.forEach((m, i) => {
      const [{ data: rows }, { byClient }] = perMonth[i]
      const clock = mtdClock(m)
      for (const r of rows || []) {
        const o = outletsById.get(r.client_id) || { clientId: r.client_id, name: r.client_name, included: false, months: [] }
        o.name = r.client_name
        o.included = o.included || !!r.is_included
        if (r.is_included) {
          const lab = byClient?.get(r.client_id)
          const open = r.period_status === 'open'
          const labour = groupOutletLabour(r, !!lab?.hrEnabled, {
            inputs: lab?.inputs || null,
            period: { bs_year: m.bs_year, bs_month: m.bs_month },
            throughDay: open && clock.running ? clock.countedDays : null,
            scale: open && clock.running ? clock.fraction : 1,
          })
          o.months.push({ month: m, col: groupColumn(r, labour) })
        }
        outletsById.set(r.client_id, o)
      }
    })

    const all = [...outletsById.values()]
    const excludedNames = all.filter(o => !o.included).map(o => o.name)
    const cols = all.filter(o => o.included).map(o => {
      const withPeriod = o.months.filter(x => x.col.hasPeriod)
      if (sel.kind !== 'fy') {
        const c = o.months[0]?.col || { name: o.name, hasPeriod: false, stmt: null }
        return { ...c, clientId: o.clientId, name: o.name }
      }
      const stmt = sumStatements(withPeriod.map(x => x.col.stmt), { stock: 'last' })
      return {
        clientId: o.clientId, name: o.name, hasPeriod: withPeriod.length > 0,
        status: withPeriod.some(x => x.col.stmt.open) ? 'open' : 'closed',
        stmt: stmt || buildStatement({}),
        monthsWithoutPeriod: o.months.filter(x => !x.col.hasPeriod).map(x => monthName(x.month.bs_year, x.month.bs_month)),
      }
    })
    const consolidated = sumStatements(cols.filter(c => c.hasPeriod).map(c => c.stmt), { stock: 'sum' })
    const senders = cols.filter(c => c.hasPeriod && c.stmt.onTheWayVal > 0).map(c => ({ name: c.name, value: c.stmt.onTheWayVal }))
    const running = sel.months.some(m => mtdClock(m).running)
    return { data: { kind: 'group', cols, consolidated, excludedNames, senders, running }, error: null }
  }, [groupArg])

  const loadSelection = useCallback(async (key, list) => {
    const sel = describe(key, list)
    if (!sel) return
    setLoadError(null)
    const { data, error } = grouped ? await loadGroupMonths(sel) : await loadOutletStatements(sel)
    if (!periodReq.isCurrent(key)) return   // superseded by a newer selection
    if (error) { console.error('Consolidated P&L failed:', error); setResult(null); setLoadError(error); return }
    setResult({ ...data, builtFor: key, sel })
  }, [describe, grouped, loadGroupMonths, loadOutletStatements, periodReq])

  // init() claims the page before its first await (PNL-4); a later selection supersedes it.
  const init = useCallback(async () => {
    const initKey = periodReq.begin(`init:${effectiveClientId}`)
    setLoading(true)
    setLoadError(null)
    setResult(null)
    const { data: p, error } = await settleWithin(
      scopedFrom('monthly_periods', 'id, bs_year, bs_month, status')
        .order('bs_year', { ascending: false }).order('bs_month', { ascending: false }).order('id'),
      LOAD_MS, 'Loading the months')
    if (!periodReq.isCurrent(initKey)) return
    if (error) { setLoadError(error); setPeriods([]); setLoading(false); return }
    const list = p || []
    setPeriods(list)
    // Closed-period default — COGS subtracts a closing count that an open month does not have — unless
    // the address names a month or fiscal year of this outlet's (askedRef above).
    const askedFy = Number(askedRef.current.fy)
    const fyKnown = askedRef.current.fy && list.some(x => fiscalYearOf(x.bs_year, x.bs_month).fyStart === askedFy)
    const asked = askedRef.current.period ? list.find(x => x.id === askedRef.current.period) : null
    const target = asked || list.find(x => x.status === 'closed') || list[0]
    if (!target) { setSelectedKey(null); setLoading(false); return }
    const key = periodReq.begin(fyKnown ? `fy:${askedFy}` : `period:${target.id}`)
    setSelectedKey(key)
    await loadSelection(key, list)
    if (periodReq.isCurrent(key)) setLoading(false)
  }, [effectiveClientId, scopedFrom, loadSelection, periodReq])

  // authLoading is a real dependency: a hard load lands here while auth is still resolving. The load runs
  // only once the Suite gate and the role allow it (ACCESS-9: nothing is read behind the card).
  useEffect(() => {
    if (authLoading || !canLoad) return
    if (!effectiveClientId) { setLoading(false); setLoadError('No client selected. Pick one from the outlet switcher in the sidebar.'); return }
    init()
  }, [authLoading, canLoad, effectiveClientId, grouped, groupArg]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSelect(key) {
    periodReq.begin(key)   // claim the page before any await
    setSelectedKey(key)
    setLoading(true)
    await loadSelection(key)
    if (periodReq.isCurrent(key)) setLoading(false)
  }

  // Whatever picked the statement (the first load, the picker, ‹ ›), the address follows it, so a link
  // copied at any moment names what is on screen. `replace`: stepping must not fill the Back button.
  useEffect(() => {
    if (!selectedKey) return
    const [kind, value] = [selectedKey.startsWith('fy:') ? 'fy' : 'period', selectedKey.replace(/^(fy|period):/, '')]
    if (searchParams.get(kind) === value && !searchParams.get(kind === 'fy' ? 'period' : 'fy')) return
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete(kind === 'fy' ? 'period' : 'fy')
      next.set(kind, value)
      return next
    }, { replace: true })
  }, [selectedKey]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Derived render state ──────────────────────────────────────────────────────────────────── */
  const sel = describe(selectedKey)
  // Keys in the picker's own form (`period:<id>`, `fy:<start>`), so a step is exactly a pick.
  const steps = selectedKey?.startsWith('fy:')
    ? neighboursOf(fyStarts, selectedKey, x => `fy:${x}`, x => `Fiscal year ${fyLabel(x)}`)
    : neighboursOf(periods, selectedKey, p => `period:${p.id}`, p => monthName(p.bs_year, p.bs_month))
  const isCurrent = !!result && result.builtFor === selectedKey
  const scope = sel?.scope || ''
  const cols = isCurrent && result.kind === 'group' ? result.cols : []
  const stmt = !isCurrent ? null : result.kind === 'group' ? result.consolidated : result.stmt
  const isEmpty = !stmt
  const withPeriod = cols.filter(c => c.hasPeriod)

  const notes = useMemo(() => {
    if (!isCurrent || !stmt) return []
    if (result.kind === 'group') {
      return pnlNotes({
        scope, scopeEnd: sel?.scopeEnd, grouped: true, fy: sel?.kind === 'fy', stmt,
        cols: result.cols, excludedNames: result.excludedNames, senders: result.senders, runningMonth: result.running,
      })
    }
    const fyNotes = sel?.kind === 'fy'
    return pnlNotes({
      scope, scopeEnd: sel?.scopeEnd, fy: fyNotes, stmt, hrOn, runningMonth: result.running,
      monthsWithoutPeriod: fyNotes
        ? sel.months.filter(m => !sel.periods.some(p => p.bs_year === m.bs_year && p.bs_month === m.bs_month)).map(m => monthName(m.bs_year, m.bs_month))
        : [],
      openMonths: fyNotes ? sel.periods.filter(p => p.status === 'open').map(p => monthName(p.bs_year, p.bs_month)) : [],
    })
  }, [isCurrent, stmt, result, scope, sel, hrOn])

  async function exportExcel() {
    if (!isCurrent || !stmt || !biz.ready) return
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    const rows = result.kind === 'group'
      ? statementRows({ grouped: true, cols: result.cols, consolidated: result.consolidated })
      : statementRows({
        stmt,
        monthCols: sel?.kind === 'fy'
          ? result.months.map(m => ({ label: monthName(m.period.bs_year, m.period.bs_month), stmt: m.stmt }))
          : null,
      })
    const gap = result.kind === 'single' && sel?.kind === 'month' ? stmt.gap : null
    const ws = sheetWithLetterhead(XLSX, {
      title: 'Profit & Loss',
      biz,
      scopeLine: `Period : ${scope}${stmt.open ? ' (PROVISIONAL — a month is still open, closing stock not counted)' : ''}`,
      rows,
      notes: [
        ...notes.map(n => n.text),
        ...(gap?.uncounted?.length ? [`Not counted: ${gap.uncounted.map(u => u.name).join(', ')}.`] : []),
      ],
    })
    XLSX.utils.book_append_sheet(wb, ws, 'P&L')
    XLSX.writeFile(wb, `pnl-${scope.replace(/[ /]/g, '-')}.xlsx`)
  }

  if (authLoading) return null
  // Owner-or-admin only, matching this page's nav entry: restrictive staff-isolation policies return an
  // empty read, not an error, so a staff login would get a confident statement at a 100% margin.
  if (!isAdmin && !isOwner) return <Navigate to="/dashboard" replace />

  // The `micro` step from DESIGN.md's ramp — 10px is only ever legal as micro-caps.
  const colMarkerStyle = { display: 'block', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginTop: 2 }
  const markerColor = tone => (tone === 'warn' ? 'var(--theme-amber-text)' : 'var(--theme-text3)')
  const net = LINES.find(l => l.key === 'netProfit')
  const gross = LINES.find(l => l.key === 'grossProfit')
  const busy = loading || (!!selectedKey && !isCurrent && !loadError)

  const actions = (
    <>
      <button className="btn btn-ghost" style={{ fontSize: 12 }}
        disabled={busy || !!loadError || isEmpty || !isCurrent}
        onClick={() => printWithTitle(`Profit & Loss - ${scope}`)}>Print</button>
      <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={exportExcel}
        disabled={busy || !!loadError || isEmpty || !isCurrent || !biz.ready}
        title={biz.error ? 'Your business details could not be loaded for the letterhead — reload the page to export' : undefined}>Export Excel</button>
      {/* ‹ › step within what is on screen (S858): month to month, or fiscal year to fiscal year. Never
          disabled while a statement loads: a disabled button drops the focus a keyboard user just put on
          it, and useLatestRequest already lets only the last step win (S601). */}
      <MonthStepper prev={steps.prev} next={steps.next} onStep={handleSelect} unit={selectedKey?.startsWith('fy:') ? 'fiscal year' : 'month'}>
        <select aria-label="Period" className="form-select" value={selectedKey || ''}
          onChange={e => handleSelect(e.target.value)}>
          <optgroup label="Months">
            {periods.map(p => (
              <option key={p.id} value={`period:${p.id}`}>
                {monthName(p.bs_year, p.bs_month)} {p.status === 'open' ? '(open)' : '(closed)'}
              </option>
            ))}
          </optgroup>
          {fyStarts.length > 0 && (
            <optgroup label="Fiscal years">
              {fyStarts.map(s => (
                <option key={s} value={`fy:${s}`}>Fiscal year {fyLabel(s)} (Shrawan–Ashadh)</option>
              ))}
            </optgroup>
          )}
        </select>
      </MonthStepper>
    </>
  )

  // `.amber-banner` (S857): the shared "you can, but this is not the usual case" box, not a hand-typed copy.
  const banners = (
    <>
      {isCurrent && stmt?.open && (
        <div className="amber-banner">
          <strong>Provisional — {grouped ? 'at least one outlet’s month is still open.' : sel?.kind === 'fy' ? 'a month of the year is still open.' : 'this month is still open.'}</strong>{' '}
          Closing stock has not been counted yet, so COGS treats closing stock as zero and overstates the true
          figure. Gross and Net Profit carry no colour until the month is closed.
        </div>
      )}
      {/* A statement that silently omits labour overstates Net Profit by exactly that much. With HR off,
          the only labour this page can see is Overheads' Labor tab — say so above the figures (S683). */}
      {!hrOn && !grouped && (
        <div className="amber-banner">
          <strong>Labour is from Overheads only.</strong>{' '}
          Crest HR is not enabled, so no payroll feeds this statement — the Labour line is whatever was
          entered in Overheads&apos; Labor tab for the month{stmt?.labourInfo?.source === 'overheads' || stmt?.labour ? '' : ', which is currently nothing'}.
        </div>
      )}
    </>
  )

  // The headline (S594): Net Profit is the reason an owner opens the page. The statement is still the
  // document; this is the answer. A withheld verdict prints in the text colour with the reason.
  const verdictSub = (s, line) => {
    if (s.open) return 'Not judged until the month is closed'
    if (s.gapMaterial) return 'Not judged: count incomplete'
    if (line.key === 'netProfit' && (!s.labourHasFigure || s.labourVerdictWithheld)) return 'Not judged: labour incomplete — see notes'
    return null
  }
  const headline = stmt ? (
    <div className="stat-grid">
      <div className="stat-card">
        <div className="stat-label">Revenue</div>
        <div className="stat-value">{npr(stmt.revenue)}</div>
        <div className="stat-sub">
          {grouped ? `${withPeriod.length} of ${cols.length} outlet${cols.length === 1 ? '' : 's'}` : scope}
        </div>
      </div>
      <div className="stat-card">
        <div className="stat-label">
          <Tip width={280} text="Revenue less cost of goods sold, before wastage, staff meals, delivery commission, labour, overheads and tax.">Gross Profit</Tip>
        </div>
        <div className="stat-value" style={{ color: lineColor(gross, stmt.grossProfit, lineWithheld(gross, stmt)) }}>
          {npr(stmt.grossProfit)}
        </div>
        <div className="stat-sub">{verdictSub(stmt, gross) || `${pctOf(stmt.grossProfit, stmt.revenue)} of revenue`}</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">
          <Tip width={300} text={net.tip}>Net Profit</Tip>
        </div>
        <div className="stat-value" style={{ color: lineColor(net, stmt.netProfit, lineWithheld(net, stmt)) }}>
          {npr(stmt.netProfit)}
        </div>
        {/* "Net Margin" is the figure's one name on every owner page (S857). */}
        <div className="stat-sub">{verdictSub(stmt, net) || `Net Margin ${pctOf(stmt.netProfit, stmt.revenue)}`}</div>
      </div>
    </div>
  ) : null

  // Coverage first, not last: what every figure on the page does and does not include (PNL-5).
  const coverage = grouped && isCurrent ? (
    <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 16px', maxWidth: 900 }}>
      Covers <strong>{withPeriod.length}</strong> of {cols.length} outlet{cols.length === 1 ? '' : 's'}
      {result.excludedNames.length > 0 && <> · not included (no Crest Suite Pro on that outlet): {result.excludedNames.join(', ')}</>}.
      {' '}Months listed are {(outlets || []).find(o => o.id === effectiveClientId)?.name || 'this outlet'}&apos;s; a month only another outlet has is reached by switching to that outlet.
    </p>
  ) : null

  const footnote = notes.length > 0 ? (
    <div style={{ marginTop: 12, maxWidth: 900 }}>
      {notes.map(n => (
        <p key={n.key} style={{ fontSize: 12, margin: '8px 0 0', color: n.tone === 'warn' ? 'var(--theme-amber-text)' : 'var(--theme-text2)' }}>
          {n.text}
        </p>
      ))}
    </div>
  ) : null

  const labourNote = s => {
    if (sel?.kind === 'fy') return s.labourMissing > 0 ? `${s.labourMissing} month${s.labourMissing === 1 ? '' : 's'} without a figure` : 'month by month'
    const src = s.labourInfo?.source
    return src === 'payroll' ? `from finalized payroll${s.labourInfo?.other ? ' + bonus/final pay' : ''}`
      : src === 'estimate' ? 'HR estimate — payroll not finalized'
      : src === 'overheads' ? 'from the Overheads Labor tab'
      : src === 'none' ? 'no labour entered — Crest HR is off and the Labor tab is empty'
      : src === 'unreadable' ? 'not readable on this login'
      : 'could not be loaded'
  }
  const depr = s => (s?.depreciation && !s.depreciation.error ? s.depreciation.amount : null)

  const body = !stmt ? null : grouped ? (
    <div className="table-wrap">
      {/* Sticky first column: with five outlets this matrix is eight currency columns wide. */}
      <table className="data-table data-table--sticky-first">
        <thead>
          <tr>
            <th>Line</th>
            {/* Keyed by position, not name — two outlets can share a display name (S612). */}
            {cols.map((c, ci) => (
              <th key={ci} style={{ textAlign: 'right' }}>
                {c.name}
                {columnMarkers(c).map(m => (
                  <span key={m.text} style={{ ...colMarkerStyle, color: markerColor(m.tone) }}>{m.text}</span>
                ))}
              </th>
            ))}
            <th style={{ textAlign: 'right' }}>Consolidated</th>
            <th style={{ textAlign: 'right' }}>
              <Tip text="Each consolidated line as a share of consolidated revenue." width={260}>% of Rev.</Tip>
            </th>
          </tr>
        </thead>
        <tbody>
          {LINES.map(l => (
            <tr key={l.key} style={l.strong ? { fontWeight: 700, borderTop: '2px solid var(--theme-border)' } : undefined}>
              <td style={{ fontWeight: l.strong ? 700 : 500, color: 'var(--theme-text1)' }}>
                {l.tip ? <Tip text={l.tip} width={300}>{l.label}</Tip> : l.label}
              </td>
              {cols.map((c, ci) => (
                <td key={ci} style={{
                  textAlign: 'right',
                  color: c.hasPeriod ? lineColor(l, c.stmt[l.key], lineWithheld(l, c.stmt)) : 'var(--theme-text3)',
                }}>
                  {/* A no-period column is blank on every line, not 0 (PNL-6). */}
                  {c.hasPeriod ? fmtLine(l, c.stmt[l.key]) : '—'}
                </td>
              ))}
              {/* NOT `{ ...l, strong: true }`: weight comes from fontWeight (S594). */}
              <td style={{ textAlign: 'right', fontWeight: 700, color: lineColor(l, stmt[l.key], lineWithheld(l, stmt)) }}>
                {fmtLine(l, stmt[l.key])}
              </td>
              <td style={{ textAlign: 'right', color: 'var(--theme-text3)', fontSize: 12 }}>
                {l.key === 'revenue' ? '100.0%' : pctOf(stmt[l.key], stmt.revenue)}
              </td>
            </tr>
          ))}
          <tr>
            <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>
              <Tip text="Depreciation posted in Fixed Assets for the month. Shown for reference only: Net Profit above is before depreciation." width={300}>
                Depreciation (memo, not subtracted)
              </Tip>
            </td>
            {cols.map((c, ci) => (
              <td key={ci} style={{ textAlign: 'right', fontSize: 12, color: 'var(--theme-text3)' }}>
                {c.hasPeriod && depr(c.stmt) != null ? npr(depr(c.stmt)) : '—'}
              </td>
            ))}
            <td style={{ textAlign: 'right', fontSize: 12, color: 'var(--theme-text3)' }}>{depr(stmt) != null ? npr(depr(stmt)) : '—'}</td>
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  ) : (
    <>
      {sel?.kind === 'month' && stmt.gap?.uncountedCount > 0 && (
        <UncountedItemsBanner gap={stmt.gap} scope={scope}
          fcLine="Gross and Net Profit are shown without a colour until the count is finished" />
      )}
      <div className="table-wrap" style={{ maxWidth: 760 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Line</th>
              <th style={{ textAlign: 'right' }}>Amount</th>
              <th style={{ textAlign: 'right' }}>
                <Tip text="Each line as a share of revenue — the standard common-size P&L reading." width={260}>% of Rev.</Tip>
              </th>
            </tr>
          </thead>
          <tbody>
            {LINES.map(l => (
              <tr key={l.key} style={l.strong ? { fontWeight: 700, borderTop: '2px solid var(--theme-border)' } : undefined}>
                <td style={{ color: 'var(--theme-text1)', fontWeight: l.strong ? 700 : 500 }}>
                  {l.tip ? <Tip text={l.tip} width={300}>{l.label}</Tip> : l.label}
                  {l.key === 'labour' && (
                    <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--theme-text3)' }}>{labourNote(stmt)}</span>
                  )}
                </td>
                <td style={{ textAlign: 'right', fontWeight: l.strong ? 700 : 500, color: lineColor(l, stmt[l.key], lineWithheld(l, stmt)) }}>
                  {fmtLine(l, stmt[l.key])}
                </td>
                <td style={{ textAlign: 'right', color: 'var(--theme-text3)', fontSize: 12 }}>
                  {l.key === 'revenue' ? '100.0%' : pctOf(stmt[l.key], stmt.revenue)}
                </td>
              </tr>
            ))}
            <tr>
              <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>
                <Tip text="Depreciation posted in Fixed Assets for the period. Shown for reference only: Net Profit above is before depreciation." width={300}>
                  Depreciation (memo, not subtracted)
                </Tip>
              </td>
              <td style={{ textAlign: 'right', fontSize: 12, color: 'var(--theme-text3)' }}>
                {stmt.depreciation?.error ? 'could not be read' : depr(stmt) != null ? npr(depr(stmt)) : '—'}
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </>
  )

  return (
    <SuiteGate page={SUITE_PAGES.consolidatedPnl} entitled={groupSuiteLive}>
      <ReportPage
        title="Profit &amp; Loss"
        // S857: the subtitle says what kind of page this is; the period it covers is the chip below it.
        subtitle={grouped
          ? 'Any month or fiscal year, set out as accounts for every outlet and the group: revenue down to net profit.'
          : 'Any month or fiscal year, set out as accounts: revenue down to net profit.'}
        scope={scope ? <PeriodScope label={scope} status={sel?.open ? 'open' : 'closed'} provisionalWhenOpen /> : null}
        actions={actions}
        noPeriod={!busy && !loadError && periods.length === 0}
        noPeriodWhat="the P&L statement"
        loading={busy}
        loadingText="Building the statement…"
        error={loadError}
        empty={isEmpty}
        // No pictograph: a screen reader read the old page emoji aloud (S857).
        emptyIcon={null}
        emptyText={grouped
          ? `No outlet in your group has Crest Suite Pro for ${scope}.`
          : `No figures recorded for ${scope} yet.`}
        banners={banners}
        stats={headline}
        note={coverage}
        footnote={footnote}
      >
        {/* `!stmt ? null :` is load-bearing: JSX children are evaluated before ReportPage's gate runs
            (S601), so `body` is built only from a statement that exists and is current. */}
        {body}
      </ReportPage>
    </SuiteGate>
  )
}
