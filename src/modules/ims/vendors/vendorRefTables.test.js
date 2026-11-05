/**
 * VENDOR_REF_TABLES must list every table with a foreign key to `vendors.id`, and must agree with
 * its SQL twin, `vendor_reference_counts()`, which the BEFORE DELETE trigger
 * `vendors_guard_referenced_delete` asks (S708, migration 20260909140000).
 *
 * Until S890 nothing compared the two lists (DEBT.md section 5). They agreed, but only a new table
 * with a `vendor_id` FK could break them, and that break has no symptom: two of the four tables are
 * ON DELETE SET NULL, so a vendor delete the page failed to warn about is not refused, it succeeds
 * and the rows silently lose their supplier. The same source-reading technique as
 * `items/itemRefTables.test.js`: read the migrations, so a new referencing table fails here.
 */
import fs from 'fs'
import path from 'path'
import { VENDOR_REF_TABLES } from './vendorRefTables'

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations')
const migrationFiles = () => fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')
const onDeleteOf = tail => (/ON DELETE SET NULL/i.test(tail) ? 'set null'
  : /ON DELETE CASCADE/i.test(tail) ? 'cascade' : 'refuse')

const REF_RE = /REFERENCES\s+(?:public\.)?vendors\s*\(\s*id\s*\)/gi

/** Every `<table>.<column>` FK pointing at vendors(id), and what it does on delete. */
function foreignKeysToVendors() {
  const found = new Map()
  let mentions = 0
  for (const file of migrationFiles()) {
    const sql = read(file)
    mentions += (sql.match(REF_RE) || []).length
    // `ALTER TABLE ONLY public.x ADD CONSTRAINT c FOREIGN KEY (col) REFERENCES public.vendors(id) ...;`
    const alterRe = /ALTER TABLE (?:ONLY )?(?:IF EXISTS )?(?:public\.)?(\w+)[\s\S]{0,200}?FOREIGN KEY \((\w+)\) REFERENCES (?:public\.)?vendors\s*\(id\)([^;]*);/gi
    let m
    while ((m = alterRe.exec(sql)) !== null) {
      const [, table, column, tail] = m
      found.set(`${table}.${column}`, { table, column, onDelete: onDeleteOf(tail) })
    }
    // `ALTER TABLE public.x ADD COLUMN [IF NOT EXISTS] col uuid REFERENCES public.vendors(id) ...`
    const addColRe = /ALTER TABLE (?:ONLY )?(?:IF EXISTS )?(?:public\.)?(\w+)\s+ADD COLUMN (?:IF NOT EXISTS )?(\w+)\s+[^,;]*?REFERENCES (?:public\.)?vendors\s*\(id\)([^,;]*)/gi
    while ((m = addColRe.exec(sql)) !== null) {
      const [, table, column, tail] = m
      found.set(`${table}.${column}`, { table, column, onDelete: onDeleteOf(tail) })
    }
    // Inline column definition inside CREATE TABLE: `vendor_id uuid REFERENCES public.vendors(id) ON DELETE SET NULL,`
    const createRe = /CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/gi
    while ((m = createRe.exec(sql)) !== null) {
      const [, table, body] = m
      const colRe = /^\s*(\w+)\s+[^,\n]*?REFERENCES\s+(?:public\.)?vendors\s*\(id\)([^,\n]*)/gim
      let c
      while ((c = colRe.exec(body)) !== null) {
        const [, column, tail] = c
        found.set(`${table}.${column}`, { table, column, onDelete: onDeleteOf(tail) })
      }
    }
  }
  return { found, mentions }
}

describe('VENDOR_REF_TABLES', () => {
  const { found: fks, mentions } = foreignKeysToVendors()

  it('finds the vendor foreign keys in the migrations at all, and every one it saw', () => {
    // Guards the parser itself: a regex that matched nothing would make every assertion below pass
    // vacuously. Every REFERENCES vendors(id) in the migrations must have been parsed into one FK,
    // so a new shape of migration fails here instead of slipping past.
    expect(fks.size).toBeGreaterThanOrEqual(4)
    expect(fks.size).toBe(mentions)
    expect([...fks.keys()]).toContain('purchase_entries.vendor_id')
  })

  it('lists every table that references vendors.id', () => {
    const expected = [...new Set([...fks.values()].map(fk => fk.table))].sort()
    expect(VENDOR_REF_TABLES.map(t => t.table).slice().sort()).toEqual(expected)
  })

  it('records what each foreign key does when its vendor is deleted', () => {
    for (const { table, onDelete } of VENDOR_REF_TABLES) {
      const fk = fks.get(`${table}.vendor_id`)
      expect(fk).toBeDefined()
      expect({ table, onDelete }).toEqual({ table, onDelete: fk.onDelete })
    }
  })

  it('still has SET NULL tables, so the guard cannot be relaxed to trust the database', () => {
    expect(VENDOR_REF_TABLES.filter(t => t.onDelete === 'set null').map(t => t.table).sort())
      .toEqual(['ims_gate_passes', 'vendor_returns'])
  })

  it('gives every table a distinct label and both phrases for the refusal', () => {
    const labels = VENDOR_REF_TABLES.map(t => t.label)
    expect(new Set(labels).size).toBe(labels.length)
    for (const t of VENDOR_REF_TABLES) expect(t.one && t.many).toBeTruthy()
  })

  // Against the LATEST migration that defines the function, not the first (the S758 lesson in
  // itemRefTables.test.js): a re-created function is the one the database runs.
  it('counts the same tables in vendor_reference_counts()', () => {
    const files = migrationFiles().filter(f => read(f).includes('CREATE OR REPLACE FUNCTION public.vendor_reference_counts'))
    expect(files.length).toBeGreaterThan(0)
    const body = read(files[files.length - 1])
      .split('CREATE OR REPLACE FUNCTION public.vendor_reference_counts')[1]
      .split('$fn$;')[0]
    // Each UNION ALL branch reads `FROM <table> x JOIN scoped`, the only place a table name appears
    // in that shape.
    const inSql = [...body.matchAll(/FROM\s+(\w+)\s+x\s+JOIN\s+scoped/g)].map(m => m[1]).sort()
    expect(inSql).toEqual(VENDOR_REF_TABLES.map(t => t.table).slice().sort())
    // And each branch labels its count with the table it read, which is what the page keys on.
    for (const t of VENDOR_REF_TABLES) {
      expect(body).toMatch(new RegExp(`'${t.table}'(?:::text AS t)?,\\s+x\\.vendor_id\\s+FROM\\s+${t.table}\\s+x`))
    }
  })
})
