/**
 * The till's "hasn't printed" banner clears an installed iPhone's home indicator (POS audit
 * 2026-10-15): at a bare 16px its Print here and Dismiss row sat in the strip the system keeps for
 * the home gesture. A stylesheet fact, so it is read from the stylesheet (jsdom applies no CSS).
 */

import fs from 'fs'
import path from 'path'

test('the banner sits above the home indicator, not 16px from the glass', () => {
  const css = fs.readFileSync(path.join(__dirname, 'StationPrintAlerts.css'), 'utf8')
  const at = css.indexOf('.station-print-alerts {')
  const rule = css.slice(at, css.indexOf('}', at))
  expect(rule).toMatch(/bottom: calc\(16px \+ env\(safe-area-inset-bottom, 0px\)\);/)
})
