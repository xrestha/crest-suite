// Brings the Bloom demo up to "now": rebuilds the whole history with a later cut-off, compares it
// with the snapshot of what is already loaded, and writes only the differences as SQL (new rows,
// and changed columns of existing rows — an open table that has since paid, a supplier bill paid
// since, a shift now closed). Run apply.mjs on the output, then promote the new snapshot.
//   node --import ./register.mjs topup.mjs --prev <loaded state.json> --profiles <profiles.json> --out <dir> [--until AD --until-min M]
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { insertSql, lit, raw, nepalNowParts } from './lib.mjs'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const now = nepalNowParts()
const until = arg('--until', now.adDate)
const untilMin = arg('--until-min', String(now.minutes - 10))
const prevFile = arg('--prev')
const outDir = arg('--out', 'topup-out')
const profiles = arg('--profiles')
if (!prevFile || !fs.existsSync(prevFile)) { console.error('--prev <state.json of what is loaded> is required'); process.exit(1) }

// 1. A full build at the new cut-off, into a scratch folder.
const buildDir = path.join(outDir, 'build')
fs.mkdirSync(buildDir, { recursive: true })
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const b = spawnSync(process.execPath, ['--no-warnings', '--import', './register.mjs', 'build.mjs', '--out', buildDir, '--until', until, '--until-min', untilMin, '--profiles', profiles],
  { cwd: here, encoding: 'utf8', maxBuffer: 1 << 28 })
if (b.status !== 0) { console.error('build failed\n' + (b.stderr || b.stdout).slice(0, 4000)); process.exit(1) }

const prev = JSON.parse(fs.readFileSync(prevFile, 'utf8')).state
const next = JSON.parse(fs.readFileSync(path.join(buildDir, 'state.json'), 'utf8')).state

// 2. Table order: parents before children (data-export's RESTORE_ORDER, trimmed to what the demo writes).
const ORDER = ['categories', 'vendors', 'items', 'recipes', 'recipe_ingredients', 'pos_option_groups', 'pos_options',
  'pos_option_ingredients', 'pos_recipe_option_groups', 'monthly_periods', 'assets_categories', 'assets_register', 'overheads',
  'par_levels', 'purchase_orders', 'purchase_order_items', 'purchase_entries', 'payable_payments', 'vendor_returns',
  'opening_stock', 'closing_stock', 'wastages', 'staff_meals', 'budgets', 'hr_shift_types', 'hr_holiday_calendar',
  'hr_leave_types', 'hr_employees', 'hr_salary_components', 'hr_roster', 'hr_roster_publish_state', 'hr_shift_swap_requests',
  'hr_advances', 'hr_overtime_entries', 'hr_leave_requests', 'hr_attendance', 'hr_payroll_runs', 'hr_payslips',
  'hr_advance_repayments', 'hr_salary_payments', 'hr_tada_claims', 'hr_tada_claim_items', 'pos_tables', 'pos_loyalty_schemes',
  'pos_customers', 'pos_shifts', 'pos_orders', 'pos_order_items', 'pos_order_item_options', 'pos_order_payments', 'pos_kot_log',
  'pos_kot_removals', 'pos_loyalty_ledger', 'pos_reservations', 'pos_reservation_tables', 'pos_credit_notes',
  'pos_cash_movements', 'sales_entries', 'stock_movements']
const unknown = Object.keys(next).filter(t => !ORDER.includes(t))
if (unknown.length) { console.error('tables with no place in ORDER: ' + unknown.join(', ')); process.exit(1) }

const val = v => (v && typeof v === 'object' && v.$raw ? raw(v.$raw) : v)
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

const updates = [], inserts = []
const counts = {}
for (const t of ORDER) {
  const P = prev[t] || {}, N = next[t] || {}
  const added = []
  for (const [id, row] of Object.entries(N)) {
    const old = P[id]
    if (!old) { added.push(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, val(v)]))); continue }
    const changed = Object.keys(row).filter(k => !same(row[k], old[k]))
    if (changed.length) updates.push(`UPDATE public.${t} SET ${changed.map(k => `${k} = ${lit(val(row[k]))}`).join(', ')} WHERE id = '${id}';`)
  }
  const gone = Object.keys(P).filter(id => !N[id]).length
  if (gone) console.warn(`warning: ${gone} ${t} rows are in the loaded snapshot but not in the new build (left as they are)`)
  if (added.length) inserts.push([t, added])
  counts[t] = { added: added.length, changed: updates.filter(u => u.startsWith(`UPDATE public.${t} `)).length }
}

// 3. Files of about 800 KB. Updates first (an ended month must close before the next one opens),
// then inserts in table order. A bill's till sales go in one statement, so sales_entries chunks
// break only between bills.
fs.mkdirSync(outDir, { recursive: true })
for (const f of fs.readdirSync(outDir)) if (f.endsWith('.sql')) fs.unlinkSync(path.join(outDir, f))
const files = []
let buf = '', n = 0
const flush = () => { if (!buf.trim()) return; n += 1; const f = `topup_${String(n).padStart(3, '0')}.sql`; fs.writeFileSync(path.join(outDir, f), `BEGIN;\n${buf}\nCOMMIT;\n`); files.push(f); buf = '' }
const add = sql => { if (buf.length + sql.length > 800000) flush(); buf += sql + '\n' }
for (const u of updates) add(u)
for (const [t, rows] of inserts) {
  let groups
  if (t === 'sales_entries') {
    const byBill = new Map()
    for (const r of rows) { const k = r.pos_order_id || r.id; if (!byBill.has(k)) byBill.set(k, []); byBill.get(k).push(r) }
    groups = [...byBill.values()]
  } else groups = rows.map(r => [r])
  let chunk = []
  let size = 0
  for (const g of groups) {
    chunk.push(...g); size += g.length
    if (size >= 1500) { add(insertSql(t, chunk)); chunk = []; size = 0 }
  }
  if (chunk.length) add(insertSql(t, chunk))
}
flush()
fs.copyFileSync(path.join(buildDir, 'state.json'), path.join(outDir, 'next-state.json'))
fs.copyFileSync(path.join(buildDir, 'report.json'), path.join(outDir, 'report.json'))
const summary = Object.fromEntries(Object.entries(counts).filter(([, c]) => c.added || c.changed))
console.log(JSON.stringify({ until, untilMin, files, summary }, null, 1))
