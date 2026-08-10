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
