import { scopedFrom } from './scopedDb'
import { onPageCacheClear } from './sessionDataCache'

// The client's month list (`monthly_periods`), read once and shared by every period page (S855,
// PERF-2). Before this, each of ~30 IMS pages read the list itself and only then started its data
// reads, so on a slow link every first paint paid one extra round trip (~0.6 s on Fast 3G) just to
// learn which month is open. Every data read filters on the period ID, so the id has to be in
// memory before `init()` can start them.
//
// How a page uses it (`initPeriodLoad` below does all of this):
//   - with a list already in memory (any visit after the first), it GUESSES the month from that list
//     and starts its data reads at once, while a fresh read of the list runs beside them;
//   - when the fresh list lands it re-picks. Same month → keep the load already in flight (the fresh
//     row still replaces the guessed one, so a status changed elsewhere reaches the screen); another
//     month → claim it and load again. The page keeps its loading state until BOTH have landed, so a
//     month closed on another device is never shown as open, and the guess never paints alone;
//   - with nothing in memory (the first page of a visit), it waits for the list. Layout starts that
//     read on mount, so on a cold load it overlaps the page's own code download instead of following it.
//
// One read at a time per client: a read already in flight is shared, so Layout and the first page
// never send two. A failed read is never stored (the last good list stays) and is handed to the
// caller as `{ error }`, like any supabase read. Writes that change the list (close, reopen, rename,
// create, restore) call `invalidatePeriodList(clientId)`; a read that started before the write is
// then not stored either (the generation check), since it may hold the list from before it.
//
// Keyed by client. Cleared whenever the page cache is (no session, or a different user signs in —
// `sessionDataCache.js`), so one login never guesses from another login's list. Only the columns
// below are read; a page that needs anything else of a month (the Dashboard's snapshot columns)
// keeps its own read.

export const PERIOD_LIST_COLUMNS = 'id, client_id, bs_year, bs_month, status, created_at'

const lists = new Map()        // clientId -> last good list, newest month first
const inflight = new Map()     // clientId -> promise of { data, error }
const generation = new Map()   // clientId -> bumped by every invalidation
const listeners = new Map()    // clientId -> Set of fn(list | null)

const genOf = clientId => generation.get(clientId) || 0
// Every caller gets its own row objects: a page that decorates or sorts its list must not change
// what the next page is handed.
const copyRows = rows => (rows || []).map(r => ({ ...r }))

function notify(clientId, list) {
  const set = listeners.get(clientId)
  if (set) set.forEach(fn => { try { fn(list) } catch (e) { console.error('period list listener', e) } })
}

/** The last good list for this client (copies), or null when none has been read yet. */
export function cachedPeriodList(clientId) {
  const list = clientId ? lists.get(clientId) : null
  return list ? copyRows(list) : null
}

/**
 * A fresh read of the client's month list, newest first. Resolves `{ data, error }` and never
 * rejects. A read already in flight for the client is shared rather than sent twice.
 */
export function readPeriodList(clientId) {
  if (!clientId) return Promise.resolve({ data: [], error: null })
  let promise = inflight.get(clientId)
  if (!promise) {
    const gen = genOf(clientId)
    promise = Promise.resolve(
      scopedFrom('monthly_periods', clientId, PERIOD_LIST_COLUMNS)
        .order('bs_year', { ascending: false })
        .order('bs_month', { ascending: false })
        .order('id')
    ).then(
      res => res,
      err => ({ data: null, error: err }),
    ).then(res => {
      if (inflight.get(clientId) === promise) inflight.delete(clientId)
      if (!res.error && genOf(clientId) === gen) {
        lists.set(clientId, res.data || [])
        notify(clientId, copyRows(res.data))
      }
      return res
    })
    inflight.set(clientId, promise)
  }
  return promise.then(res => (res.error ? { data: null, error: res.error } : { data: copyRows(res.data), error: null }))
}

/** Forget the list after a write that changed it. Listeners are told (null) so they can re-read. */
export function invalidatePeriodList(clientId) {
  if (!clientId) return
  generation.set(clientId, genOf(clientId) + 1)
  lists.delete(clientId)
  inflight.delete(clientId)
  notify(clientId, null)
}

/** Forget every client's list (sign-out, a different user). */
export function clearPeriodLists() {
  for (const clientId of new Set([...lists.keys(), ...inflight.keys()])) {
    generation.set(clientId, genOf(clientId) + 1)
  }
  lists.clear()
  inflight.clear()
}

onPageCacheClear(clearPeriodLists)

/** Called with each new list for the client, and with null after an invalidation. Returns an unsubscribe. */
export function subscribePeriodList(clientId, fn) {
  if (!clientId) return () => {}
  if (!listeners.has(clientId)) listeners.set(clientId, new Set())
  listeners.get(clientId).add(fn)
  return () => { listeners.get(clientId)?.delete(fn) }
}

/**
 * The month a period page opens on: the open one, else the latest (the S722 rule: between closing
 * one month and opening the next, a page that selected nothing said "No data" about months that
 * have data). `monthly_periods` allows one open month per client.
 */
export function openOrLatest(list) {
  if (!list || list.length === 0) return null
  return list.find(p => p.status === 'open') || list[0]
}

/**
 * A period page's first load, with the data reads started beside the month list (see the header).
 *
 *   req         the page's `useLatestRequest()`; `initKey` is what init() already claimed
 *   periodList  () => ({ cached, fresh }) — `usePeriodList()` hands this back
 *   pick        list -> the month to open on (default `openOrLatest`)
 *   setPeriods  receives the guessed list, then the fresh one
 *   select      receives the guessed month, then the fresh row (null when there is none)
 *   load        periodId -> promise; the page's own loader, which checks `req.isCurrent(periodId)`
 *               before its setters as every period loader does
 *
 * Resolves `{ superseded }` when a newer claim owns the page (do nothing more), `{ error }` when the
 * month list could not be read (show it; a guessed load is cancelled first so it cannot paint over
 * the error), or `{ chosen }` once `load(chosen.id)` has finished (`chosen` is null with no months).
 * The caller clears its loading flag only when `!chosen || req.isCurrent(chosen.id)`.
 *
 * `{ superseded }` returns before the caller looks at anything else it started beside this call (a
 * categories read, say), so a page settles those reads first, whoever now owns the page. When the
 * guessed month is kept, the guessed load is kept as it was: a load that also used the list itself
 * (a window of months, a "newest month" flag) re-checks that itself.
 */
export async function initPeriodLoad({ req, initKey, periodList, pick = openOrLatest, setPeriods, select, load }) {
  const { cached, fresh } = periodList()
  const guess = cached ? pick(cached) : null
  let guessLoad = null
  if (guess) {
    req.begin(guess.id)
    setPeriods(cached)
    select(guess)
    guessLoad = Promise.resolve(load(guess.id))
    guessLoad.catch(() => {})   // awaited below on the path that keeps it; never an unhandled rejection
  }
  const owner = guess ? guess.id : initKey
  const { data, error } = await fresh
  if (!req.isCurrent(owner)) {
    // A month picked from the guessed list while the fresh read was out still gets the fresh rows,
    // so the dropdown and the picked month's open/closed status are not left as guessed. Only when
    // the claim is one of THIS list's months: a client switch claims a key no row of it carries.
    const picked = !error && (data || []).find(p => req.isCurrent(p.id))
    if (picked) { setPeriods(data); select(picked) }
    return { superseded: true }
  }
  if (error) {
    if (guess) req.begin(`${initKey}:failed`)
    return { error }
  }
  const list = data || []
  setPeriods(list)
  const chosen = pick(list)
  if (!chosen) {
    if (guess) req.begin(`${initKey}:none`)
    select(null)
    return { chosen: null }
  }
  select(chosen)
  if (guess && guess.id === chosen.id) {
    await guessLoad
    return { chosen }
  }
  req.begin(chosen.id)
  await load(chosen.id)
  return { chosen }
}
