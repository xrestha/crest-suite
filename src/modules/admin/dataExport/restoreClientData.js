// Rebuilds a client's data from the .json artifact produced by exportClientData.js.
//
// Insert order is the REVERSE of deleteClientData's delete order (admin-user-ops/index.ts).
// That sequence already encodes the full FK dependency graph of this schema — including the
// circular pos_orders <-> pos_credit_notes reference and the monthly_owner_reports ->
// monthly_periods ordering, both of which only surfaced as production errors (S382). Deriving a
// fresh insert order by inspection would be re-doing that discovery, wrongly.
//
// Scope: this restores DATA. Logins are a separate concern (reprovisionAccounts.js) because
// passwords live in GoTrue and are not exportable at any privilege level.
import { supabase } from '../../../supabaseClient'

// Reverse of the delete sequence: parents before children, so every FK target exists first.
const RESTORE_ORDER = [
  // Foundations
  'categories', 'vendors', 'items', 'recipes', 'recipe_ingredients', 'recipe_suggestions',
  'monthly_periods', 'monthly_owner_reports',
  // Fixed assets
  'assets_categories', 'assets_register', 'assets_repair_expenses',
  'assets_tax_pool_runs', 'assets_tax_pool_lines',
  'assets_depreciation_runs', 'assets_depreciation_schedule',
  // IMS operational
  'overheads', 'par_levels', 'purchase_orders', 'purchase_order_items',
  'requisitions', 'requisition_lines', 'ims_gate_passes',
  'demand_forecast_run_log', 'demand_forecast_daily',
  'purchase_entries', 'payable_payments', 'vendor_returns',
  'opening_stock', 'closing_stock', 'wastages', 'staff_meals', 'sales_entries', 'budgets',
  // HR setup then transactions
  'hr_shift_types', 'hr_holiday_calendar', 'hr_leave_types', 'hr_employees',
  'hr_salary_components', 'hr_roster', 'hr_roster_publish_state', 'hr_shift_swap_requests',
  'hr_incentive_configs', 'hr_incentives', 'hr_tada_claims', 'hr_tada_claim_items',
  'hr_advances', 'hr_advance_repayments', 'hr_festival_allowances',
  'hr_overtime_entries', 'hr_leave_requests', 'hr_attendance',
  'hr_payroll_runs', 'hr_payslips', 'hr_final_settlements',
  // POS — tables/customers before orders; credit notes after orders (circular FK, see below)
  // pos_cash_movements after pos_shifts and pos_orders — it holds an FK to both.
  'pos_tables', 'pos_loyalty_schemes', 'pos_customers', 'pos_shifts', 'pos_parking_slips',
  'pos_orders', 'pos_order_items', 'pos_order_payments', 'pos_kot_log', 'pos_kot_removals',
  'pos_loyalty_ledger',
  // Reservations reference pos_orders (order_id) and pos_tables (via the join table), both above.
  'pos_reservations', 'pos_reservation_tables',
  'pos_guest_order_requests', 'pos_payment_confirmations',
  'pos_cash_movements',
  'pos_credit_notes',
  'stock_movements',
  // Config last — harmless either way, and keeps the noisy tables at the end of the log
  'feature_flags',
]

// Generated columns cannot appear in an INSERT payload at all — Postgres rejects the statement
// rather than ignoring the field.
// pos_customers.phone_canonical was missing here from the day the restore shipped (S545) — the
// export carried it (select('*')) and Postgres refuses a generated column in an INSERT, so every
// restore of the customer book was rejected while the backup looked complete. Found S677 while
// registering pos_reservations, which carries the same generated column.
const GENERATED_COLUMNS = {
  items: ['per_uom_rate'],
  pos_customers: ['phone_canonical'],
  pos_reservations: ['phone_canonical'],
}

// pos_orders.credit_note_id -> pos_credit_notes.id, while pos_credit_notes.order_id ->
// pos_orders.id. Neither cascades, so one of the two must be inserted with the link empty and
// patched afterwards. Same shape as the null-first step deleteClientData does in reverse.
const DEFERRED_LINKS = { pos_orders: ['credit_note_id'] }

const CHUNK = 500

function isAttributionColumn(key) {
  return key.endsWith('_by') || key === 'custodian_user_id' || key === 'supervisor_id'
}

// Strips what must not be inserted, and re-points the row at the target client.
//
// Attribution UUIDs are nulled because they reference profiles rows that may no longer exist
// (a full delete removes the auth users first), which would otherwise raise a FK violation on
// nearly every table. Safe because S543 established by grep that no *_by column is ever filtered
// on — they are display lookups. The readable half survives in the artifact's *_by_name fields.
function prepareRow(table, row, clientId) {
  const out = {}
  for (const [k, v] of Object.entries(row)) {
    if (k.endsWith('_by_name')) continue                      // export-time annotation, not a column
    if ((GENERATED_COLUMNS[table] || []).includes(k)) continue
    if ((DEFERRED_LINKS[table] || []).includes(k)) continue
    out[k] = isAttributionColumn(k) ? null : v
  }
  if ('client_id' in row) out.client_id = clientId
  // Items are stored in their smallest unit — purchase_qty is always 1, so `rate` is the price of
  // one base unit. A backup taken before that rule could carry a pack size, which would restore as
  // a row whose `rate` means something different from every other item's (and trip the CHECK).
  // Value-preserving: per_uom_rate is rate / purchase_qty either way, so no figure a restore
  // rebuilds moves.
  if (table === 'items' && parseFloat(out.purchase_qty) > 1 && out.rate != null) {
    out.rate = parseFloat((parseFloat(out.rate) / parseFloat(out.purchase_qty)).toFixed(6))
    out.purchase_qty = 1
  }
  return out
}

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// Refuses to write into a client that already holds data.
//
// These are inserts, not upserts, so restoring over a live client would duplicate every row and
// silently double their books — a worse outcome than the data loss a restore is meant to undo.
// Clearing first (Danger Zone) is the deliberate, separately-confirmed path to a true replace.
async function assertEmpty(clientId) {
  const probes = ['items', 'recipes', 'monthly_periods', 'hr_employees', 'pos_orders']
  const counts = {}
  let probesRun = 0
  for (const table of probes) {
    const { count, error } = await supabase
      .from(table).select('id', { count: 'exact', head: true }).eq('client_id', clientId)
    if (error) continue // one failing probe is not evidence either way — but see the check below
    probesRun++
    counts[table] = count || 0
  }
  // Fail CLOSED when nothing could be verified. The old `continue` alone meant five failing
  // probes let the restore proceed into a possibly-live client and duplicate every row —
  // the guard the rules file states as absolute held only when a probe both ran and hit (S574).
  if (probesRun === 0) {
    throw new Error('Could not verify this client is empty (all emptiness checks failed) — not restoring. Check the connection and retry.')
  }

  // "+ New Client" seeds one open monthly_periods row, so the natural recovery path — deleted by
  // mistake → recreate → restore — used to dead-end here on "1 rows in monthly_periods", pointing
  // the operator at a destructive Danger Zone action against a brand-new client. A single period
  // with nothing in it is indistinguishable from that seed, so it is removed rather than treated
  // as data; the backup's own periods are inserted in its place (S574).
  if (counts.monthly_periods === 1 && probes.every(t => t === 'monthly_periods' || counts[t] === 0)) {
    const { data: seedPeriods } = await supabase
      .from('monthly_periods').select('id').eq('client_id', clientId)
    const seedId = seedPeriods?.[0]?.id
    if (seedId) {
      const { count: pe } = await supabase
        .from('purchase_entries').select('id', { count: 'exact', head: true }).eq('period_id', seedId)
      const { count: se } = await supabase
        .from('sales_entries').select('id', { count: 'exact', head: true }).eq('period_id', seedId)
      if ((pe || 0) === 0 && (se || 0) === 0) {
        const { error: delErr } = await supabase.from('monthly_periods').delete().eq('id', seedId)
        if (!delErr) counts.monthly_periods = 0
      }
    }
  }

  for (const table of probes) {
    if ((counts[table] || 0) > 0) {
      throw new Error(
        `This client already has data (${counts[table]} rows in ${table}). Restore only into an empty client — ` +
        `clear it from the Danger Zone first if you intend to replace it.`,
      )
    }
  }
}

/**
 * @param clientId  target client — must be empty
 * @param parsed    the parsed .json artifact ({ manifest, data })
 * @returns { inserted, tables, skipped }
 */
export async function restoreClientData(clientId, parsed, { onProgress = () => {} } = {}) {
  if (!clientId) throw new Error('restoreClientData: clientId is required')
  const { manifest, data } = parsed || {}
  if (!data || manifest?.schema !== 'crest-client-export') {
    throw new Error('Not a Crest client export file.')
  }

  await assertEmpty(clientId)

  let inserted = 0
  let tables = 0
  const skipped = []
  let done = 0

  for (const table of RESTORE_ORDER) {
    done++
    const rows = data[table]
    if (!rows || rows.length === 0) continue
    onProgress(table, done, RESTORE_ORDER.length)

    let tableFailed = false
    for (const part of chunk(rows, CHUNK)) {
      const payload = part.map(r => prepareRow(table, r, clientId))
      const { error } = await supabase.from(table).insert(payload)
      if (error) {
        // One unrestorable table must not abandon the other sixty. Report it and continue —
        // a partial restore that names its gaps is far more useful than an aborted one.
        console.error(`restore ${table}:`, error.message)
        if (table === 'feature_flags' && /duplicate key/i.test(error.message)) {
          // Expected on every Archive → Restore: the live flags row was deliberately kept and
          // deliberately wins. The raw constraint name read as a failure at the end of the
          // product's own recommended recovery path (S574).
          skipped.push("feature_flags (kept this client's existing feature access)")
        } else {
          skipped.push(`${table} (${error.message})`)
        }
        tableFailed = true
        break
      }
      inserted += payload.length
    }
    if (!tableFailed) tables++
  }

  // Settings — exported by every backup and, until S574, restored by nothing: a Delete →
  // recreate → Restore round trip silently came back with default branding, no VAT number, no
  // invoice prefix (POS invoice numbering keys off it) and no payment QR. Not in RESTORE_ORDER
  // because it needs update-or-insert against the row createClient seeds, not a bare insert.
  const settingsRows = (data.settings || []).filter(r => r.client_id)
  if (settingsRows.length) {
    const src = settingsRows[0]
    const { id: _id, client_id: _cid, ...fields } = src
    const { data: existing } = await supabase
      .from('settings').select('id').eq('client_id', clientId).limit(1)
    const op = existing?.length
      ? supabase.from('settings').update(fields).eq('id', existing[0].id)
      : supabase.from('settings').insert({ ...fields, client_id: clientId })
    const { error: setErr } = await op
    if (setErr) skipped.push(`settings (${setErr.message})`)
    else { inserted += 1; tables++ }
  }

  // Second pass for the circular POS link, now that both sides exist.
  const orderLinks = (data.pos_orders || []).filter(o => o.credit_note_id)
  for (const order of orderLinks) {
    const { error } = await supabase
      .from('pos_orders').update({ credit_note_id: order.credit_note_id }).eq('id', order.id)
    if (error) skipped.push(`pos_orders.credit_note_id for ${order.id} (${error.message})`)
  }

  return { inserted, tables, skipped }
}
