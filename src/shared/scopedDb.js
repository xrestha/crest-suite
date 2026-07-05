// Centralizes the "which client does this row belong to" invariant that used to be
// hand-copied into 200+ call sites (`.eq('client_id', clientId)` on reads, `client_id: clientId`
// on inserts, scattered `if (!clientId) return` guards). See memory: bug-null-client-id — that
// incident was the write-side version of this; a missed `.eq('client_id', ...)` on a read is the
// more dangerous sibling, since an admin's RLS policy allows every client's rows and only this
// filter narrows an admin "viewing as" session down to one client.
//
// CLIENT_SCOPED_TABLES mirrors the tables that carry a DB-level `client_id NOT NULL` constraint
// (see supabase/rls-audit.sql). Keep the two in sync: a table added here should also get that
// migration, and a table given the migration should be added here.
import { supabase } from '../supabaseClient'

export const CLIENT_SCOPED_TABLES = [
  'recipes', 'items', 'vendors', 'categories', 'monthly_periods', 'requisitions',
  'overheads', 'purchase_orders', 'vendor_returns', 'feature_flags',
  'par_levels', 'payable_payments', 'recipe_suggestions',
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
// supabase.from() — this only owns the client_id filter, not the rest of the query.
export function scopedFrom(table, clientId, columns = '*') {
  assertKnownTable(table)
  return supabase.from(table).select(columns).eq('client_id', clientId || NO_CLIENT_SENTINEL)
}

// Insert: stamps client_id automatically and refuses to write without one, replacing the
// hand-written `if (!clientId) { setError(...); return }` guard at each call site.
export async function scopedInsert(table, clientId, row) {
  assertKnownTable(table)
  if (!clientId) return { data: null, error: missingClientIdError(table) }
  const stamped = Array.isArray(row)
    ? row.map(r => ({ ...r, client_id: clientId }))
    : { ...row, client_id: clientId }
  return supabase.from(table).insert(stamped).select()
}

// Upsert: same client_id guard as scopedInsert, for bulk-seed patterns (e.g. default categories).
export async function scopedUpsert(table, clientId, rows, options) {
  assertKnownTable(table)
  if (!clientId) return { data: null, error: missingClientIdError(table) }
  const stamped = rows.map(r => ({ ...r, client_id: clientId }))
  return supabase.from(table).upsert(stamped, options)
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
