'use strict'
// Fonts and text shaping. Text is split into runs by script and glyph coverage, and each run is
// shaped by HarfBuzz with the font that covers it: Noto Sans Mono for Latin and most symbols, Noto
// Sans Devanagari for Nepali, then Noto Sans Symbols 2 and Noto Sans Math for anything Mono lacks
// (Math has the ↳ arrow). A character no font has prints as Mono's empty box.
const { getAsset } = require('./assets')
const { loadHarfbuzz } = require('./hb')

// Unhinted TTFs from the notofonts GitHub releases: NotoSansMono-v2.014, NotoSansDevanagari-v2.007,
// NotoSansSymbols2-v2.008, NotoSansMath-v3.000 (fonts/OFL.txt). Every file is also a SEA asset.
const FILES = {
  mono: 'NotoSansMono-Regular.ttf',
  monoBold: 'NotoSansMono-Bold.ttf',
  deva: 'NotoSansDevanagari-Regular.ttf',
  devaBold: 'NotoSansDevanagari-Bold.ttf',
  sym: 'NotoSansSymbols2-Regular.ttf',
  math: 'NotoSansMath-Regular.ttf',
}

// Devanagari reads small next to Latin capitals at the same em, so it is drawn a little larger.
const DEVA_SCALE = 1.12

const FAMILIES = {
  mono: { regular: 'mono', bold: 'monoBold', scale: 1, lang: null },
  deva: { regular: 'deva', bold: 'devaBold', scale: DEVA_SCALE, lang: 'ne' },
  sym: { regular: 'sym', bold: null, scale: 1, lang: null },
  math: { regular: 'math', bold: null, scale: 1, lang: null },
}

const isDevanagari = cp => (cp >= 0x0900 && cp <= 0x097F) || (cp >= 0xA8E0 && cp <= 0xA8FF) || (cp >= 0x1CD0 && cp <= 0x1CFF)
// Characters that belong to the run they sit in: joiners, variation selectors, combining marks.
const isAttaching = cp => cp === 0x200C || cp === 0x200D || (cp >= 0xFE00 && cp <= 0xFE0F)
  || (cp >= 0x0300 && cp <= 0x036F) || (cp >= 0x1AB0 && cp <= 0x1AFF) || (cp >= 0x20D0 && cp <= 0x20FF)

class FaceEntry {
  constructor(hb, drawFuncs, name, bytes) {
    this.name = name
    this.hb = hb
    this.drawFuncs = drawFuncs
    this.blob = new hb.Blob(bytes)
    this.face = new hb.Face(this.blob, 0)
    this.font = new hb.Font(this.face)
    this.upem = this.face.upem
    this.cps = new Set(this.face.collectUnicodes())
    this.outlines = new Map()
    this.boxes = new Map()
    this.flat = new Map()
    const sp = this.font.glyph(0x20)
    this.spaceAdvance = sp !== undefined ? this.font.glyphHAdvance(sp) : this.upem / 2
  }

  covers(cp) { return this.cps.has(cp) }

  /** Outline commands in font units: 0 move x y, 1 line x y, 2 quad cx cy x y, 3 cubic …, 4 close. */
  outline(gid) {
    let o = this.outlines.get(gid)
    if (!o) {
      o = []
      this.font.drawGlyph(gid, this.drawFuncs, o)
      this.outlines.set(gid, o)
    }
    return o
  }

  /** The glyph's ink top and bottom in font units (y up), or null for an empty glyph. */
  box(gid) {
    if (this.boxes.has(gid)) return this.boxes.get(gid)
    const e = this.font.glyphExtents(gid)
    const b = e && e.height !== 0 ? { top: e.yBearing, bottom: e.yBearing + e.height } : null
    this.boxes.set(gid, b)
    return b
  }
}

class FontSet {
  constructor(hb, faces) {
    this.hb = hb
    this.faces = faces
    this.buffer = new hb.Buffer()
  }

  static async load() {
    const hb = await loadHarfbuzz()
    const df = new hb.DrawFuncs()
    df.setMoveToFunc((x, y, out) => { out.push(0, x, y) })
    df.setLineToFunc((x, y, out) => { out.push(1, x, y) })
    df.setQuadraticToFunc((cx, cy, x, y, out) => { out.push(2, cx, cy, x, y) })
    df.setCubicToFunc((ax, ay, bx, by, x, y, out) => { out.push(3, ax, ay, bx, by, x, y) })
    df.setClosePathFunc(out => { out.push(4) })
    const faces = {}
    for (const [key, file] of Object.entries(FILES)) faces[key] = new FaceEntry(hb, df, key, getAsset(file))
    return new FontSet(hb, faces)
  }

  /** Which family draws this code point, given the family of the run it follows. */
  familyFor(cp, prev) {
    const f = this.faces
    if (isDevanagari(cp)) return 'deva'
    if (prev && isAttaching(cp) && f[FAMILIES[prev].regular].covers(cp)) return prev
    if (f.mono.covers(cp)) return 'mono'
    if (f.sym.covers(cp)) return 'sym'
    if (f.math.covers(cp)) return 'math'
    if (f.deva.covers(cp)) return 'deva'
    return 'mono'
  }

  /** Split a string (no spaces needed) into [{ family, text }] runs. */
  runs(text) {
    const out = []
    let prev = null
    for (const ch of text) {
      const fam = this.familyFor(ch.codePointAt(0), prev)
      if (out.length && out[out.length - 1].family === fam) out[out.length - 1].text += ch
      else out.push({ family: fam, text: ch })
      prev = fam
    }
    return out
  }

  faceFor(family, bold) {
    const fam = FAMILIES[family]
    if (bold && fam.bold) return { face: this.faces[fam.bold], fakeBold: false }
    return { face: this.faces[fam.regular], fakeBold: !!bold }
  }

  spaceWidth(family, sizeDots) {
    const fam = FAMILIES[family || 'mono']
    const face = this.faces[fam.regular]
    return face.spaceAdvance * (sizeDots * fam.scale) / face.upem
  }

  /**
   * Shape one word. Returns { glyphs: [{ face, gid, x, dy, k, fakeBold }], width, top, bottom,
   * lastFamily }: x from the word's start in dots, dy the glyph's baseline lift in dots (up),
   * k dots per font unit, top/bottom the ink extent in dots above (+) and below (-) the baseline.
   */
  shapeWord(text, sizeDots, bold, letterSpacing = 0) {
    const glyphs = []
    let pen = 0
    let top = 0
    let bottom = 0
    let lastFamily = null
    for (const run of this.runs(text)) {
      const fam = FAMILIES[run.family]
      const { face, fakeBold } = this.faceFor(run.family, bold)
      const k = (sizeDots * fam.scale) / face.upem
      const buf = this.buffer
      buf.clearContents()
      buf.addText(run.text)
      buf.guessSegmentProperties()
      if (fam.lang) buf.setLanguage(fam.lang)
      this.hb.shape(face.font, buf)
      const infos = buf.getGlyphInfosAndPositions()
      const spacing = run.family === 'deva' ? 0 : letterSpacing
      for (let i = 0; i < infos.length; i++) {
        const g = infos[i]
        const dy = g.yOffset * k
        glyphs.push({ face, gid: g.codepoint, x: pen + g.xOffset * k, dy, k, fakeBold })
        const b = face.box(g.codepoint)
        if (b) {
          top = Math.max(top, dy + b.top * k)
          bottom = Math.min(bottom, dy + b.bottom * k)
        }
        pen += g.xAdvance * k
        if (spacing && (i === infos.length - 1 || infos[i + 1].cluster !== g.cluster)) pen += spacing
      }
      lastFamily = run.family
    }
    if (letterSpacing && lastFamily !== 'deva' && glyphs.length) pen -= letterSpacing
    return { glyphs, width: pen, top, bottom, lastFamily }
  }
}

module.exports = { FontSet, FAMILIES, DEVA_SCALE, isDevanagari }
