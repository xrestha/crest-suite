// The dashboard's frozen Target and the database guard must agree on the current snapshot models
// (S849, DATABASE-8). `ims_monthly_periods_guard` accepts a projection snapshot only of exactly the
// model the dashboard draws; if SNAPSHOT_MODEL is bumped and the guard is not, every Target capture is
// refused as `snapshot_frozen` and no month gets a Target again — silently, since the capture is
// best-effort. So this reads the NEWEST migration that defines the guard and compares its literals
// with SNAPSHOT_MODEL. Never hard-code the numbers here: the point is that the two move together.
import fs from 'fs'
import path from 'path'
import { SNAPSHOT_MODEL } from './dailyForecast'

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations')
const stripComments = sql => sql.replace(/--[^\n]*/g, '')

function newestGuardDefinition() {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
  let found = null
  for (const file of files) {
    const sql = stripComments(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'))
    if (/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.ims_monthly_periods_guard\s*\(/i.test(sql)) found = { file, sql }
  }
  return found
}

describe('the snapshot guard names the models the dashboard writes', () => {
  const def = newestGuardDefinition()

  test('a migration defines ims_monthly_periods_guard', () => {
    expect(def).not.toBeNull()
  })

  test('its sales / purchase models equal SNAPSHOT_MODEL', () => {
    const m = def.sql.match(/WHEN\s+'sales_projection_snapshot'\s+THEN\s+(\d+)\s+ELSE\s+(\d+)/i)
    expect(m).not.toBeNull()
    expect([Number(m[1]), Number(m[2])]).toEqual([SNAPSHOT_MODEL.sales, SNAPSHOT_MODEL.purch])
  })
})
