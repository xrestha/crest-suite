// An update or delete that matched no row returns `{ data: null, error: null }` — the same answer
// as success to a call site that tests `error` alone. Three things produce it on the HR screens:
// the row was changed or removed on another screen, the login lost the rank RLS needs (a refused
// RLS write is 0 rows, not an error), or the window shows an outlet the login has since left, so
// RLS resolves to a different client than the page filters by (S798 GAP-OUTLETS-2).
//
// Unlike a dead connection this one IS proof: PostgREST returns the rows it wrote, so a write that
// asks for them with `.select('id')` and gets none may say it did not land. Hand-written, so it is
// shown as is and never run through errorText (S714: the table would turn it into "the reason
// isn't one we recognise").
export const NOTHING_CHANGED = 'Nothing was changed: the record was changed or removed on another screen, this login no longer has the rank for it, or this window shows an outlet your account has since left. Reload to see it as it is.'

// True when a write that asked for its rows back with .select('id') got none, and no error.
export const changedNothing = (rows, error) => !error && !rows?.length
