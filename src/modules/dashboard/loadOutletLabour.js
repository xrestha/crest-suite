/**
 * The reads behind the one labour rule (S849, GAPS-4 / SU11 (a)). `labourSource.js` decides; this file
 * only asks, so every page asks the same questions the same way.
 *
 * `from(table, columns)` is the caller's client-scoped builder (the `loadOtherLabourPay` convention):
 * `(t, c) => scopedFrom(t, c)` on a page, `(t, c) => scopedFrom(t, clientId, c)` in the Owner Report.
 * Every HR table read here carries the payslip RLS (`no_ims_staff`), so a fenced login must not call
 * `loadOutletLabour` with `fenced: false` — it would read `[]` with no error, a zero nobody computed.
 *
 * Every read is paged with a unique tiebreaker (OWNER-DASHBOARD-14: the approved-overtime read was not).
 * A failed read returns its error; the rule turns it into `failed`, never into "no staff" or "no run".
 */
import { fetchAllRows, fetchAllRowsChunked } from '../../shared/fetchAllRows'
import { settleWithin } from '../../utils/withTimeout'
import { bsToAd, formatAd, daysInBsMonth } from '../../utils/bsCalendar'
import { loadMonthOtherLabour } from './loadOtherLabourPay'
import { PAYSLIP_LABOUR_COLUMNS, payrollLabourTotal, resolveOutletLabour } from './labourSource'
import {
  ESTIMATE_EMPLOYEE_COLUMNS, ESTIMATE_COMPONENT_COLUMNS, ESTIMATE_OT_COLUMNS,
  ESTIMATE_ATTENDANCE_COLUMNS, ESTIMATE_SETTLEMENT_COLUMNS, estimateLabour,
} from './labourEstimate'

/**
 * The five reads `estimateLabour` needs for one outlet and one month.
 *
 * @param {(table: string, columns: string) => object} from
 * @param {{ id: string, bs_year: number, bs_month: number }} period  a monthly_periods row
 * @returns {Promise<{ inputs: ?{ employees, components, otEntries, attendance, settlements }, error: ?object }>}
 */
export async function loadLabourEstimateInputs(from, period) {
  const monthEnd = formatAd(bsToAd(period.bs_year, period.bs_month, daysInBsMonth(period.bs_year, period.bs_month)))
  const results = await Promise.all([
    // Every employee: payroll's roster rule (payrollRoster) decides who is on the month's list. Paged:
    // read as a MAP, so an employee past a truncated read would accrue nothing.
    fetchAllRows(() => from('hr_employees', ESTIMATE_EMPLOYEE_COLUMNS).order('id')),
    fetchAllRows(() => from('hr_salary_components', ESTIMATE_COMPONENT_COLUMNS).eq('type', 'earning').order('id')),
    fetchAllRows(() => from('hr_overtime_entries', ESTIMATE_OT_COLUMNS)
      .eq('status', 'approved').eq('bs_year', period.bs_year).eq('bs_month', period.bs_month).order('id')),
    // One row per employee per day: past 1,000 rows at ~34 staff.
    fetchAllRows(() => from('hr_attendance', ESTIMATE_ATTENDANCE_COLUMNS).eq('period_id', period.id).order('id')),
    fetchAllRows(() => from('hr_final_settlements', ESTIMATE_SETTLEMENT_COLUMNS)
      .eq('status', 'finalized').lte('last_working_date', monthEnd).order('id')),
  ])
  const failed = results.find(r => r.error)
  if (failed) return { inputs: null, error: failed.error }
  const [employees, components, otEntries, attendance, settlements] = results.map(r => r.data || [])
  return { inputs: { employees, components, otEntries, attendance, settlements }, error: null }
}

/**
 * One outlet's labour for one month, through the one rule.
 *
 * @param {(table: string, columns: string) => object} from
 * @param {object}  o
 * @param {object}  o.period        a monthly_periods row ({ id, bs_year, bs_month })
 * @param {boolean} o.hrOn          clients.hr_enabled for the outlet
 * @param {boolean} [o.fenced]      isPayrollFenced(...) for the viewer: no HR read is made
 * @param {number}  [o.throughDay]  the estimate's last day (mtdClock.countedDays); default the whole month
 * @param {number}  [o.labourBucket] the typed Labor tab for the period
 * @param {number}  [o.scale]       mtdClock.fraction for the running month (the run and the Labor tab)
 * @param {number}  [o.timeoutMs]   each read settles within this; a timeout is a failed read
 * @returns {Promise<{ labour: object, parts: object, error: ?object }>}
 *   parts: every resolveOutletLabour argument but labourBucket and scale, so a page that holds the Labor
 *   tab in editable state (Overheads) or a cache re-resolves at render:
 *   `resolveOutletLabour({ ...parts, labourBucket, scale })`. error: the failure that made the labour
 *   `failed` (for the banner's fine print), else null.
 */
export async function loadOutletLabour(from, { period, hrOn, fenced = false, throughDay, labourBucket = 0, scale = 1, timeoutMs = 20000 } = {}) {
  const parts = {
    hrOn: !!hrOn, fenced: !!fenced, payroll: null, payrollReadFailed: false,
    estimate: null, estimateReadFailed: false, otherPay: null,
  }
  if (!period || !hrOn || fenced) {
    return { labour: resolveOutletLabour({ ...parts, labourBucket, scale }), parts, error: null }
  }

  const [runsRes, otherRes, inputsRes] = await Promise.all([
    settleWithin(from('hr_payroll_runs', 'id').eq('period_id', period.id).eq('status', 'finalized'), timeoutMs, 'Payroll runs'),
    // Festival, incentive and final-settlement pay finalized for the month (S798 3c): a failed read is a
    // failed payroll read — never a figure without it.
    settleWithin(loadMonthOtherLabour(from, period.bs_year, period.bs_month), timeoutMs, 'Other labour'),
    settleWithin(loadLabourEstimateInputs(from, period), timeoutMs, 'Labour estimate'),
  ])

  let payrollError = runsRes.error || otherRes.error || null
  const runIds = (runsRes.data || []).map(r => r.id)
  if (!payrollError && runIds.length > 0) {
    // One row per employee per run: paged and chunked, with a unique tiebreaker.
    const slipRes = await settleWithin(fetchAllRowsChunked(runIds, chunk =>
      from('hr_payslips', PAYSLIP_LABOUR_COLUMNS).in('run_id', chunk).order('id')), timeoutMs, 'Payslips')
    if (slipRes.error) payrollError = slipRes.error
    else parts.payroll = payrollLabourTotal(slipRes.data || [])
  }
  parts.payrollReadFailed = !!payrollError
  parts.otherPay = otherRes.error ? null : (otherRes.other ?? null)

  const estimateError = inputsRes.error || (!inputsRes.inputs ? new Error('Labour estimate inputs were not read') : null)
  parts.estimateReadFailed = !!estimateError
  if (!estimateError) {
    parts.estimate = estimateLabour({ ...inputsRes.inputs, period, throughDay })
  }

  const labour = resolveOutletLabour({ ...parts, labourBucket, scale })
  const error = labour.source !== 'failed' ? null : (payrollError || estimateError)
  return { labour, parts, error }
}

/**
 * The group pages' estimate inputs, one row per member outlet (`get_group_labour_inputs`, mig S849 §2).
 *
 * @param {(name: string, args: object) => Promise} rpc  `(name, args) => supabase.rpc(name, args)`
 * @param {object} o
 * @param {number} o.bsYear
 * @param {number} o.bsMonth
 * @param {?string} [o.groupId]  null for an Owner (their own group); the operator's view-as passes
 *                               AuthContext's `viewGroupId` (ACCESS-8 support view)
 * @returns {Promise<{ byClient: ?Map<string, { included, hrEnabled, periodId, periodStatus, hasFinalizedRun,
 *   inputs: ?{ employees, components, otEntries, attendance, settlements } }>, error: ?object }>}
 *   inputs is null unless the outlet is included, has HR, has the month and no finalized run. Employees
 *   carry no name, so noPay / unended name nobody: the group pages print counts.
 */
export async function loadGroupLabourInputs(rpc, { bsYear, bsMonth, groupId = null, timeoutMs = 20000 } = {}) {
  const { data, error } = await settleWithin(
    rpc('get_group_labour_inputs', { p_bs_year: bsYear, p_bs_month: bsMonth, p_group_id: groupId ?? null }),
    timeoutMs, 'Group labour inputs')
  if (error) return { byClient: null, error }
  const byClient = new Map()
  for (const r of data || []) {
    byClient.set(r.client_id, {
      included: !!r.is_included,
      hrEnabled: !!r.hr_enabled,
      periodId: r.period_id ?? null,
      periodStatus: r.period_status ?? null,
      hasFinalizedRun: !!r.has_finalized_run,
      inputs: groupRowInputs(r),
    })
  }
  return { byClient, error: null }
}

/**
 * One RPC row's five arrays in `estimateLabour`'s shape, or null when the row ships none. The RPC sends a
 * boolean `ssf_contributor` instead of the SSF number; it is mapped onto the two fields
 * `isSsfContributor` reads, so the estimate runs unchanged.
 */
export function groupRowInputs(r) {
  if (!r || r.employees == null) return null
  return {
    employees: (r.employees || []).map(e => ({
      id: e.id, status: e.status, basic_salary: e.basic_salary, pay_basis: e.pay_basis,
      join_date: e.join_date, end_date: e.end_date,
      ssf_enrolled: !!e.ssf_contributor, ssf_no: e.ssf_contributor ? 'on file' : null,
    })),
    components: r.components || [],
    otEntries: r.ot_entries || [],
    attendance: r.attendance || [],
    settlements: r.settlements || [],
  }
}
