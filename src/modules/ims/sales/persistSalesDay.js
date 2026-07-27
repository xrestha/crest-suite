import { withTimeout } from '../../../utils/withTimeout'

// How long any single save request may hang before we give up and re-enable the button (S453/S454).
export const SAVE_TIMEOUT_MS = 20000

// PostgREST reports a missing/not-yet-cached function as PGRST202; Postgres itself as 42883.
// This is ONLY used to decide whether to fall back to the pre-RPC path — every other error must
// surface to the user, never be silently retried a second way.
export function isMissingFunctionError(error) {
  if (!error) return false
  const code = error.code || ''
  if (code === 'PGRST202' || code === '42883') return true
  const msg = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`
  return /could not find the function|function .*save_sales_day.* does not exist/i.test(msg)
}

const signalled = (builder, signal) => (signal ? builder.abortSignal(signal) : builder)

// Which existing rows a save is about to SILENTLY delete, so the user can be warned first (S457).
//
// Bulk (bs_day 0) and Daily (bs_day > 0) are mutually exclusive per recipe — saving one supersedes
// the other for every recipe in the payload, across the WHOLE period, not just the day on screen.
// That's intended (every downstream report sums all rows with no bs_day distinction, so leaving
// both double-counts), but it is destructive, unbounded and was completely unannounced: typing one
// number into Bulk Entry and hitting Save deletes that item's entire month of daily entries.
// Real incident, 2026-07-27 — it ate two rows of live client data during a smoke test, and the
// person it happened to had read the source.
//
// Reads the whole period's opposite-mode rows and intersects client-side rather than sending
// `.in('recipe_id', [...])` — a 92-recipe menu would put ~3.4kB of UUIDs in the query string, and
// an over-long URL is its own failure mode (postgrest-js warns about exactly this).
export async function findSupersededRows(supabase, { periodId, bsDay, recipeIds, signal, timeoutMs = SAVE_TIMEOUT_MS }) {
  if (!recipeIds.length) return { total: 0, byRecipe: [] }

  const base = supabase.from('sales_entries').select('recipe_id, bs_day, qty_sold').eq('period_id', periodId)
  const scoped = bsDay === 0 ? base.gt('bs_day', 0) : base.eq('bs_day', 0)

  const { data, error } = await withTimeout(signalled(scoped, signal), timeoutMs, 'Check')
  if (error) throw new Error(error.message)

  const wanted = new Set(recipeIds)
  const byId = new Map()
  for (const row of data || []) {
    if (!wanted.has(row.recipe_id)) continue
    const entry = byId.get(row.recipe_id) || { recipeId: row.recipe_id, count: 0, days: [], qty: 0 }
    entry.count += 1
    entry.qty += Number(row.qty_sold) || 0
    if (row.bs_day > 0) entry.days.push(row.bs_day)
    byId.set(row.recipe_id, entry)
  }

  const byRecipe = [...byId.values()]
  byRecipe.forEach(e => e.days.sort((a, b) => a - b))
  byRecipe.sort((a, b) => b.count - a.count)
  return { total: byRecipe.reduce((s, e) => s + e.count, 0), byRecipe }
}

// Save one "day" of sales — bs_day 0 is the Bulk (whole-period) row, 1..32 a dated Daily row.
//
// Preferred path is the single `save_sales_day` RPC (migration 20260727120000), which does
// delete + insert + cross-mode cleanup inside one transaction. The old shape was three separate
// HTTP round trips, so a stall between the delete and the insert left the day's rows deleted with
// nothing written back — real data loss, and not theoretical (a live smoke test saw a 12.4s round
// trip on a connection that served the others in under a second).
//
// The legacy three-call path is kept ONLY as a fallback for the window between this code
// deploying and the migration actually being applied by hand in the Supabase dashboard — which is
// this project's documented migration workflow, so that window genuinely exists. It is not a
// retry-on-failure path: anything other than "the function isn't there" is rethrown untouched.
// Once the migration is applied everywhere, this fallback and `isMissingFunctionError` can go.
export async function persistSalesDay(supabase, { periodId, bsDay, rows, signal, timeoutMs = SAVE_TIMEOUT_MS }) {
  const { error } = await withTimeout(
    signalled(
      supabase.rpc('save_sales_day', { p_period_id: periodId, p_bs_day: bsDay, p_rows: rows }),
      signal
    ),
    timeoutMs,
    'Save'
  )

  if (!error) return { atomic: true }
  if (!isMissingFunctionError(error)) throw new Error(error.message)

  await persistSalesDayLegacy(supabase, { periodId, bsDay, rows, signal, timeoutMs })
  return { atomic: false }
}

async function persistSalesDayLegacy(supabase, { periodId, bsDay, rows, signal, timeoutMs }) {
  const { error: delErr } = await withTimeout(
    signalled(supabase.from('sales_entries').delete().eq('period_id', periodId).eq('bs_day', bsDay), signal),
    timeoutMs, 'Save'
  )
  if (delErr) throw new Error(delErr.message)

  if (!rows.length) return

  const { error: insErr } = await withTimeout(
    signalled(
      supabase.from('sales_entries').insert(rows.map(r => ({ ...r, period_id: periodId, bs_day: bsDay }))),
      signal
    ),
    timeoutMs, 'Save'
  )
  if (insErr) throw new Error(insErr.message)

  const recipeIds = rows.map(r => r.recipe_id)
  const cleanup = supabase.from('sales_entries').delete().eq('period_id', periodId)
  const scoped = bsDay === 0 ? cleanup.gt('bs_day', 0) : cleanup.eq('bs_day', 0)
  const { error: clearErr } = await withTimeout(
    signalled(scoped.in('recipe_id', recipeIds), signal),
    timeoutMs, 'Save'
  )
  if (clearErr) throw new Error(clearErr.message)
}
