'use strict'
// Where the helper keeps its files: the pairing (config.json), the delivery state (state.json, so a
// report that never got through survives a restart), the log, and the single-instance lock.
//   Windows: %APPDATA%\CrestPrintHelper    elsewhere: ~/.config/crest-print-helper
//   CREST_PRINT_HELPER_HOME overrides both.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function homeDir(env = process.env, platform = process.platform) {
  if (env.CREST_PRINT_HELPER_HOME) return env.CREST_PRINT_HELPER_HOME
  if (platform === 'win32') return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'CrestPrintHelper')
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'crest-print-helper')
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

class Store {
  constructor(dir) {
    this.dir = dir
    fs.mkdirSync(dir, { recursive: true })
    this.configFile = path.join(dir, 'config.json')
    this.stateFile = path.join(dir, 'state.json')
    this.lockFile = path.join(dir, 'helper.lock')
    this.logFile = path.join(dir, 'helper.log')
  }

  /** { deviceId, secret, deviceName, clientName, pairedAt } or null when not paired. */
  loadConfig() {
    const c = readJson(this.configFile)
    if (!c || typeof c.deviceId !== 'string' || typeof c.secret !== 'string' || !c.deviceId || !c.secret) return null
    return c
  }

  saveConfig(cfg) { writeAtomic(this.configFile, `${JSON.stringify(cfg, null, 2)}\n`) }

  updateConfig(patch) {
    const c = this.loadConfig()
    if (c) this.saveConfig({ ...c, ...patch })
  }

  clearPairing() {
    try { fs.unlinkSync(this.configFile) } catch (e) { if (e.code !== 'ENOENT') throw e }
    this.saveState({ pending: { printed: [], failed: [] }, recent: [] })
  }

  /** { pending: { printed: [ids], failed: [{ id, reason }] }, recent: [[id, printedAtMs]] } */
  loadState() {
    const s = readJson(this.stateFile) || {}
    const pending = s.pending && typeof s.pending === 'object' ? s.pending : {}
    return {
      pending: {
        printed: Array.isArray(pending.printed) ? pending.printed.filter(x => typeof x === 'string') : [],
        failed: Array.isArray(pending.failed) ? pending.failed.filter(x => x && typeof x.id === 'string') : [],
      },
      recent: Array.isArray(s.recent) ? s.recent.filter(x => Array.isArray(x) && typeof x[0] === 'string') : [],
    }
  }

  saveState(state) { writeAtomic(this.stateFile, JSON.stringify(state)) }
}

// ---- single instance -------------------------------------------------------------------------

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

const bootTime = () => Date.now() - os.uptime() * 1000

/**
 * Take the lock file, or return { ok: false, pid } when another helper holds it. A lock whose pid is
 * gone, or that was written before this computer last started (a power cut leaves one behind, and
 * Windows reuses pids), is stale and taken over.
 */
function acquireLock(lockFile, { pid = process.pid, isAlive = pidAlive, boot = bootTime() } = {}) {
  const body = JSON.stringify({ pid, boot: Math.round(boot) })
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(lockFile, body, { flag: 'wx' })
      return { ok: true, release: () => releaseLock(lockFile, pid) }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
    let held = null
    try { held = JSON.parse(fs.readFileSync(lockFile, 'utf8')) } catch { held = null }
    const heldPid = held && Number(held.pid)
    const sameBoot = held && Number.isFinite(held.boot) && Math.abs(held.boot - boot) < 120000
    if (held && heldPid !== pid && sameBoot && isAlive(heldPid)) return { ok: false, pid: heldPid }
    try { fs.unlinkSync(lockFile) } catch (e) { if (e.code !== 'ENOENT') throw e }
  }
  return { ok: false, pid: null }
}

function releaseLock(lockFile, pid = process.pid) {
  try {
    const held = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
    if (Number(held.pid) === pid) fs.unlinkSync(lockFile)
  } catch { /* gone or not ours */ }
}

// ---- log --------------------------------------------------------------------------------------

/** A log file that rolls over at maxBytes, keeping `keep` old files (helper.log.1, .2). */
class RotatingLog {
  constructor(file, { maxBytes = 1024 * 1024, keep = 2 } = {}) {
    this.file = file
    this.maxBytes = maxBytes
    this.keep = keep
    try { this.size = fs.statSync(file).size } catch { this.size = 0 }
  }

  rotate() {
    for (let i = this.keep; i >= 1; i--) {
      const from = i === 1 ? this.file : `${this.file}.${i - 1}`
      try { fs.renameSync(from, `${this.file}.${i}`) } catch { /* nothing to move */ }
    }
    this.size = 0
  }

  write(level, msg, err) {
    let line = `${new Date().toISOString()} ${level} ${msg}`
    if (err) line += `\n${String((err && err.stack) || err).replace(/^/gm, '  ')}`
    line += '\n'
    const bytes = Buffer.byteLength(line)
    try {
      if (this.size + bytes > this.maxBytes && this.size > 0) this.rotate()
      fs.appendFileSync(this.file, line)
      this.size += bytes
    } catch { /* logging must never stop printing */ }
  }

  info(msg) { this.write('INFO', msg) }
  warn(msg, err) { this.write('WARN', msg, err) }
  error(msg, err) { this.write('ERROR', msg, err) }
}

module.exports = { Store, homeDir, acquireLock, releaseLock, pidAlive, RotatingLog }
