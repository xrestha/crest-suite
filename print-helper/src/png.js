'use strict'
// A tiny PNG encoder for 1-bit page images (tools/preview.js and the --preview flag): grayscale,
// 1 bit per pixel, black ink on white paper.
const zlib = require('node:zlib')

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(td) >>> 0)
  return Buffer.concat([len, td, crc])
}

/** bitmap: { width, height, data } with one byte per dot (1 = black). Returns a PNG Buffer. */
function encodePng(bitmap) {
  const { width, height, data } = bitmap
  const rowBytes = Math.ceil(width / 8)
  const raw = Buffer.alloc((rowBytes + 1) * height)
  for (let y = 0; y < height; y++) {
    const o = y * (rowBytes + 1)
    raw[o] = 0
    for (let x = 0; x < width; x++) {
      // PNG grayscale: 1 is white, so a white dot sets the bit.
      if (!data[y * width + x]) raw[o + 1 + (x >> 3)] |= 0x80 >> (x & 7)
    }
    // Padding bits past the width stay 0 (black) but are never shown.
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 1 // bit depth
  ihdr[9] = 0 // grayscale
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

module.exports = { encodePng }
