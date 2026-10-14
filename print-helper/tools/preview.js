'use strict'
// Draws the sample tickets to PNG files, to check the layout and the Nepali shaping by eye.
// Usage: node tools/preview.js <output folder>
const fs = require('node:fs')
const path = require('node:path')
const { FontSet } = require('../src/fonts')
const { renderDoc, withLateLine } = require('../src/render')
const { encodePng } = require('../src/png')
const { sampleKotDoc, sampleVoidDoc, sampleMoveDoc, testPrintDoc } = require('../src/samples')

async function main() {
  const out = process.argv[2]
  if (!out) { console.error('Usage: node tools/preview.js <output folder>'); process.exit(2) }
  fs.mkdirSync(out, { recursive: true })
  const fonts = await FontSet.load()
  const late = withLateLine(sampleKotDoc({ reprint: false }), new Date(Date.UTC(2026, 9, 14, 8, 20)).toISOString())
  const jobs = [
    ['kot-80mm.png', sampleKotDoc(), 80],
    ['kot-58mm.png', sampleKotDoc(), 58],
    ['kot-late-80mm.png', late, 80],
    ['void-80mm.png', sampleVoidDoc(), 80],
    ['move-58mm.png', sampleMoveDoc(), 58],
    ['test-print-80mm.png', testPrintDoc({ host: '192.168.1.50', port: 9100, width: 80 }), 80],
  ]
  for (const [name, doc, width] of jobs) {
    const t0 = process.hrtime.bigint()
    const bmp = renderDoc(doc, fonts, width)
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    fs.writeFileSync(path.join(out, name), encodePng(bmp))
    console.log(`${name}: ${bmp.width}x${bmp.height} dots, ${ms.toFixed(0)} ms`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
