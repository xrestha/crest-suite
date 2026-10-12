import { settleWithin } from '../../../utils/withTimeout'

// What a reprint needs that the bill row does not carry (S809 CHECKOUT-11): the HSC codes of ITS
// lines and the name of the staff member who closed (or comped) it. The till used to print a reprint
// with the `hscMap` state — filled only by openBilling, so it held whichever bill this device last
// opened for payment, and nothing after a reload — and with the reprinter's own name as Cashier or
// "Authorized by". A reprint is a copy of the original, so both come from the bill.
//
// Each answers `{ ..., error }` and never throws; a hung read comes back as a timeout error, because
// a cashier is standing at the counter while it runs. A caller prints nothing on an error: a Tax
// Invoice without its HSC codes, or naming the wrong cashier, is a wrong document, not a partial one.

export const REPRINT_READ_MS = 20000

/**
 * `{ map: { recipeId: hscCode }, error }` for these recipe ids. `scopedFrom(table, select)` is the
 * till's scoped read (useScopedDb), or a wrapper binding a client id for the module-level one.
 */
export async function readHscMap(scopedFrom, recipeIds) {
  const ids = [...new Set((recipeIds || []).filter(Boolean))]
  if (ids.length === 0) return { map: {}, error: null }
  // One bill's lines: a few dozen ids at most, so one request (not chunked) and never near 1000 rows.
  const { data, error } = await settleWithin(scopedFrom('recipes', 'id, hsc_code').in('id', ids), REPRINT_READ_MS, 'Reading the HSC codes')
  if (error) return { map: {}, error }
  return { map: Object.fromEntries((data || []).map(r => [r.id, r.hsc_code])), error: null }
}

/**
 * `{ name, error }` for the login that closed or comped a bill. A raw `profiles` read returns only
 * the caller's own row under RLS, so another staff member's name comes from the DEFINER RPC.
 * No staff id (an old bill, or one closed before closed_by was stamped) is an empty name, not an error.
 */
export async function staffNameFor(supabase, clientId, staffId) {
  if (!staffId) return { name: '', error: null }
  const { data, error } = await settleWithin(
    supabase.rpc('get_client_profile_names', { p_client_id: clientId }), REPRINT_READ_MS, 'Reading staff names')
  if (error) return { name: '', error }
  return { name: (data || []).find(s => s.id === staffId)?.full_name || '', error: null }
}
