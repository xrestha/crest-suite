'use strict'
// What the helper says on screen: short, plain lines with the Nepal time, for the restaurant owner.
// Details and stack traces go only to the log file. Anything that came from Crest (outlet, device
// and ticket names) is printed as plain text, without control characters.

const NEPAL_OFFSET_MS = (5 * 60 + 45) * 60 * 1000

function nepalClock(d = new Date()) {
  const n = new Date(d.getTime() + NEPAL_OFFSET_MS)
  return `${String(n.getUTCHours()).padStart(2, '0')}:${String(n.getUTCMinutes()).padStart(2, '0')}`
}

// eslint-disable-next-line no-control-regex
const plain = v => String(v ?? '').replace(/[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim()

class ConsoleUi {
  constructor({ write = s => process.stdout.write(s), log = null, now = () => new Date() } = {}) {
    this.write = write
    this.log = log
    this.now = now
    this.last = new Map()
    this.lines = []
  }

  say(msg) {
    const text = `${nepalClock(this.now())}  ${msg}`
    this.lines.push(msg)
    if (this.lines.length > 500) this.lines.shift()
    this.write(`${text}\n`)
    if (this.log) this.log.info(`screen: ${msg}`)
  }

  /** Say msg unless it is what was last said under this key. */
  status(key, msg) {
    if (this.last.get(key) === msg) return
    this.last.set(key, msg)
    this.say(msg)
  }

  forget(key) { this.last.delete(key) }
}

module.exports = { ConsoleUi, nepalClock, plain }
