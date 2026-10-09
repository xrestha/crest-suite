// S809 3a: GUEST-1 (a guest's note reaches the kitchen) and ORDER-FLOW-9 (a changed instruction
// reaches the Kitchen Display). See kitchenNotes.js for the rules these pin.
import {
  KOT_CHANGE_ITEMS, CHANGE_NO_NOTE, isChangeLine, isChangeTicket, isChangeOnlyLine, changeNoteText,
  kotItemText, joinNote, guestDishNote,
} from './kitchenNotes'
import { buildKotBotHtml } from './orders/posOrderPrintHtml'

describe('joinNote', () => {
  test('adds a phrase to an empty or existing note', () => {
    expect(joinNote('', 'No peanuts')).toBe('No peanuts')
    expect(joinNote(null, 'No peanuts')).toBe('No peanuts')
    expect(joinNote('Less spicy', 'No peanuts')).toBe('Less spicy, No peanuts')
  })
  test('never adds a part the note already has, and leaves the note untouched then', () => {
    expect(joinNote('Less spicy,No onion', 'No onion')).toBe('Less spicy,No onion')
    expect(joinNote('Less spicy', 'Less spicy, No onion')).toBe('Less spicy, No onion')
    expect(joinNote('a', 'b, b')).toBe('a, b')
  })
  test('nothing to add returns the note as it was', () => {
    expect(joinNote('Less spicy', '')).toBe('Less spicy')
    expect(joinNote('Less spicy', '  ')).toBe('Less spicy')
    expect(joinNote(undefined, undefined)).toBe('')
  })
})

describe('guestDishNote — the guest\'s note on each of their dishes (Q11 a)', () => {
  test('a dish of its own carries the order note as the guest\'s', () => {
    expect(guestDishNote({ orderNote: 'No peanuts — allergy', qty: 2 })).toBe('Guest: No peanuts — allergy')
  })
  test('a dish joining food the table already has names how many plates are the guest\'s', () => {
    expect(guestDishNote({ orderNote: 'No peanuts — allergy', qty: 2, shared: true }))
      .toBe('Guest ×2: No peanuts — allergy')
  })
  test('the dish\'s own note and the order note both arrive, once each', () => {
    expect(guestDishNote({ dishNote: 'No onion', orderNote: 'No peanuts', qty: 1 })).toBe('Guest: No onion, No peanuts')
    expect(guestDishNote({ dishNote: 'No peanuts', orderNote: 'No peanuts', qty: 1 })).toBe('Guest: No peanuts')
    expect(guestDishNote({ dishNote: 'Extra hot', qty: 1 })).toBe('Guest: Extra hot')
  })
  test('a guest who wrote nothing adds nothing', () => {
    expect(guestDishNote({ orderNote: '', qty: 2 })).toBe('')
    expect(guestDishNote({ orderNote: null, dishNote: '  ', qty: 2, shared: true })).toBe('')
  })
})

describe('the guest note joined onto a till line (what mergeGuestItem stores)', () => {
  test('a new line: the guest\'s words only', () => {
    expect(joinNote('', guestDishNote({ orderNote: 'No peanuts', qty: 2 }))).toBe('Guest: No peanuts')
  })
  test('a line the table already ordered: its own note is kept and the guest\'s is scoped', () => {
    const merged = joinNote('Extra spicy', guestDishNote({ orderNote: 'No peanuts — allergy', qty: 2, shared: true }))
    expect(merged).toBe('Extra spicy, Guest ×2: No peanuts — allergy')
  })
  test('a guest note with commas keeps every part', () => {
    expect(joinNote('', guestDishNote({ orderNote: 'No peanuts, no onion', qty: 1 }))).toBe('Guest: No peanuts, no onion')
  })
})

describe('isChangeOnlyLine — the paper ticket\'s CHANGE ONLY case, and nothing else', () => {
  test('sent at this quantity and unsent again: a changed instruction', () => {
    expect(isChangeOnlyLine({ qty: 2, sent_qty: 2, sent_to_kot: false, notes: 'No peanuts' })).toBe(true)
  })
  test('more since the last ticket is food, not a change', () => {
    expect(isChangeOnlyLine({ qty: 3, sent_qty: 2, sent_to_kot: false })).toBe(false)
  })
  test('a cut since the last ticket is not a change ticket', () => {
    expect(isChangeOnlyLine({ qty: 1, sent_qty: 2, sent_to_kot: false })).toBe(false)
  })
  test('never sent, or already sent and untouched', () => {
    expect(isChangeOnlyLine({ qty: 2, sent_qty: 0, sent_to_kot: false })).toBe(false)
    expect(isChangeOnlyLine({ qty: 2 })).toBe(false)
    expect(isChangeOnlyLine({ qty: 2, sent_qty: 2, sent_to_kot: true })).toBe(false)
  })
})

describe('change tickets', () => {
  const change = { recipe_id: 'r-momo', name: 'Chicken Momo', qty: 0, change: true, notes: 'No peanuts' }
  const food = { recipe_id: 'r-thukpa', name: 'Thukpa', qty: 1, notes: null }

  test('a ticket of change lines only is a change ticket', () => {
    expect(isChangeTicket({ items: [change] })).toBe(true)
    expect(isChangeTicket({ items: [change, { ...change, name: 'Veg Momo' }] })).toBe(true)
  })
  test('a food ticket, an empty one or a malformed one is not', () => {
    expect(isChangeTicket({ items: [food] })).toBe(false)
    expect(isChangeTicket({ items: [] })).toBe(false)
    expect(isChangeTicket({ items: null })).toBe(false)
    expect(isChangeTicket(null)).toBe(false)
    expect(isChangeLine({ ...food, change: 'true' })).toBe(false)
  })
  test('the server filter value is jsonb containment of one change line', () => {
    expect(JSON.parse(KOT_CHANGE_ITEMS)).toEqual([{ change: true }])
  })
  test('what a change line says, on the board and in the KOT Register', () => {
    expect(changeNoteText(change)).toBe('No peanuts')
    expect(changeNoteText({ ...change, notes: null })).toBe(CHANGE_NO_NOTE)
    expect(changeNoteText({ ...change, notes: '   ' })).toBe(CHANGE_NO_NOTE)
    expect(kotItemText(change)).toBe('Chicken Momo — now: No peanuts')
    expect(kotItemText({ ...change, notes: '' })).toBe(`Chicken Momo — now: ${CHANGE_NO_NOTE}`)
    expect(kotItemText(food)).toBe('Thukpa ×1')
  })
})

describe('the paper ticket for a change', () => {
  const ticket = items => buildKotBotHtml({
    station: 'KOT', items, ticketNo: 57, outletName: '', tableName: 'Table 6', takenBy: '', covers: 2, reprint: true,
  })
  test('a reprinted CHANGE ticket line prints CHANGE ONLY with the note, never "×0"', () => {
    const html = ticket([{ name: 'Chicken Momo', qty: 0, sent_qty: 0, notes: 'No peanuts', change: true }])
    expect(html).toContain('CHANGE ONLY')
    expect(html).toContain('No peanuts')
    expect(html).not.toContain('×0')
  })
  test('the live send of a changed line still prints CHANGE ONLY, and food still prints its quantity', () => {
    const html = ticket([
      { name: 'Chicken Momo', qty: 2, sent_qty: 2, notes: 'No peanuts' },
      { name: 'Thukpa', qty: 1, sent_qty: 0, notes: '' },
    ])
    expect(html).toContain('CHANGE ONLY')
    expect(html).toContain('×1')
  })
})
