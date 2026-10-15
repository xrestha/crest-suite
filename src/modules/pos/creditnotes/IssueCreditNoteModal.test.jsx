/**
 * S843: a Credit bill can be paid in parts, so the Credit Note dialog says what has been paid on it
 * before "Was money returned?" is answered. Words only: the cash refund stays the server's figure.
 */
import { render, screen } from '@testing-library/react'
import { CreditBillPaidLine } from './IssueCreditNoteModal'

jest.mock('../../../supabaseClient', () => ({ supabase: {} }))

test('a part-paid Credit bill names what was paid, the cash part, and the rest still owed', () => {
  render(<CreditBillPaidLine creditPaid={{ totals: { received: 700, commission: 0, cash: 400 } }} bill={{ paid_amount: 1130, credit_settled_at: null }} cashOut={400} />)
  const p = screen.getByText(/This Credit bill has been paid/)
  expect(p).toHaveTextContent('paid NPR 700 so far, NPR 400 of it in cash; the NPR 430 still owed is simply cleared by the note.')
  expect(p).toHaveTextContent('NPR 400 from the drawer if you choose Cash, and what was paid by card, QR or bank goes back that way, as Other.')
})

test('a Credit bill nobody has paid anything on says no money goes back', () => {
  render(<CreditBillPaidLine creditPaid={{ totals: null }} bill={{ paid_amount: 1130, credit_settled_at: null }} cashOut={0} />)
  expect(screen.getByText(/Nothing has been paid on this Credit bill yet/)).toHaveTextContent('choose None')
})

test('a bill settled whole before part payments says nothing more', () => {
  const { container } = render(<CreditBillPaidLine creditPaid={{ totals: null }} bill={{ paid_amount: 1130, credit_settled_at: '2026-10-01T05:00:00Z' }} cashOut={1130} />)
  expect(container).toBeEmptyDOMElement()
})

test('a failed read says so, and never reads as nothing paid', () => {
  render(<CreditBillPaidLine creditPaid={{ error: { message: 'Failed to fetch' } }} bill={{ paid_amount: 1130 }} cashOut={0} />)
  expect(screen.getByText(/Could not read what has been paid/)).toBeInTheDocument()
  expect(screen.queryByText(/Nothing has been paid/)).toBeNull()
})
