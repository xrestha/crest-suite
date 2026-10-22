import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import AssetFormModal from './AssetFormModal'
import { BS_MONTHS, bsToAd, formatAd, getBsToday } from '../../../utils/bsCalendar'

// S858: the acquisition date is picked in BS. What is stored must stay the same AD string the
// AD box used to write (formatAd of the picked day, never toISOString), and the required-date
// message must still reach the picker.

jest.mock('../../../supabaseClient', () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: {} } }))

const mockInsert = jest.fn()
jest.mock('../../../shared/hooks/useScopedDb', () => ({
  useScopedDb: () => ({ scopedFrom: jest.fn(), scopedInsert: (...a) => mockInsert(...a), scopedUpdate: jest.fn() }),
}))

beforeEach(() => {
  mockInsert.mockReset()
  mockInsert.mockResolvedValue({ data: null, error: null })
})

// A new asset with a name and a useful life, so the acquisition date is the field on trial.
function openNewAssetForm(onSaved) {
  render(<AssetFormModal categories={[]} asset={null} onClose={jest.fn()} onSaved={onSaved} />)
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Oven' } })
  fireEvent.change(screen.getByLabelText(/Useful Life/), { target: { value: '10' } })
}

test('a BS day picked for the acquisition date is stored as the AD date it falls on', async () => {
  const onSaved = jest.fn()
  openNewAssetForm(onSaved)
  const today = getBsToday()
  const dayName = `1 ${BS_MONTHS[today.month - 1]} ${today.year}`

  const trigger = screen.getByLabelText('Acquisition Date')
  fireEvent.click(trigger)
  fireEvent.click(await screen.findByRole('button', { name: dayName }))
  expect(trigger).toHaveTextContent(dayName)

  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(mockInsert).toHaveBeenCalledTimes(1))
  expect(mockInsert.mock.calls[0][0]).toBe('assets_register')
  expect(mockInsert.mock.calls[0][1].acquisition_date).toBe(formatAd(bsToAd(today.year, today.month, 1)))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
})

test('no acquisition date: nothing is written and the message is tied to the picker', async () => {
  openNewAssetForm(jest.fn())
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText('Acquisition date is required.')).toHaveAttribute('id', 'assetf-f7-err')
  expect(screen.getByLabelText('Acquisition Date')).toHaveAttribute('aria-describedby', 'assetf-f7-err')
  expect(mockInsert).not.toHaveBeenCalled()
})
