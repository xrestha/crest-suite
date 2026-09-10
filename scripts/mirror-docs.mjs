#!/usr/bin/env node
// Mirror every git-tracked Markdown file to the E: documentation drive.
//
// WHY A SCRIPT. The mirror used to be README.md + CHANGELOG/ copied by hand, which meant the two
// documents a person reads outside the repo were backed up and the ~110 that carry the actual
// engineering rules were not — CLAUDE.md, all 27 `.claude/rules/*.md`, PRODUCT.md, DESIGN.md,
// docs/CROSS-REPO.md. Decision, Aashish 2026-09-10: E: mirrors C:. Copying 113 files by hand once
// per session is how a mirror silently stops being one, so it is one command instead.
//
// THE FILE LIST IS `git ls-files`, deliberately. That is the same boundary the repo already uses
// for "what is ours": node_modules, build/, and anything gitignored are excluded for free, and a
// new rules file joins the mirror the moment it is committed rather than when someone remembers to
// add it here. Paths are preserved exactly, so `.claude/rules/x.md` lands at `.claude/rules/x.md`
// — a dot-directory is hidden in Explorer by default, which is the price of the mirror actually
// being a mirror.
//
// IT NEVER DELETES. E: also holds legacy material this repo knows nothing about (the
// crest-inventory folders, recovery-codes.txt, a supabase_schema.sql). A prune pass that got its
// boundary slightly wrong would destroy a backup, which is the one outcome a backup script must
// not have. Stale files are REPORTED and left for a person to remove — that is how the duplicate
// S675-S699.md sitting at the E: root was found.

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const DEST = process.env.CREST_DOCS_MIRROR || 'E:\\CREST SUITE MANAGEMENT'

if (!fs.existsSync(DEST)) {
  // Not an error. The drive is frequently not mounted, and a docs mirror must never be the reason
  // a commit or a check fails.
  console.log(`mirror-docs: SKIPPED — destination not available (${DEST})`)
  process.exit(0)
}

const files = execSync('git ls-files "*.md"', { encoding: 'utf8' })
  .split('\n')
  .map(s => s.trim())
  .filter(Boolean)

let copied = 0, unchanged = 0
const failed = []

for (const rel of files) {
  const src = path.resolve(rel)
  const dst = path.join(DEST, rel.split('/').join(path.sep))
  try {
    const body = fs.readFileSync(src)
    // Compare before writing so the report distinguishes "the mirror was already current" from
    // "113 files were rewritten", which is the only way to notice the mirror has drifted.
    if (fs.existsSync(dst) && Buffer.compare(fs.readFileSync(dst), body) === 0) { unchanged++; continue }
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.writeFileSync(dst, body)
    copied++
  } catch (err) {
    failed.push(`${rel}: ${err.message}`)
  }
}

// Stale check, report-only. Walks just the directories the mirror itself manages, so the legacy
// material at the destination root is never even looked at.
const managed = [...new Set(files.filter(f => f.includes('/')).map(f => f.split('/')[0]))]
const stale = []
const tracked = new Set(files.map(f => f.split('/').join(path.sep)))
for (const top of managed) {
  const root = path.join(DEST, top)
  if (!fs.existsSync(root)) continue
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.md') && !tracked.has(path.relative(DEST, full))) {
        stale.push(path.relative(DEST, full))
      }
    }
  }
  walk(root)
}

console.log(`mirror-docs: ${copied} copied, ${unchanged} already current, ${files.length} tracked → ${DEST}`)
if (stale.length) {
  console.log(`\n  ${stale.length} file(s) on the mirror are no longer tracked in the repo.`)
  console.log('  Nothing is deleted automatically — remove them by hand if they are genuinely stale:')
  for (const s of stale) console.log(`    ${s}`)
}
if (failed.length) {
  console.error(`\nmirror-docs: ${failed.length} file(s) FAILED to copy:`)
  for (const f of failed) console.error(`  ${f}`)
  process.exit(1)
}
