import fs from 'fs'
import path from 'path'
import { trailParts, personLabel, statusMeta, whenLabel } from './requisitionTrail'

// 2026-09-15T08:30:00Z is 14:15 in Kathmandu (+05:45).
const TS = '2026-09-15T08:30:00Z'
const names = { u1: 'Ram Thapa', u2: 'Sita Gurung' }

describe('requisitionTrail (S756, D14)', () => {
  test('rejected wears the neutral chip, never red or amber', () => {
    expect(statusMeta('rejected').badge).toBe('badge-gray')
    expect(statusMeta('issued').badge).toBe('badge-green')
    expect(statusMeta('draft').badge).toBe('badge-amber')
    // An unknown or NULL status (the column is nullable) reads as the draft it defaults to.
    expect(statusMeta(null).label).toBe('Draft')
  })

  test('times are pinned to Nepal, 24-hour only when asked for (spreadsheet cells)', () => {
    expect(whenLabel(TS)).toMatch(/02:15 PM$/)
    expect(whenLabel(TS, { clock: '24' })).toMatch(/14:15$/)
    expect(whenLabel(null)).toBe('')
  })

  test('a failed names read is not "someone from outside"', () => {
    expect(personLabel('u9', names, true)).toBe('name could not be loaded')
    expect(personLabel('u9', names, false)).toBe('a login from outside this outlet')
    expect(personLabel(null, names, false)).toBeNull()
  })

  test('an issued slip names who raised and who issued, with the Nepal time', () => {
    const parts = trailParts(
      { status: 'issued', requested_by: 'u1', created_at: TS, issued_by: 'u2', issued_at: TS },
      { names }
    )
    expect(parts.map(p => p.key)).toEqual(['raised', 'issued'])
    expect(parts[0].text).toMatch(/^Raised by Ram Thapa · .*02:15 PM$/)
    expect(parts[1].text).toMatch(/^Issued by Sita Gurung at .*02:15 PM$/)
  })

  test('a slip from before S756 says it was not recorded, rather than omitting the line', () => {
    const parts = trailParts({ status: 'issued', created_at: TS }, { names })
    expect(parts[0].text).toBe('Raised before who-raised-it was recorded')
    expect(parts[1].text).toBe('Issued before who-issued-it was recorded')
  })

  test('a draft has no issued line; a rejected slip names who rejected it', () => {
    expect(trailParts({ status: 'draft', requested_by: 'u1', created_at: TS }, { names }).map(p => p.key)).toEqual(['raised'])
    const rej = trailParts({ status: 'rejected', requested_by: 'u1', created_at: TS, rejected_by: 'u2', rejected_at: TS }, { names })
    expect(rej.map(p => p.key)).toEqual(['raised', 'rejected'])
    expect(rej[1].text).toMatch(/^Rejected by Sita Gurung at /)
  })
})

// The attribution columns must never be chosen by the browser for a client login. The page may
// send them (an operator session keeps what it supplies), but the migration must overwrite them —
// assert the migration still does, and that the guard stays INVOKER.
describe('20260918140000 migration', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '../../../../supabase/migrations/20260918140000_ims_requisitions_s756.sql'), 'utf8'
  ).replace(/--[^\n]*/g, '')

  test('stamps attribution from the session for client logins', () => {
    expect(sql).toMatch(/NEW\.requested_by\s*:=\s*v_uid/)
    expect(sql).toMatch(/NEW\.issued_by\s*:=\s*v_uid/)
    expect(sql).toMatch(/NEW\.rejected_by\s*:=\s*v_uid/)
    expect(sql).toMatch(/NEW\.requested_by\s*:=\s*OLD\.requested_by/)
  })

  test('neither requisition guard is SECURITY DEFINER', () => {
    const bodies = sql.match(/CREATE OR REPLACE FUNCTION public\.ims_requisition_(rank_guard|attribution)\(\)[\s\S]*?\$\$;/g)
    expect(bodies).toHaveLength(2)
    bodies.forEach(b => expect(b).not.toMatch(/SECURITY DEFINER/i))
  })

  test('a line insert onto an issued slip below supervisor is tied to the issuer and a short window', () => {
    expect(sql).toMatch(/v_slip\.issued_by = \(select auth\.uid\(\)\)/)
    expect(sql).toMatch(/v_slip\.issued_at > now\(\) - interval '5 minutes'/)
  })
})
