// Supplier Excel import (S885, owner decision 1): parse the sheet and plan what is written. Pure,
// pinned by vendorImportPlan.test.js; VendorImportButton.jsx does the reading and the writing.
//
// A row whose name matches any supplier already on file (trimmed, any capitals, archived ones
// included) is skipped with its reason and nothing existing is changed; a name repeated further
// down the file is skipped too. A PAN that is not 9 digits, or one another supplier already has,
// still imports, with a warning (the earlier decision on the form: warn, never refuse).
import { cellText, cellNumber, isBlankRow } from '../items/sheetImport'
import { panWarning, normalisePan } from '../reports/purchaseTaxSplit'
import { parsePayTerms, MAX_PAY_WITHIN_DAYS, DEFAULT_PAY_WITHIN_DAYS } from './payTerms'
import { nextVendorCodeAfter } from './vendorFormRules'

export const VENDOR_SHEET_NAME = 'Suppliers'

export const VENDOR_IMPORT_COLUMNS = [
  'Supplier Name *', 'Contact Person', 'Phone', 'Address', 'PAN / VAT No.', 'Pay Within (days)', 'Terms Note',
]

const COL = { name: 0, contact: 1, phone: 2, address: 3, pan: 4, payWithin: 5, note: 6 }

export function vendorNameKey(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

export function isVendorHeaderRow(row) {
  return /^(supplier\s*name\b.*|vendor\s*name\b.*|name\s*\*?|supplier\s*\*?|vendor\s*\*?)$/i.test(cellText(row, COL.name))
}

const PAY_WITHIN_RULE = `Pay within takes whole days from 0 to ${MAX_PAY_WITHIN_DAYS} (0 means due on delivery), or a blank for the usual ${DEFAULT_PAY_WITHIN_DAYS} days.`

/**
 * The Pay Within cell: `{ value }` (a whole number of days, or null when blank) or `{ bad: text }`.
 * A number cell must be whole and in range; typed text goes through parsePayTerms, so "30 days",
 * "Net 30" and "COD" read the same as on the form.
 */
export function readPayWithinCell(row, i = COL.payWithin) {
  const n = cellNumber(row, i)
  if (n.blank) return { value: null }
  if (n.value != null) {
    return Number.isInteger(n.value) && n.value >= 0 && n.value <= MAX_PAY_WITHIN_DAYS ? { value: n.value } : { bad: String(n.value) }
  }
  const parsed = parsePayTerms(cellText(row, i))
  return parsed == null ? { bad: cellText(row, i) } : { value: parsed }
}

/**
 * One sheet row as the supplier it would add: `{ rowNo, name, contact_person, phone, address,
 * pan_vat_no, payment_terms, pay_within_days, payFromNote }`, or `{ rowNo, name, reason }`.
 */
export function parseVendorRow(row) {
  const rowNo = row.rowNo
  const name = cellText(row, COL.name)
  if (!name) return { rowNo, name: '', reason: 'No supplier name.' }
  const note = cellText(row, COL.note)
  const pay = readPayWithinCell(row)
  if (pay.bad != null) return { rowNo, name, reason: `"${pay.bad}" is not a number of days. ${PAY_WITHIN_RULE}` }
  let payWithin = pay.value
  let payFromNote = false
  // A blank number with a note that says one ("Net 30", "COD") takes the note's days, the
  // suggestion the form offers. A note it cannot read ("50% advance") leaves the default.
  if (payWithin == null && note) {
    const fromNote = parsePayTerms(note)
    if (fromNote != null) { payWithin = fromNote; payFromNote = true }
  }
  return {
    rowNo, name,
    contact_person: cellText(row, COL.contact),
    phone: cellText(row, COL.phone),
    address: cellText(row, COL.address),
    pan_vat_no: cellText(row, COL.pan),
    payment_terms: note || null,
    pay_within_days: payWithin,
    payFromNote,
  }
}

export function parseVendorRows(rows) {
  const body = (rows || []).filter(r => !isBlankRow(r))
  const start = body.length && isVendorHeaderRow(body[0]) ? 1 : 0
  return body.slice(start).map(parseVendorRow)
}

/**
 * What an import of `parsed` would write against every supplier on file (`vendors`: `name`,
 * `vendor_code`, `pan_vat_no`, `is_active`, `archived_at`, archived ones included). → `{ ready,
 * skipped }`; each ready row carries its minted `vendor_code` and its `warnings`.
 */
export function planVendorImport(parsed, { vendors = [], prefix = 'VND' } = {}) {
  const byName = new Map()
  const byPan = new Map()
  vendors.forEach(v => {
    const k = vendorNameKey(v.name)
    if (k && !byName.has(k)) byName.set(k, v)
    const pan = normalisePan(v.pan_vat_no)
    if (pan && !byPan.has(pan)) byPan.set(pan, v.name)
  })
  const codes = vendors.map(v => v.vendor_code).filter(Boolean)
  const firstRowOf = new Map()
  const ready = []
  const skipped = []

  parsed.forEach(p => {
    if (p.reason) { skipped.push(p); return }
    const key = vendorNameKey(p.name)
    const held = byName.get(key)
    if (held) {
      const state = held.archived_at ? ' (archived)' : held.is_active === false ? ' (inactive)' : ''
      skipped.push({ rowNo: p.rowNo, name: p.name, reason: `"${held.name}"${state} is already a supplier. Nothing about it was changed.` })
      return
    }
    if (firstRowOf.has(key)) {
      skipped.push({ rowNo: p.rowNo, name: p.name, reason: `Named again: row ${firstRowOf.get(key)} already has this supplier, and only the first is imported.` })
      return
    }
    firstRowOf.set(key, p.rowNo)

    const warnings = []
    const panNote = panWarning(p.pan_vat_no)
    if (panNote) warnings.push(panNote)
    const pan = normalisePan(p.pan_vat_no)
    if (pan) {
      const other = byPan.get(pan)
      if (other) warnings.push(`"${other}" already has this PAN. Both are imported; check whether they are one supplier.`)
      else byPan.set(pan, p.name)
    }

    const vendor_code = nextVendorCodeAfter(prefix || 'VND', codes)
    codes.push(vendor_code)
    ready.push({ ...p, vendor_code, warnings })
  })
  return { ready, skipped }
}

/** The `vendors` row for a ready line, in the Add Vendor form's own shape. */
export function vendorInsertRow(r) {
  return {
    vendor_code: r.vendor_code,
    name: r.name,
    contact_person: r.contact_person,
    phone: r.phone,
    address: r.address,
    pan_vat_no: r.pan_vat_no,
    payment_terms: r.payment_terms || null,
    pay_within_days: r.pay_within_days,
  }
}
