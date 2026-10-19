/**
 * get_group_pnl is the SQL copy of the Profit & Loss rules (periodCost.js, deliveryCommission.js, the
 * labour rule's payroll figure, the uncounted gap, the depreciation memo, the waiting-bills rule, the
 * stock transfers). It cannot import any of them, so it is kept in step by hand — and every one of these
 * rules has drifted silently once already (S747 comps, S774 bill keys, S792 hidden items and D32 VAT).
 *
 * This reads the NEWEST migration that defines the function and pins each rule's expression, the
 * itemRefTables.test.js technique. A migration that rebuilds get_group_pnl from an older body fails here
 * before it reaches a client's consolidated column (S849, PNL-15).
 */
import fs from 'fs'
import path from 'path'

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations')

function newestBody() {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
  let found = null
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    const at = sql.search(/CREATE (OR REPLACE )?FUNCTION public\.get_group_pnl\(/)
    if (at === -1) continue
    const start = sql.indexOf('$function$', at)
    const end = sql.indexOf('$function$', start + 10)
    found = { file, head: sql.slice(at, start), body: sql.slice(start, end) }
  }
  return found
}

// Comments removed and whitespace flattened, so a comment naming a rule cannot satisfy it.
const flat = s => s.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ')

describe('get_group_pnl (newest definition)', () => {
  const def = newestBody()
  const body = flat(def?.body || '')
  const head = flat(def?.head || '')

  it('is defined by a migration', () => {
    expect(def).not.toBeNull()
    expect(body.length).toBeGreaterThan(1000)
  })

  it('takes the support-view group id last and returns the S849 columns', () => {
    expect(head).toMatch(/get_group_pnl\(p_bs_year integer, p_bs_month integer, p_group_id uuid DEFAULT NULL\)/)
    for (const col of ['transfer_in_val numeric', 'transfer_out_val numeric', 'stock_items integer', 'uncounted_count integer',
      'uncounted_val numeric', 'delivery_commission numeric', 'delivery_unsettled integer', 'depreciation_memo numeric',
      'till_waiting_bills integer', 'till_waiting_notes integer', 'on_the_way_val numeric']) {
      expect(head).toContain(col)
    }
  })

  it('lets only the operator name a group, and an unknown one is P0002', () => {
    expect(body).toMatch(/IF p_group_id IS NOT NULL THEN IF NOT COALESCE\(public\.is_admin\(\), false\) THEN/)
    expect(body).toMatch(/USING ERRCODE = 'P0002'/)
    expect(body).toMatch(/COALESCE\(public\.is_admin\(\), false\) OR COALESCE\(public\.is_client_owner\(\), false\)/)
  })

  it('includes an outlet by its live Suite (client_suite_live) or its consolidated_pnl flag', () => {
    expect(body).toMatch(/COALESCE\(public\.client_suite_live\(c\.id\), false\)/)
    expect(body).toMatch(/consolidated_pnl IS TRUE/)
  })

  it('filters comps NULL-safely (S747) and drops prep everywhere (S792)', () => {
    expect(body).toMatch(/source IS DISTINCT FROM 'pos_comp'/)
    expect(body).not.toMatch(/\.?source\s*<>\s*'pos_comp'/)
    expect(body).toMatch(/NOT i\.is_sub_recipe/)
  })

  it('keys a legacy bill as periodCost does (allocationBillKey)', () => {
    expect(body).toContain("COALESCE( pe.purchase_group_id::text, COALESCE(pe.vendor_id::text, '') || '|' || COALESCE(pe.invoice_ref, '') || '|' || COALESCE(pe.bs_day::text, '') )")
  })

  it('values a VAT line of a vat_is_cost bill × 1.13 (D32)', () => {
    expect(body).toMatch(/THEN 1\.13 ELSE 1 END/)
  })

  it('counts finalized payroll as pay earned + overtime + employer SSF (H19)', () => {
    expect(body).toContain('sum(ps.gross - COALESCE(ps.absence_deduction, 0) + COALESCE(ps.ot_amount, 0) + COALESCE(ps.ssf_employer, 0))')
  })

  it('reads a closing count as physical_qty IS NOT NULL (PNL-2)', () => {
    expect(body).toMatch(/cs\.physical_qty IS NOT NULL/)
  })

  it('folds transfers in into purchases and transfers out into returns (PNL-8)', () => {
    expect(body).toMatch(/\), 0\) \+ COALESCE\(ts\.t_in, 0\) END/)
    expect(body).toMatch(/\), 0\) \+ COALESCE\(ts\.t_out, 0\) END/)
  })

  it('names stock on the way: sent in or before the month, not ended by its end, through the period rows', () => {
    expect(body).toMatch(/LEFT JOIN monthly_periods sp ON sp\.id = t\.sent_period_id/)
    expect(body).toMatch(/LEFT JOIN monthly_periods ep ON ep\.id = t\.ended_period_id/)
    expect(body).toMatch(/\(COALESCE\(sp\.bs_year, t\.sent_bs_year\), COALESCE\(sp\.bs_month, t\.sent_bs_month\)\) <= \(p_bs_year, p_bs_month\)/)
    expect(body).toMatch(/t\.status = 'on_the_way' OR \(COALESCE\(ep\.bs_year, t\.ended_bs_year\), COALESCE\(ep\.bs_month, t\.ended_bs_month\)\) > \(p_bs_year, p_bs_month\)/)
  })

  it('takes delivery commission from uncancelled receipt lines, else the bill (deliveryCommission.js)', () => {
    expect(body).toMatch(/po\.delivery_partner IS NOT NULL/)
    expect(body).toMatch(/po\.status = 'billed'/)
    expect(body).toMatch(/po\.close_type = 'paid'/)
    expect(body).toMatch(/r\.cancelled_at IS NULL/)
    expect(body).toMatch(/ELSE COALESCE\(d\.commission_amount, 0\)/)
    expect(body).toMatch(/d\.credit_settled_at IS NULL AND d\.credit_note_id IS NULL/)
  })

  it('pro-rates the depreciation memo by overlapping days ÷ the run\'s span (PNL-3)', () => {
    expect(body).toContain('(LEAST(s.period_end, v_ad_end) - GREATEST(s.period_start, v_ad_start) + 1)::numeric / NULLIF(s.period_end - s.period_start + 1, 0)')
    expect(body).toMatch(/s\.is_posted/)
  })

  it('counts waiting till bills by pos_ims_waiting_counts\' rule (PNL-11)', () => {
    expect(body).toMatch(/po\.ims_posted_at IS NULL/)
    expect(body).toMatch(/o\.ims_since IS NULL OR po\.closed_at >= o\.ims_since/)
  })
})
