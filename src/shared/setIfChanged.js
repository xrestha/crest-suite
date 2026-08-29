// Skips a re-render when a poll comes back with what the screen is already showing.
//
// A `setState(freshArray)` always re-renders, because the array is a new object even when every
// row in it is identical. That is normally harmless — but a screen that polls has this happen on
// a timer forever, whether or not anything moved. POS Orders polls its KOT tickets and its guest
// requests every 5 s each, and both call a setter unconditionally, so the largest component in
// the product was reconciling its whole tree roughly every 2.5 s for the length of a service, on
// a device that is usually a tablet. The overwhelmingly common answer to both polls is "nothing
// has changed".
//
// Returning `prev` unchanged from an updater is React's own documented bail-out, so this is the
// cheapest possible fix: one signature comparison instead of a render.
//
// `signOf` must be PURE and must cover every field the screen actually draws from — a signature
// that omits one is a stale render that never repaints, which is a worse bug than the one this
// solves. Keep it to the fields the UI reads; adding a column to the query does not require
// adding it here, but starting to *display* one does.
export function setIfChanged(setState, next, signOf) {
  setState(prev => (signOf(prev) === signOf(next) ? prev : next))
}

// Signature for a list of rows: length plus the named fields, in order. Order matters and is
// meant to — a reordered list is a different screen.
export function rowsSignature(rows, fields) {
  if (!Array.isArray(rows)) return 'x'
  let s = String(rows.length)
  for (const r of rows) {
    for (const f of fields) s += '|' + (r?.[f] ?? '')
  }
  return s
}

// Signature for a plain object keyed by id (a per-table or per-order lookup). Keys are sorted, so
// two maps built in a different order still compare equal — the map is unordered by nature and
// nothing renders from its insertion order.
export function mapSignature(obj, valueOf = v => v) {
  if (!obj || typeof obj !== 'object') return 'x'
  const keys = Object.keys(obj).sort()
  let s = String(keys.length)
  for (const k of keys) s += '|' + k + '=' + valueOf(obj[k])
  return s
}
