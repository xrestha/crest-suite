'use strict'
// A small scanline rasterizer: glyph outlines are flattened to edges (quadratic and cubic curves cut
// into short lines), filled with the non-zero winding rule on a 4x4 supersampled strip, and each
// printer dot is black when at least half its sub-samples are covered.

const STRIP_DOTS = 64

function curveSteps(len) { return Math.max(1, Math.min(32, Math.ceil(len / 1.5))) }
const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay)

/** Outline commands (font units, y up) → edge list in sub-samples, y down, relative to the origin. */
function buildEdges(cmds, scale) {
  const edges = []
  let minY = Infinity
  let maxY = -Infinity
  let sx = 0; let sy = 0; let cx = 0; let cy = 0; let open = false
  const line = (x0, y0, x1, y1) => {
    if (y0 === y1) return
    const dir = y1 > y0 ? 1 : -1
    if (dir < 0) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0] }
    edges.push(x0, y0, y1, (x1 - x0) / (y1 - y0), dir)
    if (y0 < minY) minY = y0
    if (y1 > maxY) maxY = y1
  }
  const close = () => { if (open && (cx !== sx || cy !== sy)) line(cx, cy, sx, sy); open = false }
  for (let i = 0; i < cmds.length;) {
    const op = cmds[i]
    if (op === 0) {
      close()
      sx = cx = cmds[i + 1] * scale; sy = cy = -cmds[i + 2] * scale; open = true; i += 3
    } else if (op === 1) {
      const x = cmds[i + 1] * scale; const y = -cmds[i + 2] * scale
      line(cx, cy, x, y); cx = x; cy = y; i += 3
    } else if (op === 2) {
      const qx = cmds[i + 1] * scale; const qy = -cmds[i + 2] * scale
      const x = cmds[i + 3] * scale; const y = -cmds[i + 4] * scale
      const n = curveSteps(dist(cx, cy, qx, qy) + dist(qx, qy, x, y))
      let px = cx; let py = cy
      for (let s = 1; s <= n; s++) {
        const t = s / n; const u = 1 - t
        const nx = u * u * cx + 2 * u * t * qx + t * t * x
        const ny = u * u * cy + 2 * u * t * qy + t * t * y
        line(px, py, nx, ny); px = nx; py = ny
      }
      cx = x; cy = y; i += 5
    } else if (op === 3) {
      const ax = cmds[i + 1] * scale; const ay = -cmds[i + 2] * scale
      const bx = cmds[i + 3] * scale; const by = -cmds[i + 4] * scale
      const x = cmds[i + 5] * scale; const y = -cmds[i + 6] * scale
      const n = curveSteps(dist(cx, cy, ax, ay) + dist(ax, ay, bx, by) + dist(bx, by, x, y))
      let px = cx; let py = cy
      for (let s = 1; s <= n; s++) {
        const t = s / n; const u = 1 - t
        const nx = u * u * u * cx + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * x
        const ny = u * u * u * cy + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * y
        line(px, py, nx, ny); px = nx; py = ny
      }
      cx = x; cy = y; i += 7
    } else if (op === 4) {
      close(); cx = sx; cy = sy; i += 1
    } else {
      break
    }
  }
  close()
  return { edges: Float64Array.from(edges), n: edges.length / 5, minY, maxY }
}

/** Fill an edge list (from buildEdges) into a sub-sample buffer at offset (ox, oy). Non-zero winding. */
function fillEdges(buf, bw, bh, shape, ox, oy, scratch) {
  if (!shape.n) return
  const rowStart = Math.max(0, Math.floor(shape.minY + oy))
  const rowEnd = Math.min(bh, Math.ceil(shape.maxY + oy))
  if (rowStart >= rowEnd) return
  const e = shape.edges
  if (scratch.xs.length < shape.n) { scratch.xs = new Float64Array(shape.n * 2); scratch.ds = new Int8Array(shape.n * 2) }
  const xs = scratch.xs; const ds = scratch.ds
  for (let row = rowStart; row < rowEnd; row++) {
    const sy = row + 0.5 - oy
    let cnt = 0
    for (let j = 0; j < e.length; j += 5) {
      if (sy >= e[j + 1] && sy < e[j + 2]) {
        const x = e[j] + (sy - e[j + 1]) * e[j + 3] + ox
        let k = cnt++
        while (k > 0 && xs[k - 1] > x) { xs[k] = xs[k - 1]; ds[k] = ds[k - 1]; k-- }
        xs[k] = x; ds[k] = e[j + 4]
      }
    }
    if (cnt < 2) continue
    const base = row * bw
    let wind = 0
    let start = 0
    for (let k = 0; k < cnt; k++) {
      const before = wind
      wind += ds[k]
      if (before === 0 && wind !== 0) start = xs[k]
      else if (before !== 0 && wind === 0) {
        const a = Math.max(0, Math.ceil(start - 0.5))
        const b = Math.min(bw, Math.ceil(xs[k] - 0.5))
        for (let x = a; x < b; x++) buf[base + x] = 1
      }
    }
  }
}

function fillRect(buf, bw, bh, x0, y0, x1, y1) {
  const a = Math.max(0, Math.round(x0)); const b = Math.min(bw, Math.round(x1))
  const c = Math.max(0, Math.round(y0)); const d = Math.min(bh, Math.round(y1))
  for (let y = c; y < d; y++) buf.fill(1, y * bw + a, y * bw + b)
}

function glyphShape(face, gid, scale) {
  const key = `${gid}|${scale}`
  let s = face.flat.get(key)
  if (!s) {
    s = buildEdges(face.outline(gid), scale)
    face.flat.set(key, s)
  }
  return s
}

/**
 * Draw items onto a 1-bit page. Items: { t: 'glyph', face, gid, x, y (baseline), k, fakeBold, top,
 * bottom } and { t: 'rect', x, y, w, h }, all in printer dots. Returns { width, height, data } with
 * one byte (0 white, 1 black) per dot.
 */
function renderPage(items, width, height, { ss = 4, threshold } = {}) {
  const h = Math.max(1, Math.ceil(height))
  const page = new Uint8Array(width * h)
  const need = threshold ?? Math.ceil((ss * ss) / 2)
  const bw = width * ss
  const bh = STRIP_DOTS * ss
  const buf = new Uint8Array(bw * bh)
  const scratch = { xs: new Float64Array(256), ds: new Int8Array(256) }
  for (let top = 0; top < h; top += STRIP_DOTS) {
    const bottom = Math.min(h, top + STRIP_DOTS)
    let any = false
    buf.fill(0)
    for (const it of items) {
      if (it.t === 'rect') {
        if (it.y >= bottom || it.y + it.h <= top) continue
        fillRect(buf, bw, bh, it.x * ss, (it.y - top) * ss, (it.x + it.w) * ss, (it.y + it.h - top) * ss)
        any = true
      } else if (it.t === 'glyph') {
        if (it.y - it.top >= bottom + 1 || it.y - it.bottom <= top - 1) continue
        const shape = glyphShape(it.face, it.gid, it.k * ss)
        const oy = (it.y - top) * ss
        fillEdges(buf, bw, bh, shape, it.x * ss, oy, scratch)
        if (it.fakeBold) fillEdges(buf, bw, bh, shape, it.x * ss + ss, oy, scratch)
        any = true
      }
    }
    if (!any) continue
    for (let y = top; y < bottom; y++) {
      const sy = (y - top) * ss
      for (let x = 0; x < width; x++) {
        let c = 0
        for (let j = 0; j < ss; j++) {
          const r = (sy + j) * bw + x * ss
          for (let i = 0; i < ss; i++) c += buf[r + i]
        }
        if (c >= need) page[y * width + x] = 1
      }
    }
  }
  return { width, height: h, data: page }
}

module.exports = { renderPage, buildEdges, fillEdges }
