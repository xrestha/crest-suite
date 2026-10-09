// One-step top-up of the Bloom demo to "now" (Nepal time).
//   node --no-warnings --import ./register.mjs topup-all.mjs            → builds and shows what would change
//   node --no-warnings --import ./register.mjs topup-all.mjs --apply    → also writes it to the LIVE database
// Keeps its memory in ~/.claude/demo-bloom/: loaded-state.json (what is loaded), profiles.json (the till
// logins) and audit-marker.txt (the last activity-log id before this top-up's own system entries).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { nepalNowParts } from './lib.mjs'

const HOME = path.join(os.homedir(), '.claude', 'demo-bloom')
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const apply = process.argv.includes('--apply')
const now = nepalNowParts()
const out = path.join(os.tmpdir(), `bloom-topup-${now.adDate}-${now.minutes}`)
const CLI = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm/node_modules/supabase/dist/supabase.js')
const KTM = 'a4bd5cba-4955-4309-819e-646834c05c7e', PKR = 'ef7e5196-e1dc-4f9d-a259-6d994f0b1932'

const run = (args, opts = {}) => spawnSync(process.execPath, args, { cwd: here, encoding: 'utf8', maxBuffer: 1 << 28, ...opts })
const sql = q => {
  const r = spawnSync(process.execPath, [CLI, 'db', 'query', '--linked', '--agent', 'no', '-o', 'json', q], { cwd: 'C:/crest-suite', encoding: 'utf8', maxBuffer: 1 << 26 })
  const text = (r.stdout || '').split('\n').filter(l => !l.startsWith('Initialising')).join('\n')
  if (r.status !== 0 || /"_tag":"Error"/.test(text)) throw new Error('query failed: ' + (text || r.stderr).slice(0, 2000))
  const j = JSON.parse(text); return j.rows || j
}

const t = run(['--no-warnings', '--import', './register.mjs', 'topup.mjs', '--prev', path.join(HOME, 'loaded-state.json'),
  '--profiles', path.join(HOME, 'profiles.json'), '--out', out, '--until', now.adDate, '--until-min', String(now.minutes - 10)])
if (t.status !== 0) { console.error(t.stderr || t.stdout); process.exit(1) }
const summary = JSON.parse(t.stdout.slice(t.stdout.indexOf('{')))
console.log(`Top-up to ${now.adDate}, ${Math.floor((now.minutes - 10) / 60)}:${String((now.minutes - 10) % 60).padStart(2, '0')} Nepal time — ${summary.files.length} file(s)`)
for (const [k, v] of Object.entries(summary.summary)) console.log(`  ${k}: +${v.added} new, ${v.changed} changed`)
const prev = JSON.parse(fs.readFileSync(path.join(HOME, 'loaded-state.json'), 'utf8')).state
const next = JSON.parse(fs.readFileSync(path.join(out, 'next-state.json'), 'utf8')).state
const newlyClosed = Object.values(next.monthly_periods || {}).filter(p => p.status === 'closed' && prev.monthly_periods?.[p.id]?.status === 'open')
if (!apply) { console.log(`\nNothing written. Re-run with --apply to load it. (Files: ${out})`); process.exit(0) }

const a = run([path.join(here, 'apply.mjs'), '--out', out])
process.stdout.write(a.stdout || '')
if (a.status !== 0) { console.error(a.stderr || a.stdout); console.error('STOPPED: nothing after the failed file was loaded; loaded-state.json is unchanged.'); process.exit(1) }
fs.copyFileSync(path.join(out, 'next-state.json'), path.join(HOME, 'loaded-state.json'))

// The seeding's own activity-log entries (no user attached) go; anything a person did stays.
const marker = Number(fs.readFileSync(path.join(HOME, 'audit-marker.txt'), 'utf8').trim())
sql(`delete from audit_logs where id > ${marker} and user_id is null and client_id in ('${KTM}','${PKR}')`)
const [{ max }] = sql('select max(id) from audit_logs')
fs.writeFileSync(path.join(HOME, 'audit-marker.txt'), String(max))
const [check] = sql(`select (select count(*) from pos_orders where client_id in ('${KTM}','${PKR}') and status='billed' and ims_posted_at is null) unposted,
  (select count(*) from pos_shifts where client_id in ('${KTM}','${PKR}') and status='open') open_shifts`)
console.log(`Loaded. Bills not in Inventory: ${check.unposted} (should be 0). Open shifts: ${check.open_shifts} (should be 2).`)
if (newlyClosed.length) {
  console.log('\nA month ended. Open the Owner Report once as the Owner at EACH branch (main café, then switch to Pokhara),')
  console.log('so the app makes that month\'s report. The page opens on the newest closed month.')
}
