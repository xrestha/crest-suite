/**
 * S875: what an IMS Staff row offers once a leaver is blocked rather than deleted (owner decision
 * 2026-11-04, "Block, keep the name"), and how an admin-user-ops answer body is read.
 */
import { imsRowState, imsLoginCanSignIn, blockOutcomeNotice, readEdgeBody, HAS_RECORDS_CODE, READY_REFUSAL_CODES } from './imsStaffRows'

describe('imsLoginCanSignIn (S878: who Stock Count → Settings offers sections to)', () => {
  it('keeps an ordinary login', () => {
    expect(imsLoginCanSignIn({ id: 'u1', ims_role: 'staff' })).toBe(true)
  })

  it('drops a login blocked on IMS Staff', () => {
    expect(imsLoginCanSignIn({ id: 'u1', ims_role: 'staff', staff_blocked_at: '2026-11-04T05:00:00Z' })).toBe(false)
  })

  it('drops a login blocked at a Final Settlement', () => {
    expect(imsLoginCanSignIn({ id: 'u1', ims_role: 'staff', settlement_blocked: true })).toBe(false)
  })
})

describe('imsRowState', () => {
  it('offers Block on an ordinary row, and Reset with no reason', () => {
    const row = imsRowState({ id: 'u1', full_name: 'Ravi' }, 'me')
    expect(row).toEqual({ isSelf: false, settlementBlocked: false, staffBlocked: false, blockAction: 'block', resetReason: '' })
  })

  it('offers Unblock on a row blocked here, and Reset says to unblock first', () => {
    const row = imsRowState({ id: 'u1', staff_blocked_at: '2026-11-04T05:00:00Z' }, 'me')
    expect(row.staffBlocked).toBe(true)
    expect(row.blockAction).toBe('unblock')
    expect(row.resetReason).toBe('This login is blocked. Unblock it first; a new password would not let them sign in.')
  })

  it('names the PIN for a counting login', () => {
    const row = imsRowState({ id: 'u1', has_pin: true, staff_blocked_at: '2026-11-04T05:00:00Z' }, 'me')
    expect(row.resetReason).toContain('a new PIN would not')
  })

  it('offers neither Block nor Unblock on a settlement block, which HR undoes', () => {
    // A row can carry both marks; the settlement one wins, so the page never offers an Unblock the
    // server would refuse (staff_login_settlement_blocked).
    const row = imsRowState({ id: 'u1', settlement_blocked: true, staff_blocked_at: '2026-11-04T05:00:00Z' }, 'me')
    expect(row.settlementBlocked).toBe(true)
    expect(row.staffBlocked).toBe(false)
    expect(row.blockAction).toBeNull()
    expect(row.resetReason).toBe('Blocked at Final Settlement, so a new password would not let them sign in.')
  })

  it('offers no Block on your own login, as no Delete', () => {
    const row = imsRowState({ id: 'me' }, 'me')
    expect(row.isSelf).toBe(true)
    expect(row.blockAction).toBeNull()
  })

  it('treats a missing viewer id as nobody', () => {
    expect(imsRowState({ id: null }, null).isSelf).toBe(false)
  })
})

describe('blockOutcomeNotice', () => {
  it('words each outcome the server returns', () => {
    expect(blockOutcomeNotice('blocked', 'Sita', true)).toBe('Sita can no longer sign in. The login is kept, so their name stays on everything they recorded.')
    expect(blockOutcomeNotice('already_blocked', 'Sita', true)).toBe('The login of Sita was already blocked, so nothing changed.')
    expect(blockOutcomeNotice('unblocked', 'Sita', false)).toBe('Sita can sign in again, with the same role and access level as before.')
    expect(blockOutcomeNotice('not_blocked', 'Sita', false)).toBe('The login of Sita was not blocked, so nothing changed.')
  })

  it('trusts a success with no outcome, and copes with no name', () => {
    expect(blockOutcomeNotice(undefined, 'Sita', true)).toBe('The login of Sita is blocked.')
    expect(blockOutcomeNotice(undefined, 'Sita', false)).toBe('The login of Sita is unblocked.')
    expect(blockOutcomeNotice('blocked', '', true)).toMatch(/^This person can no longer sign in\./)
  })
})

describe('readEdgeBody', () => {
  const body = { error: 'Sita has recorded 3 stock counts. Block the login instead.', code: HAS_RECORDS_CODE }

  it('returns a 2xx refusal as it came', async () => {
    await expect(readEdgeBody(null, body)).resolves.toBe(body)
  })

  it('reads a non-2xx body from a clone, leaving the original readable', async () => {
    let reads = 0
    const res = { status: 409, json: async () => { reads += 1; if (reads > 1) throw new TypeError('body used'); return body } }
    res.clone = () => ({ json: async () => body })
    await expect(readEdgeBody({ name: 'FunctionsHttpError', context: res }, null)).resolves.toEqual(body)
    await expect(res.json()).resolves.toEqual(body)
  })

  it('answers null for no answer at all, or a body that is not JSON', async () => {
    await expect(readEdgeBody({ name: 'FunctionsFetchError', message: 'Failed to fetch' }, null)).resolves.toBeNull()
    const res = { json: async () => { throw new SyntaxError('Unexpected token') } }
    await expect(readEdgeBody({ context: res }, null)).resolves.toBeNull()
  })

  it('keeps the three ready-worded codes and not the delete one', () => {
    expect([...READY_REFUSAL_CODES].sort()).toEqual(['staff_login_is_till', 'staff_login_settlement_blocked', 'staff_unblock_leaver'])
    expect(READY_REFUSAL_CODES.has(HAS_RECORDS_CODE)).toBe(false)
  })
})
