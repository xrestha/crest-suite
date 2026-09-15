import { withTimeout } from '../../../utils/withTimeout'
import { isAuthExpiredError } from '../../../utils/sessionKeepAlive'
import { scopedInsert, scopedDelete } from '../../../shared/scopedDb'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { explodeRecipeIngredients } from '../../../utils/recipeCost'
import { buildPosIndex, posSupersedesManual } from './salesDepletion'

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

// A Supabase/PostgREST error, rethrown as a real Error that KEEPS its code, hint and details (S756).
//
// Every throw in this file used to be `throw new Error(error.message)`, which discards `error.code`
// and `error.hint` — so errorText's code-keyed rules could never match a save refusal. The one that
// matters most here is `period_closed` (ims_closed_period_guard, migration 20260918100000): a Save
// into a closed month reached the page as the raw trigger message instead of the sentence saying who
// can change a closed month. `fromSupabase` tells the page this is a server answer to be run through
// the error table, as opposed to the hand-written sentences below (session expiry) and withTimeout's
// own message, which are already user-facing and must pass through untouched (the S714 rule).
export function supabaseError(error) {
  if (error instanceof Error && error.fromSupabase) return error
  const e = new Error(error?.message || 'The server refused the request.')
  e.code = error?.code
  e.hint = error?.hint
  e.details = error?.details
  e.status = error?.status
  e.fromSupabase = true
  return e
}

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
//
// PAGED, with a unique tiebreaker (S756). The Bulk-side read is every dated manual row in the
// period — ~50 dishes a day is 1,500 rows a month — and a bare select stops at PostgREST's 1000-row
// cap with no error and in no particular order. So the recipes this save was about to wipe could
// fall past the cut, `total` could come back 0, the confirmation never showed, and save_sales_day
// deleted a month of daily entries unannounced: the exact incident this function exists to stop,
// reintroduced by the read that guards it. A warning is only as complete as the read behind it.
export async function findSupersededRows(supabase, { periodId, bsDay, recipeIds, signal, timeoutMs = SAVE_TIMEOUT_MS }) {
  if (!recipeIds.length) return { total: 0, byRecipe: [] }

  const makeQuery = () => {
    const base = manualOnly(supabase.from('sales_entries').select('recipe_id, bs_day, qty_sold').eq('period_id', periodId))
    const scoped = bsDay === 0 ? base.gt('bs_day', 0) : base.eq('bs_day', 0)
    return signalled(scoped.order('id'), signal)
  }

  const { data, error } = await withTimeout(fetchAllRows(makeQuery), timeoutMs, 'Check')
  if (error) throw supabaseError(error)

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
  if (!isMissingFunctionError(error)) throw supabaseError(error)

  await persistSalesDayLegacy(supabase, { periodId, bsDay, rows, signal, timeoutMs })
  return { atomic: false }
}

async function persistSalesDayLegacy(supabase, { periodId, bsDay, rows, signal, timeoutMs }) {
  const { error: delErr } = await withTimeout(
    signalled(manualOnly(supabase.from('sales_entries').delete()).eq('period_id', periodId).eq('bs_day', bsDay), signal),
    timeoutMs, 'Save'
  )
  if (delErr) throw supabaseError(delErr)

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
  if (insErr) throw supabaseError(insErr)

  const recipeIds = rows.map(r => r.recipe_id)
  const cleanup = manualOnly(supabase.from('sales_entries').delete().eq('period_id', periodId))
  const scoped = bsDay === 0 ? cleanup.gt('bs_day', 0) : cleanup.eq('bs_day', 0)
  const { error: clearErr } = await withTimeout(
    signalled(scoped.in('recipe_id', recipeIds), signal),
    timeoutMs, 'Save'
  )
  if (clearErr) throw supabaseError(clearErr)
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
    await replaceManualMovements(supabase, { clientId, periodId, rowsByDay: new Map([[bsDay, rows || []]]) })
  } catch (err) {
    console.error('manual stock_movements write failed:', err)
  }
}

// A cross-mode supersede leaves the OTHER mode's movements behind, so re-post those days (S756).
//
// save_sales_day's step 3 deletes the opposite mode's manual sales rows for every recipe in the
// payload — a Bulk save removes those recipes' dated rows across the whole period, a Daily save
// removes their Bulk row. depleteManualSales only ever replaced movements for the day being SAVED,
// so the superseded day's movements survived: the item was depleted once by the new Bulk row and
// again by the dated rows it had just replaced, and the perpetual ledger (Stock Movements, Book
// Stock, Reorder) over-consumed it for the rest of the period.
//
// Why re-post rather than delete narrowly: stock_movements has no recipe_id. A manual movement is
// ONE row per item per day, AGGREGATED across every recipe sold that day — flour from the momo
// that was superseded and flour from the pizza that was not are the same row. There is no
// narrower delete that removes only the superseded recipes' share, and deleting the whole day would
// strip the recipes that were never touched. So each affected day is rebuilt from the manual
// sales rows it still holds, through the same replace-wholesale path as an ordinary save — which
// also means the POS-supersedes guard and the refuse-on-failed-read rule apply unchanged.
//
// `days` are the superseded days the save's precheck found (the dated days a Bulk save wipes, or
// [0] for the Bulk row a Daily save wipes). A day left with no manual rows gets its movements
// cleared and nothing re-posted, which is exactly its new state. Best-effort, like the ordinary
// depletion: the sales save has already committed and nothing here may undo it.
export async function repostSupersededMovements(supabase, { clientId, periodId, days }) {
  try {
    const uniqueDays = [...new Set((days || []).map(Number))].filter(d => Number.isInteger(d) && d >= 0)
    if (uniqueDays.length === 0) return

    // Bounded (≤ 33 distinct days, so the .in() is short), paged, uniquely ordered. manualOnly so a
    // POS row on the same day is never re-posted as a manual movement.
    const { data, error } = await fetchAllRows(() =>
      manualOnly(supabase.from('sales_entries').select('recipe_id, bs_day, qty_sold, source').eq('period_id', periodId))
        .in('bs_day', uniqueDays).order('id'))
    if (error) {
      console.error('manual stock_movements: could not read the superseded days, so their movements were left as they were (they still count the replaced entries):', error)
      return
    }

    const rowsByDay = new Map(uniqueDays.map(d => [d, []]))
    for (const r of data || []) {
      const day = Number(r.bs_day) || 0
      if (rowsByDay.has(day)) rowsByDay.get(day).push(r)
    }
    await replaceManualMovements(supabase, { clientId, periodId, rowsByDay })
  } catch (err) {
    console.error('manual stock_movements: re-posting the superseded days failed:', err)
  }
}

// Replace the manual movements for one or more days of a period with what `rowsByDay` says those
// days sold. One guard read, one delete, one ingredient explosion and one insert however many days
// are involved — a Bulk supersede can touch every day of the month, and a round trip per day is
// the loop-with-an-await shape frontend-performance.md warns about.
async function replaceManualMovements(supabase, { clientId, periodId, rowsByDay }) {
  const days = [...rowsByDay.keys()]
  if (days.length === 0) return
  const candidatesByDay = new Map(days.map(d => [d, (rowsByDay.get(d) || []).filter(r => Number(r.qty_sold) > 0)]))
  const allCandidates = [...candidatesByDay.values()].flat()

  // The POS-supersedes-manual guard reads BEFORE the movements are replaced, and a read that fails
  // stops here — leaving the previous save's depletion in place rather than an empty day. It used
  // to run after the delete and drop its error: on a failed read `posRows` was null, the index
  // empty, every manual row "not superseded", and a recipe POS had already depleted deposited a
  // second movement (S683). A check that could not run has not passed.
  let posIndex = buildPosIndex([])
  if (allCandidates.length > 0) {
    const recipeIds = [...new Set(allCandidates.map(r => r.recipe_id))]
    // Chunked and paged (S756). A Bulk save's payload is the whole menu, so a bare .in() of every
    // recipe id is a URL past what a proxy accepts; and the Bulk case reads the WHOLE period's POS
    // rows (one per bill line), which crosses the 1000-row cap on an ordinary month. A truncated
    // guard read is the vacuous pass described above wearing a different coat: a recipe POS sold
    // after the cut reads as not superseded and is depleted twice.
    //
    // bs_day is selected (not just recipe_id) so buildPosIndex can key the supersedes check by day.
    // Day 0 (Bulk) is superseded by a POS sale anywhere in the period, so it needs every day read.
    const wholePeriod = days.includes(0)
    const { data: posRows, error: posErr } = await fetchAllRowsChunked(recipeIds, ids => {
      const q = supabase.from('sales_entries').select('recipe_id, bs_day')
        .eq('period_id', periodId).in('recipe_id', ids).in('source', ['pos', 'pos_comp'])
      const scoped = wholePeriod ? q : (days.length === 1 ? q.eq('bs_day', days[0]) : q.in('bs_day', days))
      return scoped.order('id')
    })
    if (posErr) {
      console.error("manual stock_movements: the POS-supersedes check could not run, so this day's movements were left as they were:", posErr)
      return
    }
    // The POS-supersedes-manual rule lives in salesDepletion.js, shared with the read path that
    // re-derives sub-recipe consumption from sales_entries — see that file's header for why.
    posIndex = buildPosIndex((posRows || []).map(r => ({ ...r, source: 'pos' })))
  }

  // Replace the days' manual movements wholesale, matching save_sales_day's own delete+reinsert
  // semantics for sales_entries — otherwise a re-save with fewer/changed rows leaves stale
  // movements behind from a previous save. A refused delete stops the reinsert: inserting over
  // rows that are still there is the double-depletion this function exists to prevent.
  // source='manual' always: since S756 the database refuses a non-manual movement delete from a
  // staff login, and a POS movement is never ours to remove anyway.
  const del = scopedDelete('stock_movements', clientId).eq('period_id', periodId)
  const { error: delErr } = await (days.length === 1 ? del.eq('bs_day', days[0]) : del.in('bs_day', days)).eq('source', 'manual')
  if (delErr) {
    console.error('manual stock_movements: could not clear this day before re-depleting; left as they were:', delErr)
    return
  }
  if (allCandidates.length === 0) return

  const qualifyingByDay = days.map(d => [d, candidatesByDay.get(d).filter(r => !posSupersedesManual(r.recipe_id, d, posIndex))])
  const qualifyingRecipes = [...new Set(qualifyingByDay.flatMap(([, rows]) => rows.map(r => r.recipe_id)))]
  if (qualifyingRecipes.length === 0) return

  const breakdown = await explodeRecipeIngredients(supabase, qualifyingRecipes)
  const movementRows = []
  for (const [day, rows] of qualifyingByDay) {
    const agg = {}
    rows.forEach(({ recipe_id, qty_sold }) => {
      ;(breakdown[recipe_id] || []).forEach(({ item_id, qty }) => {
        agg[item_id] = (agg[item_id] || 0) + qty * Number(qty_sold)
      })
    })
    Object.entries(agg).forEach(([item_id, qty]) => {
      movementRows.push({ item_id, period_id: periodId, bs_day: day, qty: -qty, source: 'manual' })
    })
  }
  if (movementRows.length > 0) {
    const { error } = await scopedInsert('stock_movements', clientId, movementRows)
    if (error) console.error('manual stock_movements write failed:', error)
  }
}
