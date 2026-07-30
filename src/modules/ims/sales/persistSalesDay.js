import { withTimeout } from '../../../utils/withTimeout'
import { isAuthExpiredError } from '../../../utils/sessionKeepAlive'
import { scopedInsert, scopedDelete } from '../../../shared/scopedDb'
import { explodeRecipeIngredients } from '../../../utils/recipeCost'

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

// sales_entries is shared with POS: a POS client's rows carry source 'pos' (one per bill),
// 'pos_comp' (comped lines) or 'pos_credit' (negative credit-note reversals). Manual entry must
// never read those as its own baseline or delete them — see migration 20260727180000 for the full
// writeup. `source` is DEFAULT 'manual' but nullable, so rows predating the default read as NULL
// and must still count as manual, or they become undeletable through the UI.
const manualOnly = builder => builder.or('source.is.null,source.eq.manual')

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

  const base = manualOnly(supabase.from('sales_entries').select('recipe_id, bs_day, qty_sold').eq('period_id', periodId))
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
  const callRpc = () => withTimeout(
    signalled(
      supabase.rpc('save_sales_day', { p_period_id: periodId, p_bs_day: bsDay, p_rows: rows }),
      signal
    ),
    timeoutMs,
    'Save'
  )

  let { error } = await callRpc()

  // An access token that expired while the user was typing must not cost them the save (S458).
  // Renew once and retry silently — safe to repeat because the RPC replaces the day wholesale, so
  // running it twice with the same payload lands on exactly the same state as running it once.
  if (error && isAuthExpiredError(error)) {
    const { error: refreshErr } = await withTimeout(supabase.auth.refreshSession(), timeoutMs, 'Session refresh')
    if (refreshErr) {
      throw new Error('Your session expired and could not be renewed. Please reload the page and sign in again — your figures are still on screen.')
    }
    ;({ error } = await callRpc())
  }

  if (!error) return { atomic: true }
  if (!isMissingFunctionError(error)) throw new Error(error.message)

  await persistSalesDayLegacy(supabase, { periodId, bsDay, rows, signal, timeoutMs })
  return { atomic: false }
}

async function persistSalesDayLegacy(supabase, { periodId, bsDay, rows, signal, timeoutMs }) {
  const { error: delErr } = await withTimeout(
    signalled(manualOnly(supabase.from('sales_entries').delete()).eq('period_id', periodId).eq('bs_day', bsDay), signal),
    timeoutMs, 'Save'
  )
  if (delErr) throw new Error(delErr.message)

  if (!rows.length) return

  // source is written explicitly, matching the RPC — these rows are manual by construction, and
  // the deletes above/below key off that value, so it must not be left to the column default.
  const { error: insErr } = await withTimeout(
    signalled(
      supabase.from('sales_entries').insert(rows.map(r => ({ ...r, period_id: periodId, bs_day: bsDay, source: 'manual' }))),
      signal
    ),
    timeoutMs, 'Save'
  )
  if (insErr) throw new Error(insErr.message)

  const recipeIds = rows.map(r => r.recipe_id)
  const cleanup = manualOnly(supabase.from('sales_entries').delete().eq('period_id', periodId))
  const scoped = bsDay === 0 ? cleanup.gt('bs_day', 0) : cleanup.eq('bs_day', 0)
  const { error: clearErr } = await withTimeout(
    signalled(scoped.in('recipe_id', recipeIds), signal),
    timeoutMs, 'Save'
  )
  if (clearErr) throw new Error(clearErr.message)
}

// Manual-sales stock depletion (added 2026-07-30) — mirrors PosOrders.jsx's POS depletion exactly
// (same explodeRecipeIngredients, same stock_movements shape) so an IMS client without POS — or an
// admin typing manual sales alongside a live POS — gets the same perpetual ledger POS already
// writes. Deliberately client-side rather than inside the save_sales_day RPC: explodeRecipeIngredients
// recurses through sub-recipes (up to 5 levels, yield%), and reimplementing that in plpgsql would
// duplicate real logic across two languages. Best-effort and non-blocking, same as POS's own write —
// a failure here must never undo or retry the sales_entries save that already committed.
//
// Product decision (confirmed with Aashish, 2026-07-30): only applies going forward from today, no
// backfill of prior saves. Where POS already sold a recipe on the same day (Bulk: anywhere in the
// period, since POS never posts a bs_day=0 row), POS supersedes and the manual row deposits no
// movement for that recipe — two different facts about the same recipe/day should not both deplete
// stock for it.
export async function depleteManualSales(supabase, { clientId, periodId, bsDay, rows }) {
  try {
    // Replace this day's manual movements wholesale, matching save_sales_day's own delete+reinsert
    // semantics for sales_entries — otherwise a re-save with fewer/changed rows leaves stale
    // movements behind from a previous save.
    await scopedDelete('stock_movements', clientId)
      .eq('period_id', periodId).eq('bs_day', bsDay).eq('source', 'manual')

    const candidates = (rows || []).filter(r => Number(r.qty_sold) > 0)
    if (candidates.length === 0) return

    const recipeIds = [...new Set(candidates.map(r => r.recipe_id))]
    const posQuery = supabase.from('sales_entries').select('recipe_id')
      .eq('period_id', periodId).in('recipe_id', recipeIds).in('source', ['pos', 'pos_comp'])
    const { data: posRows } = await (bsDay === 0 ? posQuery : posQuery.eq('bs_day', bsDay))
    const posRecipeIds = new Set((posRows || []).map(r => r.recipe_id))

    const qualifying = candidates.filter(r => !posRecipeIds.has(r.recipe_id))
    if (qualifying.length === 0) return

    const breakdown = await explodeRecipeIngredients(supabase, [...new Set(qualifying.map(r => r.recipe_id))])
    const agg = {}
    qualifying.forEach(({ recipe_id, qty_sold }) => {
      ;(breakdown[recipe_id] || []).forEach(({ item_id, qty }) => {
        agg[item_id] = (agg[item_id] || 0) + qty * Number(qty_sold)
      })
    })

    const movementRows = Object.entries(agg).map(([item_id, qty]) => ({
      item_id, period_id: periodId, bs_day: bsDay, qty: -qty, source: 'manual',
    }))
    if (movementRows.length > 0) {
      const { error } = await scopedInsert('stock_movements', clientId, movementRows)
      if (error) console.error('manual stock_movements write failed:', error)
    }
  } catch (err) {
    console.error('manual stock_movements write failed:', err)
  }
}
