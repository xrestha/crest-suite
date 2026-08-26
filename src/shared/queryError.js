/**
 * The one place a batch of Supabase results is checked for failure.
 *
 * WHY (S594 `/impeccable critique`): every read on the report pages written the week of
 * 2026-08-17 destructured `{ data }` and dropped `error`, then ran the result through `|| []`.
 * An RLS rejection, a network blip, a PostgREST schema-cache miss or the documented auth-token
 * stall all produce `data: null, error: {...}` — so the page rendered a complete report of
 * NPR 0, visually identical to a genuinely quiet period. That is strictly worse than a crash:
 * a crash gets reported, a zero gets believed, and this product is sold on an accountant
 * trusting the figure.
 *
 * `ConsolidatedPnl`'s group path already had the right instinct and the right sentence for it —
 * "'nothing to show' and 'could not load' are different facts, and only one of them should send
 * someone to billing." This exists so that instinct does not have to travel by hand to the next
 * report page somebody writes.
 *
 * Usage — capture the array instead of destructuring straight through:
 *
 *   const results = await Promise.all([...])
 *   const failed = firstError(results)
 *   if (failed) { setLoadError(failed); return }
 *   const [{ data: items }, { data: sales }] = results
 */
export function firstError(results) {
  const bad = (results || []).find(r => r && r.error)
  if (!bad) return null
  return bad.error.message || bad.error.details || String(bad.error)
}

/**
 * The throwing form, for compute functions that run inside a try/catch harness rather than a
 * React component — the Monthly Owner Report's `runSection()` being the motivating case (S612):
 * its sections already degrade a THROWN failure to a named `sectionErrors` entry the page shows
 * as "couldn't be generated", but a Supabase read does not throw — it returns `error` and the
 * arithmetic runs on `|| []`, freezing zeros into the immutable snapshot with no trace. Call this
 * on every batch (and wrap single reads) inside such functions so a failed read becomes a caught,
 * named failure instead of a permanent wrong number.
 */
export function throwFirstError(results) {
  const msg = firstError(results)
  if (msg) throw new Error(msg)
}
