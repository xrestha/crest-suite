#!/usr/bin/env node
/**
 * Regenerates CHANGELOG/README.md's range table and every range file's own header
 * block, deriving entry counts, session spans and date spans from the files
 * themselves.
 *
 * WHY THIS IS A GENERATOR AND NOT A HAND-EDITED TABLE
 * --------------------------------------------------
 * CLAUDE.md's "never embed a value that moves" rule applies to an index as much as
 * to a rule file: an entry count typed by hand is correct on the day it is typed and
 * silently wrong from the next session on, and nothing anywhere reports it. Run this
 * after adding a changelog entry. It is deliberately NOT wired into build:verify --
 * a generator that rewrites files has no business running inside a check.
 *
 * Writes UTF-8 with LF and no BOM. Never use PowerShell's Get-Content/Set-Content on
 * these files: the first reads ANSI and mangles every em dash, the second emits a BOM.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, 'CHANGELOG')
const EM = '\u2014', EN = '\u2013', ARR = '\u2192'

const kb = (n) => Math.round(n / 1024).toLocaleString('en-US')
const pad = (n) => String(n).padStart(3, '0')

const files = readdirSync(DIR).filter((f) => /^S\d{3}-S\d{3}\.md$/.test(f) && f !== 'S000-ORIGINAL-HEAD.md')
if (files.length === 0) {
  console.error('no CHANGELOG/S###-S###.md files found')
  process.exit(1)
}

const rows = []
for (const fn of files) {
  const path = join(DIR, fn)
  const lines = readFileSync(path, 'utf8').split('\n')
  const heads = lines.filter((l) => /^### S\d/.test(l))
  if (heads.length === 0) { console.error(`${fn}: no session headings`); process.exit(1) }

  const nums = heads.map((l) => Number(l.match(/^### S(\d+)/)[1]))
  const dates = heads.map((l) => l.match(/(\d{4}-\d{2}-\d{2})/)).filter(Boolean).map((m) => m[1]).sort()
  const undated = heads.length - dates.length
  const loA = Math.min(...nums), hiA = Math.max(...nums)

  let note = `${heads.length} entries`
  if (dates.length) note += `, ${dates[0]} to ${dates[dates.length - 1]}`
  note += '. Newest first, as in the original `README.md`.'
  if (undated) note += ` ${undated} carry no date (\`2026 (earlier)\`).`

  // Replace only our own header block: everything up to and including the first
  // '---' rule and the blank line after it. Session bodies are never touched.
  const cut = lines.indexOf('---')
  if (cut < 0) { console.error(`${fn}: no header rule to replace`); process.exit(1) }
  const header = [
    `# Session log ${EM} S${pad(loA)}${EN}S${pad(hiA)}`, '', note,
    'Full range list: [CHANGELOG/README.md](README.md).', '', '---', '',
  ]
  writeFileSync(path, header.concat(lines.slice(cut + 2)).join('\n'), 'utf8')
  rows.push({ fn, loA, hiA, n: heads.length, dates, undated, size: statSync(path).size })
}

rows.sort((a, b) => b.loA - a.loA)
const totalEntries = rows.reduce((s, r) => s + r.n, 0)
const loAll = Math.min(...rows.map((r) => r.loA)), hiAll = Math.max(...rows.map((r) => r.hiA))
const headSize = statSync(join(DIR, 'S000-ORIGINAL-HEAD.md')).size

const table = rows.map((r) => {
  let span = r.dates.length ? `${r.dates[0]} ${ARR} ${r.dates[r.dates.length - 1]}` : 'undated'
  if (r.undated) span += ` (+${r.undated} undated)`
  return `| [S${pad(r.loA)}${EN}S${pad(r.hiA)}](${r.fn}) | ${r.n} | ${span} | ${kb(r.size)} KB |`
})

const out = `# Changelog

The Crest Suite session log. It was the back 15,198 lines of \`README.md\`, which reached
1,801,834 characters ${EM} about 45\u00d7 the size at which Claude Code warns about a memory file, and
past what a person or a tool can read end to end. S666 split it here and gave \`README.md\` back
its job as a map.

## Session Log

${totalEntries} entries, S${pad(loAll)} to S${pad(hiAll)}, across ${rows.length} files. **Newest first**, both inside each file and
down this table.

| Range | Entries | Dates | Size |
| --- | ---: | --- | ---: |
${table.join('\n')}

Plus [\`S000-ORIGINAL-HEAD.md\`](S000-ORIGINAL-HEAD.md) (${kb(headSize)} KB): the head of \`README.md\` as it
stood before the split ${EM} App Overview, the Plans table, the Routes table, "Pending Features" ${EM}
kept verbatim and **not corrected**. Every claim in it is stale. It is history, not reference.

## What the split did not do

**Nothing was reordered.** Every cut is at a session heading and every file holds one unbroken
run of the original, so the head archive plus these files concatenated in order reproduce the
pre-split \`README.md\` byte for byte. That was asserted, not assumed.

The consequence is that two long-standing oddities are still here, because they were always here:

- **The tail is out of order.** Inside \`S023${EN}S099.md\`, after \`S47\` comes \`S23\`, \`S24\`, \`S24/S25\`,
  \`S26\`, \`S27\`, \`S28\`, \`S45\`, \`S46\`, \`S31\`, \`S30\`, \`S29\`, \`S44\`, \`S43\`, \`S42\`, \`S41\`, \`S33\`,
  \`S32\`, \`S40\`, \`S39\`, \`S38\`, \`S37\`, \`S36\`, \`S35\`, \`S34\`. Six of those carry no date at all,
  only \`2026 (earlier)\`.
- **\`S197\` appears three times**, on three genuinely distinct entries, in \`S150${EN}S199.md\`.

Sorting either would have meant a split that could no longer be checked against the original, to
fix something no reader has ever been misled by.

## Adding an entry

1. Prepend it to the **newest** range file, above the entry currently at the top. The heading is
   \`### S<n> ${EM} YYYY-MM-DD ${EM} what changed\`, in the past tense, saying what is different now
   rather than what was worked on.
2. State explicitly whether app code changed, and whether the service worker was bumped. A reader
   six months from now cannot otherwise tell a docs-only session from a shipping one.
3. Run \`npm run changelog:index\`. It rewrites this table and each range file's header from the
   files themselves, so no count here is ever typed by hand.

**Start a new range file when the current one passes about 150,000 characters.** The ceiling is
200,000 ${EM} the point at which a file stops being readable by the things that need to read it ${EM}
and the margin exists so one long session cannot breach it. Name the file for the 50-session block
it opens, not for the sessions it currently holds, so it need not be renamed as it fills.
`

writeFileSync(join(DIR, 'README.md'), out, 'utf8')
console.log(`CHANGELOG/README.md: ${rows.length} range files, ${totalEntries} entries, ` +
            `largest ${Math.max(...rows.map((r) => r.size)).toLocaleString('en-US')} B`)
