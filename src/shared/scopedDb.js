// Centralizes the "which client does this row belong to" invariant that used to be
// hand-copied into 200+ call sites (`.eq('client_id', clientId)` on reads, `client_id: clientId`
// on inserts, scattered `if (!clientId) return` guards). See memory: bug-null-client-id — that
// incident was the write-side version of this; a missed `.eq('client_id', ...)` on a read is the
// more dangerous sibling, since an admin's RLS policy allows every client's rows and only this
// filter narrows an admin "viewing as" session down to one client.
//
// CLIENT_SCOPED_TABLES mirrors every table that carries a DB-level `client_id NOT NULL`
// constraint — confirmed against supabase/migrations/20260705074838_baseline_schema.sql, not
// just the original IMS-only S134/S211 audit (which missed every hr_* and pos_* table; those
// carry the constraint too, just declared in their original DDL instead of a later migration).
// Keep this in sync with the schema: a table added here should also get that constraint, and a
// table given the constraint should be added here.
import { supabase } from '../supabaseClient'

export const CLIENT_SCOPED_TABLES = [
  // IMS
  'recipes', 'items', 'vendors', 'categories', 'monthly_periods', 'requisitions',
  'overheads', 'purchase_orders', 'vendor_returns', 'feature_flags',
  'par_levels', 'payable_payments', 'recipe_suggestions',
  'demand_forecast_daily', 'demand_forecast_run_log', 'stock_movements',
  // HR
  'hr_employees', 'hr_attendance', 'hr_advances', 'hr_advance_repayments',
  'hr_leave_requests', 'hr_leave_types', 'hr_holiday_calendar', 'hr_festival_allowances',
  'hr_overtime_entries', 'hr_payroll_runs', 'hr_payslips', 'hr_roster',
  'hr_salary_components', 'hr_shift_types', 'hr_roster_publish_state', 'hr_shift_swap_requests',
  'hr_tada_claims', 'hr_incentive_configs', 'hr_incentives',
  // NOT hr_tada_claim_items — no client_id column of its own (scoped via claim_id →
  // hr_tada_claims.id, same parent-scoped pattern as recipe_ingredients); stays on raw
  // supabase.from() in TadaClaims.jsx.
  // POS
  'pos_orders', 'pos_order_items', 'pos_order_payments', 'pos_tables', 'pos_customers',
  'pos_credit_notes', 'pos_kot_log', 'pos_shifts', 'pos_payment_confirmations',
  'pos_guest_order_requests',
]

// A UUID column can never equal this, so any scoped query built without a real
// clientId fails closed to zero rows instead of running unfiltered or matching NULLs.
const NO_CLIENT_SENTINEL = '00000000-0000-0000-0000-000000000000'

function assertKnownTable(table) {
  if (!CLIENT_SCOPED_TABLES.includes(table)) {
    throw new Error(
      `scopedDb: "${table}" is not in CLIENT_SCOPED_TABLES. Use supabase.from() directly for ` +
      `period-scoped or system tables, or add "${table}" here (and run the client_id NOT NULL ` +
      `migration) if it should be client-scoped.`
    )
  }
}

function missingClientIdError(table) {
  return { message: `No client selected — refusing to query "${table}" without a client_id.` }
}

// Read: pre-filters to the current client. Chain further .eq()/.order()/etc. exactly as with
// supabase.from() — this only owns the client_id filter, not the rest of the query. Pass
// options (e.g. { count: 'exact', head: true }) exactly as the third arg to .select() would take.
export function scopedFrom(table, clientId, columns = '*', options) {
  assertKnownTable(table)
  const q = options !== undefined ? supabase.from(table).select(columns, options) : supabase.from(table).select(columns)
  return q.eq('client_id', clientId || NO_CLIENT_SENTINEL)
}

// Insert: stamps client_id automatically and refuses to write without one, replacing the
// hand-written `if (!clientId) { setError(...); return }` guard at each call site.
// Pass { single: true } for the `.insert(...).select().single()` shape (returning one row
// as an object instead of a one-element array).
export async function scopedInsert(table, clientId, row, { single = false } = {}) {
  assertKnownTable(table)
  if (!clientId) return { data: null, error: missingClientIdError(table) }
  const stamped = Array.isArray(row)
    ? row.map(r => ({ ...r, client_id: clientId }))
    : { ...row, client_id: clientId }
  const q = supabase.from(table).insert(stamped).select()
  return single ? q.single() : q
}

// Upsert: same client_id guard as scopedInsert, for bulk-seed patterns (e.g. default categories)
// and single-row upserts (e.g. the POS customer book, keyed by client_id+phone). Always selects
// the upserted rows back (matching scopedInsert), since some callers need the row (e.g. its id).
export async function scopedUpsert(table, clientId, rows, options) {
  assertKnownTable(table)
  if (!clientId) return { data: null, error: missingClientIdError(table) }
  const stamped = Array.isArray(rows)
    ? rows.map(r => ({ ...r, client_id: clientId }))
    : { ...rows, client_id: clientId }
  return supabase.from(table).upsert(stamped, options).select()
}

// Update: scopes the WHERE to the current client, so an update can never reach another
// client's row even if an id/other filter is missing or wrong.
export function scopedUpdate(table, clientId, patch) {
  assertKnownTable(table)
  return supabase.from(table).update(patch).eq('client_id', clientId || NO_CLIENT_SENTINEL)
}

// Delete: same client-scoped WHERE guarantee as scopedUpdate.
export function scopedDelete(table, clientId) {
  assertKnownTable(table)
  return supabase.from(table).delete().eq('client_id', clientId || NO_CLIENT_SENTINEL)
}
