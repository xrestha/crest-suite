// Item Master Excel import (S885, owner decision 1): parse the sheet and plan what is written.
// Pure, pinned by itemImportPlan.test.js; ItemImportButton.jsx does the reading and the writing.
//
// Every column is a box on the Add Item form, converted the way the form converts it (Items.js
// doSave): the name upper-cased, one price per base unit (or a pack size and what it cost, divided
// by the form's own perUnitOf), purchase unit and how many base units come in one (both or
// neither), Yield % from 1 to 100. Never `per_uom_rate` (a generated column) and never anything
// existing: a row whose name the book already holds, in any capitals, hidden items and sub-recipe
// mirrors included, is skipped with its reason, and so is a name repeated further down the file.
import { UNITS, SUB_RECIPES_CATEGORY, nextCodeAfter, perUnitOf, itemNameKey } from './itemFormRules'
import { cellText, cellNumber, cellPercent, isBlankRow } from './sheetImport'

export const ITEM_SHEET_NAME = 'Items'

/** The price column header says which basis the outlet keeps its master prices on (D32). */
export function itemPriceHeader(vatMode) {
  if (vatMode === 'pan') return 'Price per Unit (NPR, VAT paid included)'
  if (vatMode === 'vat') return 'Price per Unit (NPR, before VAT)'
  return 'Price per Unit (NPR)'
}

export function itemImportColumns(vatMode) {
  return [
    'Item Name *', 'Category', 'Unit *', itemPriceHeader(vatMode),
    'Pack Size (in Unit)', 'Pack Price (NPR)', 'Purchase Unit', 'Units per Purchase Unit', 'Yield %',
  ]
}

/** One sentence on the price basis, for the template and the preview. */
export function itemPriceBasisText(vatMode) {
  if (vatMode === 'pan') {
    return 'This outlet gives PAN bills, so it cannot claim back the VAT on a supplier bill: type the price you actually paid, VAT included, as the Add Item form takes it.'
  }
  if (vatMode === 'vat') {
    return 'This outlet is VAT registered, so type the price before VAT, as the Add Item form takes it.'
  }
  return 'Type the price the same way the Add Item form takes it.'
}

const COL = { name: 0, category: 1, unit: 2, price: 3, packQty: 4, packPrice: 5, purchaseUnit: 6, factor: 7, yield: 8 }

// Spellings people type for a unit Crest already has. Anything not here and not in UNITS is refused
// rather than guessed: GM against KG is a price 1000 times wrong.
const UNIT_ALIASES = {
  G: 'GM', GMS: 'GM', GRAM: 'GM', GRAMS: 'GM', GRM: 'GM',
  KGS: 'KG', KILO: 'KG', KILOS: 'KG', KILOGRAM: 'KG', KILOGRAMS: 'KG',
  MLS: 'ML', MILLILITRE: 'ML', MILLILITER: 'ML',
  L: 'LTR', LT: 'LTR', LTRS: 'LTR', LITRE: 'LTR', LITRES: 'LTR', LITER: 'LTR', LITERS: 'LTR',
  PC: 'PCS', PIECE: 'PCS', PIECES: 'PCS', NOS: 'PCS', NO: 'PCS',
  PACKET: 'PKT', PACKETS: 'PKT', PKTS: 'PKT', PACK: 'PKT',
  BOTTLE: 'BTL', BOTTLES: 'BTL', BTLS: 'BTL',
  BOXES: 'BOX', ROLLS: 'ROLL', BUNCHES: 'BUNCH', JARS: 'JAR',
  CARTON: 'CTN', CARTONS: 'CTN', CTNS: 'CTN', BAGS: 'BAG', TINS: 'TIN', CAN: 'TIN', SACHETS: 'SACHET',
}

/** A typed unit as one of UNITS, or null. */
export function readUnit(text) {
  const t = String(text ?? '').replace(/[\s.]+/g, '').toUpperCase()
  if (!t) return null
  if (UNITS.includes(t)) return t
  return UNIT_ALIASES[t] || null
}

const unitList = () => UNITS.join(', ')

/** A header row is recognised by its first cell, as Recipe Import does. */
export function isItemHeaderRow(row) {
  return /^(item\s*name\b.*|name\s*\*?|item\s*\*?)$/i.test(cellText(row, COL.name))
}

const round6 = n => Number(Number(n).toFixed(6))

/**
 * One sheet row as the item it would add: `{ rowNo, name, categoryName, uom, rate, purchase_unit,
 * conversion_factor, yield_pct, notes }`, or `{ rowNo, name, reason }` when it cannot be imported.
 */
export function parseItemRow(row) {
  const rowNo = row.rowNo
  const name = cellText(row, COL.name).toUpperCase()
  const skip = reason => ({ rowNo, name, reason })
  if (!name) return skip('No item name.')

  const unitText = cellText(row, COL.unit)
  const uom = readUnit(unitText)
  if (!unitText) return skip(`No unit. Type the unit you count it in: one of ${unitList()}.`)
  if (!uom) return skip(`"${unitText}" is not a unit Crest counts in. Use one of ${unitList()}.`)

  const notes = []
  const price = cellNumber(row, COL.price)
  const packQty = cellNumber(row, COL.packQty)
  const packPrice = cellNumber(row, COL.packPrice)
  if (price.bad) return skip(`The price "${price.text}" is not a number.`)
  if (packQty.bad) return skip(`The pack size "${packQty.text}" is not a number.`)
  if (packPrice.bad) return skip(`The pack price "${packPrice.text}" is not a number.`)
  const packGiven = !packQty.blank || !packPrice.blank
  if (packGiven && (packQty.blank || packPrice.blank)) {
    return skip(`A pack needs both its size in ${uom} and what it cost.`)
  }
  const packRate = packGiven ? perUnitOf(packQty.value, packPrice.value) : null
  if (packGiven && packRate == null) return skip('The pack size and the pack price both need a number above zero.')

  let rate
  if (!price.blank) {
    if (!(price.value > 0)) return skip(`The price per ${uom} must be above zero.`)
    rate = round6(price.value)
    // Both given: they must describe one price, or one of them is a typing slip the import
    // cannot pick between. Half a percent covers a pack price rounded to the rupee.
    if (packRate != null && Math.abs(packRate - rate) > Math.max(1e-6, rate * 0.005)) {
      return skip(`The price per ${uom} (${rate}) and the pack (${packQty.value} ${uom} for NPR ${packPrice.value}, so ${packRate} per ${uom}) do not agree. Keep one of them.`)
    }
  } else if (packRate != null) {
    rate = packRate
    notes.push(`price worked out from ${packQty.value} ${uom} for NPR ${packPrice.value}`)
  } else {
    return skip(`No price. Type the price per ${uom}, or the pack size and what it cost.`)
  }
  if (!(rate > 0)) return skip(`The price per ${uom} is too small to store: Crest keeps six decimals. Check the unit.`)

  const puText = cellText(row, COL.purchaseUnit)
  const factor = cellNumber(row, COL.factor)
  if (factor.bad) return skip(`The units per purchase unit "${factor.text}" is not a number.`)
  let purchaseUnit = null
  let cf = 1
  if (puText || !factor.blank) {
    if (!puText || factor.blank) return skip(`A purchase unit needs both the unit you buy in and how many ${uom} come in one.`)
    purchaseUnit = readUnit(puText)
    if (!purchaseUnit) return skip(`"${puText}" is not a purchase unit Crest knows. Use one of ${unitList()}.`)
    if (!(factor.value > 0)) return skip(`How many ${uom} come in one ${purchaseUnit} must be above zero.`)
    cf = factor.value
  }

  const y = cellPercent(row, COL.yield)
  let yieldPct = 100
  if (y.bad) return skip(`The yield "${y.text}" is not a number.`)
  if (!y.blank) {
    if (!(y.value > 0) || y.value > 100) return skip('Yield must be from 1 to 100: the usable percentage left after trim, so 100 means no loss.')
    if (y.value <= 1 && !y.fromPercentCell) {
      return skip(`A yield of ${y.value} would mean ${y.value} percent usable. For seventy percent type 70, not 0.7.`)
    }
    yieldPct = round6(y.value)
  }

  return {
    rowNo, name, categoryName: cellText(row, COL.category), uom, rate,
    purchase_unit: purchaseUnit, conversion_factor: cf, yield_pct: yieldPct, notes,
  }
}

/** Every non-blank row after the header, parsed. */
export function parseItemRows(rows) {
  const body = (rows || []).filter(r => !isBlankRow(r))
  const start = body.length && isItemHeaderRow(body[0]) ? 1 : 0
  return body.slice(start).map(parseItemRow)
}

const catKey = name => itemNameKey(name)

/** The category a typed name files under: exact spelling first, then any capitals or spacing. */
export function findCategory(name, categories) {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return null
  return (categories || []).find(c => c.name === clean)
    || (categories || []).find(c => catKey(c.name) === catKey(clean))
    || null
}

/**
 * What an import of `parsed` would write, against the book as read just now.
 *  - `book`: every item row, unfiltered (`name`, `item_code`, `is_sub_recipe`, `is_active`).
 *  - `categories`: every category row, Sub-Recipes included (`id`, `name`).
 *  - `prefix`: the item code prefix setting; `extraCodes`: codes this visit already minted.
 * → `{ ready, skipped, newCategories }`. `ready` rows carry the minted `item_code`, and either a
 * `category_id` or the `newCategory` name they will be filed under once it is created.
 */
export function planItemImport(parsed, { book = [], categories = [], prefix = 'ITM', extraCodes = [] } = {}) {
  const byName = new Map()
  book.forEach(i => {
    const k = itemNameKey(i.name)
    if (k && !byName.has(k)) byName.set(k, i)
  })
  const codes = [...book.map(i => i.item_code).filter(Boolean), ...(extraCodes || [])]
  const firstRowOf = new Map()
  const newCategories = []
  const ready = []
  const skipped = []

  parsed.forEach(p => {
    if (p.reason) { skipped.push(p); return }
    const skip = reason => skipped.push({ rowNo: p.rowNo, name: p.name, reason })
    const key = itemNameKey(p.name)
    const held = byName.get(key)
    if (held) {
      skip(held.is_sub_recipe
        ? `"${held.name}" is already a sub-recipe in Recipe Costing, and it is counted beside your items, so a second row would split its stock. Nothing was changed.`
        : `Item Master already has "${held.name}"${held.is_active === false ? ' (hidden)' : ''}. Nothing about it was changed.`)
      return
    }
    if (firstRowOf.has(key)) {
      skip(`Named again: row ${firstRowOf.get(key)} already has this item, and only the first is imported.`)
      return
    }

    let category_id = null
    let newCategory = null
    let categoryResolved = null
    if (p.categoryName) {
      if (catKey(p.categoryName) === catKey(SUB_RECIPES_CATEGORY)) {
        skip('Sub-Recipes holds only the sub-recipes made in Recipe Costing. Pick another category for this item.')
        return
      }
      const found = findCategory(p.categoryName, categories)
      if (found) {
        category_id = found.id
        categoryResolved = found.name
      } else {
        const already = newCategories.find(n => catKey(n) === catKey(p.categoryName))
        newCategory = already || p.categoryName
        if (!already) newCategories.push(p.categoryName)
      }
    }

    firstRowOf.set(key, p.rowNo)
    const item_code = nextCodeAfter(prefix || 'ITM', codes)
    codes.push(item_code)
    ready.push({ ...p, category_id, categoryResolved, newCategory, item_code })
  })
  return { ready, skipped, newCategories }
}

/** The `items` row for a ready line, in the form's own shape (Items.js doSave payload + code). */
export function itemInsertRow(r, categoryId = r.category_id) {
  return {
    name: r.name,
    category_id: categoryId || null,
    uom: r.uom,
    purchase_qty: 1,
    rate: r.rate,
    purchase_unit: r.purchase_unit,
    base_unit: r.purchase_unit ? r.uom : null,
    conversion_factor: r.conversion_factor,
    yield_pct: r.yield_pct,
    item_code: r.item_code,
  }
}
