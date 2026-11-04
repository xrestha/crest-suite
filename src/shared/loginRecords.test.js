/**
 * A login that has recorded anything is blocked, never deleted: a till login since S809 (ACCESS-5,
 * owner decision Q17 a), an IMS or HR login since S875 (D36, owner decision 2026-11-04). Deleting it
 * set every bill, shift, count, gate pass, leave decision and payment it recorded to "no one". Which
 * rows count is the database's: login_reference_columns() reads every foreign key to a login that
 * does not go with it (anything but ON DELETE CASCADE), plus the columns that hold a login's id with
 * no key. admin-user-ops only words them, in LOGIN_RECORD_WORDS, for the sentence that refuses the
 * Delete and offers Block.
 *
 * So the words must cover every such key. A new one without words is still counted and still
 * refuses the Delete (it reads "other entries"); this test makes it get its own words, and makes a
 * key that goes away take its words with it.
 */
import fs from 'fs'
import path from 'path'
import { foreignKeysFromMigrations, stripComments, MIGRATIONS_DIR } from './migrationForeignKeys'

const FUNCTION_FILE = path.join(MIGRATIONS_DIR, '..', 'functions', 'admin-user-ops', 'index.ts')
const fn = fs.readFileSync(FUNCTION_FILE, 'utf8')

// LOGIN_RECORD_WORDS' entries, read as text (Deno, not importable here). The object ends at the first
// line that is only `}`; the values contain `{n}`, so the first brace is not the end.
const WORDS = (() => {
  const at = fn.indexOf('const LOGIN_RECORD_WORDS')
  const body = fn.slice(at, fn.indexOf('\n}\n', at))
  return [...body.matchAll(/'([a-z_]+\.[a-z_]+)':\s*\['([^']*)',\s*'([^']*)'\]/g)]
    .map(([, key, one, many]) => ({ key, one, many }))
})()

// The key-less columns login_reference_columns() adds, from its last definition. The pos_ name is a
// call to it since S875, so only the module-free name carries the VALUES list.
const KEYLESS = (() => {
  let last = []
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()) {
    const sql = stripComments(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'))
    const at = sql.search(/FUNCTION public\.login_reference_columns\(\)/)
    if (at < 0) continue
    const body = sql.slice(at, sql.indexOf('$function$', sql.indexOf('$function$', at) + 1))
    const values = body.slice(body.search(/\bVALUES\b/))
    last = [...values.matchAll(/\('([a-z_]+)',\s*'([a-z_]+)'\)/g)].map(([, t, c]) => `${t}.${c}`)
  }
  return last
})()

// Every single-column key from a public table to a login, that a delete would empty.
const LOGIN_KEYS = foreignKeysFromMigrations(MIGRATIONS_DIR)
  .filter(f => (f.parent === 'profiles' || f.parent === 'users') && f.cols.length === 1 && f.onDelete !== 'CASCADE')
  .map(f => `${f.table}.${f.cols[0]}`)

describe('LOGIN_RECORD_WORDS', () => {
  it('is read at all, and the migrations hold keys to a login in every module', () => {
    expect(WORDS.length).toBeGreaterThanOrEqual(60)
    expect(LOGIN_KEYS).toEqual(expect.arrayContaining([
      'pos_orders.closed_by', 'pos_shifts.opened_by', 'pos_kot_log.sent_by',
      'closing_stock.counted_by', 'requisitions.requested_by', 'ims_gate_passes.issued_by',
      'hr_salary_payments.paid_by', 'hr_tada_claims.approved_by', 'profiles.staff_blocked_by',
    ]))
    expect(KEYLESS.sort()).toEqual([
      'demand_forecast_run_log.run_by', 'hr_advances.written_off_by', 'hr_final_settlements.reopened_by',
      'hr_leave_requests.decided_by', 'ims_stock_transfer_lines.created_by', 'ims_stock_transfers.ended_by',
      'ims_stock_transfers.sent_by', 'pos_order_items.comped_by', 'pos_orders.opened_by',
    ])
  })

  it('words every column that keeps a login\'s name', () => {
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

describe('the restore of a blocked login', () => {
  it('exports both block marks with the roster, so restore_staff_accounts can block a login again', () => {
    const exp = fs.readFileSync(path.join(__dirname, '..', 'modules', 'admin', 'dataExport', 'exportClientData.js'), 'utf8')
    expect(exp).toMatch(/settlement_blocked_by, pos_blocked_at, staff_blocked_at/)
    expect(fn).toMatch(/p\.pos_blocked_at \? \{ pos_blocked_at: p\.pos_blocked_at \}/)
    expect(fn).toMatch(/p\.staff_blocked_at \? \{ staff_blocked_at: p\.staff_blocked_at \}/)
  })
})

describe('the IMS and HR deletes', () => {
  it('ask the database what the login recorded before deleting it', () => {
    for (const action of ['delete_ims_staff', 'delete_hr_staff', 'delete_pos_staff']) {
      const at = fn.indexOf(`if (action === '${action}')`)
      const body = fn.slice(at, fn.indexOf('deleteUser(userId)', at))
      expect(body).toMatch(/staffRecordsRefusal|login_recorded_rows/)
    }
  })
})
