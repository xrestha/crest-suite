// Stock transfers between outlets of one group (S849, PNL-8): the one reader of the transfer tables,
// and the pure helpers every stock figure folds them in with.
//
// THE INVARIANT (mig S849 §1): a row in ims_stock_transfer_lines exists only when it counts for that
// outlet's figures. Send writes `sent` lines (direction out) at the SENDER; Receive writes `received`
// lines (in) at the RECEIVER; Cancel or Refuse writes `returned` lines (in) back at the SENDER. So a
// reader sums the lines it can see by direction and period, exactly as it sums purchases and supplier
// returns, and needs no idea of "on the way": no status filter, no is_active filter (a hidden item
// keeps its history), and no prep (a transfer carries raw items only).
//
//   direction 'in'  → adds like a purchase       (Net Purchases + value, on-hand + qty)
//   direction 'out' → subtracts like a return    (Net Purchases − value, on-hand − qty)
//
// `value` is qty × the sender's rate frozen at sending (a stored generated column): no bill discount
// and no VAT factor, it is already the cost basis stock is valued at. Gross Purchases and Returns stay
// supplier-only; the statutory and vendor readers (VAT, Non-VAT, 1L+, payables, Vendor Report, price
// trackers, supplier attribution) never read either table.
//
// A failed transfer read is a failed report read, never "no transfers": callers pass the `error` into
// their firstError() batch like any other read.
import { supabase } from '../../../supabaseClient'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { BS_MONTHS } from '../../../utils/bsCalendar'

/** The columns every stock reader takes. Lines stand alone without their header. */
export const TRANSFER_LINE_SELECT =
  'id, period_id, transfer_id, leg, direction, counterpart_name, bs_day, item_id, qty, rate, value, prep_label, ' +
  'created_by_name, created_at'

/**
 * The header columns the Stock Transfers page lists (both outlets can read a header). The stored
 * sent_/ended_bs_* labels are the month as recorded; sent_period_id / ended_period_id are the period
 * rows the lines are in, so a month relabel moves with them (mig review N5). A reader that can see the
 * period row shows its current label; the other outlet's period rows are not readable, so it falls back
 * to the stored label.
 */
export const TRANSFER_HEADER_SELECT =
  'id, client_id, to_client_id, from_name, to_name, status, lines, total_value, note, ' +
  'sent_at, sent_bs_year, sent_bs_month, sent_bs_day, sent_period_id, sent_by_name, ' +
  'ended_at, ended_bs_year, ended_bs_month, ended_bs_day, ended_period_id, ended_by_name, end_reason'

/** send_stock_transfer refuses a transfer of more lines than this (stock_transfer_too_many_lines). */
export const MAX_TRANSFER_LINES = 500

export const TRANSFER_STATUSES = ['on_the_way', 'received', 'cancelled', 'refused']

const asError = e => ({ message: e?.message || String(e) })

/**
 * This outlet's transfer lines for one period (an id) or a window (an array of ids), paged and
 * ordered on the unique id. Never throws; `{ data, error }`.
 *
 * `scopedFrom` is useScopedDb()'s (or a reader's own bound scopedFrom). The lines are read by
 * period_id, the same scoping the readers use for purchase_entries / vendor_returns; scopedFrom adds
 * the client_id fence on top. A long window is chunked (the ids travel in the URL).
 */
export async function readPeriodTransfers(scopedFrom, periodIds, { select = TRANSFER_LINE_SELECT } = {}) {
  const ids = (Array.isArray(periodIds) ? periodIds : [periodIds]).filter(id => id != null)
  if (ids.length === 0) return { data: [], error: null }
  if (typeof scopedFrom !== 'function') return { data: null, error: { message: 'Stock transfers could not be read: no outlet is selected.' } }
  try {
    if (ids.length === 1) {
      return await fetchAllRows(() => scopedFrom('ims_stock_transfer_lines', select)
        .eq('period_id', ids[0])
        .order('id'))
    }
    return await fetchAllRowsChunked(ids, chunk => scopedFrom('ims_stock_transfer_lines', select)
      .in('period_id', chunk)
      .order('id'))
  } catch (e) {
    return { data: null, error: asError(e) }
  }
}

/**
 * Transfers this outlet SENT (the header's client_id is the sender), oldest first. Paged.
 * Optional `statuses` narrows by status. Never throws.
 */
export async function readOutgoingTransfers(scopedFrom, { statuses } = {}) {
  if (typeof scopedFrom !== 'function') return { data: null, error: { message: 'Stock transfers could not be read: no outlet is selected.' } }
  try {
    return await fetchAllRows(() => {
      let q = scopedFrom('ims_stock_transfers', TRANSFER_HEADER_SELECT)
      if (statuses?.length) q = q.in('status', statuses)
      return q.order('sent_at').order('id')
    })
  } catch (e) {
    return { data: null, error: asError(e) }
  }
}

/**
 * Transfers sent TO this outlet, oldest first. Paged. Never throws.
 *
 * The one documented exception to the scoped data layer: an incoming header is the SENDER's row
 * (its client_id is the sender), so it is read by to_client_id. RLS returns exactly
 * `to_client_id = my_client_id()` for a client session (ims_stock_transfers_all), and this fails
 * closed without a clientId, never reading unfenced.
 */
export async function readIncomingTransfers(clientId, { statuses } = {}) {
  if (!clientId) return { data: null, error: { message: 'No outlet selected — refusing to read incoming stock transfers without one.' } }
  try {
    return await fetchAllRows(() => {
      let q = supabase.from('ims_stock_transfers').select(TRANSFER_HEADER_SELECT).eq('to_client_id', clientId)
      if (statuses?.length) q = q.in('status', statuses)
      return q.order('sent_at').order('id')
    })
  } catch (e) {
    return { data: null, error: asError(e) }
  }
}

const num = v => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}
const isIn = l => l?.direction === 'in'
const isOut = l => l?.direction === 'out'

/** Pure: per-item quantities by direction → `{ in: id → qty, out: id → qty }`. */
export function transferQtyByItem(lines) {
  const out = { in: {}, out: {} }
  for (const l of lines || []) {
    if (!l || l.item_id == null) continue
    const side = isIn(l) ? out.in : isOut(l) ? out.out : null
    if (side) side[l.item_id] = (side[l.item_id] || 0) + num(l.qty)
  }
  return out
}

/** Pure: per-item values by direction → `{ in: id → value, out: id → value }`. */
export function transferValueByItem(lines) {
  const out = { in: {}, out: {} }
  for (const l of lines || []) {
    if (!l || l.item_id == null) continue
    const side = isIn(l) ? out.in : isOut(l) ? out.out : null
    if (side) side[l.item_id] = (side[l.item_id] || 0) + lineValue(l)
  }
  return out
}

/** Pure: per-item net quantity (in − out) → id → qty, for an on-hand or expected-quantity reader. */
export function transferNetQtyByItem(lines) {
  const { in: tin, out: tout } = transferQtyByItem(lines)
  const net = {}
  for (const [id, q] of Object.entries(tin)) net[id] = (net[id] || 0) + q
  for (const [id, q] of Object.entries(tout)) net[id] = (net[id] || 0) - q
  return net
}

/** Pure: the period's totals → `{ inVal, outVal }`. */
export function transferTotals(lines) {
  let inVal = 0
  let outVal = 0
  for (const l of lines || []) {
    if (isIn(l)) inVal += lineValue(l)
    else if (isOut(l)) outVal += lineValue(l)
  }
  return { inVal, outVal }
}

/** A line's value: the stored `value`, else qty × rate (a row from an older read or a test). */
export function lineValue(line) {
  if (line?.value != null && line.value !== '') return num(line.value)
  return num(line?.qty) * num(line?.rate)
}

// ── Preview problems (send_stock_transfer's dry run, per line) ───────────────────────────────────
// Wording from plan-PNL.md (per-line problems), as sentences.
const PROBLEM_TEXT = {
  not_this_outlet: 'Not an item of this outlet.',
  hidden: 'Hidden in Item Master — show it first.',
  prep: 'A prep item (sent as its ingredients): remove it and add it again from the item list.',
  qty: 'Quantity must be above 0.',
  no_rate: 'No price in Item Master.',
  no_match: 'No matching item at the other outlet — push it from HQ first.',
  ambiguous: 'Two matching items at the other outlet.',
  unit: 'The other outlet counts it in a different unit.',
  same_item_twice: 'Two lines land on the same item at the other outlet.',
}

/** Plain words for a per-line problem code from the preview; null for no problem. */
export function problemText(code) {
  if (!code) return null
  return PROBLEM_TEXT[code] || 'This line can\'t be sent as it is.'
}

/** Pure: does a dry-run plan have any line that cannot go? */
export function planHasProblems(plan) {
  return !plan || !Array.isArray(plan.lines) || plan.lines.length === 0 || plan.lines.some(l => !!l?.problem)
}

// ── Status and dates ──────────────────────────────────────────────────────────────────────────────
const STATUS_LABEL = {
  on_the_way: 'On the way',
  received: 'Received',
  cancelled: 'Cancelled',
  refused: 'Refused',
}
export function statusLabel(status) {
  return STATUS_LABEL[status] || status || '—'
}

/** "12 Bhadra 2083" from a BS (year, month, day) triple; '—' when incomplete. */
export function bsDateLabel(y, m, d) {
  if (!y || !m) return '—'
  const month = BS_MONTHS[m - 1] || `Month ${m}`
  return d ? `${d} ${month} ${y}` : `${month} ${y}`
}

/** "Bhadra 2083" from a BS (year, month) pair. */
export function bsMonthLabel(y, m) {
  return bsDateLabel(y, m, null)
}

// ── The three writes (SECURITY DEFINER RPCs; the page wraps each in withTimeout) ──────────────────
// Each resolves supabase-js's { data, error }; never throws for a refusal. The error carries the
// RAISE code as its HINT, which errorText.js words.

/**
 * send_stock_transfer. `lines` = [{ item_id, qty, prep_label? }] of the SENDING outlet's raw items.
 * `dryRun: true` returns the plan (per line: rate, value, the receiving item or the problem) and writes
 * nothing. `transferId` is the idempotency key: mint one per send attempt and reuse it for retries of
 * that same send.
 */
/**
 * A quantity as send_stock_transfer reads it: a plain decimal with at most 6 places (its pattern is
 * `^[0-9]{1,12}(\.[0-9]{1,6})?$`). A float sum such as 0.1 + 0.2 = 0.30000000000000004 would
 * otherwise come back as a `qty` problem, and a tiny one would be written in exponent form.
 */
export function qtyParam(qty) {
  const n = Number(qty)
  if (!Number.isFinite(n)) return ''
  const s = n.toFixed(6).replace(/\.?0+$/, '')
  return s === '-0' ? '0' : s
}

export function sendStockTransfer({ transferId, fromClientId, toClientId, lines, note, dryRun = false }) {
  return supabase.rpc('send_stock_transfer', {
    p_transfer_id: transferId,
    p_from_client_id: fromClientId,
    p_to_client_id: toClientId,
    p_lines: (lines || []).map(l => ({
      item_id: l.item_id,
      qty: qtyParam(l.qty),
      ...(l.prep_label ? { prep_label: l.prep_label } : {}),
    })),
    p_note: note ? String(note) : null,
    p_dry_run: !!dryRun,
  })
}

/** receive_stock_transfer: the whole transfer, into the receiver's open month, today. Final. */
export function receiveStockTransfer(transferId) {
  return supabase.rpc('receive_stock_transfer', { p_transfer_id: transferId })
}

/** end_stock_transfer: 'cancel' (sender) or 'refuse' (receiver), with a reason of 3+ characters. */
export function endStockTransfer(transferId, action, reason) {
  return supabase.rpc('end_stock_transfer', { p_transfer_id: transferId, p_action: action, p_reason: reason })
}
