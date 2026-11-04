/**
 * S875: the HR login of a leaver is blocked, not deleted (owner decision "Block, keep the name"). These
 * pin the decisions HR Staff makes from an admin-user-ops answer, and that no sentence claims a write
 * did not land when nobody knows.
 */
import {
  blockStateOf, nameOf, resetLockReason, readEdgeAnswer, staffActionFailure, deleteRefusal, blockNotice,
} from './hrLoginBlock'

const httpError = (status, body) => ({
  name: 'FunctionsHttpError',
  message: 'Edge Function returned a non-2xx status code',
  context: { status, json: async () => body },
})
const fetchError = { name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function', context: new TypeError('Failed to fetch') }

describe('blockStateOf', () => {
  it('names who blocked the login, settlement first', () => {
    expect(blockStateOf({ settlement_blocked: true, staff_blocked_at: '2026-11-04T05:00:00Z' })).toBe('settlement')
    expect(blockStateOf({ settlement_blocked: false, staff_blocked_at: '2026-11-04T05:00:00Z' })).toBe('here')
    expect(blockStateOf({ settlement_blocked: false, staff_blocked_at: null })).toBeNull()
    expect(blockStateOf({})).toBeNull()
    expect(blockStateOf(null)).toBeNull()
  })
})

describe('resetLockReason', () => {
  it('keeps Reset Password off a blocked login and says why', () => {
    expect(resetLockReason({ settlement_blocked: true })).toMatch(/Final Settlement/)
    expect(resetLockReason({ staff_blocked_at: '2026-11-04T05:00:00Z' })).toMatch(/Unblock it first/)
    expect(resetLockReason({})).toBe('')
  })
})

describe('nameOf', () => {
  it('falls back to the email, then to a plain word', () => {
    expect(nameOf({ full_name: 'Ram', email: 'r@x.np' })).toBe('Ram')
    expect(nameOf({ email: 'r@x.np' })).toBe('r@x.np')
    expect(nameOf({})).toBe('this person')
  })
})

describe('readEdgeAnswer', () => {
  it('reads a refusal on a non-2xx once, with its status and code', async () => {
    const a = await readEdgeAnswer(null, httpError(409, { error: 'Ram has decided 3 leave requests.', code: 'staff_login_has_records' }))
    expect(a).toEqual(expect.objectContaining({ status: 409, answered: true }))
    expect(a.body.code).toBe('staff_login_has_records')
  })

  it('reads a refusal carried in a 2xx body', async () => {
    const a = await readEdgeAnswer({ error: 'Not allowed here.', code: 'x' }, null)
    expect(a).toEqual(expect.objectContaining({ status: null, answered: true }))
    expect(a.body.error).toBe('Not allowed here.')
  })

  it('treats a dropped call as no answer', async () => {
    const a = await readEdgeAnswer(null, fetchError)
    expect(a.answered).toBe(false)
    expect(a.body).toBeNull()
  })

  it('survives a body that is not JSON', async () => {
    const err = { name: 'FunctionsHttpError', message: 'non-2xx', context: { status: 502, json: async () => { throw new Error('not json') } } }
    const a = await readEdgeAnswer(null, err)
    expect(a).toEqual(expect.objectContaining({ status: 502, answered: true, body: null }))
  })
})

describe('staffActionFailure', () => {
  const opts = { name: 'Ram', verbed: 'blocked' }

  it('shows the sentence the function wrote, as written', async () => {
    const f = staffActionFailure(await readEdgeAnswer(null, httpError(409, {
      error: 'HR shows Ram as no longer working here, so the login stays blocked', code: 'staff_unblock_leaver',
    })), { name: 'Ram', verbed: 'unblocked' })
    expect(f.text).toBe('HR shows Ram as no longer working here, so the login stays blocked.')
    expect(f.detail).toBe('HTTP 409 · staff_unblock_leaver')
    expect(f.reload).toBe(false)
  })

  it('says "was not" only for a refusal with no sentence', async () => {
    const f = staffActionFailure(await readEdgeAnswer(null, httpError(403, { error: 'Forbidden' })), opts)
    expect(f.text).toBe('The login of Ram was not blocked.')
    expect(f.detail).toBe('HTTP 403 · Forbidden')
    expect(f.reload).toBe(false)
  })

  it('claims nothing when no answer came back, and asks for a reload', async () => {
    const f = staffActionFailure(await readEdgeAnswer(null, fetchError), opts)
    expect(f.text).toMatch(/^It is not known whether the login of Ram was blocked/)
    expect(f.reload).toBe(true)
  })

  it('claims nothing on a 5xx with no sentence', async () => {
    const err = { name: 'FunctionsHttpError', message: 'non-2xx', context: { status: 504, json: async () => { throw new Error('x') } } }
    const f = staffActionFailure(await readEdgeAnswer(null, err), opts)
    expect(f.text).toMatch(/^It is not known/)
    expect(f.reload).toBe(true)
  })

  it('shows a 5xx sentence as written and still re-reads the list', async () => {
    const f = staffActionFailure(await readEdgeAnswer(null, httpError(503, {
      error: 'Could not check whether Ram has recorded anything in HR, so the login was not deleted. Try again in a moment.',
    })), { name: 'Ram', verbed: 'deleted' })
    expect(f.text).toMatch(/^Could not check whether Ram/)
    expect(f.reload).toBe(true)
  })
})

describe('deleteRefusal', () => {
  const recorded = { status: 409, answered: true, body: { error: 'Ram has decided 3 leave requests in HR, so deleting this login would take their name off those records. Block the login instead', code: 'staff_login_has_records' } }

  it('offers Block, with the server sentence, for a login that recorded something', () => {
    const r = deleteRefusal(recorded, { full_name: 'Ram' })
    expect(r.offerBlock).toBe(true)
    expect(r.why).toMatch(/^Ram has decided 3 leave requests/)
    expect(r.why.endsWith('.')).toBe(true)
  })

  it('offers nothing more for a login already blocked, here or by a settlement', () => {
    for (const p of [{ full_name: 'Ram', staff_blocked_at: '2026-11-04T05:00:00Z' }, { full_name: 'Ram', settlement_blocked: true }]) {
      const r = deleteRefusal(recorded, p)
      expect(r.offerBlock).toBeUndefined()
      expect(r.text).toMatch(/It is already blocked, so it cannot sign in\.$/)
    }
  })

  it('leaves every other refusal to the general message', () => {
    expect(deleteRefusal({ body: { error: 'x', code: 'other' } }, { full_name: 'Ram' })).toBeNull()
    expect(deleteRefusal({ body: null }, { full_name: 'Ram' })).toBeNull()
  })
})

describe('blockNotice', () => {
  it('says what happened for every outcome the function returns', () => {
    expect(blockNotice('blocked', 'Ram', true)).toMatch(/is blocked: it can no longer sign in/)
    expect(blockNotice('already_blocked', 'Ram', true)).toMatch(/already blocked, so nothing changed/)
    expect(blockNotice('unblocked', 'Ram', false)).toMatch(/is unblocked and signs in again/)
    expect(blockNotice('not_blocked', 'Ram', false)).toMatch(/was not blocked, so nothing changed/)
    expect(blockNotice(undefined, 'Ram', true)).toMatch(/is blocked/)
    expect(blockNotice(undefined, 'Ram', false)).toMatch(/is unblocked/)
  })

  it('carries no apostrophe (S851)', () => {
    for (const o of ['blocked', 'already_blocked', 'unblocked', 'not_blocked', undefined]) {
      expect(blockNotice(o, 'Ram', true)).not.toMatch(/['’]/)
    }
  })
})
