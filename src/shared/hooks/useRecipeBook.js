import { useCallback, useRef } from 'react'
import { useScopedDb } from './useScopedDb'
import { loadRecipeBook } from '../../utils/recipeCost'

// The client's recipe book (`loadRecipeBook`) as ONE promise per client, for a page that walks the
// recipe tree on every period it shows (S793). The book does not depend on the period, so the page
// starts it beside its period list and every later load reuses it — each walk then costs no round
// trip at all, where the fetch-per-level walk cost one per sub-recipe nesting level.
//
// Returns a function, `recipeBook()`, that hands back that promise. An admin switching client gets a
// fresh book (it is keyed on the client the scoped reads are bound to), and a failed read is
// forgotten so the next call retries instead of replaying the failure. The promise REJECTS on a
// failed read, like the walk it feeds; callers route that to their own load-error state.
export function useRecipeBook() {
  const { clientId, scopedFrom } = useScopedDb()
  const ref = useRef(null)
  return useCallback(() => {
    if (ref.current?.clientId === clientId) return ref.current.promise
    const promise = loadRecipeBook(scopedFrom)
    ref.current = { clientId, promise }
    promise.catch(() => { if (ref.current?.promise === promise) ref.current = null })
    return promise
  }, [clientId, scopedFrom])
}
