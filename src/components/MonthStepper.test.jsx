import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import MonthStepper, { neighboursOf } from './MonthStepper'

// S858: the ‹ › every owner page puts around its month picker.
const months = [
  { id: 'c', name: 'Ashwin 2083' },  // newest first, as every period list here is read
  { id: 'b', name: 'Bhadra 2083' },
  { id: 'a', name: 'Shrawan 2083' },
]
const steps = id => neighboursOf(months, id, m => m.id, m => m.name)

test('the previous month is the next item down a newest-first list, the next month the one above', () => {
  expect(steps('b')).toEqual({ prev: { key: 'a', label: 'Shrawan 2083' }, next: { key: 'c', label: 'Ashwin 2083' } })
  expect(steps('a').prev).toBeNull()
  expect(steps('c').next).toBeNull()
  expect(steps('zz')).toEqual({ prev: null, next: null })
})

test('a press steps to the neighbour it names; an end of the list stays in place and does nothing', () => {
  const onStep = jest.fn()
  render(<MonthStepper {...steps('a')} onStep={onStep}><select aria-label="Period" /></MonthStepper>)
  fireEvent.click(screen.getByRole('button', { name: 'Next month: Bhadra 2083' }))
  expect(onStep).toHaveBeenCalledWith('b')
  const none = screen.getByRole('button', { name: 'No earlier month' })
  expect(none.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(none)
  expect(onStep).toHaveBeenCalledTimes(1)
})
