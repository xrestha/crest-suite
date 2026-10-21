import { act, render, fireEvent, screen } from '@testing-library/react'
import Tip from './Tip'
import Modal from './Modal'

// S852, WCAG 1.4.13: the bubble could not be dismissed and could not be hovered. It took no pointer
// events and leaving the trigger hid it at once, so a reader with a magnifier could not move onto
// it, and a 220px bubble over the field below a label stayed until the pointer went elsewhere.

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

const tip = () => screen.queryByRole('tooltip')

test('Escape closes a showing tip without moving focus', () => {
  render(<Tip text="What this column means"><button type="button">Rate</button></Tip>)
  const btn = screen.getByRole('button', { name: 'Rate' })
  act(() => { btn.focus() })
  expect(tip()).toHaveTextContent('What this column means')
  fireEvent.keyDown(btn, { key: 'Escape' })
  expect(tip()).toBeNull()
  expect(btn).toHaveFocus()
})

test('the pointer can move from the trigger onto the bubble and it stays open', () => {
  render(<Tip text="Hover me"><span>Label</span></Tip>)
  const trigger = screen.getByText('Label')
  fireEvent.mouseEnter(trigger)
  expect(tip()).not.toBeNull()
  // Crossing the gap: the trigger is left, then the bubble is entered within the delay.
  fireEvent.mouseLeave(trigger)
  fireEvent.mouseEnter(tip())
  act(() => { jest.advanceTimersByTime(1000) })
  expect(tip()).not.toBeNull()
  // Leaving the bubble for the page closes it after the delay.
  fireEvent.mouseLeave(tip())
  act(() => { jest.advanceTimersByTime(1000) })
  expect(tip()).toBeNull()
})

test('leaving the trigger for the page still closes the tip', () => {
  render(<Tip text="Gone soon"><span>Label</span></Tip>)
  const trigger = screen.getByText('Label')
  fireEvent.mouseEnter(trigger)
  fireEvent.mouseLeave(trigger)
  expect(tip()).not.toBeNull()
  act(() => { jest.advanceTimersByTime(1000) })
  expect(tip()).toBeNull()
})

test('a press on the bubble closes it and does not reach a clickable parent', () => {
  const onCard = jest.fn()
  render(
    <div onClick={onCard}>
      <Tip text="Bubble"><span>Label</span></Tip>
    </div>
  )
  fireEvent.mouseEnter(screen.getByText('Label'))
  const bubble = tip()
  fireEvent.mouseDown(bubble)
  fireEvent.click(bubble)
  expect(tip()).toBeNull()
  expect(onCard).not.toHaveBeenCalled()
})

test('inside a dialog, the first Escape closes the tip and leaves the dialog open', () => {
  const onClose = jest.fn()
  render(
    <Modal title="Edit item" onClose={onClose}>
      <Tip text="Price per base unit"><button type="button">Rate</button></Tip>
    </Modal>
  )
  const btn = screen.getByRole('button', { name: 'Rate' })
  act(() => { btn.focus() })
  expect(tip()).not.toBeNull()
  fireEvent.keyDown(btn, { key: 'Escape' })
  expect(tip()).toBeNull()
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.keyDown(btn, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledTimes(1)
})
