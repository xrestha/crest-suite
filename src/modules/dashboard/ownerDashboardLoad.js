/**
 * The Owner Dashboard's reads (S853, OWNER-DASHBOARD-9), pulled out of the page so their ORDER can be
 * tested: which reads start together, and which wait for what. The page keeps the sections, the
 * request counters and every setter; this file only starts reads and hands back their promises.
 *
 * The round trips in a row on load, before and after:
 *   before  the month read; then the month batch, its longest chain `sales_entries` paged 1,000 rows
 *           at a time, one page after another (10 pages on day 25 of a busy till); the HR staff reads
 *           waited for the month too, though they use nothing of it.
 *   after   the month read, with the recipe book and the HR staff reads beside it (startFirstWave);
 *           then the batch, whose sales read asks page 1 with the row count and every later page at
 *           once (fetchAllRowsParallel): 1 + 2 levels, whatever the month's size.
 *
 * Every promise here settles (never rejects): each read goes through the page's `read` (settleWithin),
 * and the recipe book's rejection is caught here and reported where the reorder section awaits it.
 */
import { fetchAllRows, fetchAllRowsParallel } from '../../shared/fetchAllRows'
import { loadRecipeBook } from '../../utils/recipeCost'
import { WASTAGE_VALUE_SELECT } from '../ims/reports/periodCost'
import { readPeriodTransfers } from '../ims/transfers/transferFlows'
import { readPriorBillLines } from '../ims/reports/readPriorBillLines'
import { loadLabourMasters } from './loadOutletLabour'
import { returnsAgainstEarlierBills } from './ownerDashboardData'

// One union read per table for the month (OWNER-DASHBOARD-9): the IMS figures and the reorder tile
// used to read five of these twice.
export const PURCHASE_COLS = 'id, item_id, qty, rate, bs_day, payment_method, discount_amount, purchase_group_id, vendor_id, invoice_ref, vat_inclusive, vat_is_cost'
// `period_id` in the embed says which returns are against an EARLIER month's bill (S853, D2), so those
// bills are read as soon as the returns land (returnsAgainstEarlierBills).
export const RETURN_COLS = 'item_id, qty, rate, bs_day, payment_method, purchase_entry_id, purchase_entries(vat_inclusive, vat_is_cost, period_id)'
// `source` is SELECTED and comps are filtered in JS (revenueOf), never `.neq('source','pos_comp')`:
// the column is nullable and `NULL <> 'pos_comp'` dropped every legacy row from revenue (S734).
export const SALES_COLS = 'recipe_id, qty_sold, unit_price, discount, source, bs_day, ingredient_deltas'

const NONE = { data: [], error: null }

/**
 * The month read and every read that needs nothing from the month, started in ONE tick: the recipe
 * book (the reorder walk reads it from memory, S793) and the HR staff reads the labour estimate needs
 * (`loadLabourMasters`, handed to `loadOutletLabour({ masters })`).
 *
 * @param {object} o
 * @param {(table: string, columns?: string) => object} o.scopedFrom
 * @param {(promise: Promise, label: string) => Promise} o.read  the page's settleWithin wrapper
 * @returns {{ book: Promise, masters: Promise, months: Promise<{ data, error }> }}
 */
export function startFirstWave({ scopedFrom, read }) {
  const book = loadRecipeBook(scopedFrom)
  book.catch(() => {}) // a failure is the reorder section's, reported where it is awaited
  const masters = loadLabourMasters((t, c) => scopedFrom(t, c))
  // Tens of rows at most: one per month the client has run. The newest first.
  const months = read(scopedFrom('monthly_periods', 'id, bs_year, bs_month, status')
    .order('bs_year', { ascending: false }).order('bs_month', { ascending: false }).limit(24), 'Months')
  return { book, masters, months }
}

/**
 * The month's batch: IMS figures and the reorder rows from ONE read per table, every read started
 * now, so each section awaits only its own. A read a section does not want is not made.
 *
 * @param {object} o
 * @param {object} o.supabase
 * @param {(table: string, columns?: string) => object} o.scopedFrom
 * @param {(promise: Promise, label: string) => Promise} o.read
 * @param {string}  o.periodId
 * @param {boolean} o.wantIms
 * @param {boolean} o.wantReorder
 * @param {(lineIds: string[]) => Promise} [o.readPrior]  readPriorBillLines (a test passes its own)
 * @returns {Object<string, Promise<{ data, error }>>}  purchases, returns, sales, recipes, wastages,
 *   transfers, overheads, priorBills (the IMS section's), opening, closing, items, pars, staffMeals
 */
export function startMonthBatch({ supabase, scopedFrom, read, periodId: pid, wantIms, wantReorder, readPrior = readPriorBillLines }) {
  const skip = Promise.resolve(NONE)
  // Paged (S734): subtracted from net purchases, so a truncation OVERSTATES Spend % so far.
  const returns = read(fetchAllRows(() => scopedFrom('vendor_returns', RETURN_COLS).eq('period_id', pid).order('id')), 'Supplier returns')
  return {
    // `discount_amount` + the bill keys feed allocateBillDiscounts (net of each bill's discount);
    // `id` and `payment_method` feed the Payment Report's cash/credit split (billPayables).
    purchases: read(fetchAllRows(() => supabase.from('purchase_entries').select(PURCHASE_COLS).eq('period_id', pid).order('id')), 'Purchases'),
    returns,
    // The longest read on the page: page 1 brings the row count and every later page goes out at once.
    sales: read(fetchAllRowsParallel(opts => supabase.from('sales_entries').select(SALES_COLS, opts).eq('period_id', pid).order('id')), 'Sales'),
    // Paged, and a PRODUCER: the price fallback for a sales row with no unit_price (S734).
    recipes: read(fetchAllRows(() => scopedFrom('recipes', 'id, selling_price').order('id')), 'Recipes'),
    // Each row carries its item's rate (WASTAGE_VALUE_SELECT): the Wastage Report's own total.
    wastages: read(fetchAllRows(() => supabase.from('wastages').select(WASTAGE_VALUE_SELECT).eq('period_id', pid).order('id')), 'Wastage'),
    // Stock received from / sent to the group's other outlets (PNL-8): in adds like a purchase, out
    // comes off like a return. A failed read fails the month's figures, never a spend without it.
    transfers: read(readPeriodTransfers(scopedFrom, [pid]), 'Stock transfers'),
    // Deliberately not paged: tens of rows per month. EVERY bucket (S849, GAPS-4): the Labor tab is
    // read so it can be named "not counted" — Crest HR is this page's labour figure.
    overheads: wantIms ? read(scopedFrom('overheads', 'amount, bucket').eq('period_id', pid), 'Overheads') : skip,
    // Every line of each earlier-month bill a return points at (S853, D2), so Cash / Credit takes such a
    // return off at its bill's discounted price, as the Payment Report does. It waits only for the
    // returns; their own failure is reported through `returns`. A failed read fails the IMS figures.
    priorBills: wantIms
      ? returns.then(r => {
        const ids = r.error ? [] : returnsAgainstEarlierBills(r.data, pid)
        return ids.length > 0 ? read(readPrior(ids), 'Earlier bills') : NONE
      })
      : skip,
    // Six paged master/period reads for the reorder tile (S734): a row past a truncated read reads
    // as a zero count and takes an item off the below-par count silently.
    opening: wantReorder ? read(fetchAllRows(() => supabase.from('opening_stock').select('item_id, qty').eq('period_id', pid).order('id')), 'Opening stock') : skip,
    closing: wantReorder ? read(fetchAllRows(() => supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', pid).order('id')), 'Closing stock') : skip,
    items: wantReorder ? read(fetchAllRows(() => scopedFrom('items', 'id, per_uom_rate, yield_pct').eq('is_active', true).eq('is_sub_recipe', false).order('id')), 'Items') : skip,
    pars: wantReorder ? read(fetchAllRows(() => scopedFrom('par_levels', 'item_id, par_qty').order('id')), 'Par levels') : skip,
    staffMeals: wantReorder ? read(fetchAllRows(() => supabase.from('staff_meals').select('item_id, qty').eq('period_id', pid).order('id')), 'Staff meals') : skip,
  }
}
