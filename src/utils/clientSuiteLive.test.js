/**
 * public.client_suite_live(uuid) (S849, migration 20261019100000 §2) is the database's copy of
 * suiteState(client).live in subscription.js: the one answer to "does this outlet have Crest Suite
 * Pro right now". The group roll-ups count an outlet only when it is true, so a rule change on one
 * side must change the other in the same commit — the clientAccessOpen.test.js technique, read from
 * the migrations rather than restated here.
 */
import fs from 'fs'
import path from 'path'
import { suiteState, GRACE_DAYS } from './subscription'

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'supabase', 'migrations')
const DAY = 86400000

const definesRe = fn => new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fn}\\(`, 'gi')
const stripComments = sql => sql.replace(/--[^\n]*/g, '')

// The body of the LAST definition of `fn` across the migrations, comments stripped.
function definition(fn) {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
  let last = null
  for (const f of files) {
    const sql = stripComments(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'))
    const re = definesRe(fn)
    let m
    while ((m = re.exec(sql))) {
      const rest = sql.slice(m.index)
      const tag = rest.match(/\bAS\s+(\$\w*\$)/)
      if (!tag) continue
      const start = rest.indexOf(tag[1], tag.index) + tag[1].length
      const end = rest.indexOf(tag[1], start)
      last = { file: f, header: rest.slice(0, tag.index), body: rest.slice(start, end) }
    }
  }
  if (!last) throw new Error(`no migration defines public.${fn}`)
  return last
}

describe('client_suite_live mirrors suiteState(client).live', () => {
  const { header, body } = definition('client_suite_live')

  it("is 'pro' only, with the IMS floor", () => {
    expect(body).toMatch(/suite_plan IS DISTINCT FROM 'pro' THEN false/)
    expect(body).toMatch(/ims_enabled IS FALSE THEN false/)
    // The JS side: 'pro' only, IMS floor.
    const src = fs.readFileSync(path.join(__dirname, 'subscription.js'), 'utf8')
    expect(src).toMatch(/subscribed = client\?\.suite_plan === 'pro'/)
    expect(src).toMatch(/imsOn = client\?\.ims_enabled !== false/)
  })

  it('resolves the end date through the same three columns in the same order', () => {
    expect(body).toMatch(/COALESCE\(c\.suite_ends_at, c\.ims_ends_at, c\.subscription_ends_at\)/)
    const src = fs.readFileSync(path.join(__dirname, 'subscription.js'), 'utf8')
    expect(src).toMatch(/endsAt = client\?\.suite_ends_at \|\| client\?\.ims_ends_at \|\| client\?\.subscription_ends_at/)
  })

  it('opens with no date, and gives the same grace week', () => {
    expect(body).toMatch(/suite_end IS NULL THEN true/)
    const m = body.match(/>=\s*-(\d+)/)
    expect(m).not.toBeNull()
    expect(Number(m[1])).toBe(GRACE_DAYS)
  })

  it('an unknown outlet is false, and no client role may call it', () => {
    expect(body).toMatch(/COALESCE\(\(/)
    expect(body).toMatch(/\), false\);?\s*$/)
    expect(header).not.toMatch(/SECURITY DEFINER/i)
    const file = fs.readFileSync(path.join(MIGRATIONS_DIR, definition('client_suite_live').file), 'utf8')
    expect(file).toMatch(/REVOKE ALL ON FUNCTION public\.client_suite_live\(uuid\) FROM PUBLIC, anon, authenticated;/)
  })

  // The browser side at the same edges.
  it('suiteState agrees at the grace edges', () => {
    const ago = d => new Date(Date.now() - d).toISOString()
    expect(suiteState({ suite_plan: 'pro', suite_ends_at: ago(7 * DAY + 3600000) }).live).toBe(true)
    expect(suiteState({ suite_plan: 'pro', suite_ends_at: ago(8 * DAY + 60000) }).live).toBe(false)
    expect(suiteState({ suite_plan: 'pro', ims_enabled: false }).live).toBe(false)
    expect(suiteState({ suite_plan: 'pro' }).live).toBe(true)
  })
})

describe('every group read that counts Suite outlets asks client_suite_live', () => {
  it.each(['get_group_summary', 'get_group_item_prices', 'get_group_pnl', 'get_group_labour_inputs'])('%s', fn => {
    const { body } = definition(fn)
    expect(body).toMatch(/COALESCE\(\s*public\.client_suite_live\(/)
    // Never a bare plan test of its own, which would skip the date and the IMS floor.
    expect(body).not.toMatch(/suite_plan\s*=\s*'pro'/)
  })
})
