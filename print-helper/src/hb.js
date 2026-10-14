'use strict'
// Loads harfbuzzjs. Run from source, its own module initialises itself (it reads its WASM from
// node_modules). In the bundle (build/build.mjs) an esbuild plugin replaces that top-level await with
// an exported __crestInit(wasmBytes), because a CommonJS single executable cannot top-level await
// or read node_modules; the WASM then comes from the SEA assets.
const { getAsset } = require('./assets')

let ready = null

function loadHarfbuzz() {
  if (!ready) {
    ready = (async () => {
      const hb = await import('harfbuzzjs')
      if (typeof hb.__crestInit === 'function') await hb.__crestInit(getAsset('harfbuzz.wasm'))
      return hb
    })()
  }
  return ready
}

module.exports = { loadHarfbuzz }
