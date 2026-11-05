import { readPushResult, countOf, countsLine, actionWords, pushOutcome, PUSH_NOT_RUN_TEXT, PUSH_UNKNOWN_TEXT } from './masterPushResult'

const total = n => ({ row_no: 0, row_kind: 'total', row_n: n })
const summary = (row_no, tid, tname, entity, action, n) => ({ row_no, row_kind: 'summary', target_client_id: tid, target_client_name: tname, entity, action, row_n: n })
const row = (row_no, tid, tname, entity, action, record_name, detail = null) => ({ row_no, row_kind: 'row', target_client_id: tid, target_client_name: tname, entity, action, record_name, detail, row_n: null })

describe('readPushResult', () => {
  const reply = [
    total(3),
    summary(1, 'a', 'Bloom PKR', 'items', 'create', 40),
    summary(2, 'a', 'Bloom PKR', 'recipes', 'skipped', 2),
    summary(3, 'a', 'Bloom PKR', 'ingredients', 'partial', 1),
    summary(4, 'b', 'Casa', 'food marks', 'change', 1),
    summary(5, 'b', 'Casa', 'items', 'create', 5),
    row(6, 'a', 'Bloom PKR', 'ingredients', 'partial', 'Momo'),
    row(7, 'a', 'Bloom PKR', 'recipes', 'skipped', 'Thukpa', 'kept exactly as this branch has it'),
    row(8, 'b', 'Casa', 'food marks', 'change', 'Chowmein'),
  ]

  test('the total row comes first and the counts come from the summary rows, not the listed ones', () => {
    const r = readPushResult(reply)
    expect(r.total).toBe(3)
    expect(r.counts).toEqual({ create: 45, skipped: 2, partial: 1, change: 1 })
    expect(r.rows.map(x => x.record_name)).toEqual(['Momo', 'Thukpa', 'Chowmein'])
    expect(r.complete).toBe(true)
  })

  test('counts per entity and per branch, skipped and partial included', () => {
    const r = readPushResult(reply)
    expect(countOf(r, 'recipes', 'skipped')).toBe(2)
    expect(countOf(r, 'ingredients', 'partial')).toBe(1)
    expect(countOf(r, 'food marks', 'change')).toBe(1)
    expect(countOf(r, 'recipes', 'create')).toBe(0)
    expect(r.byBranch).toEqual([
      { id: 'a', name: 'Bloom PKR', counts: { create: 40, skipped: 2, partial: 1 } },
      { id: 'b', name: 'Casa', counts: { change: 1, create: 5 } },
    ])
  })

  test('complete is false when fewer rows arrived than the total names', () => {
    const r = readPushResult([total(1500), summary(1, 'a', 'Bloom PKR', 'items', 'create', 1500), row(2, 'a', 'Bloom PKR', 'items', 'create', 'Flour')])
    expect(r.total).toBe(1500)
    expect(r.rows).toHaveLength(1)
    expect(r.complete).toBe(false)
    expect(r.counts.create).toBe(1500)
  })

  test('a push that changed nothing: total 0, no rows, complete', () => {
    const r = readPushResult([total(0)])
    expect(r).toMatchObject({ total: 0, counts: {}, rows: [], complete: true })
  })

  test('an older reply with no row_kind is counted from its rows', () => {
    const r = readPushResult([
      { target_client_id: 'a', target_client_name: 'Bloom PKR', entity: 'items', action: 'create', record_name: 'Flour' },
      { target_client_id: 'a', target_client_name: 'Bloom PKR', entity: 'items', action: 'create', record_name: 'Sugar' },
    ])
    expect(r).toMatchObject({ total: 2, counts: { create: 2 }, complete: true })
    expect(r.rows).toHaveLength(2)
  })

  test('countsLine names each action with its count, in plain words (S857)', () => {
    expect(countsLine({ create: 12, update: 3, conflict: 1, adopt: 0 })).toBe('12 to add · 3 to update · 1 blocked at the branch')
    expect(countsLine({ create: 12, update: 3, adopt: 2 }, { applied: true })).toBe('12 added · 3 updated · 2 matched by name')
    expect(countsLine({ somethingNew: 4 })).toBe('4 somethingNew')
    expect(countsLine({})).toBe('')
  })

  test('actionWords never shows the database code for an action it knows (S857)', () => {
    for (const a of ['create', 'adopt', 'update', 'replaced', 'partial', 'skipped', 'change', 'conflict', 'hide', 'warning']) {
      expect(actionWords(a)).not.toBe(a)
      expect(actionWords(a, { applied: true })).not.toBe(a)
    }
    expect(actionWords('adopt')).toBe('matched by name: will follow HQ')
    expect(actionWords('conflict', { applied: true })).toBe('blocked at the branch: skipped')
    expect(actionWords('create', { applied: true })).toBe('added')
    expect(actionWords('unknown')).toBe('unknown')
  })
})

describe('pushOutcome', () => {
  test('a database refusal (42501) did not run', () => {
    expect(pushOutcome({ code: '42501', message: 'group_hq_outside: …', hint: 'group_hq_outside' })).toEqual({ kind: 'not_run', text: PUSH_NOT_RUN_TEXT })
  })
  test('the statement timeout (57014) rolled back, so it did not run', () => {
    expect(pushOutcome({ code: '57014', message: 'canceling statement due to statement timeout' }).kind).toBe('not_run')
  })
  test('a P0001 raise and a PostgREST refusal did not run', () => {
    expect(pushOutcome({ code: 'P0001', message: 'This group has no HQ outlet set' }).kind).toBe('not_run')
    expect(pushOutcome({ code: 'PGRST301', message: 'JWT expired' }).kind).toBe('not_run')
  })
  test('our own timeout cannot say what happened', () => {
    const err = new Error('Push timed out after 30s')
    err.name = 'TimeoutError'
    expect(pushOutcome(err)).toEqual({ kind: 'unknown', text: PUSH_UNKNOWN_TEXT })
  })
  test('a dropped connection cannot say what happened', () => {
    expect(pushOutcome({ message: 'TypeError: Failed to fetch', code: '' }).kind).toBe('unknown')
  })
  test('a gateway 504 with no SQL code cannot say what happened', () => {
    expect(pushOutcome({ status: 504 }).kind).toBe('unknown')
  })
  test('the unknown sentence never claims the branches are unchanged', () => {
    expect(PUSH_UNKNOWN_TEXT).not.toMatch(/unchanged/)
    expect(PUSH_UNKNOWN_TEXT).toMatch(/Preview changes/)
  })
})
