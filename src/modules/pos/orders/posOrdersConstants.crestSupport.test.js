// S819 4k (GAP-OPERATOR-3, D28 b / D29 a): what Crest support does in a client's POS is named
// "Crest support", on the Owner's screens (get_client_profile_names) and on every slip the
// operator's own session prints (printedStaffName). A reprint resolves the name through the RPC, so
// the two spellings must be one, or a reprinted bill names its cashier differently from the original.
//
// S840: the RPC no longer hands every client every operator login. An operator row comes back only
// to the operator itself or for an id the caller asked for in `p_ids` (src/shared/profileNames.js),
// and the one-key form is gone, so a one-key call resolves through the new parameter's default.
import fs from 'fs'
import path from 'path'
import { CREST_SUPPORT_LABEL, printedStaffName } from './posOrdersConstants'

const MIGRATION = path.join(__dirname, '../../../../supabase/migrations/20261015100000_pos_leftovers_s840.sql')

// The function's body: from its CREATE (a plain CREATE after the DROP below) to the end of its
// dollar-quoted body.
function functionBody(sql) {
  const start = sql.search(/CREATE (?:OR REPLACE )?FUNCTION public\.get_client_profile_names\(/)
  expect(start).toBeGreaterThan(-1)
  const rest = sql.slice(start)
  const end = rest.search(/\$(?:function)?\$;/)
  expect(end).toBeGreaterThan(-1)
  return rest.slice(0, end)
}

test('the operator prints as Crest support, never its own name', () => {
  expect(printedStaffName({ full_name: 'Aashish Shrestha' }, true)).toBe('Crest support')
  expect(printedStaffName(null, true)).toBe(CREST_SUPPORT_LABEL)
})

test('everyone else prints their own name, and nothing rather than "undefined"', () => {
  expect(printedStaffName({ full_name: 'Sita Rai' }, false)).toBe('Sita Rai')
  expect(printedStaffName({ full_name: null }, false)).toBe('')
  expect(printedStaffName(undefined, false)).toBe('')
})

test('get_client_profile_names names an operator login with the same words', () => {
  const body = functionBody(fs.readFileSync(MIGRATION, 'utf8'))
  expect(body).toContain(`WHEN p.role = 'admin' THEN '${CREST_SUPPORT_LABEL}'`)
})

test('an operator login is returned only to the operator, or for an id asked for by name', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8')
  const body = functionBody(sql)
  // The ids a screen is resolving, defaulted so a one-key call still resolves.
  expect(body).toMatch(/get_client_profile_names\(\s*p_client_id uuid,\s*p_ids uuid\[\] DEFAULT NULL(?:::uuid\[\])?\s*\)/)
  // The S819 clause handed every caller every operator id; it must be gone.
  expect(body).not.toMatch(/OR p\.role = 'admin';/)
  // The operator's rows are still returned to the two who may see them, or the label reaches nobody.
  expect(body).toMatch(
    /p\.role = 'admin'\s+AND\s+\(\s*COALESCE\(v_caller_role = 'admin', false\)\s+OR\s+p\.id = ANY\s*\(\s*COALESCE\(p_ids, '\{\}'::uuid\[\]\)\s*\)\s*\)/,
  )
  // One overload only: keeping the one-key form beside the new one makes a one-key call ambiguous.
  expect(sql).toMatch(/DROP FUNCTION (?:IF EXISTS )?public\.get_client_profile_names\((?:p_client_id )?uuid\)/)
})
