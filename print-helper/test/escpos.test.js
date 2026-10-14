'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { buildEscPos } = require('../src/escpos')

function bitmap(width, height, black = []) {
  const data = new Uint8Array(width * height)
  for (const [x, y] of black) data[y * width + x] = 1
  return { width, height, data }
}

/** Walk the bytes: header, raster bands, trailer. */
function parse(buf) {
  assert.deepEqual([...buf.subarray(0, 2)], [0x1B, 0x40], 'starts with ESC @')
  let o = 2
  const bands = []
  while (buf[o] === 0x1D && buf[o + 1] === 0x76) {
    assert.equal(buf[o + 2], 0x30)
    assert.equal(buf[o + 3], 0)
    const xBytes = buf[o + 4] | (buf[o + 5] << 8)
    const rows = buf[o + 6] | (buf[o + 7] << 8)
    bands.push({ xBytes, rows, data: buf.subarray(o + 8, o + 8 + xBytes * rows) })
    o += 8 + xBytes * rows
  }
  return { bands, trailer: [...buf.subarray(o)] }
}

test('header, bands of at most 255 rows, feed and partial cut', () => {
  const out = parse(buildEscPos(bitmap(576, 600)))
  assert.deepEqual(out.bands.map(b => b.rows), [255, 255, 90])
  for (const b of out.bands) assert.equal(b.xBytes, 72)
  assert.deepEqual(out.trailer, [0x1B, 0x64, 4, 0x1D, 0x56, 66, 0])
})

test('58 mm paper is 48 bytes a row; a short image is one band', () => {
  const out = parse(buildEscPos(bitmap(384, 40)))
  assert.deepEqual(out.bands.map(b => [b.xBytes, b.rows]), [[48, 40]])
})

test('dots pack most significant bit first, 1 = black', () => {
  const out = parse(buildEscPos(bitmap(16, 2, [[0, 0], [9, 0], [15, 1]])))
  assert.deepEqual([...out.bands[0].data], [0x80, 0x40, 0x00, 0x01])
})

test('band height is capped at 255 even when asked for more', () => {
  const out = parse(buildEscPos(bitmap(8, 300), { bandRows: 1000 }))
  assert.deepEqual(out.bands.map(b => b.rows), [255, 45])
  const small = parse(buildEscPos(bitmap(8, 300), { bandRows: 100, feedLines: 2 }))
  assert.deepEqual(small.bands.map(b => b.rows), [100, 100, 100])
  assert.deepEqual(small.trailer.slice(0, 3), [0x1B, 0x64, 2])
})
