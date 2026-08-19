// Schema-drift guard for feature_flags (the S547 failure class).
//
// FeatureAccessModal's Save sends its ENTIRE DEFAULT_FLAGS object in one upsert, so a single key
// with no matching DB column rejects the whole request — every feature-flag save, for every
// client, with an error naming a feature the admin wasn't even touching. It stays invisible until
// someone presses Save (weeks later, in the S547 case), because the feature itself works via the
// plan tier. This test makes that impossible to ship: it diffs the keys the modal upserts against
// the columns the migrations create, and requires the diff to be empty in BOTH directions
// (CLAUDE.md, "When adding a new feature" → the DB-column step).
//
// It reads source and SQL as text rather than importing them, so it needs no DB connection and
// drags in no React/Supabase deps. The migration scan is additive (CREATE TABLE + ADD COLUMN) —
// this codebase never drops a flag column; if that ever changes, teach this parser about DROP.
import fs from 'fs'
import path from 'path'

const MODAL = path.resolve(__dirname, 'FeatureAccessModal.js')
const MIGRATIONS = path.resolve(__dirname, '../../../supabase/migrations')

// The keys FeatureAccessModal upserts — extracted from its flat `const DEFAULT_FLAGS = { ... }`.
function modalFlagKeys() {
  const src = fs.readFileSync(MODAL, 'utf8')
  const m = src.match(/const DEFAULT_FLAGS\s*=\s*\{([\s\S]*?)\}/)
  if (!m) throw new Error('DEFAULT_FLAGS object not found in FeatureAccessModal.js — did it move or get renamed?')
  return new Set([...m[1].matchAll(/(\w+)\s*:/g)].map(x => x[1]))
}

// Every boolean column on public.feature_flags, from the baseline CREATE TABLE plus every later
// ADD COLUMN scoped to a feature_flags ALTER. `boolean` is what distinguishes a flag column from
// the structural ones (id/client_id/created_at/updated_at are uuid/timestamp), so keying on the
// type excludes those for free.
function dbFlagColumns() {
  const cols = new Set()
  const files = fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql'))
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')

    const create = sql.match(/CREATE TABLE\s+(?:public\.)?feature_flags\s*\(([\s\S]*?)\);/i)
    if (create) {
      for (const c of create[1].matchAll(/^\s*(\w+)\s+boolean/gim)) cols.add(c[1])
    }
    // Each ALTER TABLE ... feature_flags ... ; statement, scoped so an ADD COLUMN on some other
    // table in the same migration can never leak in.
    for (const alter of sql.matchAll(/ALTER TABLE\s+(?:public\.)?feature_flags\b[\s\S]*?;/gi)) {
      for (const c of alter[0].matchAll(/ADD COLUMN\s+(?:IF NOT EXISTS\s+)?(\w+)\s+boolean/gi)) cols.add(c[1])
    }
  }
  return cols
}

describe('feature_flags schema stays in sync with FeatureAccessModal', () => {
  const modalKeys = modalFlagKeys()
  const dbCols = dbFlagColumns()

  test('parsers found a plausible number of flags (guards against a broken regex)', () => {
    expect(modalKeys.size).toBeGreaterThan(20)
    expect(dbCols.size).toBeGreaterThan(20)
  })

  test('every flag the modal upserts has a DB column (the S547 save-breaker)', () => {
    const missing = [...modalKeys].filter(k => !dbCols.has(k))
    expect(missing).toEqual([])
  })

  test('every feature_flags column is a flag the modal knows about (no orphan columns)', () => {
    const orphan = [...dbCols].filter(c => !modalKeys.has(c))
    expect(orphan).toEqual([])
  })
})
