'use strict'
// The program's entry point (and the bundle's): run main and exit with its code.
const { main } = require('./main')
const { plain } = require('./ui')

main().then(
  (code) => { process.exitCode = code; setImmediate(() => process.exit(code)) },
  (e) => { console.log(`The helper stopped: ${plain(e && e.message)}`); process.exit(1) },
)
