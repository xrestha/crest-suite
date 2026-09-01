#!/usr/bin/env node
// T4 — Fail the build when a pointer stub names a destination that cannot deliver.
//
// WHY THIS EXISTS
// ---------------
// Three stubs in S663 named a destination file that had never received the content. A stub that
// names a destination is worse than no stub at all, because it reads as available: a session sees
// "the detail is in X", treats the subject as covered, and moves on without the guidance. No stub
// would at least have left the gap visible.
//
// This is the read side of the same silent failure T3 covers on the write side. Neither errors.
//
// WHAT IS CHECKED
// ---------------
// Four things, chosen because each is mechanical — a check that needed judgement would either
// false-positive on good prose or be tuned until it passed, and a check tuned until it passes is
// the vacuous guard CLAUDE.md warns about in three separate places.
//
//   1. The named file exists.
//   2. It is not itself a stub — a destination under 600 non-whitespace characters of body cannot
//      hold what a stub defers to it, and a pointer chain ending in nothing is the exact S663
//      fault.
//   3. It has at least one markdown heading, so it is a structured document rather than a note.
//   4. If the referring sentence claims the file AUTO-LOADS, it has a non-empty `paths:` list.
//      This one is the sharpest: "See X (auto-loads when editing Y)" is a claim about machinery,
//      and a destination with no `paths:` never loads for anything. T3 then separately proves
//      those globs resolve, so the two checks together make the auto-load claim honest end to end.
//
// It deliberately does NOT try to judge whether the destination's content matches the stub's
// subject. That needs reading comprehension, and a keyword-overlap approximation of it would flag
// correct pairs whose vocabulary differs and pass wrong pairs that happen to share a word.

import { readText, splitFrontmatter, parsePaths, ruleFiles, relFromRoot, ROOT } from './lib/rules-frontmatter.mjs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const SUBSTANTIVE_FLOOR = 600

// Every backticked `.claude/rules/*.md` or `.claude/skills/**/SKILL.md` reference.
const REF = /`(\.claude\/(?:rules\/[A-Za-z0-9._-]+\.md|skills\/[A-Za-z0-9._/-]+\.md))`/g

const sources = [join(ROOT, 'CLAUDE.md'), ...ruleFiles()]
const problems = []
let refCount = 0

// Cache per destination so a file referenced ten times is read and judged once.
const verdicts = new Map()

function judge(target) {
  if (verdicts.has(target)) return verdicts.get(target)
  const abs = join(ROOT, target)
  let v
  if (!existsSync(abs)) {
    v = { ok: false, reason: 'the file does not exist' }
  } else {
    const text = readText(abs)
    const { body } = splitFrontmatter(text)
    const substantive = body.replace(/\s/g, '').length
    const headings = (body.match(/^#{1,6} /gm) || []).length
    const globs = parsePaths(text)
    if (substantive < SUBSTANTIVE_FLOOR) {
      v = { ok: false, reason: `it is itself a stub — ${substantive} non-whitespace chars of body, floor is ${SUBSTANTIVE_FLOOR}` }
    } else if (headings === 0) {
      v = { ok: false, reason: 'it has no markdown heading — a note, not a destination document' }
    } else {
      v = { ok: true, globs: globs.length, isRule: target.startsWith('.claude/rules/') }
    }
  }
  verdicts.set(target, v)
  return v
}

for (const src of sources) {
  const rel = relFromRoot(src)
  const lines = readText(src).split('\n')

  lines.forEach((line, i) => {
    // Self-references inside a rule file's own prose ("this file") are pointers to where the
    // reader already is; they are harmless and would otherwise flag every file that names itself.
    for (const m of line.matchAll(REF)) {
      const target = m[1]
      if (rel === target) continue
      refCount += 1

      const v = judge(target)
      if (!v.ok) {
        problems.push({ rel, line: i + 1, target, reason: v.reason })
        continue
      }

      // The auto-load claim. Read the sentence around the reference — stubs wrap, so the claim can
      // sit on the following line ("See `x.md` (auto-loads when editing\n  `y.js` ...)").
      const context = [lines[i - 1] || '', line, lines[i + 1] || ''].join(' ')
      const claimsAutoLoad = /auto-?loads?\b/i.test(context)
      if (claimsAutoLoad && v.isRule && v.globs === 0) {
        problems.push({
          rel,
          line: i + 1,
          target,
          reason: 'the stub says it auto-loads, but the file has no paths: frontmatter, so it never does',
        })
      }
    }
  })
}

if (problems.length === 0) {
  console.log(`check-rules-stubs: OK — ${refCount} pointer(s) across ${sources.length} files, every destination exists and carries content.`)
  process.exit(0)
}

console.error(`\ncheck-rules-stubs: ${problems.length} broken pointer(s).\n`)
for (const p of problems) {
  console.error(`  ${p.rel}:${p.line}`)
  console.error(`      points at ${p.target} — ${p.reason}\n`)
}
console.error('A stub that names a destination reads as available. Either move the content it defers')
console.error('to into that file, or delete the pointer so the gap stays visible.\n')
process.exit(1)
