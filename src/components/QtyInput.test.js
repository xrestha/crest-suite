import { render, fireEvent, act } from '@testing-library/react'
import { useState } from 'react'
import QtyInput from './QtyInput'
import Modal from './Modal'

// Controlled harness wired the way every call site wires QtyInput. Real input.focus()/.blur()
// matter here: fireEvent.focus never moves document.activeElement, so the component's own
// e.currentTarget.blur() would silently no-op and the commit paths under test would never run.
function Harness({ onCommit, onChangeSpy }) {
  const [val, setVal] = useState('')
  return (
    <QtyInput
      aria-label="qty"
      value={val}
      onChange={v => { onChangeSpy?.(v); setVal(v) }}
      onCommit={onCommit}
    />
  )
}

const type = (input, text) => fireEvent.change(input, { target: { value: text } })
// Native focus/blur sit outside RTL's automatic act() wrapping, so the state updates they
// trigger would not flush before the assertions without these.
const focus = input => act(() => input.focus())
const blur = input => act(() => input.blur())

function seed(input, text) {
  focus(input)
  type(input, text)
  blur(input)
}

test('an expression commits its result on blur', () => {
  const onCommit = jest.fn()
  const { container } = render(<Harness onCommit={onCommit} />)
  const input = container.querySelector('input')
  focus(input)
  type(input, '12*4')
  blur(input)
  expect(onCommit).toHaveBeenCalledTimes(1)
  expect(onCommit).toHaveBeenCalledWith(48)
  expect(input.value).toBe('48')
})

// parseFloat("1,200") === 1 and parseFloat("12x4") === 12 — neither prefix reading may ever
// reach a parent (they priced an item 1000×/4× wrong before evaluation covered these, S623).
test('comma and ascii-x input evaluate instead of passing through raw', () => {
  const onCommit = jest.fn()
  const { container } = render(<Harness onCommit={onCommit} />)
  const input = container.querySelector('input')
  focus(input)
  type(input, '1,200')
  blur(input)
  expect(onCommit).toHaveBeenLastCalledWith(1200)
  expect(input.value).toBe('1200')
  focus(input)
  type(input, '12x4')
  blur(input)
  expect(onCommit).toHaveBeenLastCalledWith(48)
  expect(input.value).toBe('48')
})

test('unparseable text reverts to the last good value and never reaches the parent', () => {
  const onCommit = jest.fn()
  const onChangeSpy = jest.fn()
  const { container } = render(<Harness onCommit={onCommit} onChangeSpy={onChangeSpy} />)
  const input = container.querySelector('input')
  seed(input, '500')
  focus(input)
  type(input, '5oo')
  blur(input)
  expect(input.value).toBe('500')
  expect(onChangeSpy).not.toHaveBeenCalledWith('5oo')
  expect(onCommit).toHaveBeenLastCalledWith(500)
})

test('Enter commits exactly once', () => {
  const onCommit = jest.fn()
  const { container } = render(<Harness onCommit={onCommit} />)
  const input = container.querySelector('input')
  focus(input)
  type(input, '12*4')
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(onCommit).toHaveBeenCalledTimes(1)
  expect(onCommit).toHaveBeenCalledWith(48)
})

// Escape blurs the field, and the blur's commit() runs before React re-renders — without the
// cancel ref it closed over the pre-Escape draft and committed 48, identical to Enter (S623).
test('Escape cancels the expression instead of committing it', () => {
  const onCommit = jest.fn()
  const { container } = render(<Harness onCommit={onCommit} />)
  const input = container.querySelector('input')
  seed(input, '500')
  onCommit.mockClear()
  focus(input)
  type(input, '12*4')
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(onCommit).not.toHaveBeenCalled()
  expect(input.value).toBe('500')
})

test('Escape with an edit in progress does not close a host Modal; a second Escape does', () => {
  const onClose = jest.fn()
  const { container } = render(
    <Modal title="Edit Item" onClose={onClose}><Harness /></Modal>
  )
  const input = container.querySelector('input[aria-label="qty"]')
  focus(input)
  type(input, '3*4')
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledTimes(1)
})
