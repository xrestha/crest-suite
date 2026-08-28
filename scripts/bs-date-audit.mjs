// Audits — and optionally repairs — dates that were STORED through a BS→AD converter that was
// wrong at the time of entry.
//
// WHY THIS EXISTS
// ---------------
// BsCalendarPicker does not store what the user picked. Line 148 of the component is
// `onChange(formatAd(bsToAd(navYear, navMonth, day)))` — the user selects a BS date and an AD
// date string is written to the database. That is fine while the converter is right, and
// permanent when it is not: fixing the table later corrects every DISPLAY but cannot correct a
// value already committed. Re-reading such a row with the fixed table shows a different BS date
// than the person chose, and no error is ever raised, because a wrong AD date is still a
// perfectly valid AD date.
//
// The converter has been wrong in two distinct ways, so there are four eras:
//
//   E1  … 2026-07-11 13:54  EPOCH_AD was 2 days off (12 Apr 2022, should be 14 Apr 2022), and
//                           BS 2080/2082/2083 had wrong month lengths.
//   E2  … 2026-07-11 14:44  2083 fixed (4e3a4c1); epoch and 2080/2082 still wrong. ~50 minutes.
//   E3  … 2026-08-15 14:31  Epoch and 2079–2087 correct (060822e), but the table STARTED at 2079
//                           and anything older fell through to a flat 30-day/365-day
//                           approximation that silently returns a plausible wrong date. This is
//                           the date-of-birth case: found live in the sister HSS app, where
//                           30 Dec 1979 round-tripped 5 days out.
//   E4  now                 Table covers 2000–2087 (dfd785b). Correct.
//
// So a transaction date in BS 2079+ is only suspect if it was written before 2026-07-11, while a
// date of birth or a long-tenured join date is suspect right up to 2026-08-15.
//
// HOW THE REPAIR IS DERIVED
// -------------------------
// For a row written in era E holding stored AD date D, the BS date the user actually picked is
// `E.adToBs(D)` — because D was produced by that same era's bsToAd. The correct value is
// therefore `current.bsToAd(E.adToBs(D))`. It depends on nothing but the two algorithms, which is
// why the historical converters are loaded FROM GIT rather than retyped here: a transcription
// slip in the old table would silently produce a confident wrong repair, which is the same class
// of bug this script exists to clean up.
//
// WHAT IT WILL NOT DO
// -------------------
// Applying the transform to an already-correct date CORRUPTS it. A row created before a fix whose
// date was re-picked after it is already correct, and nothing in the row distinguishes that from
// one that was never touched. Where a table has `updated_at` and it postdates the fix, the row is
// reported as NEEDS REVIEW and never auto-repaired. Tables carrying only `created_at`
// (hr_advances, hr_tada_claims, hr_leave_requests, purchase_orders) cannot make that distinction
// at all, so --apply refuses them unless you pass --include-unverifiable, having decided their
// rows are not edited after creation in practice.
//
// Usage (from the project root):
//   node scripts/bs-date-audit.mjs                    # dry run, reports only — no writes
//   node scripts/bs-date-audit.mjs --apply            # repair the rows it can prove are safe
//   node scripts/bs-date-audit.mjs --apply --include-unverifiable
//
// Reads REACT_APP_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local. The service key is
// needed because this crosses every tenant. Its name is deliberately WITHOUT the REACT_APP_ prefix:
// CRA inlines every REACT_APP_* variable into the production bundle, so a prefixed service-role key
// gets published to every visitor on the next `npm run build`. Delete the line when you are done.
// (scripts/backfill-credit-note-reversals.mjs still reads the prefixed name — same hazard.)

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const BS_MONTH_NAMES = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

// ── Historical converters, loaded from git ────────────────────────────────────────────────────
// `<rev>^:path` is the file as it stood immediately BEFORE that fix landed — i.e. the code that
// was writing dates up to that moment.
const ERAS = [
  { id: 'E1', until: '2026-07-11T13:54:36+05:45', rev: '4e3a4c1^', note: 'bad epoch + bad 2080/2082/2083' },
  { id: 'E2', until: '2026-07-11T14:44:45+05:45', rev: '060822e^', note: 'bad epoch + bad 2080/2082' },
  { id: 'E3', until: '2026-08-15T14:31:06+05:45', rev: 'dfd785b^', note: 'pre-2079 fell back to a 30-day approximation' },
]

async function loadEraConverters() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-era-'))
  for (const era of ERAS) {
    const src = execFileSync('git', ['show', era.rev + ':src/utils/bsCalendar.js'], { cwd: ROOT, encoding: 'utf8' })
    const file = path.join(dir, era.id + '.mjs')
    writeFileSync(file, src)
    era.mod = await import('file://' + file.split(path.sep).join('/'))
    era.cutoff = new Date(era.until)
  }
}

const current = await import('file://' + path.join(ROOT, 'src', 'utils', 'bsCalendar.js').split(path.sep).join('/'))

// ── Config ────────────────────────────────────────────────────────────────────────────────────
// `verifiable: false` means the table has no updated_at, so a post-fix edit is indistinguishable
// from an untouched row.
// `labelCols` are columns ON the row that name it; `empCol` is a foreign key resolved to an
// employee name in a second pass. A uuid is not something anyone can check against a personnel
// file, and this script proposes edits to legal records — the report has to say WHOSE date it is
// and at WHICH outlet, or it cannot be confirmed before it is applied.
const TARGETS = [
  { table: 'hr_employees',      cols: ['date_of_birth', 'join_date', 'end_date', 'retirement_date'], audited: true,
    labelCols: ['full_name', 'employee_code'],
    labelOf: r => [r.full_name, r.employee_code].filter(Boolean).join(' · ') },
  { table: 'hr_leave_requests', cols: ['start_date', 'end_date'], audited: true,  empCol: 'employee_id' },
  { table: 'hr_advances',       cols: ['issued_date'],            audited: false, empCol: 'employee_id' },
  { table: 'hr_tada_claims',    cols: ['start_date', 'end_date'], audited: false, empCol: 'employee_id' },
  { table: 'purchase_orders',   cols: ['expected_date'],          audited: false },
  // Subscription windows, set by admin through the same unlocked picker. These are timestamptz
  // rather than date, so only the date part is compared and they are never auto-repaired — a
  // written-back value could shift the time component. `audited: false` already forces that, and
  // it is the right posture regardless: a day either way on an access window is absorbed by
  // GRACE_DAYS, and correcting one by hand in Admin → Clients is a single click.
  { table: 'clients', cols: ['ims_ends_at', 'hr_ends_at', 'pos_ends_at', 'suite_ends_at', 'subscription_ends_at'],
    audited: false, labelCols: ['name'], labelOf: r => r.name, clientIdCol: 'id' },
]

function loadEnvLocal() {
  const text = readFileSync(path.join(ROOT, '.env.local'), 'utf8')
  const env = {}
  for (const line of text.split('\n')) {
    const m = line.replace(/\r$/, '').match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) env[m[1]] = m[2].trim()
  }
  return env
}

const APPLY = process.argv.includes('--apply')
const INCLUDE_UNVERIFIABLE = process.argv.includes('--include-unverifiable')

const env = loadEnvLocal()
const url = env.REACT_APP_SUPABASE_URL
// Deliberately NOT REACT_APP_-prefixed. CRA inlines every REACT_APP_* variable into the production
// bundle, so a service-role key under that prefix would be published in plain text to every visitor
// the next time anyone runs `npm run build` — full read/write on every tenant, readable from View
// Source. An unprefixed name is invisible to the build. The prefixed form is still accepted so an
// existing .env.local keeps working, but it warns, because leaving it there is the actual danger.
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.REACT_APP_SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceKey) {
  console.error('Missing REACT_APP_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local')
  console.error('Note: name it SUPABASE_SERVICE_ROLE_KEY with NO react_app prefix — a prefixed one')
  console.error('would be compiled into the public browser bundle by the next production build.')
  process.exit(1)
}
if (!env.SUPABASE_SERVICE_ROLE_KEY && env.REACT_APP_SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('WARNING: the service key is named REACT_APP_SUPABASE_SERVICE_ROLE_KEY.')
  console.warn('Rename it to SUPABASE_SERVICE_ROLE_KEY before the next `npm run build`, or that')
  console.warn('build will publish full database access inside the browser bundle.')
  console.warn('')
}
const supabase = createClient(url, serviceKey, { auth: { persistSession: false } })

await loadEraConverters()

// The era whose converter wrote a row created at `ts`. Null once the converter was correct.
const eraFor = ts => ERAS.find(e => new Date(ts) < e.cutoff) || null

// Format a Date the way formatAd does — from LOCAL getters. Never .toISOString(): bsToAd returns
// local midnight, and at Nepal's +05:45 that serialises to 18:15Z on the PREVIOUS day.
const fmtAd = d =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')

// The whole derivation, in one place: read D back through the converter that wrote it, then
// re-encode that BS date with the converter we trust now.
function repair(era, stored) {
  // A timestamptz column arrives as a full ISO string; compare only its calendar date.
  const dayOnly = String(stored).slice(0, 10)
  const asDate = new Date(dayOnly + 'T00:00:00')
  if (Number.isNaN(asDate.getTime())) return null
  const bs = era.mod.adToBs(asDate)
  if (!bs || !bs.year) return null
  const fixed = current.bsToAd(bs.year, bs.month, bs.day)
  if (!fixed || Number.isNaN(fixed.getTime())) return null
  return { bs, fixed: fmtAd(fixed) }
}

// Paged read — this runs across every tenant at once, so the 1000-row cap is well within reach.
async function readAll(table, cols, extra = [], clientIdCol = 'client_id') {
  // `clients` has no client_id — it IS the client, so its own id is the tenant key.
  const select = [...new Set(['id', clientIdCol, 'created_at', ...cols, ...extra])]
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(select.join(', ')).order('id').range(from, from + 999)
    if (error) throw new Error(table + ': ' + error.message)
    out.push(...(data || []))
    if ((data || []).length < 1000) break
  }
  return out
}

// ── When was THIS FIELD actually written? ──────────────────────────────────────────────────────
// The row's `created_at` is not the answer, and this cost a near-miss. A leaver's `end_date` is set
// months after the row is created — Jeevan Tamang's was written 2026-08-22, a week AFTER the
// calendar was fixed, so it was already correct while the row's creation date said "era E1" and the
// script proposed changing it. The first version guarded that with `updated_at`, which turns out to
// be dead: nothing maintains it (no trigger, and EmployeeForm never writes it), so it equals
// `created_at` forever and the guard could never fire. A guard on a column nobody updates is not a
// guard — it reported "0 need review" and meant nothing by it.
//
// `log_audit()` stores a full row snapshot per change, so the real per-field write time is in
// `audit_logs`. Walking an id's history newest-first, the first entry where a column's value
// CHANGED is when that column took the value it holds now.
async function auditHistory(table, ids) {
  const byId = {}
  if (!ids.length) return byId
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('audit_logs')
      .select('record_id, created_at, old_data, new_data')
      .eq('table_name', table).in('record_id', ids)
      .order('created_at').order('id').range(from, from + 999)
    if (error) return byId                       // degrade: callers treat "no history" as unprovable
    for (const r of data || []) (byId[r.record_id] ||= []).push(r)
    if ((data || []).length < 1000) break
  }
  return byId
}

// → ISO timestamp the column last changed, or null if this row has no usable history.
function lastWriteOf(history, col) {
  if (!history || !history.length) return null
  for (let i = history.length - 1; i >= 0; i--) {
    const o = history[i].old_data ? history[i].old_data[col] ?? null : null
    const n = history[i].new_data ? history[i].new_data[col] ?? null : null
    if (o !== n) return history[i].created_at
  }
  return null
}

// Resolve ids to names so the report can be checked against a personnel file. Best-effort: a
// failure here must never stop the audit, so it degrades to showing the raw id.
async function nameMap(table, ids, cols) {
  if (!ids.length) return {}
  const { data, error } = await supabase.from(table).select('id, ' + cols.join(', ')).in('id', ids)
  if (error) return {}
  return Object.fromEntries((data || []).map(r => [r.id, cols.map(c => r[c]).filter(Boolean).join(' · ')]))
}

async function main() {
  console.log(APPLY ? '-- BS DATE AUDIT — APPLYING REPAIRS --' : '-- BS DATE AUDIT — DRY RUN (no writes) --')
  console.log('Eras: ' + ERAS.map(e => e.id + ' < ' + e.until).join('   ') + '\n')

  let totalChanged = 0, totalReview = 0, totalRepaired = 0

  for (const target of TARGETS) {
    let rows
    const extra = [...(target.labelCols || []), ...(target.empCol ? [target.empCol] : [])]
    try { rows = await readAll(target.table, target.cols, extra, target.clientIdCol) }
    catch (e) { console.log(target.table + ': SKIPPED — ' + e.message + '\n'); continue }

    // Only rows created before the last fix can be affected at all; fetch history for those.
    const lastCutoff = ERAS[ERAS.length - 1].cutoff
    const candidates = rows.filter(r => new Date(r.created_at) < lastCutoff)
    const history = target.audited ? await auditHistory(target.table, candidates.map(r => r.id)) : {}

    const changes = [], review = []
    for (const row of candidates) {
      for (const col of target.cols) {
        const stored = row[col]
        if (!stored) continue

        // The write time of THIS FIELD, not of the row. Falls back to the row's creation date only
        // where there is no history to consult.
        const writtenAt = target.audited ? lastWriteOf(history[row.id], col) : null
        const proven = !!writtenAt
        const era = eraFor(writtenAt || row.created_at)
        if (!era) continue                                 // written by the correct converter

        const r = repair(era, stored)
        if (!r || r.fixed === String(stored).slice(0, 10)) continue
        // E3 only broke years the table did not cover; a 2079+ date written then is fine.
        if (era.id === 'E3' && r.bs.year >= 2079) continue

        const rec = { id: row.id, col, stored, fixed: r.fixed, bs: r.bs, era: era.id,
                      clientId: row[target.clientIdCol || 'client_id'], writtenAt: writtenAt || row.created_at, proven,
                      label: target.labelOf ? target.labelOf(row) : null,
                      empId: target.empCol ? row[target.empCol] : null }
        // Auto-repair ONLY where the audit log proves when this field was written. Everything else
        // is reported for a human, because applying the transform to an already-correct date
        // corrupts it — and being unable to tell is not the same as it being safe.
        if (proven) changes.push(rec)
        else review.push(rec)
      }
    }

    console.log(target.table + ': ' + rows.length + ' rows scanned — ' + changes.length + ' repairable, ' + review.length + ' need review')
    const flagged = [...changes, ...review]
    const clients = await nameMap('clients', [...new Set(flagged.map(c => c.clientId).filter(Boolean))], ['name'])
    const emps = await nameMap('hr_employees', [...new Set(flagged.map(c => c.empId).filter(Boolean))], ['full_name', 'employee_code'])
    for (const c of flagged.slice(0, 20)) {
      const who = c.label || emps[c.empId] || ('id ' + c.id)
      const where = clients[c.clientId] || c.clientId || '?'
      console.log('   ' + who + '  [' + where + ']')
      console.log('      ' + c.col + ': ' + c.stored + ' -> ' + c.fixed +
        '   (picked ' + c.bs.day + ' ' + BS_MONTH_NAMES[c.bs.month - 1] + ' ' + c.bs.year + ')')
      console.log('      written ' + c.writtenAt.slice(0, 16).replace('T', ' ') + ' UTC, era ' + c.era +
        (c.proven ? '  [from the audit log]' : '  [NO AUDIT HISTORY — row creation date assumed; NOT auto-repaired]'))
    }
    if (flagged.length > 20) console.log('   ... ' + (flagged.length - 20) + ' more not listed')
    totalChanged += changes.length
    totalReview += review.length

    if (APPLY && changes.length) {
      if (!target.audited && !INCLUDE_UNVERIFIABLE) {
        console.log('   NOT APPLIED — ' + target.table + ' has no audit trigger, so when each date was written cannot be established.')
        console.log('   Re-run with --include-unverifiable to repair it anyway.')
      } else {
        let n = 0
        for (const c of changes) {
          const { error } = await supabase.from(target.table).update({ [c.col]: c.fixed }).eq('id', c.id)
          if (error) { console.log('   FAILED id=' + c.id + ' ' + c.col + ': ' + error.message); continue }
          n++
        }
        totalRepaired += n
        console.log('   applied ' + n + ' update(s)')
      }
    }
    console.log('')
  }

  console.log('TOTAL: ' + totalChanged + ' repairable, ' + totalReview + ' need manual review' +
    (APPLY ? ', ' + totalRepaired + ' written' : ''))
  if (!APPLY && totalChanged) console.log('Re-run with --apply to write these. Take a database backup first.')
}

main().catch(e => { console.error(e); process.exit(1) })
