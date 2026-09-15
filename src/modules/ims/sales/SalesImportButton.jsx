import { useState } from 'react'
import Tip from '../../../components/Tip'
import { BS_MONTHS, adToBs } from '../../../utils/bsCalendar'

const norm = s => String(s ?? '').trim()
const lc = s => norm(s).toLowerCase()

// A cell as a number, or null when it is not one (S756).
//
// `parseFloat('1,250.00')` is 1 — it stops at the comma — so any figure a vendor export writes with
// thousands separators (or that Excel hands back as formatted text) was imported as its first digit
// group, silently, into a quantity or a discount. Grouping commas, spaces and non-breaking spaces are
// stripped first; Nepali/Indian grouping (`1,25,000`) strips the same way. An accountant's
// parenthesised negative `(50)` reads as -50. A real number cell passes through untouched.
export function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  let s = String(v ?? '').replace(/[,\s ]/g, '')
  const paren = /^\((.*)\)$/.exec(s)
  if (paren) s = `-${paren[1]}`
  if (s === '') return null
  const n = parseFloat(s)
  return isNaN(n) ? null : n
}

// A header that holds a RATE rather than an amount: "Disc %", "Discount (%)", "Disc Pct",
// "Discount Percent". Its values are percentages, and reading one as NPR would put "10" of discount
// on a line that was discounted 10% (S756).
const isPercentHeader = c => c.includes('%') || /\bpct\b|percent/.test(c)
const isDiscountHeader = c => c.includes('discount') || /\bdisc\b/.test(c)

// Vendor "Sales Report Item Wise" exports have a variable-length metadata block (title, company
// name, VAT no, date range, division) before the real header row, so the header can't be assumed
// to sit at a fixed row/col — it's located by scanning for a row containing a "Product Name"-like
// cell alongside a Sale/Return/Net quantity column (the only columns this feature actually reads).
// Matching is substring-based (c.includes(...), not startsWith an exact phrase) because real
// exports commonly wrap header text with a line break inside the cell ("Product\nName") or use a
// non-breaking space — .includes('product') && .includes('name') matches regardless of what
// whitespace character sits between the two words.
export function parseSalesReport(aoa) {
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
    //
    // The first "discount" header used to win even when it was a percentage column (S756), so an
    // export carrying both "Disc %" and "Discount Amt" imported the rate as NPR. The amount column
    // is preferred; a sheet whose only discount column is a percentage imports no discount at all,
    // because a rate cannot become an amount without the line value this importer does not read.
    discountCol = cells.findIndex((c, i) => i > boundary && isDiscountHeader(c) && !isPercentHeader(c))
    break
  }
  if (headerRow === -1) return { headerFound: false, rows: [], dateRange: null }

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
  return { headerFound: true, rows, dateRange: findDateRange(aoa.slice(0, headerRow)) }
}

// The date range a report prints in its metadata block, as BS { year, month, day } pairs (S756,
// owner decision D28). The importer used to ignore it, so a file for the wrong day filled the grid
// as readily as the right one.
//
// Only the rows ABOVE the header are read — that is where these exports put "@As On Dated : … To : …"
// / "From … To …" — so a date inside the data never counts. A date is a Y-M-D token with -, / or .
// separators. BS and AD are told apart by the year: this product's BS years run 2000–2087 but real
// report dates sit in the 2070s–2090s, while AD dates sit in the 2010s–2040s, so a year of 2050 or
// more is BS and anything below it is AD (converted with adToBs). Crest's own Item Wise export
// prints both — "2026-09-01 (B.S. 2083/05/16)" — so when a block holds any BS date, only the BS
// dates are used. Excel date SERIALS and month-name dates ("16 Bhadra 2083", "01-Sep-2026") are not
// recognised; a file carrying only those gets no warning either way, rather than a wrong one.
export function findDateRange(metaRows) {
  const bs = []
  const ad = []
  const re = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g
  for (const row of metaRows || []) {
    for (const cell of row || []) {
      if (typeof cell !== 'string') continue
      let m
      re.lastIndex = 0
      while ((m = re.exec(cell)) !== null) {
        const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
        if (mo < 1 || mo > 12 || d < 1 || d > 32) continue
        if (y >= 2050) bs.push({ year: y, month: mo, day: d })
        else if (y >= 1990) {
          const date = new Date(y, mo - 1, d)   // local midnight — adToBs reads local getters
          if (date.getMonth() === mo - 1) ad.push(adToBs(date))
        }
      }
    }
  }
  const found = bs.length ? bs : ad
  if (!found.length) return null
  const key = x => x.year * 10000 + x.month * 100 + x.day
  const sorted = [...found].sort((a, b) => key(a) - key(b))
  return { from: sorted[0], to: sorted[sorted.length - 1] }
}

const fmtBs = d => `${d.day} ${BS_MONTHS[d.month - 1]} ${d.year}`
const sameBsDay = (a, b) => a.year === b.year && a.month === b.month && a.day === b.day

// The warning to show when the file's dates are not the day being filled in, or null when they are
// (or when the file names no date this importer can read). A warning, not a refusal: an owner
// importing a report run for "today" a little after midnight is doing nothing wrong.
export function dateMismatchWarning(dateRange, selected) {
  if (!dateRange || !selected) return null
  const { from, to } = dateRange
  const span = sameBsDay(from, to) ? fmtBs(from) : `${fmtBs(from)} to ${fmtBs(to)}`
  if (!sameBsDay(from, to)) {
    return `This file covers ${span} — more than one day — but its quantities will all be filled in for ${fmtBs(selected)} only.`
  }
  if (!sameBsDay(from, selected)) {
    return `This file is for ${span}, but you are filling in ${fmtBs(selected)}.`
  }
  return null
}

// Reads a vendor "Sales Report Item Wise" .xlsx, matches Product Name against this client's active
// recipes (exact case-insensitive match, same idiom as RecipeImportButton.jsx), and hands the
// matched qty + discount maps back to the parent via onMatched(qtyMap, discountMap) — which merges
// them into the same local qty/discount state the Daily Entry inputs already write to. No Supabase
// calls happen here; nothing is persisted until the parent's existing Save Day button is clicked.
export default function SalesImportButton({ recipes, onMatched, disabled, selectedDate }) {
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
        const { headerFound, rows, dateRange } = parseSalesReport(aoa)
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
        // D28: the date is checked and SAID, in the confirm the user is already reading, and kept
        // under the summary afterwards — never a silent refusal.
        const dateWarning = dateMismatchWarning(dateRange, selectedDate)
        if (!window.confirm(`${dateWarning ? `⚠ ${dateWarning}\n\n` : ''}This will fill in qty${discountMap.size > 0 ? ' and discount' : ''} for ${matched} matched menu item${matched !== 1 ? 's' : ''} on the currently selected day, overwriting any value already entered for those items. Continue?`)) {
          return
        }
        onMatched(qtyMap, discountMap)
        setImportSummary({ matched, total: rows.length, unmatchedNames: [...new Set(unmatchedNames)], dateWarning })
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
      {importError && <div style={{ fontSize: 11, color: 'var(--theme-red-text)', marginTop: 6 }}>{importError}</div>}
      {importSummary && (
        <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 6 }}>
          <strong style={{ color: 'var(--theme-accent-ink)' }}>{importSummary.matched}</strong> of {importSummary.total} rows matched.
          {importSummary.dateWarning && (
            <div role="note" style={{ marginTop: 4, color: 'var(--theme-amber-text)' }}>⚠ {importSummary.dateWarning} Check the figures before you save.</div>
          )}
          {importSummary.unmatchedNames.length > 0 && (
            <details style={{ marginTop: 4 }}>
              <summary style={{ cursor: 'pointer', color: 'var(--theme-red-text)' }}>
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
