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
  'hr_payroll_runs', 'hr_payslips',
  // POS — tables/customers before orders; credit notes after orders (circular FK, see below)
  // pos_cash_movements after pos_shifts and pos_orders — it holds an FK to both.
  'pos_tables', 'pos_customers', 'pos_shifts', 'pos_parking_slips',
  'pos_orders', 'pos_order_items', 'pos_order_payments', 'pos_kot_log',
  'pos_guest_order_requests', 'pos_payment_confirmations',
  'pos_cash_movements',
  'pos_credit_notes',
  'stock_movements',
  // Config last — harmless either way, and keeps the noisy tables at the end of the log
  'feature_flags',
]

// Generated columns cannot appear in an INSERT payload at all — Postgres rejects the statement
// rather than ignoring the field.
const GENERATED_COLUMNS = { items: ['per_uom_rate'] }

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
  for (const table of probes) {
    const { count, error } = await supabase
      .from(table).select('id', { count: 'exact', head: true }).eq('client_id', clientId)
    if (error) continue // a probe that cannot run is not evidence of emptiness either way
    if ((count || 0) > 0) {
      throw new Error(
        `This client already has data (${count} rows in ${table}). Restore only into an empty client — ` +
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
        skipped.push(`${table} (${error.message})`)
        tableFailed = true
        break
      }
      inserted += payload.length
    }
    if (!tableFailed) tables++
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
