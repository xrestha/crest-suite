'use strict'
// Lays a ticket document (docs/kitchen-printers.md, version 1) out on thermal paper and draws it as
// a 1-bit image. Sizes are the contract's CSS px, scaled so `sm` text fits about 42 monospace
// characters on 80 mm paper (576 dots); 58 mm paper (384 dots) is the same layout scaled down.
// Every string in a doc is untrusted: it is only ever drawn as plain text.
const { renderPage } = require('./raster')

const SIZE_PX = { xs: 11, sm: 13, md: 15, lg: 17, xl: 20 }
const PAPER_DOTS = { 80: 576, 58: 384 }
const DOTS_PER_PX_80 = 1.7
const MAX_LINES = 300
const MAX_TEXT = 2000

// Spacing in CSS px, as the till's own print window lays the doc out (ticketDoc.js TICKET_CSS).
const TEXT_PAD = 1
const ROW_PAD = 3
const HR_MARGIN = 7
const LINE_GAP = 1
// Minimum line box, in ems of the line's size, so short lines of capitals still space evenly.
const MIN_ASCENT = 0.80
const MIN_DESCENT = 0.24

function paperFor(width) {
  const w = Number(width) === 58 ? 58 : 80
  const dots = PAPER_DOTS[w]
  const dpp = DOTS_PER_PX_80 * (dots / PAPER_DOTS[80])
  const margin = Math.round(8 * (dots / PAPER_DOTS[80]))
  const charW = 0.6 * SIZE_PX.sm * dpp
  return {
    width: w,
    dots,
    dpp,
    margin,
    content: dots - 2 * margin,
    indent: 2 * charW,
    gap: charW,
    top: Math.round(6 * (dots / PAPER_DOTS[80])),
    bottom: Math.round(10 * (dots / PAPER_DOTS[80])),
    hrDash: Math.max(4, Math.round(9 * (dots / PAPER_DOTS[80]))),
    hrGap: Math.max(3, Math.round(6 * (dots / PAPER_DOTS[80]))),
    hrThick: 2,
  }
}

const sizeOf = s => (Object.prototype.hasOwnProperty.call(SIZE_PX, s) ? s : 'sm')

// Plain text only: control characters and bidi overrides are dropped, runs of whitespace become one
// space (as HTML collapses them), and an absurdly long string is cut.
function cleanText(v) {
  let s = typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v))
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩﻿]/g, '')
  s = s.replace(/\s+/g, ' ').trim()
  if (s.length > MAX_TEXT) s = `${s.slice(0, MAX_TEXT)}…`
  return s
}

const graphemes = (() => {
  let seg = null
  try { seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' }) } catch { seg = null }
  return s => (seg ? Array.from(seg.segment(s), x => x.segment) : Array.from(s))
})()

/**
 * Greedy word wrap. `words` are { width, ... }; `spaceAfter(i)` is the gap between word i and i+1;
 * `maxWidth` the line width. Words wider than a line come back as their own line (the caller breaks
 * them first). Returns arrays of word indexes, one per line.
 */
function wrapWords(words, maxWidth, spaceAfter) {
  const lines = []
  let cur = []
  let w = 0
  words.forEach((word, i) => {
    if (!cur.length) { cur = [i]; w = word.width; return }
    const gap = spaceAfter(cur[cur.length - 1])
    if (w + gap + word.width <= maxWidth + 0.01) { cur.push(i); w += gap + word.width }
    else { lines.push(cur); cur = [i]; w = word.width }
  })
  if (cur.length) lines.push(cur)
  return lines
}

class Layout {
  constructor(fonts, width) {
    this.fonts = fonts
    this.p = paperFor(width)
    this.items = []
    this.y = this.p.top
  }

  sizeDots(size) { return SIZE_PX[size] * this.p.dpp }

  /** Shape a string into words, hard-breaking any word wider than maxWidth. */
  words(text, sizeDots, bold, spacing, maxWidth) {
    const out = []
    for (const raw of text.split(' ')) {
      if (!raw) continue
      const w = this.fonts.shapeWord(raw, sizeDots, bold, spacing)
      if (w.width <= maxWidth) { out.push(w); continue }
      // Too long for a line: cut between graphemes where the pieces fit.
      let piece = ''
      let pieceW = 0
      for (const g of graphemes(raw)) {
        const gw = this.fonts.shapeWord(g, sizeDots, bold, spacing).width + spacing
        if (piece && pieceW + gw > maxWidth) {
          out.push(this.fonts.shapeWord(piece, sizeDots, bold, spacing))
          piece = ''; pieceW = 0
        }
        piece += g; pieceW += gw
      }
      if (piece) out.push(this.fonts.shapeWord(piece, sizeDots, bold, spacing))
    }
    return out
  }

  /** Words → visual lines: [{ words, gaps, width, top, bottom }]. */
  lines(words, maxWidth, sizeDots, spacing) {
    const gapAfter = i => this.fonts.spaceWidth(words[i].lastFamily, sizeDots) + spacing
    return wrapWords(words, maxWidth, gapAfter).map(idx => {
      let width = 0
      let top = 0
      let bottom = 0
      const gaps = []
      idx.forEach((wi, n) => {
        const w = words[wi]
        if (n > 0) { const g = gapAfter(idx[n - 1]); gaps.push(g); width += g }
        width += w.width
        top = Math.max(top, w.top)
        bottom = Math.min(bottom, w.bottom)
      })
      return { words: idx.map(i => words[i]), gaps, width, top, bottom }
    })
  }

  place(line, x, baseline) {
    let pen = x
    line.words.forEach((w, n) => {
      if (n > 0) pen += line.gaps[n - 1]
      for (const g of w.glyphs) {
        const b = g.face.box(g.gid)
        if (!b) continue
        this.items.push({ t: 'glyph', face: g.face, gid: g.gid, x: pen + g.x, y: baseline - g.dy, k: g.k, fakeBold: g.fakeBold, top: b.top * g.k, bottom: b.bottom * g.k })
      }
      pen += w.width
    })
  }

  strike(x, baseline, width, sizeDots) {
    const thick = Math.max(2, Math.round(sizeDots * 0.075))
    this.items.push({ t: 'rect', x: Math.floor(x), y: Math.round(baseline - sizeDots * 0.30 - thick / 2), w: Math.ceil(width) + 1, h: thick })
  }

  text(l) {
    const p = this.p
    const size = sizeOf(l.size)
    const sd = this.sizeDots(size)
    const center = l.align === 'center'
    const spacing = center && size === 'lg' ? 1 * p.dpp : center && size === 'xl' ? 2 * p.dpp : 0
    const indent = l.indent ? p.indent : 0
    const maxW = p.content - indent
    const words = this.words(cleanText(l.t), sd, !!l.bold, spacing, maxW)
    this.y += TEXT_PAD * p.dpp
    for (const vl of this.lines(words, maxW, sd, spacing)) {
      const asc = Math.max(MIN_ASCENT * sd, vl.top)
      const desc = Math.max(MIN_DESCENT * sd, -vl.bottom)
      const baseline = Math.round(this.y + asc)
      const x = p.margin + indent + (center ? Math.max(0, (maxW - vl.width) / 2) : 0)
      this.place(vl, x, baseline)
      if (l.strike) this.strike(x, baseline, vl.width, sd)
      this.y = baseline + desc + LINE_GAP * p.dpp
    }
    this.y += TEXT_PAD * p.dpp
  }

  row(l) {
    const p = this.p
    const size = sizeOf(l.size)
    const rSize = l.rSize ? sizeOf(l.rSize) : size
    const lBold = l.lBold ?? l.bold
    const rBold = l.rBold ?? l.bold
    const sdL = this.sizeDots(size)
    const sdR = this.sizeDots(rSize)
    // The right side keeps to one line unless it alone would take more than 60% of the paper.
    const rMax = p.content * 0.6
    const rWords = this.words(cleanText(l.r), sdR, !!rBold, 0, rMax)
    const rLines = this.lines(rWords, rMax, sdR, 0)
    const rWidth = rLines.reduce((m, x) => Math.max(m, x.width), 0)
    const lMax = rWidth > 0 ? p.content - rWidth - p.gap : p.content
    const lLines = this.lines(this.words(cleanText(l.l), sdL, !!lBold, 0, lMax), lMax, sdL, 0)
    this.y += ROW_PAD * p.dpp
    const n = Math.max(lLines.length, rLines.length)
    for (let i = 0; i < n; i++) {
      const L = lLines[i]
      const R = rLines[i]
      const asc = Math.max(L ? Math.max(MIN_ASCENT * sdL, L.top) : 0, R ? Math.max(MIN_ASCENT * sdR, R.top) : 0)
      const desc = Math.max(L ? Math.max(MIN_DESCENT * sdL, -L.bottom) : 0, R ? Math.max(MIN_DESCENT * sdR, -R.bottom) : 0)
      const baseline = Math.round(this.y + asc)
      if (L) {
        this.place(L, p.margin, baseline)
        if (l.strike) this.strike(p.margin, baseline, L.width, sdL)
      }
      if (R) this.place(R, p.margin + p.content - R.width, baseline)
      this.y = baseline + desc + LINE_GAP * p.dpp
    }
    this.y += ROW_PAD * p.dpp
  }

  hr() {
    const p = this.p
    this.y += HR_MARGIN * p.dpp
    const y = Math.round(this.y)
    for (let x = p.margin; x < p.margin + p.content; x += p.hrDash + p.hrGap) {
      this.items.push({ t: 'rect', x, y, w: Math.min(p.hrDash, p.margin + p.content - x), h: p.hrThick })
    }
    this.y = y + p.hrThick + HR_MARGIN * p.dpp
  }

  add(l) {
    if (!l || typeof l !== 'object') return
    if (l.k === 'text') this.text(l)
    else if (l.k === 'row') this.row(l)
    else if (l.k === 'hr') this.hr()
  }
}

/** Lay the doc out. Returns { items, width (dots), height (dots), paper }. */
function layoutDoc(doc, fonts, width = 80) {
  const lay = new Layout(fonts, width)
  const lines = Array.isArray(doc?.lines) ? doc.lines.slice(0, MAX_LINES) : []
  for (const l of lines) lay.add(l)
  return { items: lay.items, width: lay.p.dots, height: Math.ceil(lay.y + lay.p.bottom), paper: lay.p }
}

/** Lay the doc out and draw it: { width, height, data } with one byte per dot (1 black). */
function renderDoc(doc, fonts, width = 80, opts) {
  const l = layoutDoc(doc, fonts, width)
  return renderPage(l.items, l.width, l.height, opts)
}

// Nepal has been UTC+05:45 all year since 1986, so its clock is a fixed offset from UTC.
const NEPAL_OFFSET_MS = (5 * 60 + 45) * 60 * 1000
function nepalHHMM(at) {
  const t = new Date(at).getTime()
  if (!Number.isFinite(t)) return ''
  const d = new Date(t + NEPAL_OFFSET_MS)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/**
 * The line a device adds to a job claimed late: bold, centred `PRINTED LATE — sent HH:MM` (Nepal
 * time of created_at), right after the first lg/xl title line, or at the top when there is none.
 */
function withLateLine(doc, createdAt) {
  const lines = Array.isArray(doc?.lines) ? [...doc.lines] : []
  const hhmm = nepalHHMM(createdAt)
  const late = { k: 'text', t: hhmm ? `PRINTED LATE — sent ${hhmm}` : 'PRINTED LATE', align: 'center', bold: true, size: 'md' }
  const title = lines.findIndex(l => l && l.k === 'text' && (l.size === 'lg' || l.size === 'xl'))
  lines.splice(title + 1, 0, late)
  return { ...(doc && typeof doc === 'object' ? doc : {}), lines }
}

module.exports = { layoutDoc, renderDoc, withLateLine, nepalHHMM, wrapWords, cleanText, paperFor, SIZE_PX, MAX_LINES }
