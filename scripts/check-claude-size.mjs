#!/usr/bin/env node
// T11 — A mechanical ceiling on CLAUDE.md, so there is no fifth /doctor pass.
//
// WHY A CEILING AND NOT A TARGET
// ------------------------------
// Four /doctor passes have been spent shrinking this file (2026-08-18, S605, S615, S663 — the last
// halved it, 110k to 51k). Between the second and third it regrew 7,052 chars in three days, and
// CLAUDE.md's own diagnosis of why is correct: "a new rule has one obvious home and no single
// session can see that it is the fortieth to pick it."
//
// That diagnosis rules out fixing this with judgement. Deciding whether a rule belongs in the root
// file or in .claude/rules/ needs the whole corpus in view, and a session editing one module does
// not have it. A hard stop does not need that view — it refuses the write and points at the rule.
// It converts a recurring manual audit into a one-time cost.
//
// WHAT IS COUNTED, AND WHY IT IS NOT WHAT `wc -c` SAYS
// ---------------------------------------------------
// Characters of LF-normalised UTF-8 text: line endings collapsed, code points not bytes.
//
// This matters for the ratchet. The working tree here is `core.autocrlf=true` with no
// .gitattributes, so CLAUDE.md is 51,761 bytes on this machine and 51,306 in a Linux checkout —
// the same file, 455 bytes apart, purely in line endings. Counting bytes would make the ceiling
// mean something different per platform and per contributor. Counting code points also stops an
// em-dash costing three times what a hyphen does, which is not a distinction anyone editing prose
// should have to think about.
//
// So the number below will read LOWER than the 51,761 quoted in DOCS-REMEDIATION.md and in the
// file's own history. Nothing shrank; the measure changed and is now stable.
//
// THE RATCHET
// -----------
// CEILING only ever goes DOWN. When a /doctor pass lowers the file, lower this constant in the
// same commit — otherwise the reclaimed space is immediately available to refill, which is exactly
// how the file got back to 51k twice.
//
// It is set at the current size plus a working margin rather than at the 40,000 aspiration on
// purpose: a ceiling that is already breached on the day it lands gets commented out within a
// week, and then there is no ceiling at all.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

// ---- The ratchet. Only ever lower this. --------------------------------------------------------
const CEILING = 53000
// Measured 2026-09-01 at 51,027 chars (LF-normalised). Margin: 1,973.
// ------------------------------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = join(ROOT, 'CLAUDE.md')

const text = readFileSync(TARGET, 'utf8').replace(/\r\n/g, '\n')
const size = [...text].length

/**
 * Split into `##` blocks, each running to the next `##` and so inclusive of its `###` children —
 * the unit a migration to .claude/rules/ actually moves. Fenced code blocks are skipped so a `#`
 * comment inside one is not mistaken for a heading.
 */
function sections(src) {
  const lines = src.split('\n')
  const found = []
  let fenced = false
  lines.forEach((line, i) => {
    if (/^```/.test(line)) fenced = !fenced
    if (fenced) return
    const m = line.match(/^(#{2,3}) (.+)$/)
    if (m) found.push({ level: m[1].length, title: m[2].trim(), start: i })
  })

  const blocks = []
  for (let i = 0; i < found.length; i += 1) {
    const h = found[i]
    if (h.level !== 2) continue
    const next = found.slice(i + 1).find((x) => x.level === 2)
    const end = next ? next.start : lines.length
    const chars = [...lines.slice(h.start, end).join('\n')].length
    const children = found
      .filter((x) => x.level === 3 && x.start > h.start && x.start < end)
      .map((x, j, arr) => {
        const cEnd = arr[j + 1] ? arr[j + 1].start : end
        return { title: x.title, chars: [...lines.slice(x.start, cEnd).join('\n')].length }
      })
      .sort((a, b) => b.chars - a.chars)
    blocks.push({ title: h.title, chars, children })
  }
  return blocks.sort((a, b) => b.chars - a.chars)
}

const pct = ((size / CEILING) * 100).toFixed(1)

if (size <= CEILING) {
  console.log(`check-claude-size: OK — CLAUDE.md is ${size.toLocaleString()} chars, ceiling ${CEILING.toLocaleString()} (${pct}%, ${(CEILING - size).toLocaleString()} to spare).`)
  process.exit(0)
}

console.error(`\ncheck-claude-size: CLAUDE.md is ${size.toLocaleString()} chars — over the ${CEILING.toLocaleString()} ceiling by ${(size - CEILING).toLocaleString()}.\n`)
console.error('Everything in this file loads on EVERY request, so a rule that only matters while one')
console.error('module is open is paid for by every session that never opens it.\n')
console.error('The three largest sections:\n')
for (const s of sections(text).slice(0, 3)) {
  console.error(`  ${s.chars.toLocaleString().padStart(7)}  ## ${s.title}`)
  if (s.children.length) {
    console.error(`           largest sub-section: ### ${s.children[0].title} (${s.children[0].chars.toLocaleString()})`)
  }
}
console.error('\nRead CLAUDE.md, "Where a new rule goes", and ask which file the rule is REACHABLE FROM,')
console.error('not which file it is about. Reachable from one module or a few files means it belongs in')
console.error('.claude/rules/ with a `paths:` entry; only rules reachable from anywhere stay in the root.')
console.error('\nIf a /doctor pass has genuinely lowered the file, lower CEILING in this script in the same')
console.error('commit. It only ever goes down.\n')
process.exit(1)
