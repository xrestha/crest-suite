/**
 * ITEM_REF_TABLES must list every table with a foreign key to `items.id`, and must know which of
 * those foreign keys actually refuse a delete.
 *
 * This exists because both halves had silently drifted, and neither drift had a symptom:
 *
 *  - The list held eight tables while eleven referenced `items`. Force-delete cleared the eight it
 *    knew about and Postgres then refused the final delete because `par_levels`,
 *    `purchase_order_items` and `stock_movements` still held the row — so the item survived with
 *    its purchases, stock counts, wastage, requisitions and recipe lines already destroyed, under
 *    a message telling the operator to try again.
 *  - Three of the eleven are ON DELETE CASCADE, so for those the database is not a backstop at
 *    all: a delete the badge failed to warn about is not refused, it succeeds and takes the rows
 *    with it. Anything that treats "the FK will stop me" as a guarantee is right about eight
 *    tables and wrong about three, with no error on the wrong three.
 *
 * Adding a table with an `item_id` FK therefore has to reach this list, and the only thing that
 * can enforce that is a test that reads the migrations — the same source-reading technique
 * `nepalMoney.test.js` uses. A new referencing table fails here rather than in production, on the
 * one page where the failure mode is deleted history.
 */
import fs from 'fs'
import path from 'path'
import { ITEM_REF_TABLES } from './itemRefTables'

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations')

/** Every `<table>.<column>` FK pointing at items(id), with whether it cascades on delete. */
function foreignKeysToItems() {
  const found = new Map()
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    // `ALTER TABLE ... ADD CONSTRAINT x FOREIGN KEY (col) REFERENCES public.items(id) [ON DELETE ...]`
    const alterRe = /ALTER TABLE ONLY (?:public\.)?(\w+)[\s\S]{0,200}?FOREIGN KEY \((\w+)\) REFERENCES (?:public\.)?items\(id\)([^;]*);/gi
    let m
    while ((m = alterRe.exec(sql)) !== null) {
      const [, table, column, tail] = m
      found.set(`${table}.${column}`, { table, column, cascades: /ON DELETE CASCADE/i.test(tail) })
    }
    // Inline column definition: `item_id uuid REFERENCES items(id) ON DELETE CASCADE`
    const inlineRe = /CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/gi
    while ((m = inlineRe.exec(sql)) !== null) {
      const [, table, body] = m
      const colRe = /^\s*(\w+)\s+[^,\n]*?REFERENCES\s+(?:public\.)?items\s*\(id\)([^,\n]*)/gim
      let c
      while ((c = colRe.exec(body)) !== null) {
        const [, column, tail] = c
        found.set(`${table}.${column}`, { table, column, cascades: /ON DELETE CASCADE/i.test(tail) })
      }
    }
  }
  return found
}

// `recipes.linked_item_id` is the sub-recipe mirror link, and Item Master lists only
// `is_sub_recipe = false` rows — an item on that page can never be a recipe's mirror. It is
// therefore deliberately not in ITEM_REF_TABLES, and named here so its absence is a decision
// rather than the next omission.
const NOT_REACHABLE_FROM_ITEM_MASTER = new Set(['recipes.linked_item_id'])

describe('ITEM_REF_TABLES', () => {
  const fks = foreignKeysToItems()

  it('finds the item foreign keys in the migrations at all', () => {
    // Guards the parser itself: a regex that silently matches nothing would make every assertion
    // below pass vacuously, which is the failure this whole file exists to prevent elsewhere.
    expect(fks.size).toBeGreaterThanOrEqual(11)
    expect([...fks.keys()]).toContain('purchase_entries.item_id')
  })

  it('lists every table that references items.id', () => {
    const expected = [...fks.values()]
      .filter(fk => !NOT_REACHABLE_FROM_ITEM_MASTER.has(`${fk.table}.${fk.column}`))
      .map(fk => fk.table)
    const listed = ITEM_REF_TABLES.map(t => t.table)
    expect(listed.slice().sort()).toEqual([...new Set(expected)].sort())
  })

  it('records the ON DELETE behaviour of each one correctly', () => {
    for (const { table, cascades } of ITEM_REF_TABLES) {
      const fk = fks.get(`${table}.item_id`)
      expect(fk).toBeDefined()
      expect({ table, cascades }).toEqual({ table, cascades: fk.cascades })
    }
  })

  it('still has cascading tables, so the guard cannot be relaxed to trust the database', () => {
    // If this ever becomes empty, the delete guard's fail-closed behaviour could be revisited —
    // and it should be revisited deliberately, not discovered.
    expect(ITEM_REF_TABLES.filter(t => t.cascades).map(t => t.table).sort())
      .toEqual(['requisition_lines', 'staff_meals', 'vendor_returns'])
  })

  it('deletes children before the parents they also reference', () => {
    // vendor_returns has an FK to purchase_entries as well as to items, so clearing purchase
    // entries first would fail or orphan it. Order in the array IS the delete order.
    const order = ITEM_REF_TABLES.map(t => t.table)
    expect(order.indexOf('vendor_returns')).toBeLessThan(order.indexOf('purchase_entries'))
  })

  it('gives every table a distinct badge code and a human name', () => {
    const labels = ITEM_REF_TABLES.map(t => t.label)
    expect(new Set(labels).size).toBe(labels.length)
    for (const t of ITEM_REF_TABLES) expect(t.name).toBeTruthy()
  })

  // ── The SQL twin (S707) ───────────────────────────────────────────────────────────────────
  //
  // The list now exists twice: here, and inside 20260909130000 — `item_reference_counts()` (what
  // the BEFORE DELETE trigger asks) and `force_delete_item()` (what actually clears). It has to,
  // because a guard the browser can skip is advice, and the server cannot import a .js module.
  //
  // Two copies of a list that must never diverge is the exact defect this whole file was written
  // for, one layer down — so the same technique applies: read the SQL and compare.
  describe('and its SQL twin in 20260909130000', () => {
    const sql = fs.readFileSync(
      path.join(MIGRATIONS_DIR, '20260909130000_items_delete_reference_guard.sql'), 'utf8')

    it('checks the same eleven tables in item_reference_counts()', () => {
      const body = sql.split('CREATE OR REPLACE FUNCTION public.item_reference_counts')[1]
        .split('$fn$;')[0]
      // Each UNION ALL branch reads `FROM <table> x JOIN scoped`, which is the only place a table
      // name appears in that shape — so a table added to the list but not the union fails here.
      const checked = [...body.matchAll(/FROM (\w+)\s+x JOIN scoped/g)].map(m => m[1])
      expect(checked.slice().sort()).toEqual(ITEM_REF_TABLES.map(t => t.table).sort())
    })

    it('clears the same eleven tables, in the same dependency order, in force_delete_item()', () => {
      const arr = sql
        .split('CREATE OR REPLACE FUNCTION public.force_delete_item')[1]
        .split('FOREACH v_tbl IN ARRAY ARRAY[')[1]
        .split(']')[0]
      const cleared = [...arr.matchAll(/'(\w+)'/g)].map(m => m[1])
      // Order, not just membership: vendor_returns references purchase_entries as well as items,
      // and the whole point of the array is that it is a dependency order.
      expect(cleared).toEqual(ITEM_REF_TABLES.map(t => t.table))
    })

    it('keeps the guard SECURITY INVOKER and the force-delete SECURITY DEFINER', () => {
      // The guard keys off `current_user`, which under DEFINER would be the owner every time and
      // could never fire; force_delete_item is DEFINER precisely so it passes that guard. Swap
      // either and the pair silently stops working in opposite directions.
      //
      // Comments are stripped first: this asserts what the function DOES, and the guard's own
      // header explains why force_delete_item is DEFINER — prose that would otherwise fail the
      // very assertion it is describing. A source-reading test has to read the source, not the
      // commentary around it.
      const code = s => s.replace(/--[^\n]*/g, '')
      const guard = code(sql.split('CREATE OR REPLACE FUNCTION public.items_guard_referenced_delete')[1]
        .split('$fn$;')[0])
      expect(guard).not.toMatch(/SECURITY DEFINER/i)
      expect(guard).toMatch(/current_user IN \('anon', 'authenticated'\)/)

      const force = code(sql.split('CREATE OR REPLACE FUNCTION public.force_delete_item')[1]
        .split('$fn$;')[0])
      expect(force).toMatch(/SECURITY DEFINER/i)
      // Admin-only, and wrapped — is_admin() returns NULL for a caller with no profiles row, and
      // `IF NOT NULL THEN` never fires, which is the fail-open trap in its third guise.
      expect(force).toMatch(/COALESCE\(is_admin\(\), false\)/)
    })

    it('attaches the guard as a BEFORE DELETE row trigger on items', () => {
      expect(sql).toMatch(/BEFORE DELETE ON public\.items\s+FOR EACH ROW/)
    })
  })
})
