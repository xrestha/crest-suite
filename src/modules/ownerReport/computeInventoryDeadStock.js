// Dead/Slow Stock for the frozen Monthly Owner Report.
//
// S756 (D20): this section now reaches the SAME verdict the live Dead Stock page reaches for the
// same period, through the same pure module — `deadStockCalc.js`. Until S756 it kept a private
// copy of the old one-month rule ("zero use this month = Dead"), so once the page moved to "Dead
// only after 3 consecutive counted still months" every snapshot frozen at close disagreed with the
// page it claims to summarise, and a frozen disagreement is never repaired. Never re-derive the
// rule here: judgeItemPeriod / classifyItem / suggestNextStep are the only definitions.
//
// What that needs, and why it mirrors DeadStock.js's fetchData line for line:
//   - the report's period and up to eleven periods before it (HISTORY_MONTHS), because a streak
//     cannot be measured from one month;
//   - every read PAGED and CHUNKED — one row per item per month × 12 months crosses PostgREST's
//     silent 1000-row cap at ~85 items, and a missing closing_stock row is indistinguishable from
//     "not counted", which would break a Dead streak with no error to catch (S717);
//   - `throwFirstError`, so a failed read names this sub-section as failed (runSub) instead of
//     freezing a list of zeros into the immutable snapshot (S612).
//
// The S717 three states survive into the snapshot as counts: assessed, not counted (no closing row
// for the report's month — a count of 0 IS a count), and inconsistent (counted higher than was
// available). Only assessed items can be Dead or Slow.
import { supabase } from '../../supabaseClient'
import { scopedFrom } from '../../shared/scopedDb'
import { fetchAllRows, fetchAllRowsChunked } from '../../shared/fetchAllRows'
import { throwFirstError } from '../../shared/queryError'
import { bsToAd, formatBsDay } from '../../utils/bsCalendar'
import { asOfForWindow, periodMonthIndex } from '../ims/reports/stockAgeingCalc'
import {
  judgeItemPeriod, classifyItem, suggestNextStep, DEAD_AFTER_MONTHS,
} from '../ims/stockcount/deadStockCalc'

// Same window as DeadStock.js: Dead needs three months, the rest lets "still for N months" say how
// long, up to a year.
export const HISTORY_MONTHS = 12

const num = v => parseFloat(v) || 0
function sumByPeriodItem(rows, field) {
  const out = {}
  for (const r of rows || []) {
    if (!out[r.period_id]) out[r.period_id] = {}
    out[r.period_id][r.item_id] = (out[r.period_id][r.item_id] || 0) + num(r[field])
  }
  return out
}

/**
 * The report's period and the ones before it, newest first, capped at HISTORY_MONTHS rows. Periods
 * AFTER the report's month are excluded by month index rather than by list position, so a Regenerate
 * Snapshot run months later still measures the streak that ended with this period.
 */
export function historyFor(periods, period, months = HISTORY_MONTHS) {
  const end = periodMonthIndex(period)
  return (periods || [])
    .filter(p => periodMonthIndex(p) <= end)
    .sort((a, b) => periodMonthIndex(b) - periodMonthIndex(a))
    .slice(0, months)
}

/**
 * Pure: the section from already-read rows. `history` is newest first and must start with the
 * report's period. Exported so the verdict can be tested without a database.
 */
export function buildDeadStockSection({ history, items, openings, purchases, returns, wastages, staffMeals, closings, vendors, asOf }) {
  const openMap  = sumByPeriodItem(openings, 'qty')
  const purchMap = sumByPeriodItem(purchases, 'qty')
  const retMap   = sumByPeriodItem(returns, 'qty')
  const wasteMap = sumByPeriodItem(wastages, 'qty')
  const staffMap = sumByPeriodItem(staffMeals, 'qty')
  // Built directly: presence is the fact the verdict turns on, and a 0 count must be present (S695).
  const closeMap = {}
  for (const r of closings || []) {
    if (r.physical_qty == null) continue
    if (!closeMap[r.period_id]) closeMap[r.period_id] = {}
    closeMap[r.period_id][r.item_id] = num(r.physical_qty)
  }

  const periodById = Object.fromEntries((history || []).map(p => [p.id, p]))
  const vendorName = Object.fromEntries((vendors || []).map(v => [v.id, v.name]))
  const lastBuy = {}
  for (const p of purchases || []) {
    const per = periodById[p.period_id]
    if (!per || !(num(p.qty) > 0)) continue
    const rank = periodMonthIndex(per) * 40 + (parseInt(p.bs_day, 10) || 0)
    if (!lastBuy[p.item_id] || rank > lastBuy[p.item_id].rank) lastBuy[p.item_id] = { rank, row: p, period: per }
  }

  const selected = history?.[0]
  let deadCount = 0, slowCount = 0, totalValueAtRisk = 0
  let assessedCount = 0, uncountedCount = 0, inconsistentCount = 0
  const flagged = []

  for (const item of (selected ? items || [] : [])) {
    const monthFigures = pid => ({
      opening:   openMap[pid]?.[item.id] || 0,
      purchased: purchMap[pid]?.[item.id] || 0,
      returned:  retMap[pid]?.[item.id] || 0,
      wasted:    wasteMap[pid]?.[item.id] || 0,
      staffUsed: staffMap[pid]?.[item.id] || 0,
      hasCount:  !!closeMap[pid] && item.id in closeMap[pid],
      closing:   closeMap[pid]?.[item.id] || 0,
    })
    const itemHistory = history.map(p => ({ monthIndex: periodMonthIndex(p), judgement: judgeItemPeriod(monthFigures(p.id)) }))
    const latest = itemHistory[0].judgement
    if (latest.state === 'absent') continue
    if (latest.state === 'uncounted') { uncountedCount += 1; continue }
    if (latest.state === 'inconsistent') { inconsistentCount += 1; continue }
    assessedCount += 1

    const verdict = classifyItem(itemHistory)
    if (!verdict.status) continue

    const f = monthFigures(selected.id)
    const buy = lastBuy[item.id]
    const lastPurchase = buy ? {
      date: bsToAd(buy.period.bs_year, buy.period.bs_month, Math.min(Math.max(parseInt(buy.row.bs_day, 10) || 1, 1), 32)),
      vendorName: buy.row.vendor_id ? (vendorName[buy.row.vendor_id] || null) : null,
      expiryDate: buy.row.expiry_date || null,
    } : null
    const suggestion = suggestNextStep({ status: verdict.status, stillMonths: verdict.stillMonths, lastPurchase, asOf })

    const valueAtRisk = f.closing * num(item.per_uom_rate)
    if (verdict.status === 'Dead') deadCount += 1; else slowCount += 1
    totalValueAtRisk += valueAtRisk
    flagged.push({
      itemId: item.id, name: item.name,
      opening: f.opening, purchased: f.purchased, returned: f.returned, wasted: f.wasted,
      used: latest.used, closing: f.closing, valueAtRisk, status: verdict.status,
      // New in schema v7 — an older snapshot has none of these, and its renderers must say so
      // rather than print 0 or blank as if it were a finding.
      stillMonths: verdict.stillMonths,
      atLeast: verdict.atLeast,
      suggestion: suggestion?.text || null,
      lastBought: buy ? `${formatBsDay(buy.row.bs_day, buy.period.bs_month)} ${buy.period.bs_year}` : null,
      supplier: lastPurchase?.vendorName || null,
    })
  }

  return {
    // `rule` is how a renderer tells a v7 section from a v1–v6 one without reading schemaVersion.
    rule: 'streak',
    deadAfterMonths: DEAD_AFTER_MONTHS,
    historyMonths: (history || []).length,
    assessedCount, uncountedCount, inconsistentCount,
    deadCount, slowCount, totalValueAtRisk,
    items: flagged.sort((a, b) => b.valueAtRisk - a.valueAtRisk),
  }
}

export async function computeInventoryDeadStock(clientId, period) {
  const periodsRes = await fetchAllRows(() => scopedFrom('monthly_periods', clientId, 'id, bs_year, bs_month, status').order('id'))
  throwFirstError([periodsRes])
  const history = historyFor(periodsRes.data, period)
  // The report's own period must head the window; if the list read somehow lacks it, use the
  // period we were handed rather than measuring a streak that ends in some other month.
  if (!history.length || history[0].id !== period.id) history.unshift(period)
  const ids = history.map(p => p.id)
  const byMonth = (table, cols) => fetchAllRowsChunked(ids, c =>
    supabase.from(table).select(cols).in('period_id', c).order('id'))

  const results = await Promise.all([
    fetchAllRows(() => scopedFrom('items', clientId, 'id, name, per_uom_rate')
      .eq('is_active', true).eq('is_sub_recipe', false).order('id')),
    byMonth('opening_stock', 'period_id, item_id, qty'),
    byMonth('purchase_entries', 'period_id, item_id, qty, bs_day, expiry_date, vendor_id'),
    fetchAllRowsChunked(ids, c => scopedFrom('vendor_returns', clientId, 'period_id, item_id, qty').in('period_id', c).order('id')),
    byMonth('wastages', 'period_id, item_id, qty'),
    byMonth('staff_meals', 'period_id, item_id, qty'),
    byMonth('closing_stock', 'period_id, item_id, physical_qty'),
    // Every vendor, archived included: this resolves a NAME on history (S708).
    fetchAllRows(() => scopedFrom('vendors', clientId, 'id, name').order('id')),
  ])
  throwFirstError(results)
  const [
    { data: items }, { data: openings }, { data: purchases }, { data: returns },
    { data: wastages }, { data: staffMeals }, { data: closings }, { data: vendors },
  ] = results

  // The page's as-of rule for a month that is not the newest: the last day of the period, so a
  // frozen "bought N days ago" does not depend on when the snapshot happened to be generated.
  const asOf = asOfForWindow(period, { isNewest: false }).date

  return buildDeadStockSection({ history, items, openings, purchases, returns, wastages, staffMeals, closings, vendors, asOf })
}
