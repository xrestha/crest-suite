/**
 * The read behind "other labour paid" (S798 stage 3c, LABOUR-FIGURES-1): a month's FINALIZED festival
 * allowance and incentives by the month they are paid in, and finalized Final Settlements by the month
 * they were settled in. `labourSource.js` holds the arithmetic (`otherLabourTotals`); this file only
 * reads, so every labour reader asks the same three questions the same way.
 *
 * `from(table, columns)` is the caller's own client-scoped builder: `(t, c) => scopedFrom(t, c)` on a
 * page, `(t, c) => scopedFrom(t, clientId, c)` in the Owner Report. The three tables carry the same
 * RLS as `hr_payslips`, so a login fenced from payroll (`isPayrollFenced`) must not call this at all:
 * it would read `[]` with no error, a zero nobody computed.
 *
 * Paged with a unique tiebreaker (one row per employee per run). A failed read returns `error` and no
 * totals; the caller treats it as a failed payroll read, never as "none paid".
 */
import { fetchAllRows } from '../../shared/fetchAllRows'
import {
  FESTIVAL_LABOUR_COLUMNS, INCENTIVE_LABOUR_COLUMNS, SETTLEMENT_LABOUR_COLUMNS,
  otherLabourTotals, NO_OTHER_LABOUR,
} from './labourSource'

const keyOf = (y, m) => Number(y) * 100 + Number(m)

/**
 * @param {(table: string, columns: string) => object} from
 * @param {Array<{ bsYear: number, bsMonth: number }>} months
 * @returns {Promise<{ byKey: ?Map<number, object>, error: ?object }>} byKey: `bsYear*100+bsMonth` →
 *   otherLabourTotals(); every month asked for has an entry, NO_OTHER_LABOUR when nothing was paid.
 */
export async function loadOtherLabourPay(from, months) {
  const list = (months || []).filter(m => m && m.bsYear && m.bsMonth)
  if (list.length === 0) return { byKey: new Map(), error: null }
  const years = [...new Set(list.map(m => Number(m.bsYear)))]
  const monthNos = [...new Set(list.map(m => Number(m.bsMonth)))]
  const wanted = new Set(list.map(m => keyOf(m.bsYear, m.bsMonth)))

  const [fest, inc, set] = await Promise.all([
    fetchAllRows(() => from('hr_festival_allowances', `${FESTIVAL_LABOUR_COLUMNS}, bs_year, bs_month`)
      .eq('status', 'finalized').in('bs_year', years).in('bs_month', monthNos).order('id')),
    fetchAllRows(() => from('hr_incentives', `${INCENTIVE_LABOUR_COLUMNS}, bs_year, bs_month`)
      .eq('status', 'finalized').in('bs_year', years).in('bs_month', monthNos).order('id')),
    fetchAllRows(() => from('hr_final_settlements', `${SETTLEMENT_LABOUR_COLUMNS}, settle_bs_year, settle_bs_month`)
      .eq('status', 'finalized').in('settle_bs_year', years).in('settle_bs_month', monthNos).order('id')),
  ])
  const error = fest.error || inc.error || set.error
  if (error) return { byKey: null, error }

  // The year and month lists cross (Chaitra 2082 and Baisakh 2083 also ask for Baisakh 2082), so
  // each row is kept only when its own month was asked for.
  const groups = new Map([...wanted].map(k => [k, { festival: [], incentives: [], settlements: [] }]))
  for (const r of fest.data || []) groups.get(keyOf(r.bs_year, r.bs_month))?.festival.push(r)
  for (const r of inc.data || []) groups.get(keyOf(r.bs_year, r.bs_month))?.incentives.push(r)
  for (const r of set.data || []) groups.get(keyOf(r.settle_bs_year, r.settle_bs_month))?.settlements.push(r)

  const byKey = new Map()
  for (const [k, g] of groups) byKey.set(k, otherLabourTotals(g))
  return { byKey, error: null }
}

/** One month's totals out of `byKey`, NO_OTHER_LABOUR when it holds nothing for it. */
export function otherLabourFor(byKey, bsYear, bsMonth) {
  return byKey?.get(keyOf(bsYear, bsMonth)) || NO_OTHER_LABOUR
}

/** The one-month form most readers want: `{ other, error }`. */
export async function loadMonthOtherLabour(from, bsYear, bsMonth) {
  const { byKey, error } = await loadOtherLabourPay(from, [{ bsYear, bsMonth }])
  if (error) return { other: null, error }
  return { other: otherLabourFor(byKey, bsYear, bsMonth), error: null }
}
