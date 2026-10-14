'use strict'
// ESC/POS bytes for a 1-bit page: initialise (ESC @), the image as GS v 0 raster bands of at most
// 255 rows, feed a few lines (ESC d n) and a partial cut (GS V 66 0).

const ESC = 0x1B
const GS = 0x1D
const MAX_BAND_ROWS = 255

/** bitmap: { width, height, data } one byte per dot (1 black). Returns a Buffer of printer bytes. */
function buildEscPos(bitmap, { bandRows = MAX_BAND_ROWS, feedLines = 4 } = {}) {
  const { width, height, data } = bitmap
  const rows = Math.max(1, Math.min(MAX_BAND_ROWS, bandRows | 0))
  const bytesPerRow = Math.ceil(width / 8)
  const parts = [Buffer.from([ESC, 0x40])]
  for (let y0 = 0; y0 < height; y0 += rows) {
    const h = Math.min(rows, height - y0)
    const band = Buffer.alloc(8 + bytesPerRow * h)
    band[0] = GS; band[1] = 0x76; band[2] = 0x30; band[3] = 0 // GS v 0, normal density
    band[4] = bytesPerRow & 0xFF; band[5] = (bytesPerRow >> 8) & 0xFF
    band[6] = h & 0xFF; band[7] = (h >> 8) & 0xFF
    for (let y = 0; y < h; y++) {
      const src = (y0 + y) * width
      const dst = 8 + y * bytesPerRow
      for (let x = 0; x < width; x++) {
        if (data[src + x]) band[dst + (x >> 3)] |= 0x80 >> (x & 7)
      }
    }
    parts.push(band)
  }
  parts.push(Buffer.from([ESC, 0x64, Math.max(0, Math.min(255, feedLines | 0))]))
  parts.push(Buffer.from([GS, 0x56, 66, 0]))
  return Buffer.concat(parts)
}

module.exports = { buildEscPos, MAX_BAND_ROWS }
