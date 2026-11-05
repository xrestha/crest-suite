/**
 * S890: Admin → Clients → Feature Access must never offer Save over grants it could not read.
 * loadClientFeatureFlags used to drop its read error and return the default flags, so a dropped
 * connection showed a client with no grants and Save wrote those defaults over the real ones.
 */
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import FeatureAccessModal from './FeatureAccessModal'

const mockLoad = jest.fn()
const mockSave = jest.fn()
jest.mock('../../context/SettingsContext', () => ({
  useSettings: () => ({ loadClientFeatureFlags: mockLoad, saveFeatureFlags: mockSave }),
}))

const CLIENT = { id: 'c1', name: 'Casa Acai', plan: 'starter', ims_enabled: true, pos_enabled: true }

beforeEach(() => { mockLoad.mockReset(); mockSave.mockReset() })

it('a failed read shows the error, offers Try again and no Save', async () => {
  mockLoad.mockRejectedValueOnce(new Error('Check your internet and try again. (TypeError · Failed to fetch)'))
  render(<FeatureAccessModal client={CLIENT} onClose={() => {}} />)
  expect(await screen.findByText(/could not be read, so nothing is shown and Save is off/)).toBeInTheDocument()
  expect(screen.getByText(/Failed to fetch/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  expect(mockSave).not.toHaveBeenCalled()
})

it('Try again reads again, and a read that answers brings Save back', async () => {
  mockLoad.mockRejectedValueOnce(new Error('connection reset'))
  mockLoad.mockResolvedValueOnce({ client_id: 'c1', menu_engineering: true })
  render(<FeatureAccessModal client={CLIENT} onClose={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
  const save = await screen.findByRole('button', { name: 'Save' })
  expect(mockLoad).toHaveBeenCalledTimes(2)
  expect(save).not.toBeDisabled()
  expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument()
})

it('Save waits for the read, so the defaults on screen while loading are never written', async () => {
  let answer
  mockLoad.mockReturnValueOnce(new Promise(res => { answer = res }))
  render(<FeatureAccessModal client={CLIENT} onClose={() => {}} />)
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  answer({ client_id: 'c1' })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled())
})
