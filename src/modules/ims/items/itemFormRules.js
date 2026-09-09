// The rules behind Item Master's Add/Edit form, as pure functions — no supabase import, so
// itemFormRules.test.js can load them (the shape purchasesHelpers.js already uses).
//
// They live out here because all three had been decided inline in `Items.js`, where the only way to
// check one was to open the dialog and try it: the next item code, what the form refuses, and the
// row the database actually receives. The last one is the reason this file exists — S597's lesson is
// that a column allowed two meanings gets read with the wrong one somewhere, and the way that stays
// fixed is for exactly one function to decide what `items` gets written.
import { nextProductCode } from '../../../shared/productCode'

// The next sequential item code, derived from the codes already loaded. The counting is
// `nextProductCode` — the same generator Recipe Costing and Settings' Product Codes use, rather than
// a third copy of it (this was the second; Vendors held the third) — which also escapes the prefix,
// since `settings.item_code_prefix` is free text an owner types in Settings.
//
// Only meaningful when the list it is given is authoritative: a failed read leaves it empty and this
// restarts at -001 over codes that already exist. `items` has no UNIQUE(client_id, item_code), so
// that duplicate is silent, and the recipe importer resolves a code to whichever row it saw last —
// which is why the caller must not offer Add while the list is unknown.
export function nextItemCode(items, prefix) {
  const p = String(prefix || 'ITM').toUpperCase() || 'ITM'
  return nextProductCode(p, (items || []).map(i => i?.item_code))
}

// "I bought 500 GM for NPR 388.50" → NPR 0.777 per GM, which is what actually gets stored. ONE
// derivation feeds both the "→ NPR x per uom" preview and the rate written into the form — they
// briefly had independent copies of this division with different rounding, which is how a preview
// comes to state a price the form did not save. Number(), not parseFloat: a prefix parse of a
// not-quite-numeric string ("5oo" → 5, "1,200" → 1) must never price an item.
export function perUnitOf(qty, total) {
  const q = Number(qty), t = Number(total)
  return q > 0 && t > 0 ? Number((t / q).toFixed(6)) : null
}

// What the form refuses, and where the message goes. `fieldErr` is per-box (a message about one box
// belongs under that box, S603); `formError` is the form-level channel, for a rule spanning several
// fields that no single box owns; `tab` is the tab that must be showing for the reader to see them.
//
// `canCheckNames` is false when the items list on screen is not authoritative (its read failed): a
// duplicate-name check against a list that may be missing rows can only produce a false all-clear,
// and saying nothing is honest where claiming the name is free is not.
export function validateItemForm(form, { items = [], editingId = null, canCheckNames = true } = {}) {
  const fieldErr = {}
  const name = String(form.name || '').trim()
  const uom = form.uom || 'unit'

  if (!name) {
    fieldErr.name = 'Item name is required.'
  } else if (canCheckNames) {
    // `items` has no UNIQUE(client_id, name) and the recipe importer maps an ingredient name to
    // whichever row it saw LAST, so two items sharing a name means every recipe imported by name
    // costs off one of them while purchases accumulate against the other — and nothing on any
    // screen says which. Blocked here rather than left to a constraint that does not exist.
    // Scoped to the items this page loads, so it does not see a sub-recipe mirror of the same name.
    const dupe = items.find(i =>
      i.id !== editingId && String(i.name || '').trim().toUpperCase() === name.toUpperCase())
    if (dupe) {
      fieldErr.name = `${dupe.item_code ? `${dupe.item_code} is` : 'Another item is'} already called ` +
        `${name.toUpperCase()}. Two items with one name cost differently in every recipe imported by ` +
        `name and only one of them can win, so edit that item instead — or add what tells them apart ` +
        `(brand, size, grade).`
    }
  }

  // parseFloat, not truthiness: "0" is truthy as a string, and a price of NPR 0 stored here
  // misprices the item in every valuation at once with nothing to flag it (S612).
  if (!form.rate || !(parseFloat(form.rate) > 0)) {
    fieldErr.rate = `Price per ${uom} is required and must be above zero — type it in, or use ` +
      `"Bought a pack?" to work it out.`
  }

  // Yield is the usable SHARE of what you buy, so 1–100 is the whole range. The box has carried
  // min="1" max="100" from the start, but this form is not a <form> and nothing was submitting it,
  // so neither was ever checked: a typed 1000 saved as 1000, and recipeCostCalc divides by
  // yield_pct/100 at every depth — quietly costing every recipe using that item at a tenth.
  const yieldRaw = String(form.yield_pct ?? '').trim()
  if (yieldRaw !== '') {
    const y = parseFloat(yieldRaw)
    if (!(y > 0) || y > 100) {
      fieldErr.yield_pct = 'Yield % is the usable share of what you buy, so it has to be between 1 ' +
        'and 100. Leave it at 100 if there is no trim loss.'
    }
  }

  // The conversion pair. Base Unit is not part of it: it is structurally the item's UOM (see
  // itemPayload), so there is nothing for the reader to get wrong and nothing to validate.
  let formError = ''
  const purchaseUnit = String(form.purchase_unit || '').trim()
  const cfRaw = String(form.conversion_factor ?? '').trim()
  if (purchaseUnit !== '' || cfRaw !== '') {
    if (purchaseUnit === '') {
      formError = 'A conversion needs the unit you buy in as well as the factor — pick a Purchase Unit, or clear the factor.'
    } else if (cfRaw === '') {
      formError = `A conversion needs the factor as well as the unit: how many ${uom} are in one ${purchaseUnit.toUpperCase()}?`
    } else if (!(parseFloat(cfRaw) > 1)) {
      // A factor of 1 or below is not a conversion, and every consumer knows it — getCf() returns 1
      // unless the factor is above 1, so a saved "1 CTN = 0.5 BTL" was carried in the row, badged in
      // the table and previewed in this dialog while no bill, print or report honoured it.
      formError = `A conversion factor has to be more than 1 — one ${purchaseUnit.toUpperCase()} has to ` +
        `hold more than one ${uom}. Clear both boxes if you buy and count in the same unit.`
    }
  }

  const hasFieldErr = Object.keys(fieldErr).length > 0
  return {
    ok: !hasFieldErr && !formError,
    fieldErr,
    formError,
    tab: hasFieldErr || !formError ? 'details' : 'conversion',
  }
}

// The row the database receives — everything but `item_code`, which only a new item gets.
// Call this ONLY on a form that validateItemForm() passed.
//
// `purchase_qty` is pinned to 1 and deliberately NOT set from the conversion factor: a
// buy-in-CTN / count-in-BTL relationship belongs to the conversion columns, which is what the
// Purchase Bill reads to pick its qty unit. Mirroring it here would store a per-CTN price in a
// column every valuation reads as per-BTL (S597).
//
// `base_unit` is derived, never chosen. Nothing downstream reads it: `getCf()` decides a conversion
// from `purchase_unit` + `conversion_factor`, and every consumer converts the purchase unit into
// `items.uom` — the qty a purchase entry stores, the unit Purchases/Returns/print label it with,
// and the unit stock is valued in. A free Base Unit select therefore let an item say
// "1 CTN = 24 BTL" while its stock was counted and priced in GM, and this dialog's own preview
// printed the per-GM rate labelled "per BTL": the screen agreeing with the reader and disagreeing
// with the arithmetic, which is the S597 shape one layer up.
export function itemPayload(form) {
  const hasConversion = String(form.purchase_unit || '').trim() !== '' && parseFloat(form.conversion_factor) > 1
  const y = parseFloat(form.yield_pct)
  return {
    name: String(form.name || '').trim().toUpperCase(),
    category_id: form.category_id || null,
    uom: form.uom,
    purchase_qty: 1,
    rate: parseFloat(parseFloat(form.rate).toFixed(6)),
    purchase_unit: hasConversion ? String(form.purchase_unit).trim().toUpperCase() : null,
    base_unit: hasConversion ? form.uom : null,
    conversion_factor: hasConversion ? parseFloat(form.conversion_factor) : 1,
    yield_pct: y > 0 && y <= 100 ? y : 100,
  }
}
