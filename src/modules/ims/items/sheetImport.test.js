import * as XLSX from 'xlsx'
import {
  sheetRows, pickSheet, cellText, cellNumber, cellPercent, isBlankRow, insertInChunks, partialImportText, IMPORT_CHUNK_SIZE,
} from './sheetImport'

const row = (raw, text = []) => ({ rowNo: 2, raw, text })

// A workbook written and read back the way a real upload is: formats survive into `w`.
function roundTrip(aoa, name = 'Items') {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  return XLSX.read(new Uint8Array(buf), { type: 'array' })
}

describe('sheetRows (both readings of a cell, row for row)', () => {
  test('keeps the stored number beside the text Excel shows, and Excel row numbers', () => {
    const wb = roundTrip([
      ['Item Name *', 'Price', 'Yield %'],
      ['MILK', { v: 0.777, t: 'n', z: '0.00' }, { v: 0.7, t: 'n', z: '0%' }],
      [],
      ['BUTTER', 1.2],
    ])
    const rows = sheetRows(XLSX, pickSheet(wb, 'items'))
    expect(rows).toHaveLength(4)
    expect(rows[1]).toMatchObject({ rowNo: 2 })
    expect(rows[1].raw[1]).toBe(0.777)       // a 2-decimal format does not round what is stored
    expect(rows[1].text[1]).toBe('0.78')
    expect(cellPercent(rows[1], 2)).toEqual({ value: 70, fromPercentCell: true })
    expect(isBlankRow(rows[2])).toBe(true)
    expect(rows[3]).toMatchObject({ rowNo: 4 })
    expect(cellText(rows[3], 0)).toBe('BUTTER')
  })

  test('falls back to the first sheet, and an empty sheet is no rows', () => {
    const wb = roundTrip([['A']], 'Whatever')
    expect(pickSheet(wb, 'Items')).toBe(wb.Sheets.Whatever)
    expect(sheetRows(XLSX, {})).toEqual([])
  })
})

describe('cell readers', () => {
  test('cellText trims and joins runs of spaces and line breaks', () => {
    expect(cellText(row(['  Big\n  Mart  ']), 0)).toBe('Big Mart')
    expect(cellText(row([9841000000], ['9841000000']), 0)).toBe('9841000000')
    expect(cellText(row([null]), 0)).toBe('')
  })

  test('cellNumber takes numbers, grouped text and NPR prefixes, and refuses the rest', () => {
    expect(cellNumber(row([12.5]), 0)).toEqual({ value: 12.5 })
    expect(cellNumber(row(['1,200.50']), 0)).toEqual({ value: 1200.5 })
    expect(cellNumber(row(['1,00,000']), 0)).toEqual({ value: 100000 })
    expect(cellNumber(row(['NPR 450']), 0)).toEqual({ value: 450 })
    expect(cellNumber(row(['  ']), 0)).toEqual({ blank: true })
    expect(cellNumber(row([null]), 0)).toEqual({ blank: true })
    expect(cellNumber(row(['5oo']), 0)).toEqual({ bad: true, text: '5oo' })
    expect(cellNumber(row(['1,5']), 0).bad).toBe(true)
    expect(cellNumber(row(['-3']), 0).bad).toBe(true)
  })

  test('cellPercent reads a typed sign and a plain number', () => {
    expect(cellPercent(row(['85%']), 0)).toEqual({ value: 85, fromPercentCell: true })
    expect(cellPercent(row([85], ['85']), 0)).toEqual({ value: 85 })
    expect(cellPercent(row(['abc%']), 0).bad).toBe(true)
  })
})

describe('insertInChunks', () => {
  const rows = n => Array.from({ length: n }, (_, i) => ({ rowNo: i + 2, name: `R${i}` }))

  test('sends 200 rows a request', async () => {
    const sizes = []
    const res = await insertInChunks(rows(450), async c => { sizes.push(c.length); return { error: null } })
    expect(IMPORT_CHUNK_SIZE).toBe(200)
    expect(sizes).toEqual([200, 200, 50])
    expect(res.inserted).toHaveLength(450)
    expect(res.failure).toBeNull()
  })

  test('a duplicate in a chunk retries that chunk row by row and lists only the clash', async () => {
    const taken = new Set(['R3'])
    const res = await insertInChunks(rows(5), async c => (c.some(r => taken.has(r.name)) ? { error: { code: '23505' } } : { error: null }), { chunkSize: 5 })
    expect(res.inserted.map(r => r.name)).toEqual(['R0', 'R1', 'R2', 'R4'])
    expect(res.clashed.map(r => r.name)).toEqual(['R3'])
    expect(res.failure).toBeNull()
  })

  test('any other refusal stops, saying what landed, what failed and what was never sent', async () => {
    let call = 0
    const res = await insertInChunks(rows(5), async () => (++call === 2 ? { error: { code: '23514', message: 'check' } } : { error: null }), { chunkSize: 2 })
    expect(res.inserted).toHaveLength(2)
    expect(res.failure).toMatchObject({ unknown: false, failedRows: 2, notSent: 1, atRow: { rowNo: 4 } })
    const text = partialImportText(res.failure, 2, 'items')
    expect(text).toMatch(/^2 items were imported before this\. Crest refused the request starting at row 4 \(2 rows\), so none of those rows were saved\. The 1 row after it was not sent\./)
  })

  test('a timeout is an unknown outcome, and the sentence never claims those rows were not saved', async () => {
    const timeout = Object.assign(new Error('Import timed out after 30s'), { name: 'TimeoutError' })
    const res = await insertInChunks(rows(3), async () => ({ error: timeout }), { chunkSize: 2 })
    expect(res.failure).toMatchObject({ unknown: true, failedRows: 2, notSent: 1 })
    const text = partialImportText(res.failure, 0, 'suppliers')
    expect(text).toMatch(/may or may not have been saved/)
    expect(text).not.toMatch(/none of those rows were saved|nothing was saved|were not saved/i)
    expect(text).toMatch(/rows already saved are skipped as duplicates/)
  })

  test('a dropped connection on a one-row retry is unknown too', async () => {
    const res = await insertInChunks(rows(2), async c => (c.length > 1 ? { error: { code: '23505' } } : { error: { message: 'TypeError: Failed to fetch' } }), { chunkSize: 2 })
    expect(res.failure).toMatchObject({ unknown: true, failedRows: 1, notSent: 1 })
  })

  test('reports progress', async () => {
    const seen = []
    await insertInChunks(rows(3), async () => ({ error: null }), { chunkSize: 2, onProgress: n => seen.push(n) })
    expect(seen).toEqual([2, 3])
  })
})
