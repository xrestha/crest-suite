/**
 * Danger Zone's Clear POS Transactions and Clear IMS Transactions each delete their own module's
 * Inventory rows, and between them every row (S809 DATABASE-2).
 *
 * Clear POS used to delete every stock_movements row of the client, the manual Sales Entry depletion
 * included, and Clear IMS every POS one: Book Stock then read the shelf as fuller than it was, and
 * the till's rows never came back (Post POS bills to Inventory skips a stamped bill). Since S809 2e a
 * "not served" credit note's 'pos_credit_restock' rows were in neither clear's list. The lists live
 * in admin-user-ops (Deno, so read here as text) and must split exactly the values the two CHECKs
 * allow: sales_entries_source_check and stock_movements_source_check (migration 20261010100000).
 */
import fs from 'fs'
import path from 'path'
import { stripComments, MIGRATIONS_DIR } from '../../../shared/migrationForeignKeys'

const FUNCTION_FILE = path.join(MIGRATIONS_DIR, '..', 'functions', 'admin-user-ops', 'index.ts')
const fn = fs.readFileSync(FUNCTION_FILE, 'utf8')

function listConst(name) {
  const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(fn)
  if (!m) throw new Error(`${name} not found in admin-user-ops`)
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1])
}

// The values of the LAST definition of the CHECK in the migrations, written either
// `source = ANY (ARRAY[…])` (how Postgres prints it, and every definition so far) or `source IN (…)`.
function checkValues(constraint) {
  let last = null
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()) {
    const sql = stripComments(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'))
    const re = new RegExp(`CONSTRAINT\\s+"?${constraint}"?\\s+CHECK\\s*\\(\\s*\\(?\\s*source\\s*(?:=\\s*ANY\\s*\\(\\s*ARRAY\\s*\\[([^\\]]*)\\]|IN\\s*\\(([^)]*)\\))`, 'gi')
    let m
    while ((m = re.exec(sql)) !== null) last = [...(m[1] ?? m[2]).matchAll(/'([a-z_]+)'/g)].map(x => x[1])
  }
  return last
}

// The clearModuleData action's text, from its `if` to the next action.
const clearBlock = (() => {
  const start = fn.indexOf("if (action === 'clearModuleData')")
  const end = fn.indexOf("if (action === 'deleteClientData')", start)
  return fn.slice(start, end)
})()

describe('the module clears split Inventory by source', () => {
  it('finds both CHECKs and the clear action at all', () => {
    expect(checkValues('sales_entries_source_check')).toEqual(expect.arrayContaining(['manual', 'pos', 'pos_credit_restock']))
    expect(checkValues('stock_movements_source_check')).toEqual(expect.arrayContaining(['manual', 'pos_sale']))
    expect(clearBlock.length).toBeGreaterThan(1000)
  })

  it.each([
    ['sales_entries_source_check', 'IMS_SALES_SOURCES', 'POS_SALES_SOURCES'],
    ['stock_movements_source_check', 'IMS_MOVEMENT_SOURCES', 'POS_MOVEMENT_SOURCES'],
  ])('%s: every allowed source is in exactly one clear', (constraint, imsName, posName) => {
    const ims = listConst(imsName)
    const pos = listConst(posName)
    expect(ims.filter(s => pos.includes(s))).toEqual([])
    expect([...ims, ...pos].sort()).toEqual([...checkValues(constraint)].sort())
  })

  it('never deletes a client\'s stock movements or sales without naming the sources', () => {
    // Each delete statement in the action, up to its label argument.
    const deletes = [...clearBlock.matchAll(/from\('(stock_movements|sales_entries)'\)\.delete\(\)([\s\S]*?), '/g)]
    expect(deletes.length).toBe(4)
    for (const [, table, chain] of deletes) {
      const named = /\.in\('source', (IMS|POS)_(SALES|MOVEMENT)_SOURCES\)/.test(chain)
        || /\.or\(`source\.is\.null,source\.in\.\(\$\{IMS_SALES_SOURCES\.join\(','\)\}\)`\)/.test(chain)
      expect({ table, chain: chain.trim(), named }).toEqual({ table, chain: chain.trim(), named: true })
    }
  })
})
