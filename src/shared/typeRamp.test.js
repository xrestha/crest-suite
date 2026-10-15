import fs from 'fs'
import path from 'path'

// Every px text size in src/ sits on the type ramp DESIGN.md declares. A source-reading test, the
// nepalMoney.test.js technique: an off-scale size has no runtime symptom, and the /impeccable design
// detector only reads a QUOTED size (`fontSize: '26px'` is flagged, `fontSize: 26` is not), which is
// how 12.5, 11.5, 13.5, 19, 26 and 36 accumulated across the product unseen.
//
// The ramp is READ from DESIGN.md's frontmatter `typography:` block, every `fontSize: "Npx"` there
// plus the px ends of the display role's clamp(), so adding a step to the design file is what makes
// it legal here. Never hard-code the list in this file.
//
// Checked: `fontSize: 26`, `fontSize: 12.5`, `fontSize: '26px'`, `fontSize: "26px"`, each numeric arm
// of a ternary (`touch ? 22 : 18`), and CSS `font-size: 26px`, in .css files and in CSS written inside
// JS strings. Not checked: em, rem, %, pt, clamp(), var(), and a size held in a variable.

const SRC = path.resolve(__dirname, '..')
const DESIGN = path.resolve(__dirname, '../../DESIGN.md')

// PRINT output is sized for paper, not for the screen ramp. `@media print` blocks are found by
// themselves (Layout.css's included), so only print output that lives outside one is listed here.
// Each entry is a whole file, or the lines from a line matching `from` to the next matching `to`.
const PRINT_EXEMPT = [
  {
    path: 'modules/pos/parking/parkingSlipHtml.js',
    reason: 'Builds the HTML of an 80 mm parking token for the thermal printer.',
  },
  {
    path: 'pages/settings/ModuleGuideTab.jsx',
    from: /<style>/,
    to: /<\/style>/,
    reason: "The stylesheet of the guide's print window, a separate document opened only to print. The on-screen tab is still checked.",
  },
  {
    path: 'modules/hr/employees/EmployeeJoiningForm.jsx',
    reason: 'A blank A4 joining form to print and fill in by hand. The dialog shows the paper itself (Modal printable), so its sizes are paper sizes.',
  },
]

/** The set of px sizes DESIGN.md's frontmatter `typography:` block declares. */
function rampFromDesign(md) {
  const front = md.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/)
  if (!front) return new Set()
  const lines = front[1].split('\n')
  const start = lines.findIndex(l => /^typography:\s*$/.test(l))
  const ramp = new Set()
  if (start < 0) return ramp
  // The block runs until the next top-level key (a line that starts in column 0).
  for (let i = start + 1; i < lines.length && !/^\S/.test(lines[i]); i++) {
    const m = lines[i].match(/^\s+fontSize:\s*"([^"]*)"/)
    if (m) for (const px of m[1].matchAll(/(\d+(?:\.\d+)?)px/g)) ramp.add(Number(px[1]))
  }
  return ramp
}

/** A whole comment line. Not `* {`, which is CSS's universal selector. */
function isCommentLine(line) {
  const t = line.trim()
  if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('{/*')) return true
  return /^\*(\s|$)/.test(t) && !t.includes('{')
}

/** Every literal px text size on one line of source, as written. */
function sizesOnLine(line) {
  if (isCommentLine(line)) return []
  const found = []
  for (const m of line.matchAll(/fontSize\s*:\s*([^,}\n]+)/g)) {
    const v = m[1].trim()
    let x
    if ((x = v.match(/^(\d+(?:\.\d+)?)$/))) found.push(x[1])
    else if ((x = v.match(/^['"`](\d+(?:\.\d+)?)px['"`]$/))) found.push(x[1])
    else {
      // A ternary: each arm that is itself a literal size (`touch ? 22 : 18`, `a ? '14px' : '16px'`).
      for (const t of v.matchAll(/[?:]\s*(?:['"`](\d+(?:\.\d+)?)px['"`]|(\d+(?:\.\d+)?))(?=\s*(?:[:,})]|$))/g)) {
        found.push(t[1] || t[2])
      }
    }
  }
  for (const m of line.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px\b/g)) found.push(m[1])
  return found
}

/** 1-based line numbers that sit inside an `@media print { … }` block. */
function printLines(text) {
  const out = new Set()
  const re = /@media\s+print\b[^{]*\{/g
  let m
  while ((m = re.exec(text))) {
    let depth = 1
    let i = re.lastIndex
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') depth--
      i++
    }
    const from = text.slice(0, m.index).split('\n').length
    const to = text.slice(0, i).split('\n').length
    for (let n = from; n <= to; n++) out.add(n)
  }
  return out
}

/** 1-based line numbers an allowlist entry exempts in this file, or null for the whole file. */
function exemptLines(entry, lines) {
  if (!entry.from) return null
  const out = new Set()
  let inside = false
  lines.forEach((l, i) => {
    if (!inside && entry.from.test(l)) inside = true
    if (!inside) return
    out.add(i + 1)
    if (entry.to.test(l)) inside = false
  })
  return out
}

const rel = f => path.relative(SRC, f).split(path.sep).join('/')

const files = []
;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(js|jsx|css)$/.test(e.name) && !/\.test\.(js|jsx)$/.test(e.name)) files.push(p)
  }
})(SRC)

const RAMP = rampFromDesign(fs.readFileSync(DESIGN, 'utf8'))

describe('the type ramp is read from DESIGN.md', () => {
  test('the parser finds the whole ramp, not a fraction of it', () => {
    // Guards the parser itself: a regex that matched nothing would make every size below "off-ramp"
    // and one that matched too little would pass a broken design file.
    expect(RAMP.size).toBeGreaterThanOrEqual(10)
    expect(RAMP.has(13)).toBe(true)   // body
    for (const s of RAMP) expect(s).toBeGreaterThan(0)
  })

  test('a step added to DESIGN.md becomes legal, and the display clamp gives both its ends', () => {
    const md = '---\ntypography:\n  display:\n    fontSize: "clamp(24px, 3.4vw, 32px)"\n  x:\n    fontSize: "19px"\nrounded:\n  fontSize: "99px"\n---\n'
    expect([...rampFromDesign(md)].sort((a, b) => a - b)).toEqual([19, 24, 32])
  })
})

describe('the size finder', () => {
  test.each([
    ["style={{ fontSize: 26 }}", ['26']],
    ["style={{ fontSize: 12.5, color: 'red' }}", ['12.5']],
    ["style={{ fontSize: '26px' }}", ['26']],
    ['style={{ fontSize: "26px" }}', ['26']],
    ['style={{ fontSize: touch ? 22 : 19 }}', ['22', '19']],
    ["style={{ fontSize: k === 'C' ? 15 : 22 }}", ['15', '22']],
    ["style={{ fontSize: a ? '14px' : '16px' }}", ['14', '16']],
    ['  font-size: 26px;', ['26']],
    ['<div style="font-size:9.5px">', ['9.5']],
    ["style={{ fontSize: '1.2em' }}", []],
    ["style={{ fontSize: 'var(--font-size-micro)' }}", []],
    ['  font-size: clamp(24px, 3.4vw, 32px);', []],
    ['  font-size: 10.5pt;', []],
    ['style={{ fontSize: size }}', []],
    ['// was fontSize: 12.5 before S844', []],
    ['   * fontSize: 26 was the old value', []],
    ['  * { margin:0; font-size:11px; }', ['11']],
  ])('%s', (line, expected) => {
    expect(sizesOnLine(line)).toEqual(expected)
  })

  test('an @media print block is found, nested rules and all', () => {
    const css = '.a { font-size: 13px; }\n@media print {\n  .b { font-size: 9.5px; }\n}\n.c { font-size: 26px; }\n'
    expect([...printLines(css)]).toEqual([2, 3, 4])
  })

  test('a from/to entry exempts the region it names and nothing else', () => {
    const lines = ['a', 'x = `<style>', 'p { font-size: 12.5px }', '</style>`', 'b']
    expect([...exemptLines({ from: /<style>/, to: /<\/style>/ }, lines)]).toEqual([2, 3, 4])
  })
})

describe('every px text size in src/ is on the ramp', () => {
  test('the print allowlist still points at what it exempts', () => {
    const problems = []
    for (const entry of PRINT_EXEMPT) {
      const file = path.join(SRC, entry.path)
      if (!fs.existsSync(file)) { problems.push(`${entry.path}: no such file`); continue }
      if (!(entry.reason && entry.reason.length > 20)) problems.push(`${entry.path}: say why it is print output`)
      if (entry.from && exemptLines(entry, fs.readFileSync(file, 'utf8').split('\n')).size === 0) {
        problems.push(`${entry.path}: no line matches ${entry.from}`)
      }
    }
    expect(problems).toEqual([])
  })

  test('no off-scale font size', () => {
    const offenders = []
    let scanned = 0
    for (const f of files) {
      const name = rel(f)
      const entry = PRINT_EXEMPT.find(e => e.path === name)
      const text = fs.readFileSync(f, 'utf8')
      const lines = text.split('\n')
      const exempt = entry ? exemptLines(entry, lines) : new Set()
      if (exempt === null) continue
      const print = printLines(text)
      for (let i = 0; i < lines.length; i++) {
        const n = i + 1
        for (const v of sizesOnLine(lines[i])) {
          scanned++
          if (print.has(n) || exempt.has(n)) continue
          if (!RAMP.has(Number(v))) offenders.push(`${name}:${n} ${v}`)
        }
      }
    }
    // Guards the scan itself: thousands of sizes are written in src/, so a finder that stopped
    // matching would otherwise pass this test with nothing checked.
    expect(scanned).toBeGreaterThan(1000)
    expect(offenders).toEqual([])
  })
})
