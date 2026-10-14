'use strict'
// Crest Print Helper: prints Crest Suite kitchen and bar tickets on network receipt printers.
//   CrestPrintHelper.exe                     run (asks for a pairing code the first time)
//   CrestPrintHelper.exe --pair              forget the pairing and ask for a new code
//   CrestPrintHelper.exe --no-startup        do not offer to start with Windows
//   CrestPrintHelper.exe --version
//   CrestPrintHelper.exe --test-print <printer address> [port] [paper width 80|58]
const readline = require('node:readline')
const { FontSet } = require('./fonts')
const { renderDoc } = require('./render')
const { buildEscPos } = require('./escpos')
const { sendToPrinter } = require('./printer')
const { createApi, crestEndpoint } = require('./api')
const { Store, homeDir, acquireLock, RotatingLog } = require('./store')
const { ConsoleUi, plain } = require('./ui')
const { Helper, APP_VERSION } = require('./helper')
const { startupInstalled, installStartup } = require('./startup')
const { testPrintDoc } = require('./samples')
const { isSea } = require('./assets')

const USAGE = [
  'Usage:',
  '  CrestPrintHelper                        start the helper',
  '  CrestPrintHelper --pair                 forget this computer\'s pairing and type a new code',
  '  CrestPrintHelper --no-startup           do not offer to start with Windows',
  '  CrestPrintHelper --version              show the version',
  '  CrestPrintHelper --test-print <address> [port] [80|58]',
  '                                          print a test ticket straight to a printer',
].join('\n')

function parseArgs(argv) {
  const a = { pair: false, noStartup: false, version: false, help: false, testPrint: null, error: null }
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]
    if (x === '--pair') a.pair = true
    else if (x === '--no-startup') a.noStartup = true
    else if (x === '--version' || x === '-v') a.version = true
    else if (x === '--help' || x === '-h' || x === '/?') a.help = true
    else if (x === '--test-print') {
      const host = argv[i + 1]
      if (!host || host.startsWith('-')) { a.error = '--test-print needs the printer\'s address, like 192.168.1.50'; break }
      i += 1
      let port = 9100
      let width = 80
      if (argv[i + 1] && /^\d+$/.test(argv[i + 1])) { port = Number(argv[i + 1]); i += 1 }
      if (argv[i + 1] && /^\d+$/.test(argv[i + 1])) { width = Number(argv[i + 1]); i += 1 }
      if (port < 1 || port > 65535) { a.error = `The port "${port}" is not valid (it is usually 9100)`; break }
      if (width !== 80 && width !== 58) { a.error = `The paper width must be 80 or 58, not ${width}`; break }
      a.testPrint = { host, port, width }
    } else { a.error = `Unknown option: ${x}`; break }
  }
  return a
}

/** Line input from the console; resolves null once input is closed. */
function createAsk() {
  let rl = null
  let closed = false
  const waiting = new Set()
  const open = () => {
    if (rl || closed) return
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY })
    rl.on('close', () => { closed = true; rl = null; for (const r of waiting) r(null); waiting.clear() })
    rl.on('SIGINT', () => process.emit('SIGINT'))
  }
  return {
    ask(prompt) {
      open()
      if (closed) return Promise.resolve(null)
      return new Promise((resolve) => {
        waiting.add(resolve)
        rl.question(prompt, (answer) => { waiting.delete(resolve); resolve(answer) })
      })
    },
    close() { if (rl) rl.close() },
  }
}

async function pauseBeforeExit(ask) {
  if (process.platform !== 'win32' || !process.stdin.isTTY) return
  await ask('Press Enter to close this window.')
}

async function testPrint({ host, port, width }) {
  const fonts = await FontSet.load()
  const bytes = buildEscPos(renderDoc(testPrintDoc({ host, port, width }), fonts, width))
  console.log(`Sending a test ticket to ${host} port ${port} (${width} mm paper)…`)
  try {
    await sendToPrinter({ host, port, data: bytes })
    console.log('Done: the printer took the test ticket.')
    return 0
  } catch (e) {
    console.log(`Could not print: ${e && e.reason ? e.reason : plain(e && e.message)}`)
    return 1
  }
}

async function runHelper(args) {
  const store = new Store(homeDir())
  const log = new RotatingLog(store.logFile)
  const ui = new ConsoleUi({ log })
  const input = createAsk()

  const lock = acquireLock(store.lockFile)
  if (!lock.ok) {
    ui.say('The Crest Print Helper is already running on this computer. Look for its window on the taskbar.')
    await pauseBeforeExit(input.ask)
    input.close()
    return 1
  }
  process.on('exit', () => lock.release())
  process.on('uncaughtException', (e) => { log.error('uncaught exception', e) })
  process.on('unhandledRejection', (e) => { log.error('unhandled rejection', e) })
  log.info(`start ${APP_VERSION} on ${process.platform} ${process.arch}, node ${process.version}, packed=${isSea()}, home=${store.dir}`)

  ui.say(`Crest Print Helper ${APP_VERSION}`)
  const { url, key } = crestEndpoint()
  if (!url || !key) {
    log.error('no Crest address or key in this build')
    ui.say('This copy of the helper does not know where Crest is. Download it again from Crest.')
    await pauseBeforeExit(input.ask)
    input.close()
    return 1
  }

  let fonts
  try {
    fonts = await FontSet.load()
  } catch (e) {
    log.error('could not load fonts', e)
    ui.say('The helper could not load its fonts, so it cannot draw tickets. Download it again from Crest.')
    await pauseBeforeExit(input.ask)
    input.close()
    return 1
  }

  const afterPairing = async () => {
    if (process.platform !== 'win32' || args.noStartup || startupInstalled()) return
    if (!isSea()) { log.info('not packed: skipping the start-with-Windows offer'); return }
    const answer = await input.ask('Start the helper automatically when Windows starts? (Y/n) ')
    if (answer === null) return
    if (/^\s*n/i.test(answer)) {
      ui.say('OK. Start the helper yourself whenever this computer is switched on.')
      return
    }
    try {
      const paths = installStartup()
      log.info(`start-with-Windows set up: ${paths.exe}, ${paths.cmd}`)
      ui.say('Done: the helper will start by itself (minimized) whenever you sign in to Windows.')
    } catch (e) {
      log.error('could not set up start-with-Windows', e)
      ui.say('Could not set up the automatic start. You can still start the helper yourself.')
    }
  }

  const api = createApi({ url, key })
  const helper = new Helper({ api, store, ui, log, fonts, ask: input.ask, onPaired: afterPairing })
  const shutdown = () => { ui.say('Closing the Crest Print Helper.'); helper.stop(); input.close(); setTimeout(() => process.exit(0), 300) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  let forcePair = args.pair
  for (;;) {
    try {
      const r = await helper.run({ forcePair })
      if (r === 'no-input') ui.say('No pairing code was typed, so the helper is closing.')
      break
    } catch (e) {
      log.error('helper loop crashed', e)
      ui.say('Something went wrong inside the helper. It will carry on in 10 seconds (details are in the log file).')
      forcePair = false
      await new Promise(r => setTimeout(r, 10000))
      if (helper.stopped) break
    }
  }
  input.close()
  return 0
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.error) { console.log(args.error); console.log(USAGE); return 2 }
  if (args.help) { console.log(`Crest Print Helper ${APP_VERSION}\n${USAGE}`); return 0 }
  if (args.version) { console.log(`Crest Print Helper ${APP_VERSION}`); return 0 }
  try { process.title = 'Crest Print Helper' } catch { /* not allowed here */ }
  if (args.testPrint) return testPrint(args.testPrint)
  return runHelper(args)
}

module.exports = { main, parseArgs, USAGE }
