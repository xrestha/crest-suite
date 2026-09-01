#!/usr/bin/env node
// T3 — Fail the build when a `.claude/rules/*.md` `paths:` glob matches nothing.
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
let globCount = 0
let ruleCount = 0

for (const path of ruleFiles()) {
  const rel = relFromRoot(path)
  const globs = parsePaths(readText(path))
  ruleCount += 1

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
  process.exit(0)
}

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
