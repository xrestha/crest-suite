// Applies the built SQL files to the LIVE database, in name order, one transaction per file.
//   node apply.mjs --out <dir> --only "^0[01]_"        (a regex over file names)
// Remembers what it applied in <dir>/applied.json, skips those on a re-run, and stops at the
// first error so nothing after a failure lands.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const outDir = arg('--out', 'out')
const only = new RegExp(arg('--only', '.'))
const status = arg('--status', null)        // optional: node script to call with progress lines
const CLI = path.join(process.env.APPDATA || 'C:/Users/xrest/AppData/Roaming', 'npm/node_modules/supabase/dist/supabase.js')

const ledgerFile = path.join(outDir, 'applied.json')
const applied = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : {}
const files = fs.readdirSync(outDir).filter(f => f.endsWith('.sql') && only.test(f)).sort()
let done = 0
for (const f of files) {
  if (applied[f]) { done++; continue }
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [CLI, 'db', 'query', '--linked', '--agent', 'no', '-o', 'json', '-f', path.join(outDir, f)],
    { cwd: 'C:/crest-suite', encoding: 'utf8', maxBuffer: 1 << 28 })
  const outText = (r.stdout || '') + (r.stderr || '')
  if (r.status !== 0 || /"_tag":"Error"|Failed to run sql query|unexpected status/.test(outText)) {
    console.error(`FAILED ${f}\n${outText.slice(0, 3000)}`)
    process.exit(1)
  }
  applied[f] = new Date().toISOString()
  fs.writeFileSync(ledgerFile, JSON.stringify(applied, null, 1))
  done++
  const line = `applied ${f} (${((Date.now() - t0) / 1000).toFixed(1)}s) — ${done}/${files.length}`
  console.log(line)
  if (status) spawnSync(process.execPath, [status, 'log', line], { encoding: 'utf8' })
}
console.log(`done: ${done}/${files.length}`)
