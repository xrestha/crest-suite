/**
 * The Kitchen Display's estimate keypad speaks to a screen reader (POS audit 2026-10-15): its C and ⌫
 * keys have names, as the PIN pad's do, and the minutes readout is a polite live region, so the
 * value is heard as the keys fill it.
 */

import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import EstimateTimeModal from './EstimateTimeModal'

const ticket = {
  id: 't1', order_no: 12, table_name: 'Table 5', pos_orders: { table_name: 'Table 5' },
  items: [{ name: 'VEG MOMO', qty: 2 }],
}

const renderPad = (onConfirm = () => {}) =>
  render(<EstimateTimeModal ticket={ticket} onConfirm={onConfirm} onClose={() => {}} />)

test('the C and ⌫ keys are named, and the minutes readout is a polite live region', () => {
  renderPad()
  const clear = screen.getByRole('button', { name: 'Clear minutes' })
  const del = screen.getByRole('button', { name: 'Delete last digit' })
  expect(clear.textContent).toBe('C')
  expect(del.textContent).toBe('⌫')

  fireEvent.click(screen.getByRole('button', { name: '1' }))
  fireEvent.click(screen.getByRole('button', { name: '5' }))
  const readout = screen.getByText((_, el) => el.getAttribute('aria-live') === 'polite')
  expect(readout.getAttribute('aria-live')).toBe('polite')
  expect(readout.getAttribute('aria-atomic')).toBe('true')
  expect(readout.textContent).toBe('15 min')

  fireEvent.click(del)
  expect(readout.textContent).toBe('1 min')
  fireEvent.click(clear)
  expect(readout.textContent).toBe('0 min')
})

test('typed minutes still confirm the ticket', () => {
  let started = null
  renderPad(m => { started = m })
  fireEvent.click(screen.getByRole('button', { name: '8' }))
  fireEvent.click(screen.getByRole('button', { name: /Confirm & Start/ }))
  expect(started).toBe(8)
})
