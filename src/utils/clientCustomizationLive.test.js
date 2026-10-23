/**
 * public.customization_live(uuid) (S862, migration 20261023130000 §1) is the database's copy of
 * customizationState(client).live in subscription.js: the one answer to "does this outlet have Crest
 * Customization right now". The till's save, the option and combo guards and the guest menu all ask
 * it, so a rule change on one side must change the other in the same commit (clientSuiteLive.test.js
 * does the same for Suite), read from the migrations rather than restated here.
 */
import fs from 'fs'
import path from 'path'
import { customizationState, getCustomizationDateStatus, GRACE_DAYS } from './subscription'

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

const src = fs.readFileSync(path.join(__dirname, 'subscription.js'), 'utf8')

describe('customization_live mirrors customizationState(client).live', () => {
  const { header, body } = definition('customization_live')

  it('needs both POS and the flag', () => {
    expect(body).toMatch(/NOT COALESCE\(c\.customization_enabled AND c\.pos_enabled, false\) THEN false/)
    expect(src).toMatch(/subscribed = !!client\?\.pos_enabled && !!client\?\.customization_enabled/)
  })

  it('reads its own end date only, with no fallback', () => {
    expect(body).toMatch(/c\.customization_ends_at IS NULL THEN true/)
    expect(body).toMatch(/extract\(epoch FROM \(c\.customization_ends_at - now\(\)\)\)/)
    expect(src).toMatch(/endsAt = client\?\.customization_ends_at \|\| null/)
  })

  it('opens with no date, and gives the same grace week', () => {
    const m = body.match(/>=\s*-(\d+)/)
    expect(m).not.toBeNull()
    expect(Number(m[1])).toBe(GRACE_DAYS)
    expect(body).toMatch(/ceil\(/)
  })

  it('an unknown or unreadable outlet is false, and it runs with the caller rights', () => {
    expect(body).toMatch(/COALESCE\(\(/)
    expect(body).toMatch(/\), false\);?\s*$/)
    expect(header).toMatch(/SECURITY INVOKER/i)
    expect(header).not.toMatch(/SECURITY DEFINER/i)
  })

  // The browser side at the same edges.
  it('customizationState agrees at the grace edges', () => {
    const ago = d => new Date(Date.now() - d).toISOString()
    const on = { pos_enabled: true, customization_enabled: true }
    expect(customizationState({ ...on, customization_ends_at: ago(7 * DAY + 3600000) }).live).toBe(true)
    expect(customizationState({ ...on, customization_ends_at: ago(8 * DAY + 60000) }).live).toBe(false)
    expect(customizationState({ ...on, customization_ends_at: ago(8 * DAY + 60000) }).lapsed).toBe(true)
    expect(customizationState({ ...on, pos_enabled: false }).live).toBe(false)
    expect(customizationState(on).live).toBe(true)
    expect(customizationState(on).noDate).toBe(true)
    expect(customizationState(null).live).toBe(false)
  })

  it('bills only while its own date is ahead and POS is paid, never on the demo outlet', () => {
    const ahead = d => new Date(Date.now() + d).toISOString()
    const ago = d => new Date(Date.now() - d).toISOString()
    const paid = { pos_enabled: true, customization_enabled: true, pos_ends_at: ahead(90 * DAY), customization_ends_at: ahead(30 * DAY) }
    expect(customizationState(paid).billed).toBe(true)
    expect(customizationState({ ...paid, is_internal: true }).billed).toBe(false)
    expect(customizationState({ ...paid, customization_ends_at: null }).billed).toBe(false)
    expect(customizationState({ ...paid, pos_ends_at: ago(DAY) }).billed).toBe(false)
    const grace = customizationState({ ...paid, customization_ends_at: ago(2 * DAY) })
    expect(grace.inGrace).toBe(true)
    expect(grace.billed).toBe(false)
  })
})

describe('getCustomizationDateStatus (the drawer chip)', () => {
  const ago = d => new Date(Date.now() - d).toISOString()
  const ahead = d => new Date(Date.now() + d).toISOString()
  it('names no date, the grace week and a lapse, and counts days otherwise', () => {
    expect(getCustomizationDateStatus('').label).toBe('No end date · not billed')
    expect(getCustomizationDateStatus(ago(2 * DAY)).label).toMatch(/^Grace · \d+d left$/)
    expect(getCustomizationDateStatus(ago(9 * DAY)).label).toBe('Lapsed · choices off')
    expect(getCustomizationDateStatus(ahead(10 * DAY)).label).toMatch(/d left$/)
  })
})
