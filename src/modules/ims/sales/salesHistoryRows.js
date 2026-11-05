// Sales Entry's Change history (S885, owner decisions: the Owner and IMS managers see who changed a
// day's sales and what it said before, deletions included; any change a signed-in person makes is
// logged, the till's own automatic sales are not; the record starts the day it went live).
//
// The rows come from get_sales_history(p_period_id, p_before_id, p_limit), newest first. The server
// nets out unchanged re-saves, so every row is a real change. This file turns one into what a row on
// screen says, and pages the list; it reads nothing and imports no Supabase client, so it is tested.
import { formatBsDay } from '../../../utils/bsCalendar'
import { nprExact, NPR_LOCALE } from '../../../shared/nepalMoney'

// What the RPC is asked for per press of Load more. Its own default is 200 too.
export const HISTORY_PAGE_SIZE = 200

// The day the record started (migration 20261104190000). A change saved before it is not listed.
export const HISTORY_STARTED_AD = '2026-11-04'

export const HISTORY_KIND_LABEL = { added: 'Added', changed: 'Changed', removed: 'Removed' }

// old_qty NULL: the line was added. new_qty NULL: it was removed. Both present: it changed.
export function historyKind(row) {
  if (row?.old_qty == null) return 'added'
  if (row?.new_qty == null) return 'removed'
  return 'changed'
}

// Day 0 is the Bulk (month total) row; any other day names its month, never a bare number.
export function historyDayLabel(bsDay, bsMonth) {
  const d = Number(bsDay)
  if (d === 0) return 'Bulk'
  return formatBsDay(d, bsMonth) || String(bsDay ?? '')
}

// A quantity as typed, Nepali grouping, up to three places (a quantity is not money).
const qtyFmt = new Intl.NumberFormat(NPR_LOCALE, { maximumFractionDigits: 3 })
export function historyQtyText(qty) {
  return qty == null ? '—' : qtyFmt.format(Number(qty) || 0)
}

// A value the server could not price (a missing price) is a dash, never NPR 0.
export function historyValueText(value) {
  return value == null ? '—' : nprExact(value)
}

// One row as the table shows it. The side that did not exist (before an add, after a remove) is
// a dash on both its lines.
export function historyRowView(row, bsMonth) {
  const kind = historyKind(row)
  return {
    id: row.id,
    kind,
    kindLabel: HISTORY_KIND_LABEL[kind],
    day: historyDayLabel(row.bs_day, bsMonth),
    dish: row.recipe_name || 'A dish no longer on the menu',
    beforeQty: kind === 'added' ? '—' : historyQtyText(row.old_qty),
    beforeValue: kind === 'added' ? '—' : historyValueText(row.old_value),
    afterQty: kind === 'removed' ? '—' : historyQtyText(row.new_qty),
    afterValue: kind === 'removed' ? '—' : historyValueText(row.new_value),
    by: row.changed_by_name || 'A login that has since been removed',
    at: row.changed_at,
  }
}

// The list after a page lands: earlier rows kept, a row already shown never twice (a change written
// between two presses moves the boundary, not the ids), newest first by id.
export function mergeHistoryPages(prev, next) {
  const seen = new Set((prev || []).map(r => r.id))
  const out = [...(prev || [])]
  for (const r of next || []) if (!seen.has(r.id)) { seen.add(r.id); out.push(r) }
  return out.sort((a, b) => Number(b.id) - Number(a.id))
}

// The id to ask the next page from, or null when this page was the last one. A full page may be
// followed by an empty one, which then says there is no more.
export function nextBeforeId(page, pageSize = HISTORY_PAGE_SIZE) {
  if (!page || page.length < pageSize) return null
  return page.reduce((min, r) => (min == null || Number(r.id) < Number(min) ? r.id : min), null)
}
