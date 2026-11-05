// What push_master_data answered, read once (S849 GROUP-6, GROUP-10). Pure, so it is pinned by
// masterPushResult.test.js.
//
// Since S849 the RPC returns one shape for both modes, in row_no order:
//   row 0           row_kind 'total'   — row_n = how many 'row' rows the reply carries in all
//   then            row_kind 'summary' — one per branch × entity × action, row_n = its count
//   then            row_kind 'row'     — every planned row on a preview; after a push, only the rows
//                                        that need a look (a routine create / update / replaced list
//                                        is in the counts, not listed)
// A set-returning call is cut at 1,000 rows (PostgREST max_rows), so the page reads a PREVIEW in
// pages, and checks the 'row' rows that arrived against row 0's count. A push is called once, never
// paged (a second call would push again), so a long push reply can arrive short: `complete` says so.
// Counts never come from the listed rows — they come from the summary rows, which are never cut.

const num = v => Number(v) || 0

// rows: the RPC rows → { total, counts, byEntity, byBranch, rows, complete }
//   counts:   { [action]: n }                     over every branch and entity
//   byEntity: { [entity]: { [action]: n } }
//   byBranch: [{ id, name, counts: { [action]: n } }] in the order the summary lists them
//   rows:     the 'row' rows, as the table renders them
//   complete: every 'row' row the total names arrived
export function readPushResult(rows) {
  const list = rows || []
  // An older database (before the S849 migration) returns no row_kind: every row is a plan row and
  // the counts come from the rows themselves, as they always did.
  if (!list.some(r => r && r.row_kind)) {
    const counts = {}
    const byEntity = {}
    const branches = new Map()
    for (const r of list) {
      counts[r.action] = (counts[r.action] || 0) + 1
      byEntity[r.entity] = byEntity[r.entity] || {}
      byEntity[r.entity][r.action] = (byEntity[r.entity][r.action] || 0) + 1
      const id = r.target_client_id || r.target_client_name
      if (!branches.has(id)) branches.set(id, { id, name: r.target_client_name, counts: {} })
      const b = branches.get(id)
      b.counts[r.action] = (b.counts[r.action] || 0) + 1
    }
    return { total: list.length, counts, byEntity, byBranch: [...branches.values()], rows: list, complete: true }
  }

  let total = null
  const counts = {}
  const byEntity = {}
  const branches = new Map()
  const planRows = []
  for (const r of list) {
    if (r.row_kind === 'total') { total = num(r.row_n); continue }
    if (r.row_kind === 'summary') {
      const n = num(r.row_n)
      counts[r.action] = (counts[r.action] || 0) + n
      byEntity[r.entity] = byEntity[r.entity] || {}
      byEntity[r.entity][r.action] = (byEntity[r.entity][r.action] || 0) + n
      const id = r.target_client_id || r.target_client_name
      if (!branches.has(id)) branches.set(id, { id, name: r.target_client_name, counts: {} })
      const b = branches.get(id)
      b.counts[r.action] = (b.counts[r.action] || 0) + n
      continue
    }
    if (r.row_kind === 'row') planRows.push(r)
  }
  // No total row at all means the reply was cut before it, which a row_no-ordered reply cannot be
  // unless it was empty; an empty reply is complete.
  const expected = total == null ? planRows.length : total
  return {
    total: expected,
    counts,
    byEntity,
    byBranch: [...branches.values()],
    rows: planRows,
    complete: planRows.length >= expected,
  }
}

// How many records an action covers for one entity (0 when none).
export const countOf = (result, entity, action) => result?.byEntity?.[entity]?.[action] || 0

// The plan actions in plain words (S857, the Suite critique: the preview showed the database codes,
// so an owner read "adopt" and "conflict"). Every action push_master_data can plan or report, as
// [before the push, after it]: a preview says what will happen, a finished push what did. An action
// this table does not know (a newer database) falls back to its own code, so it still shows.
//   create    a record new to the branch
//   adopt     the first push into a branch that already has the record: matched by name, once
//   update    a linked record overwritten with the HQ version
//   replaced  a list (ingredient lines, choice stock lines, a dish's choice groups) set to HQ's
//   partial   a new dish or choice written without the lines the branch cannot match
//   skipped   the branch's own dish or stock lines kept whole (an ingredient is missing there)
//   change    a dish's Veg / Egg / Non-veg mark changes at the branch
//   conflict  another branch record (a name, a code) is in the way, so this one is not written
//   hide      a choice, group or combo HQ deleted, switched off at the branch
//   warning   a choice that would take a dish below zero at the branch
const ACTION_WORDS = {
  create: ['will be added', 'added'],
  adopt: ['matched by name: will follow HQ', 'matched by name: now follows HQ'],
  update: ['will be updated', 'updated'],
  replaced: ['will match HQ', 'now matches HQ'],
  partial: ['will be added without some lines', 'added without some lines'],
  skipped: ['kept unchanged at the branch', 'kept unchanged at the branch'],
  change: ['food mark will change', 'food mark changed'],
  conflict: ['blocked at the branch: skipped', 'blocked at the branch: skipped'],
  hide: ['will be switched off', 'switched off'],
  warning: ['check this', 'check this'],
}
// The same actions as a count: "12 to add", "12 added".
const COUNT_WORDS = {
  create: ['to add', 'added'],
  adopt: ['to match by name', 'matched by name'],
  update: ['to update', 'updated'],
  replaced: ['to match HQ', 'now match HQ'],
  partial: ['to add without some lines', 'added without some lines'],
  skipped: ['kept unchanged at the branch', 'kept unchanged at the branch'],
  change: ['food marks to change', 'food marks changed'],
  conflict: ['blocked at the branch', 'blocked at the branch'],
  hide: ['to switch off', 'switched off'],
  warning: ['to check', 'to check'],
}

// One plan row's action as the table's badge says it.
export const actionWords = (action, { applied = false } = {}) => ACTION_WORDS[action]?.[applied ? 1 : 0] || action

// "12 to add · 3 to update · 1 blocked at the branch" (a preview), or "12 added · 3 updated · …" (a
// finished push) — a count line from { [action]: n }.
export const countsLine = (counts, { applied = false } = {}) => Object.entries(counts || {})
  .filter(([, n]) => n > 0)
  .map(([k, n]) => `${n} ${COUNT_WORDS[k]?.[applied ? 1 : 0] || k}`)
  .join(' · ')

// A Postgres SQLSTATE is five characters (42501, 23505, 57014, P0001); PostgREST's own refusals are
// PGRSTnnn. Either means the server answered and the call did not run to its end: push_master_data is
// one transaction, so a refusal or a statement timeout (57014) rolled back everything.
const SQLSTATE_RE = /^[0-9A-Z]{5}$/
const PGRST_RE = /^PGRST\d{3}$/

export const PUSH_NOT_RUN_TEXT = 'The push did not run — the branches are unchanged.'
export const PUSH_UNKNOWN_TEXT = 'We couldn’t confirm whether the push finished — the connection dropped or the server took too long to answer. '
  + 'Press Preview changes to see what each branch holds now; pushing again does not duplicate anything the first push created.'

// What a failed push may truthfully say (GROUP-10). A database answer → it did not run. Anything
// else (our own timeout, a dropped connection, a gateway 5xx with no SQL code) → we do not know, and
// the message never claims the branches are unchanged.
// → { kind: 'not_run' | 'unknown', text }
export function pushOutcome(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (SQLSTATE_RE.test(code) || PGRST_RE.test(code)) return { kind: 'not_run', text: PUSH_NOT_RUN_TEXT }
  return { kind: 'unknown', text: PUSH_UNKNOWN_TEXT }
}
