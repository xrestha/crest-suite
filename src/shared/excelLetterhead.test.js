/**
 * The letterhead's closing blank row reaches the sheet (S845). With `origin: -1` the column headings
 * sat straight under the scope line on every export, because an empty row holds no cell.
 */
import * as XLSX from 'xlsx'
import { sheetWithLetterhead } from './excelLetterhead'

const biz = { name: 'Test Cafe', vat: '301234567', address: 'Thamel, Kathmandu', vatReg: true }
const readBack = ws => XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: true })

test('one blank row separates the scope line from the column headings', () => {
  const ws = sheetWithLetterhead(XLSX, { title: 'Report', biz, scopeLine: '@As On Dated : 2083/06/01', rows: [{ Item: 'Momo', Qty: 2 }] })
  expect(readBack(ws)).toEqual([
    ['Report'],
    ['CompanyName : Test Cafe'],
    ['VATNO : 301234567'],
    ['ADDRESS : Thamel, Kathmandu'],
    [],
    ['@As On Dated : 2083/06/01'],
    [],
    ['Item', 'Qty'],
    ['Momo', 2],
  ])
})

test('notes sit under the scope line, and the blank row still follows them', () => {
  const ws = sheetWithLetterhead(XLSX, { title: 'Report', biz: { ...biz, vatReg: false }, scopeLine: 'Scope', notes: ['Note one'], rows: [{ A: 1 }] })
  const rows = readBack(ws)
  expect(rows[2]).toEqual(['PAN No : 301234567'])
  expect(rows.slice(5)).toEqual([['Scope'], ['Note one'], [], ['A'], [1]])
})
