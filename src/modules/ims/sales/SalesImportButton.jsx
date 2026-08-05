import { useState } from 'react'
import Tip from '../../../components/Tip'

const norm = s => String(s ?? '').trim()
const lc = s => norm(s).toLowerCase()
const toNum = v => {
  const n = parseFloat(v)
  return isNaN(n) ? null : n
}

// Vendor "Sales Report Item Wise" exports have a variable-length metadata block (title, company
// name, VAT no, date range, division) before the real header row, so the header can't be assumed
// to sit at a fixed row/col — it's located by scanning for a row containing a "Product Name"-like
// cell alongside a Sale/Return/Net quantity column (the only columns this feature actually reads).
// Matching is substring-based (c.includes(...), not startsWith an exact phrase) because real
// exports commonly wrap header text with a line break inside the cell ("Product\nName") or use a
// non-breaking space — .includes('product') && .includes('name') matches regardless of what
// whitespace character sits between the two words.
function parseSalesReport(aoa) {
  let headerRow = -1
  let nameCol = -1, saleCol = -1, returnCol = -1, netQtyCol = -1, discountCol = -1
  for (let r = 0; r < aoa.length; r++) {
    const row = aoa[r] || []
    const cells = row.map(lc)
    const nc = cells.findIndex(c => c.includes('product') && c.includes('name'))
    if (nc === -1) continue
    const sc = cells.findIndex(c => c.startsWith('sale'))
    const rc = cells.findIndex(c => c.startsWith('retur'))
    const hasQtyCol = sc !== -1 || rc !== -1 || cells.some(c => c.startsWith('net'))
    if (!hasQtyCol) continue
    headerRow = r
    nameCol = nc
    saleCol = sc
    returnCol = rc
    const boundary = Math.max(sc, rc)
    netQtyCol = cells.findIndex((c, i) => c.startsWith('net') && i > boundary)
    // "Discount" sits in the report's Amount group (Gross / Discount), to the right of the
    // Quantity group (Sale / Return / Net) — search past that boundary the same way Net Qty
    // does, so an unrelated "net qty" column never gets mistaken for it.
    discountCol = cells.findIndex((c, i) => c.includes('discount') && i > boundary)
    break
  }
  if (headerRow === -1) return { headerFound: false, rows: [] }

  const rows = []
  for (let r = headerRow + 1; r < aoa.length; r++) {
    const row = aoa[r] || []
    const firstNonEmpty = lc(row.find(c => norm(c) !== ''))
    if (firstNonEmpty === undefined || firstNonEmpty === '') break
    if (firstNonEmpty.includes('total')) break
    const productName = norm(row[nameCol])
    if (!productName) continue
    const netFromFile = netQtyCol !== -1 ? toNum(row[netQtyCol]) : null
    const sale = saleCol !== -1 ? (toNum(row[saleCol]) || 0) : 0
    const ret = returnCol !== -1 ? (toNum(row[returnCol]) || 0) : 0
    const qty = netFromFile != null ? netFromFile : (sale - ret)
    const discount = discountCol !== -1 ? (toNum(row[discountCol]) || 0) : 0
    rows.push({ productName, qty: qty || 0, discount })
  }
  return { headerFound: true, rows }
}

// Reads a vendor "Sales Report Item Wise" .xlsx, matches Product Name against this client's active
// recipes (exact case-insensitive match, same idiom as RecipeImportButton.jsx), and hands the
// matched qty + discount maps back to the parent via onMatched(qtyMap, discountMap) — which merges
// them into the same local qty/discount state the Daily Entry inputs already write to. No Supabase
// calls happen here; nothing is persisted until the parent's existing Save Day button is clicked.
export default function SalesImportButton({ recipes, onMatched, disabled }) {
  const [importSummary, setImportSummary] = useState(null)
  const [importError, setImportError] = useState('')

  function handleImportFile(e) {
    setImportError('')
    setImportSummary(null)
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return
    const reader = new FileReader()
    reader.onload = async ev => {
      try {
        const XLSX = await import('xlsx')
        const wb = XLSX.read(new Uint8Array(ev.target.result), { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        // defval fills every blank cell with '' instead of leaving it as a hole in the row array —
        // without it, Array.prototype.map (used to lowercase each cell below) silently skips holes
        // while findIndex does not, so a callback hitting a hole gets `undefined` and crashes on
        // `.startsWith`. Real vendor exports have plenty of blank/merged cells (blank Product Code,
        // blank hierarchy columns), so this reliably tripped.
        const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' })
        const { headerFound, rows } = parseSalesReport(aoa)
        if (!headerFound) {
          setImportError('Could not find a "Product Name" header row with a Sale/Return/Net quantity column in this file. Make sure this is a Sales Report Item Wise export.')
          return
        }
        if (rows.length === 0) {
          setImportError('No data rows found under the header in this file.')
          return
        }

        const byName = new Map(recipes.map(r => [lc(r.name), r]))
        const qtyMap = new Map()
        const discountMap = new Map()
        const unmatchedNames = []
        rows.forEach(row => {
          const recipe = byName.get(lc(row.productName))
          if (!recipe) { unmatchedNames.push(row.productName); return }
          qtyMap.set(recipe.id, (qtyMap.get(recipe.id) || 0) + row.qty)
          if (row.discount) discountMap.set(recipe.id, (discountMap.get(recipe.id) || 0) + row.discount)
        })

        const matched = rows.length - unmatchedNames.length
        if (!window.confirm(`This will fill in qty${discountMap.size > 0 ? ' and discount' : ''} for ${matched} matched menu item${matched !== 1 ? 's' : ''} on the currently selected day, overwriting any value already entered for those items. Continue?`)) {
          return
        }
        onMatched(qtyMap, discountMap)
        setImportSummary({ matched, total: rows.length, unmatchedNames: [...new Set(unmatchedNames)] })
      } catch (err) {
        setImportError('Could not read the file — make sure it is a valid .xlsx. (' + err.message + ')')
      }
    }
    reader.readAsArrayBuffer(file)
  }

  return (
    <>
      <Tip text="Upload a vendor/POS 'Sales Report Item Wise' Excel export to auto-fill qty sold and discount for this day. Matches by Product Name against your active menu items and reads the Net quantity and Discount columns; unmatched names are listed below. Review the filled table, then click Save Day as usual." width={300}>
        <label className="btn btn-ghost" style={{ fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer', margin: 0, opacity: disabled ? 0.5 : 1 }}>
          ↑ Import Excel
          <input type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={handleImportFile} disabled={disabled} />
        </label>
      </Tip>
      {importError && <div style={{ fontSize: 11, color: 'var(--theme-red)', marginTop: 6 }}>{importError}</div>}
      {importSummary && (
        <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 6 }}>
          <strong style={{ color: 'var(--theme-accent)' }}>{importSummary.matched}</strong> of {importSummary.total} rows matched.
          {importSummary.unmatchedNames.length > 0 && (
            <details style={{ marginTop: 4 }}>
              <summary style={{ cursor: 'pointer', color: 'var(--theme-red)' }}>
                {importSummary.unmatchedNames.length} unmatched name{importSummary.unmatchedNames.length !== 1 ? 's' : ''} — click to view
              </summary>
              <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                {importSummary.unmatchedNames.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}
    </>
  )
}
