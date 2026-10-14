'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { FontSet } = require('../src/fonts')
const { layoutDoc, renderDoc, withLateLine, nepalHHMM, wrapWords, cleanText, paperFor, MAX_LINES } = require('../src/render')

let fonts
test.before(async () => { fonts = await FontSet.load() })

const glyphs = items => items.filter(i => i.t === 'glyph')
const rects = items => items.filter(i => i.t === 'rect')
const baselines = items => [...new Set(glyphs(items).map(g => Math.round(g.y)))].sort((a, b) => a - b)
const doc = (...lines) => ({ v: 1, title: 'T', lines })

test('wrapWords fills lines greedily and keeps a too-wide word on its own line', () => {
  const words = [3, 3, 3, 10, 2].map(width => ({ width }))
  const lines = wrapWords(words, 8, () => 1)
  assert.deepEqual(lines, [[0, 1], [2], [3], [4]])
  assert.deepEqual(wrapWords([], 8, () => 1), [])
  assert.deepEqual(wrapWords([{ width: 4 }, { width: 3 }], 8, () => 1), [[0, 1]])
})

test('cleanText drops control characters and collapses whitespace', () => {
  assert.equal(cleanText('  a\u0007b\n\tc  ‮d '), 'ab c d')
  assert.equal(cleanText(null), '')
  assert.equal(cleanText(42), '42')
  assert.equal(cleanText('x'.repeat(5000)).length, 2001)
})

test('paper sizes: 80 mm is 576 dots, 58 mm is 384, anything else is 80', () => {
  assert.equal(paperFor(80).dots, 576)
  assert.equal(paperFor(58).dots, 384)
  assert.equal(paperFor('nope').dots, 576)
  assert.ok(paperFor(58).dpp < paperFor(80).dpp)
})

for (const width of [80, 58]) {
  test(`about 42 monospace characters fit a line at sm on ${width} mm`, () => {
    const one = layoutDoc(doc({ k: 'text', t: 'X'.repeat(42) }), fonts, width)
    assert.equal(baselines(one.items).length, 1)
    const two = layoutDoc(doc({ k: 'text', t: 'X'.repeat(44) }), fonts, width)
    assert.equal(baselines(two.items).length, 2, '44 characters break onto a second line')
    const max = Math.max(...glyphs(one.items).map(g => g.x))
    assert.ok(max < one.width, 'no glyph starts past the paper')
  })
}

test('text wraps by words, and a long word is broken', () => {
  const words = layoutDoc(doc({ k: 'text', t: 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu' }), fonts, 80)
  assert.equal(baselines(words.items).length, 2)
  const long = layoutDoc(doc({ k: 'text', t: 'A'.repeat(100) }), fonts, 80)
  assert.equal(baselines(long.items).length, 3)
  assert.equal(glyphs(long.items).length, 100)
})

test('centre alignment, indent and sizes', () => {
  const p = paperFor(80)
  const c = layoutDoc(doc({ k: 'text', t: 'MID', align: 'center' }), fonts, 80)
  const xs = glyphs(c.items).map(g => g.x)
  const left = Math.min(...xs) - p.margin
  const right = p.margin + p.content - (Math.max(...xs) + 13)
  assert.ok(Math.abs(left - right) < 14, `centred (${left} vs ${right})`)
  const ind = layoutDoc(doc({ k: 'text', t: 'NO onion', indent: 1 }), fonts, 80)
  assert.ok(Math.min(...glyphs(ind.items).map(g => g.x)) >= p.margin + p.indent - 1)
  const sm = layoutDoc(doc({ k: 'text', t: 'H' }), fonts, 80).items[0]
  const xl = layoutDoc(doc({ k: 'text', t: 'H', size: 'xl' }), fonts, 80).items[0]
  assert.ok(Math.abs(xl.k / sm.k - 20 / 13) < 0.01)
  const bogus = layoutDoc(doc({ k: 'text', t: 'H', size: 'huge' }), fonts, 80).items[0]
  assert.equal(bogus.k, sm.k)
})

test('a row keeps the right text on its first line, right-aligned, and wraps the left', () => {
  const p = paperFor(80)
  const l = layoutDoc(doc({ k: 'row', l: 'VERY LONG DISH NAME THAT WILL HAVE TO WRAP ONTO A SECOND LINE', r: '×12', lBold: true, rBold: true, rSize: 'md' }), fonts, 80)
  const bl = baselines(l.items)
  assert.equal(bl.length, 2)
  const firstLine = glyphs(l.items).filter(g => Math.round(g.y) === bl[0])
  const rightmost = firstLine.reduce((a, g) => (g.x > a.x ? g : a))
  assert.ok(rightmost.x > p.margin + p.content - 20, 'the right text ends at the right margin')
  const second = glyphs(l.items).filter(g => Math.round(g.y) === bl[1])
  assert.ok(Math.max(...second.map(g => g.x)) < rightmost.x - 30, 'the second line is the left text only')
})

test('strike: a text line is struck through; a row strikes only its left text', () => {
  const t = layoutDoc(doc({ k: 'text', t: 'Cancelled', strike: true }), fonts, 80)
  assert.equal(rects(t.items).length, 1)
  const r = layoutDoc(doc({ k: 'row', l: 'VEG MOMO', r: '×2', strike: true, rSize: 'md' }), fonts, 80)
  const [bar] = rects(r.items)
  assert.ok(bar)
  const rightGlyphX = Math.max(...glyphs(r.items).map(g => g.x))
  assert.ok(bar.x + bar.w < rightGlyphX - 100, 'the bar stops at the end of the left text')
  const plainRow = layoutDoc(doc({ k: 'row', l: 'VEG MOMO', r: '×2' }), fonts, 80)
  assert.equal(rects(plainRow.items).length, 0)
})

test('hr is a dashed rule across the paper', () => {
  const p = paperFor(80)
  const h = layoutDoc(doc({ k: 'hr' }), fonts, 80)
  const dashes = rects(h.items)
  assert.ok(dashes.length > 20)
  assert.ok(dashes[0].x === p.margin)
  assert.ok(dashes.at(-1).x + dashes.at(-1).w <= p.margin + p.content)
})

test('Nepali is shaped with the Devanagari font (the i-sign moves before its consonant)', () => {
  const l = layoutDoc(doc({ k: 'text', t: 'कि' }), fonts, 80)
  const g = glyphs(l.items).sort((a, b) => a.x - b.x)
  assert.equal(g[0].face.name, 'deva')
  assert.notEqual(g[0].gid, fonts.faces.deva.font.glyph(0x0915), 'the first glyph drawn is the i-sign, not क')
  const conj = fonts.shapeWord('स्पेशल', 20, false)
  assert.ok(conj.glyphs.length < [...'स्पेशल'].length, 'the conjunct स्प joins into fewer glyphs')
})

test('symbols fall back to a font that has them', () => {
  const face = t => fonts.shapeWord(t, 20, false).glyphs[0].face.name
  assert.equal(face('×'), 'mono')
  assert.equal(face('↓'), 'mono')
  assert.equal(face('↳'), 'math')
  assert.equal(face('—'), 'mono')
  const missing = fonts.shapeWord('↳', 20, false).glyphs[0]
  assert.notEqual(missing.gid, 0, '↳ is not the empty box')
})

test('bold uses the bold font files', () => {
  assert.equal(fonts.shapeWord('A', 20, true).glyphs[0].face.name, 'monoBold')
  assert.equal(fonts.shapeWord('क', 20, true).glyphs[0].face.name, 'devaBold')
})

test('late line: after the first lg/xl title, in Nepal time, or at the top', () => {
  assert.equal(nepalHHMM('2026-10-14T08:20:00Z'), '14:05')
  assert.equal(nepalHHMM('2026-10-14T18:30:00Z'), '00:15')
  assert.equal(nepalHHMM('nonsense'), '')
  const d = doc({ k: 'text', t: 'Outlet', size: 'md' }, { k: 'text', t: 'KITCHEN ORDER TICKET', size: 'lg' }, { k: 'hr' })
  const late = withLateLine(d, '2026-10-14T08:20:00Z')
  assert.equal(late.lines.length, 4)
  assert.deepEqual(late.lines[2], { k: 'text', t: 'PRINTED LATE — sent 14:05', align: 'center', bold: true, size: 'md' })
  assert.equal(d.lines.length, 3, 'the job doc is not changed')
  const top = withLateLine(doc({ k: 'hr' }), '2026-10-14T08:20:00Z')
  assert.equal(top.lines[0].t, 'PRINTED LATE — sent 14:05')
})

test('untrusted docs never throw: odd values, unknown kinds, too many lines', () => {
  const weird = { v: 1, lines: [null, 7, 'x', { k: 'nope' }, { k: 'text', t: { a: 1 } }, { k: 'row', l: null, r: 5 }, { k: 'text', t: '<script>alert(1)</script>\u001b[2J' }] }
  const bmp = renderDoc(weird, fonts, 80)
  assert.equal(bmp.width, 576)
  assert.ok(bmp.height > 0)
  assert.doesNotThrow(() => renderDoc(null, fonts, 58))
  assert.doesNotThrow(() => renderDoc({ lines: 'nope' }, fonts, 80))
  const many = { v: 1, lines: Array.from({ length: 400 }, (_, i) => ({ k: 'text', t: `line ${i}` })) }
  const l = layoutDoc(many, fonts, 80)
  assert.equal(baselines(l.items).length, MAX_LINES)
})

test('renderDoc draws black dots inside the paper width', () => {
  const bmp = renderDoc(doc({ k: 'text', t: 'KITCHEN ORDER TICKET', size: 'lg', bold: true, align: 'center' }, { k: 'hr' }), fonts, 58)
  assert.equal(bmp.width, 384)
  assert.equal(bmp.data.length, bmp.width * bmp.height)
  const black = bmp.data.reduce((a, b) => a + b, 0)
  assert.ok(black > 500)
})
