// Builds the Crest Print Helper as a Node single executable application (SEA).
//
//   node --env-file=../.env.local build/build.mjs            Windows: dist/CrestPrintHelper.exe + .zip
//   node --env-file=../.env.local build/build.mjs --linux    Linux: dist/linux/crest-print-helper
//
// Steps: bundle src/cli.js with esbuild into one CommonJS file (the Crest address and anon key are
// baked in from REACT_APP_SUPABASE_URL / REACT_APP_SUPABASE_ANON_KEY, never printed); make the SEA
// blob with the HarfBuzz WASM and the fonts as assets; inject it with postject into a Node binary of
// this same version: the official node.exe for Windows (downloaded from nodejs.org, SHA-256 checked
// against that release's SHASUMS256.txt, cached in .cache/), or this machine's node for --linux.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { readZipEntry, writeZip } from './zip.mjs'

const require = createRequire(import.meta.url)
const { inject } = require('postject')
const { ASSET_NAMES, diskPath } = require('../src/assets.js')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const WORK = path.join(DIST, 'sea')
const CACHE = path.join(ROOT, '.cache')
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
const LINUX = process.argv.includes('--linux')

const step = msg => console.log(`• ${msg}`)
function fail(msg) { console.error(`Build failed: ${msg}`); process.exit(1) }

// ---- the Crest endpoint -------------------------------------------------------------------------

const url = (process.env.REACT_APP_SUPABASE_URL || '').trim()
const key = (process.env.REACT_APP_SUPABASE_ANON_KEY || '').trim()
if (!url || !key) fail('REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY are not set. Run it as: node --env-file=../.env.local build/build.mjs')
if (!/^https:\/\/[^\s/]+\/?$/.test(url)) fail('REACT_APP_SUPABASE_URL is not an https origin (the value is not shown)')
if (!/^[A-Za-z0-9._-]+$/.test(key)) fail('REACT_APP_SUPABASE_ANON_KEY has unexpected characters (the value is not shown)')
step(`Crest endpoint and anon key found (${url.length} and ${key.length} characters; not shown)`)

// ---- bundle -------------------------------------------------------------------------------------

// harfbuzzjs is an ES module that initialises itself with a top-level await and reads its WASM next
// to itself. A CommonJS SEA can do neither, so its init becomes an exported __crestInit(wasmBytes)
// (src/hb.js calls it with the SEA asset) and its Node file lookups are taken out. Every patch must
// apply, so a harfbuzzjs upgrade that changes these lines fails the build instead of the exe.
const harfbuzzPatch = {
  name: 'harfbuzz-sea',
  setup(b) {
    b.onLoad({ filter: /harfbuzzjs[\\/]dist[\\/](index\.mjs|harfbuzz\.js)$/ }, async (args) => {
      let src = await fs.promises.readFile(args.path, 'utf8')
      const swap = (from, to, all = false) => {
        if (!src.includes(from)) throw new Error(`harfbuzzjs patch did not apply in ${path.basename(args.path)}: ${from.slice(0, 60)}`)
        src = all ? src.split(from).join(to) : src.replace(from, to)
      }
      if (args.path.endsWith('index.mjs')) {
        swap('init(await createHarfBuzz());', 'async function __crestInit(wasmBinary) { init(await createHarfBuzz({ wasmBinary })); }')
        swap('export { AxisFlags,', 'export { __crestInit, AxisFlags,')
      } else {
        swap('const{createRequire}=await import("module");var require=createRequire(import.meta.url)', '')
        swap('import.meta.url', '"file:///crest-print-helper/harfbuzz.js"', true)
      }
      return { contents: src, loader: 'js' }
    })
  },
}

fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(WORK, { recursive: true })
const bundle = path.join(WORK, 'crest-print-helper.cjs')
step('Bundling with esbuild')
const result = await build({
  entryPoints: [path.join(ROOT, 'src', 'cli.js')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'warning',
  legalComments: 'inline',
  define: {
    __CREST_SUPABASE_URL__: JSON.stringify(url.replace(/\/+$/, '')),
    __CREST_SUPABASE_ANON_KEY__: JSON.stringify(key),
  },
  // Only resolved when running from source (src/assets.js); the SEA reads the WASM as an asset.
  external: ['harfbuzzjs/dist/harfbuzz.wasm'],
  plugins: [harfbuzzPatch],
})
if (result.errors.length) fail('esbuild reported errors')

// ---- SEA blob -----------------------------------------------------------------------------------

const assets = Object.fromEntries(ASSET_NAMES.map(n => [n, diskPath(n)]))
for (const [n, p] of Object.entries(assets)) if (!fs.existsSync(p)) fail(`asset ${n} is missing at ${p}`)
const blob = path.join(WORK, 'sea-prep.blob')
const seaConfig = path.join(WORK, 'sea-config.json')
fs.writeFileSync(seaConfig, JSON.stringify({
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  // Off, so the blob made here runs inside the Windows node.exe too.
  useSnapshot: false,
  useCodeCache: false,
  assets,
}, null, 2))
step(`Making the SEA blob with Node ${process.version}`)
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: ['ignore', 'ignore', 'inherit'] })
const blobBytes = fs.readFileSync(blob)

async function injectInto(file) {
  // postject prints progress on the console; keep only errors.
  const log = console.log
  console.log = () => {}
  try {
    await inject(file, 'NODE_SEA_BLOB', blobBytes, { sentinelFuse: FUSE, overwrite: true })
  } finally {
    console.log = log
  }
}

// ---- Linux (smoke tests on this machine) ---------------------------------------------------------

if (LINUX) {
  const outDir = path.join(DIST, 'linux')
  fs.mkdirSync(outDir, { recursive: true })
  const out = path.join(outDir, 'crest-print-helper')
  fs.copyFileSync(process.execPath, out)
  fs.chmodSync(out, 0o755)
  step('Injecting into this machine\'s node binary')
  await injectInto(out)
  step(`Wrote ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`)
  process.exit(0)
}

// ---- Windows ------------------------------------------------------------------------------------

async function download(u) {
  const res = await fetch(u)
  if (!res.ok) throw new Error(`${u}: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

const version = process.version
const zipName = `node-${version}-win-x64.zip`
const base = `https://nodejs.org/dist/${version}`
fs.mkdirSync(CACHE, { recursive: true })
const cachedZip = path.join(CACHE, zipName)
const cachedSums = path.join(CACHE, `SHASUMS256-${version}.txt`)
if (!fs.existsSync(cachedSums)) {
  step(`Downloading ${base}/SHASUMS256.txt`)
  fs.writeFileSync(cachedSums, await download(`${base}/SHASUMS256.txt`))
}
const sumLine = fs.readFileSync(cachedSums, 'utf8').split('\n').find(l => l.trim().endsWith(`  ${zipName}`))
if (!sumLine) fail(`${zipName} is not listed in SHASUMS256.txt`)
const expected = sumLine.trim().split(/\s+/)[0].toLowerCase()
if (!fs.existsSync(cachedZip)) {
  step(`Downloading ${base}/${zipName}`)
  const bytes = await download(`${base}/${zipName}`)
  fs.writeFileSync(`${cachedZip}.part`, bytes)
  fs.renameSync(`${cachedZip}.part`, cachedZip)
}
const zipBytes = fs.readFileSync(cachedZip)
const actual = crypto.createHash('sha256').update(zipBytes).digest('hex')
if (actual !== expected) {
  fs.rmSync(cachedZip, { force: true })
  fail(`${zipName} SHA-256 mismatch (expected ${expected}, got ${actual}); the cached copy was deleted, run the build again`)
}
step(`${zipName} SHA-256 verified (${actual.slice(0, 16)}…)`)

// node.exe carries the Node.js project's Authenticode signature, which injecting would break. It is
// removed first (the certificate table is the last thing in the file), so the exe is plainly
// unsigned rather than carrying a signature that no longer matches.
function stripAuthenticode(exe) {
  const pe = exe.readUInt32LE(0x3C)
  if (exe.readUInt32LE(pe) !== 0x00004550) throw new Error('node.exe is not a PE file')
  const opt = pe + 24
  const magic = exe.readUInt16LE(opt)
  const dirs = opt + (magic === 0x20B ? 112 : 96)
  const sec = dirs + 4 * 8
  const off = exe.readUInt32LE(sec)
  const size = exe.readUInt32LE(sec + 4)
  if (!off || !size) return { exe, stripped: false }
  if (off + size > exe.length || exe.subarray(off + size).some(b => b !== 0)) throw new Error('unexpected certificate table layout in node.exe')
  const out = Buffer.from(exe.subarray(0, off))
  out.writeUInt32LE(0, sec)
  out.writeUInt32LE(0, sec + 4)
  out.writeUInt32LE(0, opt + 64) // the optional header checksum, no longer valid
  return { exe: out, stripped: true }
}

step('Extracting node.exe')
const { exe: nodeExe, stripped } = stripAuthenticode(readZipEntry(zipBytes, `node-${version}-win-x64/node.exe`))
if (stripped) step('Removed node.exe\'s Authenticode signature (the helper exe is unsigned)')
const exePath = path.join(DIST, 'CrestPrintHelper.exe')
fs.writeFileSync(exePath, nodeExe)
step('Injecting the SEA blob into CrestPrintHelper.exe')
await injectInto(exePath)
const exeBytes = fs.readFileSync(exePath)
step(`Wrote dist/CrestPrintHelper.exe (${(exeBytes.length / 1e6).toFixed(1)} MB)`)

const readme = fs.readFileSync(path.join(ROOT, 'build', 'README.txt'), 'utf8').replaceAll('{{VERSION}}', PKG.version).replace(/\r?\n/g, '\r\n')
const licence = fs.readFileSync(path.join(ROOT, 'fonts', 'OFL.txt'), 'utf8').replace(/\r?\n/g, '\r\n')
// The exe is Node.js plus HarfBuzz (via harfbuzzjs); their MIT notices travel with it.
const hbLicence = fs.readFileSync(path.join(path.dirname(require.resolve('harfbuzzjs/dist/harfbuzz.wasm')), '..', 'LICENSE'), 'utf8')
const nodeLicence = readZipEntry(zipBytes, `node-${version}-win-x64/LICENSE`).toString('utf8')
const thirdParty = [
  'Crest Print Helper is built on the following software. Their licences follow.',
  '',
  `  Node.js ${version}  https://nodejs.org`,
  '  harfbuzzjs / HarfBuzz  https://github.com/harfbuzz/harfbuzzjs',
  '  Noto fonts: see FONTS-LICENSE.txt',
  '',
  '='.repeat(78), `Node.js ${version}`, '='.repeat(78), nodeLicence,
  '='.repeat(78), 'harfbuzzjs', '='.repeat(78), hbLicence,
].join('\n').replace(/\r?\n/g, '\r\n')
const zipPath = path.join(DIST, 'CrestPrintHelper.zip')
fs.writeFileSync(zipPath, writeZip([
  { name: 'CrestPrintHelper.exe', data: exeBytes },
  { name: 'README.txt', data: Buffer.from(readme) },
  { name: 'FONTS-LICENSE.txt', data: Buffer.from(licence) },
  { name: 'THIRD-PARTY-LICENSES.txt', data: Buffer.from(thirdParty) },
]))
step(`Wrote dist/CrestPrintHelper.zip (${(fs.statSync(zipPath).size / 1e6).toFixed(1)} MB)`)
