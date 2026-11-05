import {
  historyKind, historyDayLabel, historyQtyText, historyValueText, historyRowView,
  mergeHistoryPages, nextBeforeId, HISTORY_KIND_LABEL, HISTORY_PAGE_SIZE,
} from './salesHistoryRows'

const row = (o = {}) => ({
  id: 10, bs_day: 5, recipe_id: 'r1', recipe_name: 'Momo', old_qty: 4, new_qty: 6,
  old_value: 1200, new_value: 1800, changed_by_name: 'Sita', changed_at: '2026-11-04T08:15:00Z', ...o,
})

describe('historyKind', () => {
  it('reads an absent before as added, an absent after as removed, both as changed', () => {
    expect(historyKind(row({ old_qty: null }))).toBe('added')
    expect(historyKind(row({ new_qty: null }))).toBe('removed')
    expect(historyKind(row())).toBe('changed')
    // A real zero is a figure, not an absence.
    expect(historyKind(row({ old_qty: 0 }))).toBe('changed')
  })

  it('labels every kind in words, so the badge never means anything by colour alone', () => {
    expect(Object.values(HISTORY_KIND_LABEL)).toEqual(['Added', 'Changed', 'Removed'])
  })
})

describe('historyDayLabel', () => {
  it('calls day 0 Bulk and names the month on any other day', () => {
    expect(historyDayLabel(0, 7)).toBe('Bulk')
    expect(historyDayLabel(1, 7)).toBe('1st Kartik')
    expect(historyDayLabel(22, 7)).toBe('22nd Kartik')
  })
})

describe('the figures', () => {
  it('prints a quantity with Nepali grouping and up to three places', () => {
    expect(historyQtyText(1234567.5)).toBe('12,34,567.5')
    expect(historyQtyText(0.125)).toBe('0.125')
    expect(historyQtyText(null)).toBe('—')
  })

  it('prints a missing value as a dash, never NPR 0', () => {
    expect(historyValueText(null)).toBe('—')
    expect(historyValueText(0)).toBe('NPR 0.00')
    expect(historyValueText(125000.5)).toBe('NPR 1,25,000.50')
  })
})

describe('historyRowView', () => {
  it('shows a change with both sides', () => {
    expect(historyRowView(row(), 7)).toEqual(expect.objectContaining({
      kind: 'changed', kindLabel: 'Changed', day: '5th Kartik', dish: 'Momo',
      beforeQty: '4', beforeValue: 'NPR 1,200.00', afterQty: '6', afterValue: 'NPR 1,800.00', by: 'Sita',
    }))
  })

  it('dashes the side that did not exist', () => {
    const added = historyRowView(row({ old_qty: null, old_value: null }), 7)
    expect([added.beforeQty, added.beforeValue, added.afterQty]).toEqual(['—', '—', '6'])
    const removed = historyRowView(row({ new_qty: null, new_value: null, bs_day: 0 }), 7)
    expect([removed.kindLabel, removed.day, removed.beforeQty, removed.afterQty, removed.afterValue]).toEqual(['Removed', 'Bulk', '4', '—', '—'])
  })

  it('a priced line with no price on one side shows a dash there only', () => {
    const v = historyRowView(row({ old_value: null }), 7)
    expect([v.beforeQty, v.beforeValue, v.afterValue]).toEqual(['4', '—', 'NPR 1,800.00'])
  })

  it('says so when the dish or the login is gone', () => {
    const v = historyRowView(row({ recipe_name: null, changed_by_name: null }), 7)
    expect(v.dish).toBe('A dish no longer on the menu')
    expect(v.by).toBe('A login that has since been removed')
  })
})

describe('paging', () => {
  const page = n => Array.from({ length: n }, (_, i) => row({ id: 1000 - i }))

  it('asks for the next page from the oldest id of a full page, and stops after a short one', () => {
    expect(nextBeforeId(page(HISTORY_PAGE_SIZE))).toBe(1000 - HISTORY_PAGE_SIZE + 1)
    expect(nextBeforeId(page(3))).toBeNull()
    expect(nextBeforeId([])).toBeNull()
    expect(nextBeforeId(page(2), 2)).toBe(999)
  })

  it('keeps earlier rows, never shows a row twice, newest first', () => {
    const merged = mergeHistoryPages([row({ id: 9 }), row({ id: 8 })], [row({ id: 8 }), row({ id: 7 }), row({ id: 12 })])
    expect(merged.map(r => r.id)).toEqual([12, 9, 8, 7])
    expect(mergeHistoryPages(null, [row({ id: 3 })]).map(r => r.id)).toEqual([3])
  })
})
