// Every live count of kitchen tickets reads the Kitchen Display's own window (S814 4d, REPORTS-11):
// this SERVICE, from Nepal midnight and rolling over at 6 AM (serviceDayStartIso), with no upper
// bound. Until then the POS Dashboard's Kitchen tickets tile, Home's "running late" row and the
// kitchen team's Home card each cut the day at midnight — the calendar day (nepalDayStartTs, or
// bsDayBoundaryIso for today) — so at 12:30 AM a ticket sent at 11:50 PM was still on the board and
// gone from all three, and "None late" sat beside a late ticket.
//
// A source-reading test, like salesReads.test.js: the window is a property of each read, and a page
// that goes back to the calendar day still renders a plausible count with no error to catch.
import fs from 'fs'
import path from 'path'

const ROOT = path.join(__dirname, '..', '..', '..')
// The screens that count today's tickets live. KotLog.jsx is a report over a picked range and reads
// that range on purpose; PosOrders reads tickets by order, never by day.
const FILES = [
  'src/modules/pos/kds/KitchenDisplay.jsx',
  'src/modules/pos/dashboard/PosDashboard.jsx',
  'src/pages/dashboard/HomeAttention.jsx',
  'src/pages/dashboard/ClientDashboard.jsx',
  'src/modules/pos/orders/PosOrders.jsx',
]
const DAY_WINDOWED = new Set(FILES.slice(0, 4))

const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1 ')

// The whole builder chain starting at `scopedFrom('pos_kot_log'`: balanced parentheses, then any
// `.method(...)` that follows.
function chainAt(src, start) {
  let i = src.indexOf('(', start)
  let depth = 0
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) {
        const rest = src.slice(i + 1)
        const next = rest.match(/^\s*\./)
        if (!next) return src.slice(start, i + 1)
        i += next[0].length - 1
        // continue into the next method's own parentheses
        const open = src.indexOf('(', i + 1)
        if (open === -1) return src.slice(start, i + 1)
        i = open - 1
      }
    }
  }
  return src.slice(start)
}

function kotReads(file) {
  const src = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'))
  const out = []
  const re = /scopedFrom\(\s*'pos_kot_log'/g
  let m
  while ((m = re.exec(src))) out.push(chainAt(src, m.index))
  return { src, reads: out }
}

// What a read's `.gte('sent_at', …)` starts from: 'none', 'serviceDayStartIso' (a direct call, or a
// variable set from one in the same file), or the expression itself for anything else.
function lowerBoundOf(chain, src) {
  const gte = chain.match(/\.gte\(\s*'sent_at'\s*,\s*([A-Za-z_$][\w$]*)\s*(\()?/)
  if (!gte) return 'none'
  if (gte[2]) return gte[1]
  const def = src.match(new RegExp(`(?:const|let)\\s+${gte[1]}\\s*=\\s*([^\\n]+)`))
  return def && /^serviceDayStartIso\(/.test(def[1]) ? 'serviceDayStartIso' : `${gte[1]} = ${def ? def[1] : '?'}`
}

describe('kitchen tickets are counted over the service, never the calendar day', () => {
  for (const file of FILES) {
    test(`${file}: no pos_kot_log read is bounded by nepalDayStartTs or bsDayBoundaryIso`, () => {
      const { src, reads } = kotReads(file)
      expect(reads.length).toBeGreaterThan(0)
      for (const chain of reads) {
        expect(chain).not.toMatch(/nepalDayStartTs|bsDayBoundaryIso/)
        expect(chain).not.toMatch(/\.lte\(\s*'sent_at'/)
        expect(lowerBoundOf(chain, src)).toMatch(/^(none|serviceDayStartIso)$/)
      }
    })
  }

  test('the four live screens read a day window at all, so the test above is not vacuous', () => {
    for (const file of DAY_WINDOWED) {
      const { reads } = kotReads(file)
      expect(reads.some(chain => /\.gte\(\s*'sent_at'/.test(chain))).toBe(true)
    }
  })
})
