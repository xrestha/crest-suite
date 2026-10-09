/**
 * `client_access_open(client)` (SQL, S809 slice 1h) is the database's copy of
 * `getAccessState(client).locked === false`. The guest QR menu and the public booking page never
 * pass through ProtectedRoute, so the server has to answer "may this outlet trade?" for them, and
 * the server cannot import this module. Two copies of one rule drift unless a test reads both
 * (`.claude/rules/supabase-sql.md`, the ITEM_REF_TABLES lesson), so this one does.
 *
 * Read from the LATEST migration that defines each function, so a later rebuild is what is checked.
 */
import fs from 'fs'
import path from 'path'
import { getAccessState, GRACE_DAYS } from './subscription'

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'supabase', 'migrations')
const DAY = 86400000

const definesRe = fn => new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`, 'i')

function latestDefining(fn) {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
  const hits = files.filter(f => definesRe(fn).test(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')))
  if (hits.length === 0) throw new Error(`no migration defines public.${fn}`)
  return fs.readFileSync(path.join(MIGRATIONS_DIR, hits[hits.length - 1]), 'utf8')
}

// One function's definition with its `--` comments stripped: a comment naming a column or a gate
// is not the column or the gate.
function definition(fn) {
  const sql = latestDefining(fn)
  const rest = sql.slice(sql.search(definesRe(fn)))
  return rest.slice(0, rest.search(/\$(fn|function)\$;/)).replace(/--[^\n]*/g, '')
}

// The end dates getAccessState weighs, read from its own source rather than restated here.
function jsEndDateColumns() {
  const src = fs.readFileSync(path.join(__dirname, 'subscription.js'), 'utf8')
  const fn = src.slice(src.indexOf('export function getAccessState'), src.indexOf('export function suiteLive'))
  return [...new Set([...fn.matchAll(/client\.(\w+_ends_at)/g)].map(m => m[1]))].sort()
}

describe('client_access_open mirrors getAccessState', () => {
  const helper = definition('client_access_open')

  it('weighs exactly the end dates getAccessState weighs', () => {
    const sqlCols = [...new Set([...helper.matchAll(/c\.(\w+_ends_at)/g)].map(m => m[1]))].sort()
    // Guards the parsers: a regex that matched nothing would make the comparison pass vacuously.
    expect(jsEndDateColumns().length).toBeGreaterThanOrEqual(6)
    expect(sqlCols).toEqual(jsEndDateColumns())
  })

  it('gives the same grace week', () => {
    const m = helper.match(/>=\s*-(\d+)/)
    expect(m).not.toBeNull()
    expect(Number(m[1])).toBe(GRACE_DAYS)
  })

  it('checks every lock before the no-dates-means-open rule', () => {
    const openOnNoDates = helper.indexOf('last_end IS NULL THEN true')
    expect(openOnNoDates).toBeGreaterThan(0)
    for (const lock of ['is_active IS FALSE', 'trial_approved_at IS NULL', 'trial_expires_at < now()']) {
      const at = helper.indexOf(lock)
      expect(at).toBeGreaterThan(0)
      expect(at).toBeLessThan(openOnNoDates)
    }
  })

  it('is not SECURITY DEFINER, and no client role is ever granted it', () => {
    expect(helper).not.toMatch(/SECURITY DEFINER/i)
    expect(latestDefining('client_access_open'))
      .toMatch(/REVOKE ALL ON FUNCTION public\.client_access_open\(uuid\) FROM PUBLIC, anon, authenticated;/)
    for (const f of fs.readdirSync(MIGRATIONS_DIR).filter(x => x.endsWith('.sql'))) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8').replace(/--[^\n]*/g, '')
      // Word-bounded: the probe's own `v_grants` variable is not a GRANT.
      expect(sql).not.toMatch(/\bGRANT\b[^;]*client_access_open[^;]*\bTO\b[^;]*\b(anon|authenticated|PUBLIC)\b/i)
    }
  })
})

// The SQL probe in 20261009140000 asserts these same instants against the database. Pinning the
// browser to them too means both sides agree on the edge, not only on the easy middle.
describe('getAccessState at the edges the SQL probe uses', () => {
  const ago = ms => new Date(Date.now() - ms).toISOString()

  it.each(jsEndDateColumns())('%s: 7 days 23 hours past is still open (grace)', col => {
    const s = getAccessState({ [col]: ago(7 * DAY + 23 * 3600000) })
    expect(s.locked).toBe(false)
    expect(s.reason).toBe('grace')
  })

  it.each(jsEndDateColumns())('%s: 8 days and a minute past is locked', col => {
    const s = getAccessState({ [col]: ago(8 * DAY + 60000) })
    expect(s).toMatchObject({ locked: true, reason: 'expired' })
  })

  it('the farthest end date wins', () => {
    expect(getAccessState({ ims_ends_at: ago(60 * DAY), suite_ends_at: ago(-10 * DAY) }).locked).toBe(false)
  })

  it('a pending signup is locked even with its provisional expiry still ahead', () => {
    expect(getAccessState({ is_trial: true, trial_approved_at: null, trial_expires_at: ago(-5 * DAY) }))
      .toMatchObject({ locked: true, reason: 'pending' })
  })

  it('a NULL is_active is not a deactivation, and no dates at all is open', () => {
    expect(getAccessState({ is_active: null }).locked).toBe(false)
  })
})

// Guest QR Ordering's only module gate is pos_enabled (CLAUDE.md), and the access gate sits beside
// it, never instead of it. A rebuild of any of these from an older file would drop one silently.
describe('every public guest-menu and booking function keeps both gates', () => {
  it.each([
    'get_guest_menu', 'get_guest_menu_options', 'submit_guest_order', 'get_guest_order_progress',
    'get_guest_table_status', 'get_booking_page', 'get_booking_availability', 'submit_reservation_request',
  ])('%s', fn => {
    const def = definition(fn)
    expect(def).toMatch(/pos_enabled/)
    expect(def).toMatch(/COALESCE\(public\.client_access_open\([^)]*\), false\)/)
    expect(def).toMatch(/SECURITY DEFINER/i)
  })
})
