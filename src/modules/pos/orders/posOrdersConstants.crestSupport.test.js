// S819 4k (GAP-OPERATOR-3, D28 b / D29 a): what Crest support does in a client's POS is named
// "Crest support", on the Owner's screens (get_client_profile_names) and on every slip the
// operator's own session prints (printedStaffName). A reprint resolves the name through the RPC, so
// the two spellings must be one, or a reprinted bill names its cashier differently from the original.
import fs from 'fs'
import path from 'path'
import { CREST_SUPPORT_LABEL, printedStaffName } from './posOrdersConstants'

const MIGRATION = path.join(__dirname, '../../../../supabase/migrations/20261012140000_pos_database_operator_s819.sql')

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
  const sql = fs.readFileSync(MIGRATION, 'utf8')
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.get_client_profile_names')
  const body = sql.slice(start, sql.indexOf('$function$;', start))
  expect(body).toContain(`WHEN p.role = 'admin' THEN '${CREST_SUPPORT_LABEL}'`)
  // The operator's rows are returned at all, or the label never reaches anyone.
  expect(body).toMatch(/OR p\.role = 'admin';/)
})
