#!/usr/bin/env node
// T3 — Fail the build when a `.claude/rules/*.md` `paths:` glob matches nothing.
// T13 — Report how much rules text opening one file loads, and warn when that grows (see below).
//
// WHY THIS EXISTS
// ---------------
// A scoped rule whose glob matches zero files does not error, does not warn, and produces a
// session that looks exactly like one where the rule simply did not apply. It fails silently and
// permanently.
//
// S663 found five of these by hand. The worst was `accounts-and-logins.md` scoped to
// `src/contexts/AuthContext.js` when the directory is `src/context`, singular — so the rule
// covering who logs in where, and the trap where giving the owner's own login a staff role demotes
// them, had never once loaded for the file it is most about. Three more pointed at pages that had
// moved from `src/pages/` into `src/modules/`.
//
// Nothing in the loader reports this, which is the whole problem: the failure is indistinguishable
// from correct operation from inside a session. It has to be checked from outside one.
//
// WHAT IT DELIBERATELY DOES NOT DO
// --------------------------------
// It does not repoint a rotted glob. A glob matching zero files has at least three possible
// intents — the path was renamed, the file was deleted and the rule is now dead, or the glob was
// always a typo for something adjacent — and picking wrong re-scopes a rule to files its author
// never meant, which is worse than the rule not loading, because it then loads and is trusted.
// Report, and let a person decide.

import { ruleFiles, readText, parsePaths, globToRegExp, walkTree, relFromRoot } from './lib/rules-frontmatter.mjs'

const files = walkTree()
const problems = []
const rules = [] // { name, chars, res } per rule file, for the load-size report below
let globCount = 0
let ruleCount = 0

for (const path of ruleFiles()) {
  const rel = relFromRoot(path)
  const text = readText(path)
  const globs = parsePaths(text)
  ruleCount += 1
  rules.push({ name: rel.replace('.claude/rules/', ''), chars: text.length, res: globs.map((g) => globToRegExp(g.glob)) })

  // A rule file with no `paths:` at all can never auto-load. That is a different fault from a
  // rotted glob but the same consequence, so it is reported here rather than passing quietly.
  if (globs.length === 0) {
    problems.push({ rel, line: 1, glob: '(no paths: key)', kind: 'unscoped' })
    continue
  }

  for (const { glob, line } of globs) {
    globCount += 1
    const re = globToRegExp(glob)
    const matches = files.filter((f) => re.test(f))
    if (matches.length === 0) problems.push({ rel, line, glob, kind: 'rotted' })
  }
}

if (problems.length === 0) {
  console.log(`check-rules-globs: OK — ${globCount} globs across ${ruleCount} rule files, all match at least one file.`)
}

// T13 — LOAD SIZE: what opening one file actually costs
// -----------------------------------------------------
// CLAUDE.md has a ceiling because it loads on every request. The rules corpus had none, and it is
// the bigger cost: opening one IMS file loaded 366k chars of rules before S770 and 218k after S772,
// against a CLAUDE.md of 16k. Size alone is the wrong measure (a large rule scoped to four files is
// cheap); what a session pays is the sum of every rule whose `paths:` match the file it opened.
//
// So this reports, per area, the median and max of that sum over every file in the area, and WARNS
// (never fails) when a median rises more than 15% above the baseline below. It warns rather than
// fails because a rise can be the right call (a new module's rules), and a check that blocks correct
// work gets tuned until it passes. The warning names the rule files that grew, so the choice is made
// by a person looking at the cause.
//
// The baseline is a ratchet in the same spirit as CEILING in check-claude-size.mjs: when a
// condensation or re-scoping pass lowers a median, lower its baseline (and RULE_CHARS_BASELINE) in
// the same commit. Raise one only for a rise you decided to keep, and say so in the CHANGELOG.

const LOAD_AREAS = [
  ['IMS', 'src/modules/ims/'],
  ['POS', 'src/modules/pos/'],
  ['HR', 'src/modules/hr/'],
  ['pages', 'src/pages/'],
  ['components', 'src/components/'],
  ['migrations', 'supabase/migrations/'],
]

// Measured 2026-09-17 at 7640d70a, after the S772 condensation pilot on dashboards.md.
const LOAD_BASELINE = {
  IMS: { median: 217795, max: 354140 },
  POS: { median: 155963, max: 254898 },
  HR: { median: 136028, max: 295297 },
  pages: { median: 72023, max: 193497 },
  components: { median: 138158, max: 178648 },
  migrations: { median: 70595, max: 94472 },
}
const LOAD_WARN_RISE = 0.15

// Chars per rule file at the same commit, so a warning can say which files grew.
const RULE_CHARS_BASELINE = {
  'access-control.md': 31547,
  'accounts-and-logins.md': 26171,
  'auth-and-pins.md': 17935,
  'bs-calendar.md': 14587,
  'closed-periods.md': 20095,
  'component-library.md': 34546,
  'dashboards.md': 31593,
  'data-export.md': 11221,
  'design-system.md': 98935,
  'design-tokens.md': 13806,
  'error-messages.md': 12746,
  'frontend-performance.md': 29526,
  'hr-payroll.md': 66026,
  'ims-figures.md': 93475,
  'input-arithmetic.md': 3217,
  'item-master-rates.md': 20276,
  'legal-documents.md': 23877,
  'login-pages.md': 8698,
  'multi-outlet.md': 11419,
  'navigation.md': 6136,
  'offline-and-cache.md': 9854,
  'owner-report.md': 12540,
  'page-layout.md': 5930,
  'pos-billing.md': 71056,
  'pos-reservations-alerts.md': 14905,
  'recipes-and-subrecipes.md': 26540,
  'report-pages.md': 22493,
  'security-headers.md': 4243,
  'settings-row.md': 16712,
  'staff-app.md': 16228,
  'subscription-access.md': 6240,
  'supabase-sql.md': 70595,
  'support-contact.md': 13620,
  'vendor-payables.md': 62329,
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}
const k = (n) => `${(n / 1000).toFixed(1)}k`
const pct = (n) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`

console.log('check-rules-globs: load size — chars of rules loaded by opening one file (baseline S772)')
const loadWarnings = []
for (const [area, prefix] of LOAD_AREAS) {
  const inArea = files.filter((f) => f.startsWith(prefix))
  if (inArea.length === 0) {
    loadWarnings.push(`${area}: no files under ${prefix} — the area moved, so this report stopped measuring it.`)
    continue
  }
  const loaded = inArea.map((f) => rules.filter((r) => r.res.some((re) => re.test(f))))
  const sizes = loaded.map((rs) => rs.reduce((sum, r) => sum + r.chars, 0))
  const med = median(sizes)
  const base = LOAD_BASELINE[area]
  const rise = (med - base.median) / base.median
  console.log(
    `  ${area.padEnd(11)} ${String(inArea.length).padStart(4)} files   median ${k(med).padStart(7)} (${pct(rise).padStart(6)})` +
      `   max ${k(Math.max(...sizes)).padStart(7)} (baseline ${k(base.max)})`,
  )
  if (rise > LOAD_WARN_RISE) {
    const grew = [...new Set(loaded.flat())]
      .filter((r) => !(r.name in RULE_CHARS_BASELINE) || r.chars > RULE_CHARS_BASELINE[r.name])
      .map((r) => r.name in RULE_CHARS_BASELINE
        ? `${r.name} ${RULE_CHARS_BASELINE[r.name].toLocaleString('en-US')} -> ${r.chars.toLocaleString('en-US')} (+${(r.chars - RULE_CHARS_BASELINE[r.name]).toLocaleString('en-US')})`
        : `${r.name} (new, ${r.chars.toLocaleString('en-US')})`)
    loadWarnings.push(
      `${area}: median ${k(med)} is ${pct(rise)} against its ${k(base.median)} baseline (warns above +${LOAD_WARN_RISE * 100}%).\n` +
        (grew.length
          ? `      Rule files loaded there that grew since the baseline:\n${grew.map((g) => `        ${g}`).join('\n')}`
          : '      No rule file grew: a paths: glob widened, or files were added to this area.'),
    )
  }
}
if (loadWarnings.length) {
  console.warn(`\ncheck-rules-globs: WARN — ${loadWarnings.length} load-size warning(s). Not a failure.`)
  for (const w of loadWarnings) console.warn(`  ${w}`)
  console.warn('  Condense or re-scope the growth (story to docs/rules-archive/, rule plus a pointer), or, for a')
  console.warn('  rise you mean to keep, raise LOAD_BASELINE in scripts/check-rules-globs.mjs and say why.\n')
}

if (problems.length === 0) process.exit(0)

console.error(`\ncheck-rules-globs: ${problems.length} problem(s) across ${ruleCount} rule files.\n`)
for (const p of problems) {
  if (p.kind === 'unscoped') {
    console.error(`  ${p.rel}`)
    console.error(`      no paths: frontmatter — this rule can never auto-load.\n`)
  } else {
    console.error(`  ${p.rel}:${p.line}`)
    console.error(`      "${p.glob}" matches zero files — this rule does not load for it.\n`)
  }
}
console.error('A glob that matches nothing fails silently: the session looks identical to one where')
console.error('the rule did not apply. Check whether the path was renamed, moved into src/modules/,')
console.error('or deleted outright — and see CLAUDE.md, "Where a new rule goes", on rotted globs.\n')
process.exit(1)
