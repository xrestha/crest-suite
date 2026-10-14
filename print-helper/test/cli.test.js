'use strict'
// The program as a whole, as a child process: pairing typed on stdin, a job printed and reported,
// the single-instance guard, and a clean exit. Runs `node src/cli.js`, or the packed executable
// when CREST_HELPER_BIN points at one (e.g. dist/linux/crest-print-helper).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { tmpDir, captureServer, waitFor, mockCrest, job } = require('./support')

const BIN = process.env.CREST_HELPER_BIN
const cmd = BIN ? [path.resolve(BIN), []] : [process.execPath, [path.join(__dirname, '..', 'src', 'cli.js')]]

function start(args, env) {
  const child = spawn(cmd[0], [...cmd[1], ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const out = { text: '' }
  child.stdout.on('data', (d) => { out.text += d })
  child.stderr.on('data', (d) => { out.text += d })
  const exited = new Promise(r => child.on('exit', (code, signal) => r({ code, signal })))
  return { child, out, exited }
}

test('--version prints the version', async () => {
  const p = start(['--version'], {})
  const { code } = await p.exited
  assert.equal(code, 0)
  assert.equal(p.out.text.trim(), 'Crest Print Helper 1.0.0')
})

test('pairs from a typed code, prints a job, refuses a second copy, and exits cleanly', async () => {
  const printer = await captureServer()
  const crest = await mockCrest({ codes: { GOOD2345: 'helper' }, device: { printers: [{ station: 'KOT', host: '127.0.0.1', port: printer.port, width: 80 }] } })
  const home = tmpDir()
  const env = { CREST_SUPABASE_URL: crest.url, CREST_SUPABASE_ANON_KEY: crest.key, CREST_PRINT_HELPER_HOME: home }
  const a = start([], env)
  try {
    await waitFor(() => a.out.text.includes('Pairing code:'), { what: 'pairing prompt' })
    a.child.stdin.write('good-2345\n')
    await waitFor(() => a.out.text.includes('Connected to Crest — outlet: Himalayan Kitchen, this helper: Counter PC'), { what: 'connected' })
    const j = job({ label: 'Table 4 · #23' })
    crest.state.queue.push(j)
    await waitFor(() => crest.state.printed.includes(j.id), { what: 'printed report' })
    assert.equal(printer.prints.length, 1)
    assert.match(a.out.text, /\d\d:\d\d {2}Printed kitchen ticket "Table 4 · #23"/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).deviceId, crest.state.device.id)

    const b = start([], env)
    const second = await b.exited
    assert.equal(second.code, 1)
    assert.match(b.out.text, /already running on this computer/)

    a.child.kill('SIGTERM')
    const first = await a.exited
    assert.equal(first.code, 0)
    assert.equal(fs.existsSync(path.join(home, 'helper.lock')), false, 'the lock is released')
    const log = fs.readFileSync(path.join(home, 'helper.log'), 'utf8')
    assert.match(log, /INFO start 1\.0\.0/)
    assert.ok(!log.includes(crest.state.secret), 'the secret never reaches the log')
    assert.ok(!a.out.text.includes('    at '), 'no stack traces on screen')
  } finally {
    a.child.kill('SIGKILL')
    await crest.close()
    await printer.close()
  }
})
