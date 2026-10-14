'use strict'
// The helper's binary assets (the HarfBuzz WASM and the fonts). Packed as a Node single executable
// application they are SEA assets (build/build.mjs lists them); run from source they are read from
// disk. Every name here must also be in the build's asset list.
const fs = require('node:fs')
const path = require('node:path')

let sea = null
try { sea = require('node:sea') } catch { sea = null }

const isSea = () => !!(sea && typeof sea.isSea === 'function' && sea.isSea())

const FONT_DIR = path.join(__dirname, '..', 'fonts')

const ASSET_NAMES = [
  'harfbuzz.wasm',
  'NotoSansMono-Regular.ttf',
  'NotoSansMono-Bold.ttf',
  'NotoSansDevanagari-Regular.ttf',
  'NotoSansDevanagari-Bold.ttf',
  'NotoSansSymbols2-Regular.ttf',
  'NotoSansMath-Regular.ttf',
  'OFL.txt',
]

function diskPath(name) {
  if (name === 'harfbuzz.wasm') return require.resolve('harfbuzzjs/dist/harfbuzz.wasm')
  return path.join(FONT_DIR, name)
}

/** The asset's bytes as a Uint8Array. */
function getAsset(name) {
  if (!ASSET_NAMES.includes(name)) throw new Error(`Unknown asset ${name}`)
  if (isSea()) return new Uint8Array(sea.getAsset(name))
  return new Uint8Array(fs.readFileSync(diskPath(name)))
}

module.exports = { getAsset, isSea, ASSET_NAMES, diskPath }
