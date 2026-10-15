import { useState } from 'react'
import { act, render, fireEvent, screen, within } from '@testing-library/react'
import BsCalendarPicker from './BsCalendarPicker'
import Modal from './Modal'
import { adToBsSafe, bsToAd, formatAd, daysInBsMonth, getBsToday, BS_MONTHS } from '../utils/bsCalendar'

// S841: the popover is portalled to <body> and focus never moved into it, so inside a Modal (whose
// Tab trap covers only its own panel) a keyboard user could not pick a date at all. These pin the
// keyboard contract: focus moves in on open, a roving tabindex over the days, arrows move by day and
// week across month edges, Tab cycles inside, Escape closes only the picker.

// jsdom has no layout, so no scrollIntoView; the nested year SearchableSelect calls it on open.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
})

const VALUE = '2025-08-31'
const SEL = adToBsSafe(new Date(`${VALUE}T00:00:00`))
const dayName = (y, m, d) => `${d} ${BS_MONTHS[m - 1]} ${y}`
const dialog = () => screen.queryByRole('dialog', { name: 'Choose a date' })
const days = () => within(dialog()).getAllByRole('button').filter(b => b.hasAttribute('data-bs-day'))
// A day's focus and blur set state, so a direct focus() goes through act.
const focus = el => act(() => { el.focus() })
// Keyboard tests need the focused node itself, which Testing Library has no query for.
const focused = () => document.activeElement // eslint-disable-line testing-library/no-node-access
const press = (key, opts) => fireEvent.keyDown(focused(), { key, ...opts })

function Picker(props) {
  const [value, setValue] = useState(props.value ?? '')
  return (
    <BsCalendarPicker
      id="d" ariaLabel="Booking date" clearable
      {...props}
      value={value}
      onChange={v => { setValue(v); props.onChange?.(v) }}
    />
  )
}

function openPicker() {
  const trigger = screen.getByRole('button', { name: 'Booking date' })
  focus(trigger)
  fireEvent.click(trigger)
  return trigger
}

test('the stored value still resolves to the BS date this test expects', () => {
  // Anchor from bs-calendar.md: 2025-08-31 AD is 15 Bhadra 2082.
  expect(dayName(SEL.year, SEL.month, SEL.day)).toBe('15 Bhadra 2082')
})

test('opening moves focus to the selected day, the only day that is a Tab stop', () => {
  render(<Picker value={VALUE} />)
  const trigger = openPicker()
  expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  expect(dialog()).not.toBeNull()
  expect(focused()).toHaveAccessibleName(dayName(SEL.year, SEL.month, SEL.day))
  expect(focused()).toHaveAttribute('aria-pressed', 'true')
  const tabbable = days().filter(b => b.tabIndex === 0)
  expect(tabbable).toEqual([focused()])
})

test('with no value, opening focuses today, marked as the current date', () => {
  render(<Picker />)
  openPicker()
  const t = getBsToday()
  expect(focused()).toHaveAccessibleName(dayName(t.year, t.month, t.day))
  expect(focused()).toHaveAttribute('aria-current', 'date')
})

test('ArrowRight and ArrowDown move focus a day and a week', () => {
  render(<Picker value={VALUE} />)
  openPicker()
  press('ArrowRight')
  expect(focused()).toHaveAccessibleName(dayName(SEL.year, SEL.month, SEL.day + 1))
  expect(focused()).toHaveAttribute('tabindex', '0')
  press('ArrowDown')
  expect(focused()).toHaveAccessibleName(dayName(SEL.year, SEL.month, SEL.day + 8))
  press('ArrowUp')
  press('ArrowLeft')
  expect(focused()).toHaveAccessibleName(dayName(SEL.year, SEL.month, SEL.day))
})

test('arrows past the month edge turn the page, using the real month lengths', () => {
  // Day 1 of Bhadra 2082, then back across the edge into Shrawan's last day.
  render(<Picker value={formatAd(bsToAd(SEL.year, SEL.month, 1))} />)
  openPicker()
  press('ArrowLeft')
  const prevLen = daysInBsMonth(SEL.year, SEL.month - 1)
  expect(focused()).toHaveAccessibleName(dayName(SEL.year, SEL.month - 1, prevLen))
  expect(screen.getByRole('combobox', { name: 'Month' })).toHaveValue(String(SEL.month - 1))
  press('ArrowRight')
  expect(focused()).toHaveAccessibleName(dayName(SEL.year, SEL.month, 1))
})

test('locked mode never navigates: an arrow past the edge stays put', () => {
  render(<Picker lockYear={2082} lockMonth={5} value="1" />)
  openPicker()
  expect(focused()).toHaveAccessibleName(dayName(2082, 5, 1))
  press('ArrowLeft')
  expect(focused()).toHaveAccessibleName(dayName(2082, 5, 1))
  expect(screen.getByRole('button', { name: 'Previous month' })).toBeDisabled()
})

test('Tab from the last control wraps to the first, Shift+Tab back again, the year field included', () => {
  render(<Picker value={VALUE} />)
  openPicker()
  const order = []
  for (let i = 0; i < 7; i++) {
    order.push(focused().getAttribute('aria-label') || focused().textContent)
    press('Tab')
  }
  // Starts on the day; Today and Clear, wrap, then ‹, Month, Year and ›, back on the day.
  expect(order).toEqual(['15 Bhadra 2082', 'Today', 'Clear', 'Previous month', 'Month', '2082▾', 'Next month'])
  expect(focused()).toHaveAccessibleName('15 Bhadra 2082')
  focus(screen.getByRole('button', { name: 'Previous month' }))
  press('Tab', { shiftKey: true })
  expect(focused()).toHaveTextContent('Clear')
  expect(screen.getByRole('button', { name: 'Year' })).toBeInTheDocument()
})

test('picking a year by keyboard keeps focus in the popover, on the year field', () => {
  render(<Picker value={VALUE} />)
  openPicker()
  fireEvent.click(screen.getByRole('button', { name: 'Year' }))
  const search = screen.getByPlaceholderText('Type to search…')
  fireEvent.change(search, { target: { value: '2081' } })
  fireEvent.keyDown(search, { key: 'Enter' })
  expect(dialog()).not.toBeNull()
  expect(focused()).toBe(screen.getByRole('button', { name: 'Year' }))
  expect(focused()).toHaveTextContent('2081')
})

test('inside a Modal, Tab stays in the picker and Escape closes only the picker', () => {
  const closeModal = jest.fn()
  render(
    <Modal title="New booking" onClose={closeModal}>
      <Picker value={VALUE} />
      <input aria-label="Guests" />
    </Modal>
  )
  const trigger = openPicker()
  focus(screen.getByText('Clear'))
  press('Tab')
  expect(focused()).toHaveAccessibleName('Previous month')

  press('Escape')
  expect(dialog()).toBeNull()
  expect(closeModal).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: 'New booking' })).toBeInTheDocument()
  expect(focused()).toBe(trigger)
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
})

test('selecting a day commits the same AD string as before, closes, and refocuses the trigger', () => {
  const onChange = jest.fn()
  render(<Picker value={VALUE} onChange={onChange} />)
  const trigger = openPicker()
  // Enter on the focused (selected) day is the native button click.
  fireEvent.click(focused())
  expect(onChange).toHaveBeenLastCalledWith(VALUE)

  openPicker()
  press('ArrowRight')
  fireEvent.click(focused())
  expect(onChange).toHaveBeenLastCalledWith(formatAd(bsToAd(SEL.year, SEL.month, SEL.day + 1)))
  expect(dialog()).toBeNull()
  expect(focused()).toBe(trigger)
})

test('locked mode still commits the day number', () => {
  const onChange = jest.fn()
  render(<Picker lockYear={2082} lockMonth={5} value="3" onChange={onChange} />)
  openPicker()
  fireEvent.click(screen.getByRole('button', { name: dayName(2082, 5, 9) }))
  expect(onChange).toHaveBeenLastCalledWith('9')
})
