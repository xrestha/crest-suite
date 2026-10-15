import { useEffect, useRef } from 'react'
import { settleWithin } from '../utils/withTimeout'

// Staff names for the attribution ids a screen shows (closed_by, issued_by, sent_by, …). A raw
// `profiles` read returns only the caller's own row under RLS, so another login's name comes from
// get_client_profile_names(), a SECURITY DEFINER RPC.
//
// S840: the RPC names a Crest operator login ("Crest support", CREST_SUPPORT_LABEL) only to the
// operator itself, or when that login's id is asked for in `p_ids`. Before, it handed every client
// every operator account id. So a screen that must name a record Crest support touched passes the
// ids it is resolving, in one of three shapes:
//
//   - The ids are known before the read (one bill's closer, one report's maker):
//     loadProfileNames(supabase, clientId, [id]).
//   - The names are read beside the rows, before the ids are known: keep that call
//     (profileNamesRpc with no ids, which names everyone but the operators, as before), then
//     fillMissingNames() with the rows' ids once they land. It asks again only for an id the first
//     read did not name, which is the rare case, so the usual load costs nothing more.
//   - The names are read once and the rows separately, more than once: useMissingProfileNames().
//
// Every form answers `{ map, error }` and never throws; a failed names read must never blank the
// figures it was naming, so each caller decides what an unnamed id shows.

export const NAMES_READ_MS = 20000

/** The distinct, non-empty ids among `ids`, in first-seen order. */
export function distinctIds(ids) {
  return [...new Set((ids || []).filter(Boolean))]
}

/** The RPC's rows as `{ id: full_name }`. */
export function namesMapOf(rows) {
  return Object.fromEntries((rows || []).map(p => [p.id, p.full_name]))
}

/**
 * The RPC call itself (a thenable, so a caller can put it in its own Promise.all or bound it). With
 * `ids`, an operator login among them is named "Crest support"; without, every name but those.
 */
export function profileNamesRpc(supabase, clientId, ids) {
  const args = { p_client_id: clientId }
  if (ids) args.p_ids = distinctIds(ids)
  return supabase.rpc('get_client_profile_names', args)
}

/** `{ map, error }` for this client's logins plus any operator login among `ids`. Time-limited. */
export async function loadProfileNames(supabase, clientId, ids, { ms = NAMES_READ_MS, label = 'Reading staff names' } = {}) {
  const { data, error } = await settleWithin(profileNamesRpc(supabase, clientId, ids), ms, label)
  if (error) return { map: {}, error }
  return { map: namesMapOf(data), error: null }
}

/** The ids among `ids` that `map` has no entry for. A login whose name is empty still has one. */
export function missingNameIds(map, ids) {
  const known = map || {}
  return distinctIds(ids).filter(id => !Object.prototype.hasOwnProperty.call(known, id))
}

/**
 * The second step: names the ids among `ids` that `map` lacks, and answers `{ map, error }` with
 * them merged in. No request when nothing is missing, and then (or on an error) `map` comes back as
 * the same object, so `result.map !== map` says something was added.
 */
export async function fillMissingNames(supabase, clientId, map, ids, opts) {
  const base = map || {}
  const missing = missingNameIds(base, ids)
  if (missing.length === 0) return { map: base, error: null }
  const res = await loadProfileNames(supabase, clientId, missing, opts)
  if (res.error) return { map: base, error: res.error }
  return { map: { ...base, ...res.map }, error: null }
}

/**
 * For a page that reads its names once and its rows separately: once `ready` (its own names read
 * has answered) it asks for the ids among `ids` that `names` lacks and hands the ones it found to
 * `onFound(found)` to merge in. Nothing is asked while every id is named, the usual case. An id the
 * RPC cannot name costs one more request when `names` next changes, never a loop: a request that
 * finds nothing changes no state. `onError(error)` hears a failed request (else it is logged).
 */
export function useMissingProfileNames({ supabase, clientId, names, ready = true, ids, onFound, onError }) {
  const key = distinctIds(ids).sort().join(',')
  const handlers = useRef({ onFound, onError })
  useEffect(() => { handlers.current = { onFound, onError } })

  useEffect(() => {
    if (!ready || !clientId || !key) return undefined
    const missing = missingNameIds(names, key.split(','))
    if (missing.length === 0) return undefined
    let live = true
    loadProfileNames(supabase, clientId, missing).then(({ map, error }) => {
      if (!live) return
      if (error) {
        if (handlers.current.onError) handlers.current.onError(error)
        else console.error('staff names: logins the first read did not name could not be read:', error)
        return
      }
      const found = {}
      for (const id of missing) if (Object.prototype.hasOwnProperty.call(map, id)) found[id] = map[id]
      if (Object.keys(found).length > 0) handlers.current.onFound?.(found)
    })
    return () => { live = false }
  }, [supabase, clientId, ready, names, key])
}
