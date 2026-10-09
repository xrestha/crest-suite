/**
 * A till login that has recorded anything is blocked, never deleted (S809 ACCESS-5, owner decision
 * Q17 a): deleting it set every bill, shift, cash entry, kitchen ticket and credit note it recorded
 * to "no one". Which rows count is the database's: pos_login_reference_columns() reads every
 * foreign key to a login that does not go with it (anything but ON DELETE CASCADE), plus the two
 * columns that hold a login's id with no key. admin-user-ops only words them, in POS_RECORD_WORDS,
 * for the sentence that refuses the Delete and offers Block.
 *
 * So the words must cover every such key on a till table. A new one without words is still counted
 * and still refuses the Delete (it reads "other entries"); this test makes it get its own words, and
 * makes a key that goes away take its words with it.
 */
import fs from 'fs'
import path from 'path'
import { foreignKeysFromMigrations, stripComments, MIGRATIONS_DIR } from '../../../shared/migrationForeignKeys'

const FUNCTION_FILE = path.join(MIGRATIONS_DIR, '..', 'functions', 'admin-user-ops', 'index.ts')
const fn = fs.readFileSync(FUNCTION_FILE, 'utf8')

// POS_RECORD_WORDS' entries, read as text (Deno, not importable here). The object ends at the first
// line that is only `}`; the values contain `{n}`, so the first brace is not the end.
const WORDS = (() => {
  const at = fn.indexOf('const POS_RECORD_WORDS')
  const body = fn.slice(at, fn.indexOf('\n}\n', at))
  return [...body.matchAll(/'([a-z_]+\.[a-z_]+)':\s*\['([^']*)',\s*'([^']*)'\]/g)]
    .map(([, key, one, many]) => ({ key, one, many }))
})()

// The key-less columns pos_login_reference_columns() adds, from its last definition.
const KEYLESS = (() => {
  let last = []
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()) {
    const sql = stripComments(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'))
    const at = sql.search(/FUNCTION public\.pos_login_reference_columns\(\)/)
    if (at < 0) continue
    const body = sql.slice(at, sql.indexOf('$function$', sql.indexOf('$function$', at) + 1))
    const values = body.slice(body.search(/\bVALUES\b/))
    last = [...values.matchAll(/\('([a-z_]+)',\s*'([a-z_]+)'\)/g)].map(([, t, c]) => `${t}.${c}`)
  }
  return last
})()

// Every single-column key from a till table (or profiles itself) to a login, that a delete would empty.
const LOGIN_KEYS = foreignKeysFromMigrations(MIGRATIONS_DIR)
  .filter(f => (f.parent === 'profiles' || f.parent === 'users') && f.cols.length === 1 && f.onDelete !== 'CASCADE')
  .filter(f => f.table.startsWith('pos_') || f.table === 'profiles')
  .map(f => `${f.table}.${f.cols[0]}`)

describe('POS_RECORD_WORDS', () => {
  it('is read at all, and the migrations hold till keys to a login', () => {
    expect(WORDS.length).toBeGreaterThanOrEqual(18)
    expect(LOGIN_KEYS).toEqual(expect.arrayContaining(['pos_orders.closed_by', 'pos_shifts.opened_by', 'pos_kot_log.sent_by']))
    expect(KEYLESS.sort()).toEqual(['pos_order_items.comped_by', 'pos_orders.opened_by'])
  })

  it('words every till column that keeps a login\'s name', () => {
    const worded = new Set(WORDS.map(w => w.key))
    expect(LOGIN_KEYS.filter(k => !worded.has(k))).toEqual([])
    expect(KEYLESS.filter(k => !worded.has(k))).toEqual([])
  })

  it('words nothing the database no longer counts', () => {
    expect(WORDS.map(w => w.key).filter(k => !LOGIN_KEYS.includes(k) && !KEYLESS.includes(k))).toEqual([])
  })

  it('has a "1" form and a counted form for each', () => {
    for (const w of WORDS) {
      expect(w.one).toMatch(/\b1\b/)
      expect(w.many).toContain('{n}')
    }
  })
})

describe('the restore of a blocked till login', () => {
  it('exports pos_blocked_at with the roster, so restore_staff_accounts can block it again', () => {
    const exp = fs.readFileSync(path.join(__dirname, '..', '..', 'admin', 'dataExport', 'exportClientData.js'), 'utf8')
    expect(exp).toMatch(/settlement_blocked_by, pos_blocked_at/)
    expect(fn).toMatch(/p\.pos_blocked_at \? \{ pos_blocked_at: p\.pos_blocked_at \}/)
  })
})
