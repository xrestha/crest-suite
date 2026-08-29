// Pages through a PostgREST query instead of silently taking the first 1000 rows.
//
// Supabase sets PostgREST's `db-max-rows` to 1000, and a plain `.select()` with no `.range()`
// hits that cap with NO error and NO indication in the returned data — the response just carries
// `content-range: 0-999/*` and the client sees a perfectly ordinary array. Any figure summed from
// that array is then wrong, and wrong quietly, which is the dangerous part: it reads as a real
// total right up until someone compares it against another source.
//
// Found live (S528) on Stock Movements for a real client: the ledger showed exactly "1000
// movements / NPR 49,241 depleted" for an open period that actually had more, and the round
// number was the only tell. Verified from the response header, not inferred.
//
// `makeQuery` must be a FUNCTION returning a fresh builder — a supabase-js builder is a one-shot
// thenable and cannot be awaited twice, so each page needs its own.
//
// The query it returns MUST have a deterministic total order, including a unique tiebreaker
// (`.order('id')` after whatever the display order is). Paging an unordered — or
// non-uniquely-ordered — query can repeat rows on one page and skip them on the next, which
// turns a truncation bug into a subtler wrong-total bug.
export async function fetchAllRows(makeQuery, { pageSize = 1000, maxRows = 100000 } = {}) {
  const out = []
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await makeQuery().range(from, from + pageSize - 1)
    if (error) return { data: null, error }
    const batch = data || []
    out.push(...batch)
    // A short page means the end of the result set. An exactly-full page is ambiguous, so it
    // costs one extra round trip that comes back empty — cheap, and the only way to be sure.
    if (batch.length < pageSize) break
  }
  return { data: out, error: null }
}

// Same job for a read whose filter is `.in(column, ids)` with a long id list.
//
// A `.in()` filter is spelled out in the request URL, so once the list is long enough the read
// stops being a row-count problem and becomes a URL-length one: a uuid costs ~37 characters, so
// a few hundred ids already exceeds what proxies and CDNs accept and the request comes back 414
// rather than short. That failure is at least loud — the quiet half is that the ROW cap still
// applies underneath it, and one order can own many rows (a bill has a line per dish), so a
// list of 200 order ids can easily match more than 1000 rows.
//
// `makeQuery` takes the id slice and returns a fresh builder for it, and must carry the same
// unique tiebreaker fetchAllRows requires. Chunks are independent reads, so they run together.
export async function fetchAllRowsChunked(ids, makeQuery, { chunkSize = 150, ...pageOpts } = {}) {
  const unique = [...new Set((ids || []).filter(id => id != null))]
  if (unique.length === 0) return { data: [], error: null }
  const chunks = []
  for (let i = 0; i < unique.length; i += chunkSize) chunks.push(unique.slice(i, i + chunkSize))
  const results = await Promise.all(chunks.map(c => fetchAllRows(() => makeQuery(c), pageOpts)))
  const failed = results.find(r => r.error)
  if (failed) return { data: null, error: failed.error }
  return { data: results.flatMap(r => r.data), error: null }
}

// The write-side counterpart: splits an id list the same way so an UPDATE/DELETE filtered by
// `.in('id', ids)` cannot outgrow its own URL either. `makeQuery` returns the builder for a
// slice; the first error wins and stops nothing that has already been applied, which is why
// callers must treat this as "some chunks may have landed" rather than atomic.
export async function runChunkedByIds(ids, makeQuery, { chunkSize = 150 } = {}) {
  const unique = [...new Set((ids || []).filter(id => id != null))]
  if (unique.length === 0) return { error: null }
  for (let i = 0; i < unique.length; i += chunkSize) {
    const { error } = await makeQuery(unique.slice(i, i + chunkSize))
    if (error) return { error }
  }
  return { error: null }
}
