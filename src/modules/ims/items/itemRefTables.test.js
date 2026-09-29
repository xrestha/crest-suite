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
import {
  ITEM_REF_TABLES, refCountsFromRows, refCodesFromCounts, readItemRefCounts,
  priceImpactPhrase, priceImpactSentence, PRICE_CHANGE_KEEPS,
} from './itemRefTables'

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
  //
  // Against the LATEST migration that defines each function, not the one that first did (S758):
  // 20260919120000 re-created both to add pos_option_ingredients, and a test pinned to the original
  // file would have kept passing against a list the database no longer runs.
  const latestDefining = fnName => {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
    const hits = files.filter(f => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')
      .includes(`CREATE OR REPLACE FUNCTION public.${fnName}`))
    return fs.readFileSync(path.join(MIGRATIONS_DIR, hits[hits.length - 1]), 'utf8')
  }

  describe('and its SQL twin in the latest migration defining each function', () => {
    const sql = fs.readFileSync(
      path.join(MIGRATIONS_DIR, '20260909130000_items_delete_reference_guard.sql'), 'utf8')
    const countsSql = latestDefining('item_reference_counts')
    const forceSql = latestDefining('force_delete_item')

    it('checks the same tables in item_reference_counts()', () => {
      const body = countsSql.split('CREATE OR REPLACE FUNCTION public.item_reference_counts')[1]
        .split('$fn$;')[0]
      // Each UNION ALL branch reads `FROM <table> x JOIN scoped`, which is the only place a table
      // name appears in that shape — so a table added to the list but not the union fails here.
      const checked = [...body.matchAll(/FROM (\w+)\s+x JOIN scoped/g)].map(m => m[1])
      expect(checked.slice().sort()).toEqual(ITEM_REF_TABLES.map(t => t.table).sort())
    })

    it('clears the same tables, in the same dependency order, in force_delete_item()', () => {
      const arr = forceSql
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

      const force = code(forceSql.split('CREATE OR REPLACE FUNCTION public.force_delete_item')[1]
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

// ── The per-item count read (S792, MASTER-8) ─────────────────────────────────────────────────────
//
// Item Master's usage scan and Price Tracker's price confirm both read `item_reference_counts`
// through `readItemRefCounts`. A fake client stands in for supabase-js: `rpc()` returns a builder
// whose `.range()` resolves one page, the way PostgREST does.
function fakeClient(rows, { error = null, pageSize = 1000 } = {}) {
  const calls = []
  const client = {
    rpc(fn, args) {
      const call = { fn, args, order: [], range: null }
      calls.push(call)
      const builder = {
        order(col) { call.order.push(col); return builder },
        range(from, to) {
          call.range = [from, to]
          if (error) return Promise.resolve({ data: null, error })
          return Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + pageSize)), error: null })
        },
      }
      return builder
    },
  }
  return { client, calls }
}

describe('refCountsFromRows / refCodesFromCounts', () => {
  const rows = [
    { ref_item_id: 'a', ref_table: 'purchase_entries', ref_count: 40 },
    { ref_item_id: 'a', ref_table: 'closing_stock', ref_count: '3' },   // bigint may arrive as text
    { ref_item_id: 'a', ref_table: 'vendor_returns', ref_count: 1 },
    { ref_item_id: 'b', ref_table: 'staff_meals', ref_count: 2 },
  ]

  it('keys counts by badge code', () => {
    expect(refCountsFromRows(rows)).toEqual({ a: { P: 40, CS: 3, VR: 1 }, b: { SM: 2 } })
  })

  it('lists codes in ITEM_REF_TABLES order, the order the chip always used', () => {
    // vendor_returns is first in the list, purchase_entries last, whatever order the rows came in.
    expect(refCodesFromCounts(refCountsFromRows(rows))).toEqual({ a: ['VR', 'CS', 'P'], b: ['SM'] })
  })

  it('keeps a table this list does not know, so the delete guard still sees the reference', () => {
    const counts = refCountsFromRows([{ ref_item_id: 'a', ref_table: 'new_table', ref_count: 1 }])
    expect(counts).toEqual({ a: { new_table: 1 } })
    expect(refCodesFromCounts(counts)).toEqual({ a: ['new_table'] })
  })

  it('skips empty and malformed rows', () => {
    expect(refCountsFromRows([{ ref_item_id: 'a', ref_table: 'wastages', ref_count: 0 }, { ref_table: 'wastages', ref_count: 3 }]))
      .toEqual({})
    expect(refCountsFromRows(null)).toEqual({})
  })
})

describe('readItemRefCounts', () => {
  it('asks item_reference_counts once, ordered on a unique key, and returns per-item counts', async () => {
    const { client, calls } = fakeClient([
      { ref_item_id: 'a', ref_table: 'wastages', ref_count: 12 },
      { ref_item_id: 'a', ref_table: 'opening_stock', ref_count: 2 },
    ])
    const { data, error } = await readItemRefCounts(client, ['a', 'b', 'a', null])
    expect(error).toBeNull()
    expect(data).toEqual({ a: { W: 12, OS: 2 } })
    expect(calls).toHaveLength(1)
    expect(calls[0].fn).toBe('item_reference_counts')
    expect(calls[0].args).toEqual({ p_ids: ['a', 'b'] })
    // Paging needs a total order; (item, table) is unique under the function's GROUP BY.
    expect(calls[0].order).toEqual(['ref_item_id', 'ref_table'])
  })

  it('pages past the 1000-row cap instead of stopping at it', async () => {
    const rows = Array.from({ length: 1500 }, (_, i) =>
      ({ ref_item_id: `item${i}`, ref_table: 'purchase_entries', ref_count: 1 }))
    const { client, calls } = fakeClient(rows)
    const { data } = await readItemRefCounts(client, rows.map(r => r.ref_item_id))
    expect(Object.keys(data)).toHaveLength(1500)
    expect(calls.map(c => c.range)).toEqual([[0, 999], [1000, 1999]])
  })

  it('a failed read is an error with no data, never an empty map', async () => {
    const failure = { code: '42501', message: 'permission denied' }
    const { client } = fakeClient([], { error: failure })
    expect(await readItemRefCounts(client, ['a'])).toEqual({ data: null, error: failure })
  })

  it('a thrown request is an error too', async () => {
    const client = { rpc() { throw new TypeError('Failed to fetch') } }
    const { data, error } = await readItemRefCounts(client, ['a'])
    expect(data).toBeNull()
    expect(error).toBeInstanceOf(TypeError)
  })

  it('no ids costs no request', async () => {
    const { client, calls } = fakeClient([])
    expect(await readItemRefCounts(client, [])).toEqual({ data: {}, error: null })
    expect(calls).toHaveLength(0)
  })
})

describe('priceImpactPhrase (S756 D5, moved from Items.js in S792)', () => {
  test('names only the records a price re-values, merging opening and closing counts', () => {
    expect(priceImpactPhrase({ OS: 2, CS: 1, W: 12, P: 40, VR: 3, PO: 2 }))
      .toEqual({ text: '3 stock counts and 12 wastage entries', total: 15 })
  })

  test('purchases alone re-value nothing', () => {
    expect(priceImpactPhrase({ P: 40, PO: 1 })).toBeNull()
    expect(priceImpactPhrase({})).toBeNull()
  })

  test('singular forms', () => {
    expect(priceImpactPhrase({ SM: 1 })).toEqual({ text: '1 staff meal', total: 1 })
  })

  test('three or more parts', () => {
    expect(priceImpactPhrase({ CS: 3, W: 12, R: 1 }).text).toBe('3 stock counts, 12 wastage entries and 1 recipe line')
  })
})

describe('priceImpactSentence (the one D5 sentence Item Master and Price Tracker both give)', () => {
  test('counts what a new price re-values', () => {
    expect(priceImpactSentence({ CS: 3, W: 12 })).toBe(
      "This item's 3 stock counts and 12 wastage entries are valued at this price wherever a report reads them — including months already closed — so those past figures change the moment you save.")
    expect(priceImpactSentence({ SM: 1 })).toMatch(/^This item's 1 staff meal is valued at this price/)
  })

  test('says nothing when the counts were read and nothing is re-valued', () => {
    expect(priceImpactSentence({ P: 40 })).toBeNull()
    expect(priceImpactSentence({}, { complete: true })).toBeNull()
  })

  test('an unread count is not "nothing changes"', () => {
    expect(priceImpactSentence({}, { complete: false })).toMatch(/^Crest could not count this item's past records/)
  })

  test('a partial count still names what it found', () => {
    expect(priceImpactSentence({ W: 2 }, { complete: false })).toMatch(/^This item's 2 wastage entries are valued/)
  })

  test('the closing note names what a price change leaves alone', () => {
    expect(PRICE_CHANGE_KEEPS).toMatch(/Purchase bills keep the price typed on them/)
  })
})
