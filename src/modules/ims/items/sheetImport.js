// What the Item Master and Supplier Excel imports share (S885): reading a sheet into rows, reading
// one cell as text or as a number, and sending the rows in chunks. Pure apart from the `XLSX`
// module the caller hands in (it is only ever `await import('xlsx')` inside a click handler).
import { isTimeout } from '../../../utils/withTimeout'
import { isNetworkError } from '../../../shared/errorText'

// About 200 rows a request: a 2,000-row book is ten requests, and one bad row costs a retry of 200
// rather than of the whole file.
export const IMPORT_CHUNK_SIZE = 200
export const IMPORT_TIMEOUT_MS = 30000

/**
 * One worksheet as rows that keep BOTH what the cell stores and what Excel shows: `raw` for
 * numbers (a price formatted to 2 decimals still stores 0.777), `text` for words, phone numbers
 * and the percent sign on a Yield cell formatted as a percentage (which stores 0.7 for 70%).
 * `blankrows: true` on both reads keeps the two lists row-for-row, and `rowNo` is the row number
 * Excel prints, so a skipped row can be found in the file.
 */
export function sheetRows(XLSX, ws) {
  if (!ws || !ws['!ref']) return []
  const range = XLSX.utils.decode_range(ws['!ref'])
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true })
  const text = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: true })
  return raw.map((r, i) => ({ rowNo: range.s.r + i + 1, raw: r || [], text: text[i] || [] }))
}

/** The sheet called `name` (any capitals), else the first one. */
export function pickSheet(wb, name) {
  const wanted = String(name).toLowerCase()
  const sheetName = wb.SheetNames.find(n => n.trim().toLowerCase() === wanted) || wb.SheetNames[0]
  return sheetName ? wb.Sheets[sheetName] : null
}

const squash = v => String(v).replace(/\s+/g, ' ').trim()

/** A cell as trimmed text, inner runs of spaces and line breaks made one space. */
export function cellText(row, i) {
  const t = row?.text?.[i]
  if (t != null && squash(t) !== '') return squash(t)
  const v = row?.raw?.[i]
  return v == null ? '' : squash(v)
}

export function isBlankRow(row) {
  const cells = [...(row?.raw || []), ...(row?.text || [])]
  return cells.every(v => v == null || squash(v) === '')
}

/**
 * A cell as a number: `{ blank: true }`, `{ value }`, or `{ bad: true, text }`. Takes a number
 * cell as stored, and typed text such as "1,200.50" or "NPR 450" (thousands commas in either the
 * Nepali 1,00,000 or the 100,000 grouping). Anything else is bad rather than a guess.
 */
export function cellNumber(row, i) {
  const v = row?.raw?.[i]
  if (v == null || (typeof v === 'string' && v.trim() === '')) return { blank: true }
  if (typeof v === 'number') return Number.isFinite(v) ? { value: v } : { bad: true, text: String(v) }
  let s = String(v).trim().replace(/^(npr|rs\.?)\s*/i, '')
  if (/^\d{1,3}(,\d{2,3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '')
  if (!/^\d*\.?\d+$/.test(s)) return { bad: true, text: String(v).trim() }
  return { value: Number(s) }
}

/**
 * A percent cell: a number formatted as a percentage stores the fraction (0.7 shows "70%"), and
 * text may carry its own sign ("70%"). Returns the cellNumber shape, in percent.
 */
export function cellPercent(row, i) {
  const v = row?.raw?.[i]
  const shown = row?.text?.[i]
  if (typeof v === 'string' && v.trim().endsWith('%')) {
    const n = cellNumber({ raw: [v.trim().slice(0, -1)] }, 0)
    return n.value != null ? { ...n, fromPercentCell: true } : { bad: true, text: v.trim() }
  }
  const n = cellNumber(row, i)
  if (n.value != null && typeof v === 'number' && String(shown ?? '').trim().endsWith('%')) {
    return { value: Number((v * 100).toFixed(6)), fromPercentCell: true }
  }
  return n
}

/** True when a failure leaves it unknown whether the write landed: the answer never came back. */
export function outcomeUnknown(err) {
  return isTimeout(err) || isNetworkError(err)
}

/**
 * Sends `rows` in chunks through `insertChunk(rows) → { error }` (never throws: wrap the call in
 * settleWithin). A chunk refused for a duplicate (23505) is retried one row at a time, and each row
 * refused that way is reported in `clashed`, so one name taken since the preview costs that row
 * only. Any other failure stops the run. `failure` then says what failed, whether its answer was
 * lost (`unknown`: those rows may have landed), how many rows that request carried (`failedRows`,
 * starting at `atRow`) and how many after it were never sent (`notSent`). `inserted` holds every
 * row the database confirmed.
 */
export async function insertInChunks(rows, insertChunk, {
  chunkSize = IMPORT_CHUNK_SIZE, isClash = e => e?.code === '23505', onProgress,
} = {}) {
  const inserted = []
  const clashed = []
  const stop = (error, sent, from) => ({
    inserted, clashed,
    failure: {
      error, unknown: outcomeUnknown(error), atRow: sent[0], failedRows: sent.length,
      notSent: rows.length - from - sent.length,
    },
  })
  const progress = () => onProgress?.(inserted.length + clashed.length)
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize)
    const { error } = await insertChunk(chunk)
    if (!error) { inserted.push(...chunk); progress(); continue }
    if (!isClash(error)) return stop(error, chunk, start)
    if (chunk.length === 1) { clashed.push(chunk[0]); progress(); continue }
    for (let j = 0; j < chunk.length; j++) {
      const one = chunk[j]
      const res = await insertChunk([one])
      if (!res.error) inserted.push(one)
      else if (isClash(res.error)) clashed.push(one)
      else return stop(res.error, [one], start + j)
      progress()
    }
  }
  return { inserted, clashed, failure: null }
}

/**
 * The sentence for a run that stopped part-way. `noun` is the plural ("items", "suppliers").
 * Never claims a request whose answer was lost did not land: those rows may be saved, and the way
 * to find out is the list, after which the same file imports again without doubling anything,
 * because a name already saved is skipped.
 */
export function partialImportText(failure, insertedCount, noun) {
  if (!failure) return ''
  const landed = insertedCount > 0 ? `${insertedCount} ${noun} were imported before this. ` : 'None of the rows were imported before this. '
  const where = `the request starting at row ${failure.atRow?.rowNo ?? '?'}${failure.failedRows > 1 ? ` (${failure.failedRows} rows)` : ''}`
  const rest = failure.notSent > 0 ? ` The ${failure.notSent} row${failure.notSent === 1 ? '' : 's'} after it ${failure.notSent === 1 ? 'was' : 'were'} not sent.` : ''
  if (failure.unknown) {
    return `${landed}Crest did not hear back about ${where}, so those rows may or may not have been saved.${rest} Reload the list to see what is there, then import the same file again: rows already saved are skipped as duplicates.`
  }
  return `${landed}Crest refused ${where}, so none of those rows were saved.${rest} Fix the cause below, then import the same file again: rows already saved are skipped as duplicates.`
}
