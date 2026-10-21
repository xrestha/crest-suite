import { render, fireEvent, screen } from '@testing-library/react'
import QuickCalculator from './Calculator'

// S852: the copy and tape actions were a clickable div and span, out of reach of the keyboard and
// unnamed, and the C and ⌫ keys read as a letter and as nothing.

test('C and ⌫ are named keys', () => {
  render(<QuickCalculator open onClose={() => {}} />)
  expect(screen.getByRole('button', { name: 'Clear' })).toHaveTextContent('C')
  expect(screen.getByRole('button', { name: 'Delete last character' })).toHaveTextContent('⌫')
})

test('the result, and each tape line, are real buttons that say what they do', () => {
  render(<QuickCalculator open onClose={() => {}} />)
  const input = screen.getByLabelText('Calculation')
  fireEvent.change(input, { target: { value: '3*24+7' } })
  expect(screen.getByRole('button', { name: 'Copy 79' })).toHaveTextContent('79')
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(screen.getByRole('button', { name: 'Reuse 3*24+7' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Reuse 3*24+7' }))
  expect(input).toHaveValue('3*24+7')
})
