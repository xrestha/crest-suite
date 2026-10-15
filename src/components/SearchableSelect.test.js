import { useState } from 'react'
import { act, render, fireEvent, screen } from '@testing-library/react'
import SearchableSelect from './SearchableSelect'
import BsCalendarPicker from './BsCalendarPicker'

// S842: the list closed only on an outside mousedown, so Tab out of its filter box left it open
// over the next field. These pin the focus close next to what it must not break: an option click,
// keyboard selection, Escape, the outside-mousedown close, and the BS picker's Year field.

// jsdom has no layout, so no scrollIntoView; the list calls it on the highlighted option.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
})

const OPTIONS = [
  { value: 'a', label: 'Apple' },
  { value: 'b', label: 'Banana' },
  { value: 'c', label: 'Cherry' },
]

function Form({ onChange }) {
  const [value, setValue] = useState('')
  return (
    <>
      <label htmlFor="fruit">Fruit</label>
      <SearchableSelect id="fruit" value={value} options={OPTIONS} onChange={v => { setValue(v); onChange?.(v) }} />
      <input aria-label="Quantity" />
    </>
  )
}

// Focus tests need the focused node itself, which Testing Library has no query for.
const focused = () => document.activeElement // eslint-disable-line testing-library/no-node-access
const listbox = () => screen.queryByRole('listbox')
const search = () => screen.getByPlaceholderText('Type to search…')

function openList() {
  const trigger = screen.getByRole('button', { name: 'Fruit' })
  act(() => { trigger.focus() })
  fireEvent.click(trigger)
  return trigger
}

test('opening moves focus into the filter box', () => {
  render(<Form />)
  const trigger = openList()
  expect(listbox()).not.toBeNull()
  expect(search()).toHaveFocus()
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
})

test('Tab out of the open filter closes the list, and focus stays on the next field', () => {
  render(<Form />)
  const trigger = openList()
  fireEvent.keyDown(search(), { key: 'Tab' })
  // jsdom does not move focus on Tab; this is the browser's default action.
  const next = screen.getByLabelText('Quantity')
  act(() => { next.focus() })
  expect(listbox()).toBeNull()
  expect(next).toHaveFocus()
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
})

test('focus moving back to its own trigger keeps the list open', () => {
  render(<Form />)
  const trigger = openList()
  act(() => { trigger.focus() })
  expect(listbox()).not.toBeNull()
})

test('focus going nowhere (a press on the panel padding, a window switch) keeps the list open', () => {
  render(<Form />)
  openList()
  fireEvent.blur(search())
  expect(listbox()).not.toBeNull()
})

test('clicking an option still selects it: its mousedown does not close the list first', () => {
  const onChange = jest.fn()
  render(<Form onChange={onChange} />)
  const trigger = openList()
  const option = screen.getByRole('option', { name: 'Banana' })
  // The option's mousedown is prevented, so focus never leaves the filter box.
  expect(fireEvent.mouseDown(option)).toBe(false)
  expect(listbox()).not.toBeNull()
  fireEvent.click(option)
  expect(onChange).toHaveBeenCalledWith('b')
  expect(listbox()).toBeNull()
  expect(trigger).toHaveTextContent('Banana')
})

test('keyboard selection and Escape still work', () => {
  const onChange = jest.fn()
  render(<Form onChange={onChange} />)
  openList()
  fireEvent.change(search(), { target: { value: 'an' } })
  fireEvent.keyDown(search(), { key: 'Enter' })
  expect(onChange).toHaveBeenLastCalledWith('b')
  expect(listbox()).toBeNull()

  openList()
  fireEvent.keyDown(search(), { key: 'ArrowDown' })
  fireEvent.keyDown(search(), { key: 'ArrowDown' })
  fireEvent.keyDown(search(), { key: 'Enter' })
  expect(onChange).toHaveBeenLastCalledWith('c')

  openList()
  fireEvent.keyDown(search(), { key: 'Escape' })
  expect(listbox()).toBeNull()
  expect(onChange).toHaveBeenCalledTimes(2)
})

test('a mousedown outside still closes the list', () => {
  render(<Form />)
  openList()
  fireEvent.mouseDown(screen.getByLabelText('Quantity'))
  expect(listbox()).toBeNull()
})

test('in the BS date picker, Tab out of the Year search closes the list and moves on inside the picker', () => {
  render(<BsCalendarPicker id="d" ariaLabel="Booking date" value="2025-08-31" onChange={() => {}} />)
  const trigger = screen.getByRole('button', { name: 'Booking date' })
  act(() => { trigger.focus() })
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('button', { name: 'Year' }))
  expect(search()).toHaveFocus()
  // The picker's own capture-phase Tab loop moves focus; the list must close behind it.
  fireEvent.keyDown(search(), { key: 'Tab' })
  expect(listbox()).toBeNull()
  expect(focused()).toHaveAccessibleName('Next month')
  expect(screen.getByRole('dialog', { name: 'Choose a date' })).toBeInTheDocument()
})
