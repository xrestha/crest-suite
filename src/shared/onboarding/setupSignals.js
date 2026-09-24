// The setup guide's "is it done yet" reads (S790). Each signal answers one question with
// true / false / null, where null means the read failed or timed out — a check that could not run
// has not passed, so the guide shows "couldn't check" instead of a tick or a "to do".
//
// Only the signals a viewer's own steps need are read (setupSteps.signalsNeeded): the staff
// isolation policies return an EMPTY result, not an error, for a table the login is fenced from,
// so reading one would turn "not allowed to see" into "not done yet" (the S750 lesson).
//
// Every count is head-only (no rows travel) and covers ALL of the client's months, never just the
// open one: a tick must not disappear when a new BS month starts at zero purchases.
import { supabase } from '../../supabaseClient'
import { fetchAllRows } from '../fetchAllRows'
import { withTimeout } from '../../utils/withTimeout'
import { fiscalYearOf } from '../../modules/hr/payroll/tds'

const TIMEOUT_MS = 15000
const CHUNK = 150

async function settle(promise, label) {
  try {
    return await withTimeout(promise, TIMEOUT_MS, label)
  } catch (err) {
    console.error(`Setup guide: ${label} failed`, err)
    return null
  }
}

// A head-only count → true (some), false (none), null (could not tell).
async function exists(query, label) {
  const res = await settle(query, label)
  if (!res || res.error || typeof res.count !== 'number') {
    if (res?.error) console.error(`Setup guide: ${label} failed`, res.error)
    return null
  }
  return res.count > 0
}

async function rpcHasRows(name, args, label, pick = () => true) {
  const res = await settle(supabase.rpc(name, args), label)
  if (!res || res.error || !Array.isArray(res.data)) {
    if (res?.error) console.error(`Setup guide: ${label} failed`, res.error)
    return null
  }
  return res.data.some(pick)
}

/**
 * @param needed    Set of signal names (setupSteps.signalsNeeded)
 * @param clientId  the client being looked at
 * @param scopedFrom useScopedDb().scopedFrom
 * @param today     getBsToday()
 * @returns { signals, firstPeriod } — firstPeriod is the client's earliest month (for the
 *          month-end window), or null when there is none or it could not be read.
 */
export async function loadSetupSignals({ needed, clientId, scopedFrom, today }) {
  const signals = {}
  const head = table => scopedFrom(table, 'id', { count: 'exact', head: true })

  // The client's months. Always read: the month-end window needs the first one, and the
  // period-scoped tables (purchase_entries, sales_entries, opening_stock, closing_stock) carry
  // period_id rather than client_id, so they are counted over these ids. One row per BS month, so
  // tens of rows for any real client — nowhere near the 1000-row cap, and the id list stays short
  // enough for a URL.
  const periodsRes = await settle(
    scopedFrom('monthly_periods', 'id, bs_year, bs_month, status')
      .order('bs_year').order('bs_month').order('id'),
    'months')
  const periodsOk = !!periodsRes && !periodsRes.error && Array.isArray(periodsRes.data)
  if (periodsRes?.error) console.error('Setup guide: months failed', periodsRes.error)
  const periods = periodsOk ? periodsRes.data : null
  const periodIds = periods ? periods.map(p => p.id) : null

  signals.periodsAny = periods ? periods.length > 0 : null
  signals.periodClosed = periods ? periods.some(p => p.status === 'closed') : null

  const inPeriods = async (table, label, extra = q => q) => {
    if (!periodIds) return null
    if (periodIds.length === 0) return false
    return exists(extra(supabase.from(table).select('id', { count: 'exact', head: true }).in('period_id', periodIds)), label)
  }

  const jobs = {
    items: () => exists(head('items').eq('is_active', true).eq('is_sub_recipe', false), 'items'),
    vendors: () => exists(head('vendors').eq('is_active', true), 'suppliers'),
    openingStock: () => inPeriods('opening_stock', 'opening count'),
    purchase: () => inPeriods('purchase_entries', 'purchases'),
    sales: () => inPeriods('sales_entries', 'sales'),
    closingStock: () => inPeriods('closing_stock', 'closing count', q => q.not('physical_qty', 'is', null)),
    // A dish on the menu: active, priced, not a sub-recipe, not switched off the till. NULL-safe on
    // both nullable columns — a bare .neq would drop every NULL row (the S699/S714 trap).
    menuPriced: () => exists(
      head('recipes').eq('is_active', true).gt('selling_price', 0)
        .or('category.is.null,category.neq.Sub-Recipe')
        .not('pos_enabled', 'is', false),
      'menu'),
    // Costed means it has ingredients. Menu Pricing's + Add Item writes a recipes row with a price
    // and NO ingredients, so counting recipes alone would tick this the moment the menu exists.
    recipesCosted: async () => {
      const res = await settle(fetchAllRows(() =>
        scopedFrom('recipes', 'id').eq('is_active', true)
          .or('category.is.null,category.neq.Sub-Recipe').order('id')), 'recipes')
      if (!res || res.error) return null
      const ids = (res.data || []).map(r => r.id)
      if (!ids.length) return false
      // recipe_ingredients has no client_id — scope it by its parent recipe ids, chunked because
      // the ids travel in the URL.
      const chunks = []
      for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK))
      const found = await Promise.all(chunks.map(c => exists(
        supabase.from('recipe_ingredients').select('id', { count: 'exact', head: true }).in('recipe_id', c),
        'recipe ingredients')))
      if (found.some(v => v === true)) return true
      return found.some(v => v === null) ? null : false
    },
    tables: () => exists(head('pos_tables'), 'tables'),
    paidBill: () => exists(head('pos_orders').eq('close_type', 'paid'), 'bills'),
    shiftClosed: () => exists(head('pos_shifts').eq('status', 'closed'), 'shifts'),
    devices: () => rpcHasRows('list_pos_devices', { p_client_id: clientId }, 'till devices', d => !d.revoked_at),
    posStaff: () => rpcHasRows('get_pos_staff_list', { p_client_id: clientId }, 'POS staff'),
    employees: () => exists(head('hr_employees'), 'employees'),
    paySet: () => exists(head('hr_employees').gt('basic_salary', 0), 'pay setup'),
    // This fiscal year's holidays only (Shrawan → Ashadh): last year's list does not pay this
    // year's holiday overtime, so a client who seeded 2082/83 still has 2083/84 to do.
    holidays: () => {
      const fy = fiscalYearOf(today.year, today.month).fyStart
      return exists(head('hr_holiday_calendar').is('removed_at', null)
        .or(`and(bs_year.eq.${fy},bs_month.gte.4),and(bs_year.eq.${fy + 1},bs_month.lte.3)`), 'holidays')
    },
    attendance: () => exists(head('hr_attendance'), 'attendance'),
    selfService: () => rpcHasRows('get_hr_self_service_status', { p_client_id: clientId }, 'staff app logins'),
    payrollFinalized: () => exists(head('hr_payroll_runs').eq('status', 'finalized'), 'payroll'),
  }

  const names = [...needed].filter(n => jobs[n])
  const values = await Promise.all(names.map(n => jobs[n]()))
  names.forEach((n, i) => { signals[n] = values[i] })

  return { signals, firstPeriod: periods && periods.length ? periods[0] : null }
}
