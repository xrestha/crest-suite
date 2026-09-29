import { fmtRate } from './purchasesHelpers'

/**
 * A purchase or return line's rate as the register, the Returns tab and the printed voucher show it
 * (S792, PURCHASES-9). Those three used a 2-decimal format, so a per-base-unit rate below one paisa
 * read as nothing at all — a 0.004/GM line printed "0" — which is exactly the figure fmtRate exists
 * to keep: below NPR 0.01 it shows up to six decimals, at or above it two.
 *
 * One difference from fmtRate: a rate of 0 is a FREE line (buy ten get one free, S698), a real
 * figure rather than a missing one, so it prints "0.00". fmtRate's "—" means "no rate", which is the
 * right answer for an Item Master hint and the wrong one on a bill.
 */
export function fmtLineRate(v) {
  const n = parseFloat(v)
  return n === 0 ? '0.00' : fmtRate(v)
}

/**
 * Bill lines naming an item that is not in `items`, with their 1-based row on the form
 * (S792, PURCHASES-10).
 *
 * The bill form's item list holds ACTIVE items (plus, on an edit, the bill's own saved items). A
 * draft typed before an item was hidden in Item Master comes back naming an item that list no
 * longer has, and every conversion on the form then falls back: getCf() on a missing item is 1, so
 * a quantity typed in cartons would save as that many single units. The form refuses such a line
 * rather than guess its unit. Lines with no item picked are not listed — that is a different refusal.
 *
 * Returns [{ line, row }].
 */
export function linesWithUnlistedItems(lines, items) {
  const known = new Set((items || []).map(i => i.id))
  return (lines || [])
    .map((line, idx) => ({ line, row: idx + 1 }))
    .filter(x => x.line?.item_id && !known.has(x.line.item_id))
}

/**
 * The refusal for linesWithUnlistedItems, naming each row and, where it could be read, its item.
 * `nameById` is `{ [itemId]: name }`; a row whose item has no name there (deleted, or the name
 * read failed) is named by its row number alone. The refusal happens before anything is written,
 * so it may say the bill was not saved.
 */
export function unlistedItemsText(unlisted, nameById = {}) {
  const list = unlisted || []
  const one = list.length === 1
  const rows = list.map(({ line, row }) => (nameById[line.item_id] ? `row ${row} ("${nameById[line.item_id]}")` : `row ${row}`))
  const named = rows.length > 1 ? `${rows.slice(0, -1).join(', ')} and ${rows[rows.length - 1]}` : rows[0] || ''
  return `The bill was not saved. ${named.charAt(0).toUpperCase()}${named.slice(1)} ${one ? 'uses an item' : 'use items'} hidden or removed in Item Master since ${one ? 'it was' : 'they were'} typed, so Crest cannot tell which unit ${one ? 'its quantity is' : 'their quantities are'} in, and will not guess. Remove ${one ? 'that row' : 'those rows'} with ×, or make the item active again in Item Master and then reopen this bill — what you typed stays on this device until you save or cancel.`
}
