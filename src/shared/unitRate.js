// A stock item's price per unit, in the unit a person buys in (S797).
//
// Every stock rate is stored per BASE unit — NPR per GM, per ML, per PCS (item-master-rates.md) — so
// a kilo of chicken at NPR 194.40 reads "0.1944 per GM", and Recipe Costing's two-decimal column
// printed it as 0.19, a 2% misstatement on every line. Where the base unit is GM or ML the rate is
// shown per KG / LTR FIRST, with the stored per-GM / per-ML figure beside it (owner decision: both,
// side by side), so the eye gets the price on the supplier's bill and the figure every calculation
// uses is still on screen. Nothing stored changes: the boxes a price is typed into stay per base
// unit, and Excel exports keep the stored figure so a spreadsheet still multiplies by base quantity.
import { NPR_LOCALE } from './nepalMoney'

const BIG_UNIT = {
  GM: { unit: 'KG', factor: 1000 },
  ML: { unit: 'LTR', factor: 1000 },
}

// The bigger unit a base unit is bought in, or null when there is none worth showing.
export function bigUnitOf(uom) {
  return BIG_UNIT[String(uom || '').trim().toUpperCase()] || null
}

// A per-unit rate at the precision it needs: two decimals from NPR 1 up, up to four below it (a
// per-gram 0.115 is NPR 115 a kg, and two decimals would print 0.12), up to six below NPR 0.01
// (cheese at 0.004 a gram would otherwise print 0.00, hiding exactly the mis-entry a rate column
// exists to reveal). '—' for a missing, zero or negative rate; a caller for whom 0 is a real figure
// (a free purchase line) says so itself. `precise` keeps up to four decimals from NPR 1 up too, for
// a page whose job is to show a price MOVING (Price Tracker): at two, 18.3612 → 18.3645 read as
// "18.36 → 18.36".
export function fmtUnitRate(v, { precise = false } = {}) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n < 0.01) return parseFloat(n.toFixed(6)).toString()
  return n.toLocaleString(NPR_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: n < 1 || precise ? 4 : 2 })
}

// The two halves for a caller that lays them out itself: `primary` is the rate in the unit to read
// first (per KG / LTR where there is one), `secondary` the stored per-base-unit figure, or null when
// the base unit has no bigger one. Null for a rate that is not a positive number.
export function unitRateParts(rate, uom, { precise = false } = {}) {
  const n = Number(rate)
  if (!Number.isFinite(n) || n <= 0) return null
  const u = String(uom || '').trim()
  const big = bigUnitOf(u)
  if (!big) return { primary: { value: fmtUnitRate(n, { precise }), unit: u }, secondary: null }
  return {
    primary: { value: fmtUnitRate(n * big.factor, { precise }), unit: big.unit },
    secondary: { value: fmtUnitRate(n, { precise }), unit: u.toUpperCase() },
  }
}

// For a table cell whose unit already sits in a column of its own: a GM / ML rate reads
// "194.40/KG (0.1944/GM)", anything else just the figure ("18.36"), which the column beside it
// already names. '—' for a rate that is not a positive number.
export function unitRateCell(rate, uom, { precise = false } = {}) {
  return bigUnitOf(uom) ? unitRateText(rate, uom, { prefix: '', per: '/', precise }) : fmtUnitRate(rate, { precise })
}

// One line of text. Sentence form by default — "NPR 194.40 per KG (0.1944 per GM)", or
// "NPR 50.00 per BTL" for a unit with no bigger one. For a table cell, pass
// `{ prefix: '', per: '/' }` → "194.40/KG (0.1944/GM)". '—' for a rate that is not a positive number.
export function unitRateText(rate, uom, { prefix = 'NPR ', per = ' per ', precise = false } = {}) {
  const p = unitRateParts(rate, uom, { precise })
  if (!p) return '—'
  const main = `${prefix}${p.primary.value}${p.primary.unit ? `${per}${p.primary.unit}` : ''}`
  return p.secondary ? `${main} (${p.secondary.value}${per}${p.secondary.unit})` : main
}
