import fs from 'fs'
import path from 'path'
import { BS_YEAR_MIN, BS_YEAR_MAX, bsToAd, daysInBsMonth, formatAd } from './bsCalendar'

// The database's copy of the BS calendar (S749b). `bs_months` lets a trigger ask "is this AD date a
// public holiday?" — leave day counts and swap-date checks depend on it — and it was GENERATED from
// this file's table. Two copies of a calendar drift the moment one is extended, so this reads the
// migration off disk and requires every row to equal what bsToAd() says, and every year the JS
// table holds to be present. Extending the JS table therefore fails this test until a migration
// adds the matching rows.

const dir = path.join(__dirname, '../../supabase/migrations')
const rows = new Map()
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
  const sql = fs.readFileSync(path.join(dir, f), 'utf8')
  if (!/INSERT INTO public\.bs_months/.test(sql)) continue
  for (const m of sql.matchAll(/\((\d{4}),(\d{1,2}),'(\d{4}-\d{2}-\d{2})',(\d{2})\)/g)) {
    rows.set(`${m[1]}:${m[2]}`, { adStart: m[3], days: Number(m[4]) })
  }
}

describe('bs_months (the database copy of the BS calendar)', () => {
  it('was found in a migration at all — a parser that matches nothing would pass vacuously', () => {
    expect(rows.size).toBeGreaterThan(1000)
  })

  it('holds every month of every year the JS table holds, with the same start date and length', () => {
    const wrong = []
    for (let y = BS_YEAR_MIN; y <= BS_YEAR_MAX; y++) {
      for (let m = 1; m <= 12; m++) {
        const row = rows.get(`${y}:${m}`)
        const want = { adStart: formatAd(bsToAd(y, m, 1)), days: daysInBsMonth(y, m) }
        if (!row || row.adStart !== want.adStart || row.days !== want.days) wrong.push(`${y}-${m}`)
      }
    }
    expect(wrong).toEqual([])
  })
})
