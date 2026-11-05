// S885, owner decision 3: a supplier bill with NPR 10 or less left can be cleared without paying.
// The rules a reader checks: the cap is per bill and to the paisa, a cleared amount is told apart
// from money paid, and every page that presents money paid knows about it.
import fs from 'fs'
import path from 'path'
import {
  WRITE_OFF_MODE, WRITE_OFF_MAX_NPR, isWriteOff, writtenOffOf, paidExcludingWriteOffs, writeOffRoom,
  clearableAmount, recordedByOf,
} from './writeOff'

describe('writeOff helpers', () => {
  test('the mode the database checks, and the per-bill cap', () => {
    expect(WRITE_OFF_MODE).toBe('Write-off')
    expect(WRITE_OFF_MAX_NPR).toBe(10)
  })

  test('isWriteOff reads only the mode', () => {
    expect(isWriteOff({ payment_mode: 'Write-off' })).toBe(true)
    expect(isWriteOff({ payment_mode: 'Cash' })).toBe(false)
    expect(isWriteOff({ payment_mode: 'Supplier credit', credit_link_id: 'L1' })).toBe(false)
    expect(isWriteOff(null)).toBe(false)
  })

  test('sums split cleared amounts from money paid, to the paisa, strings included', () => {
    const rows = [
      { amount: '1000.10', payment_mode: 'Cheque' },
      { amount: 0.1, payment_mode: 'Write-off' },
      { amount: 0.2, payment_mode: 'Write-off' },
      { amount: -300, payment_mode: 'Supplier credit' },
    ]
    expect(writtenOffOf(rows)).toBe(0.3)
    expect(paidExcludingWriteOffs(rows)).toBe(700.1)
    expect(writtenOffOf(null)).toBe(0)
  })

  test('room left under the cap', () => {
    expect(writeOffRoom(0)).toBe(10)
    expect(writeOffRoom(6.5)).toBe(3.5)
    expect(writeOffRoom(10)).toBe(0)
    expect(writeOffRoom(12)).toBe(0)
  })

  test('clearableAmount: above 0, at most NPR 10, and within what is left of the cap', () => {
    expect(clearableAmount({ remaining: 4.5, writtenOff: 0 })).toBe(4.5)
    expect(clearableAmount({ remaining: 10, writtenOff: 0 })).toBe(10)
    expect(clearableAmount({ remaining: 10.000004, writtenOff: 0 })).toBe(10)
    expect(clearableAmount({ remaining: 10.01, writtenOff: 0 })).toBeNull()
    expect(clearableAmount({ remaining: 4, writtenOff: 6 })).toBe(4)
    expect(clearableAmount({ remaining: 4.01, writtenOff: 6 })).toBeNull()
    expect(clearableAmount({ remaining: 0, writtenOff: 0 })).toBeNull()
    expect(clearableAmount({ remaining: 0.004, writtenOff: 0 })).toBeNull()
    expect(clearableAmount({ remaining: -20, writtenOff: 0 })).toBeNull()
    expect(clearableAmount(null)).toBeNull()
  })

  test('recordedByOf: the stamped name, or nothing for an older row', () => {
    expect(recordedByOf({ recorded_by_name: ' Sita Rai ' })).toBe('Sita Rai')
    expect(recordedByOf({ recorded_by_name: '' })).toBeNull()
    expect(recordedByOf({})).toBeNull()
  })
})

// Every reader that presents money PAID must know a write-off is not one (S885 part D). A source
// check, because each reader's arithmetic lives inside a page with no seam to call.
describe('the readers that present money paid tell a write-off apart', () => {
  const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8')

  test.each([
    ['OutstandingPayables.js'],
    ['VendorReport.js'],
    ['vendorBalanceHelpers.js'],
  ])('%s uses isWriteOff', file => {
    expect(read(file)).toMatch(/\bisWriteOff\b/)
  })

  test('the payment modes a person can pick never include Write-off', () => {
    const src = read('OutstandingPayables.js')
    const modes = src.match(/const PAYMENT_MODES = \[([^\]]*)\]/)
    expect(modes).not.toBeNull()
    expect(modes[1]).not.toMatch(/Write-off/)
    // The bulk Edit Mode leaves write-off rows out of what it changes.
    expect(src).toMatch(/!isCreditRow\(p\) && !isWriteOff\(p\)/)
  })

  test('the balance letter prints a Written off total beside Payments', () => {
    expect(read('VendorBalanceConfirmationPrint.jsx')).toMatch(/totalWrittenOffFy/)
  })
})
