/**
 * get_ims_cost_trend (S876, PERF-7) is the Inventory Dashboard's Food Cost trend in one read: each closed
 * month's raw sums. It must not become a third copy of the COGS rules, so every sum in it is
 * get_group_pnl's expression copied word for word — and getGroupPnlSql.test.js already pins those to
 * periodCost.js. This reads the NEWEST migration defining each function and asserts that every CTE and
 * every per-month sum of the trend appears, flattened, in get_group_pnl's body. A change to one that is
 * not made to the other fails here.
 */
import fs from 'fs'
import path from 'path'

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations')

function newestBody(name) {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
  let found = null
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    const at = sql.search(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${name}\\(`))
    if (at === -1) continue
    const start = sql.indexOf('$function$', at)
    const end = sql.indexOf('$function$', start + 10)
    found = { file, sql, head: sql.slice(at, start), body: sql.slice(start, end) }
  }
  return found
}

// Comments removed and whitespace flattened, so a comment cannot satisfy an assertion.
const flat = s => s.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ')

// The text from `open` (an index of '(') to its matching ')', inclusive.
function balanced(s, open) {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')' && --depth === 0) return s.slice(open, i + 1)
  }
  return null
}

describe('get_ims_cost_trend (newest definition)', () => {
  const trend = newestBody('get_ims_cost_trend')
  const pnl = newestBody('get_group_pnl')
  const body = flat(trend?.body || '')
  const pnlBody = flat(pnl?.body || '')

  it('is defined by a migration, after the get_group_pnl it copies', () => {
    expect(trend).not.toBeNull()
    expect(pnl).not.toBeNull()
    expect(trend.file > pnl.file).toBe(true)
  })

  it('reads as the caller, for the outlet the caller is signed in to, and is not anon-callable', () => {
    expect(flat(trend.head)).toMatch(/SECURITY INVOKER/)
    expect(body).toMatch(/IF NOT COALESCE\(p_client_id = \(SELECT public\.my_client_id\(\)\) OR \(SELECT public\.is_admin\(\)\), false\) THEN/)
    expect(flat(trend.sql)).toMatch(/REVOKE ALL ON FUNCTION public\.get_ims_cost_trend\(uuid, integer\) FROM PUBLIC, anon;/)
  })

  it('reads closed months of this outlet only, newest first', () => {
    expect(body).toMatch(/WHERE mp\.client_id = p_client_id AND mp\.status = 'closed' ORDER BY mp\.bs_year DESC, mp\.bs_month DESC/)
  })

  it.each(['bill', 'pline', 'tline', 'tsum', 'stock_rows', 'gap'])('its %s CTE is get_group_pnl\'s, word for word', name => {
    const at = body.search(new RegExp(`\\b${name} AS \\(`))
    expect(at).toBeGreaterThan(-1)
    const cte = `${name} AS ${balanced(body, body.indexOf('(', at))}`
    expect(pnlBody).toContain(cte)
  })

  it("every per-month sum is get_group_pnl's, word for word", () => {
    const select = body.slice(body.search(/\) SELECT per\.period_id/))
    const sums = []
    let i = select.indexOf('COALESCE((')
    while (i !== -1) {
      sums.push(`COALESCE${balanced(select, i + 'COALESCE'.length)}`)
      i = select.indexOf('COALESCE((', i + 1)
    }
    // revenue, opening, purchases, returns, wastage, staff meals, closing
    expect(sums).toHaveLength(7)
    sums.forEach(s => expect(pnlBody).toContain(s))
  })
})
