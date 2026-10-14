// POS Setup → Printers rendered against a mocked server (S837).
import { render, screen, fireEvent } from '@testing-library/react'
import PosPrintersPanel from './PosPrintersPanel'
import * as api from './printDeviceApi'

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ isAdmin: false, adminViewClientName: '', profile: { clients: { name: 'Bhatti Choila' } } }),
}))
jest.mock('./printDeviceApi', () => ({
  HELPER_DOWNLOAD_URL: 'https://x/CrestPrintHelper.zip',
  listPrintDevices: jest.fn(),
  listPrintJobs: jest.fn(),
  createPrintDevice: jest.fn(),
  updatePrintDevice: jest.fn(),
  issuePrintPairCode: jest.fn(),
  removePrintDevice: jest.fn(),
  sendPrintTest: jest.fn(),
  pairPrintDevice: jest.fn(),
  deviceRpc: jest.fn(),
}))

const now = Date.now()
const devices = [
  { id: 'd1', name: 'Counter PC', kind: 'page', stations: ['KOT', 'BOT'], printers: [], paired: true, online: true, last_seen_at: new Date(now - 4000).toISOString(), status: null, last_error: null },
  { id: 'd2', name: 'Bar helper', kind: 'helper', stations: ['BOT'], printers: [{ station: 'BOT', host: '192.168.1.51', port: 9100, width: 58 }], paired: false, online: false, pair_code_expires_at: new Date(now + 600000).toISOString(), status: { printers: [{ station: 'BOT', ok: false, error: 'Out of paper' }] }, last_error: 'Out of paper', last_error_at: new Date(now - 60000).toISOString() },
]
const jobs = [
  { id: 'j1', station: 'KOT', kind: 'ticket', label: 'Table 4 · #23', state: 'printed', printed_via: 'device', device_name: 'Counter PC', created_at: new Date(now - 30000).toISOString() },
  { id: 'j2', station: 'BOT', kind: 'test', label: '', state: 'retrying', fail_reason: 'Paper out', device_name: 'Bar helper', created_at: new Date(now - 60000).toISOString() },
]

test('panel renders devices, summary and jobs; Add opens the form; create shows the code', async () => {
  api.listPrintDevices.mockResolvedValue({ data: devices, error: null })
  api.listPrintJobs.mockResolvedValue({ data: jobs, error: null })
  api.createPrintDevice.mockResolvedValue({ data: { device_id: 'd3', pair_code: 'ABCDEFGH', pair_code_expires_at: new Date(now + 900000).toISOString() }, error: null })
  render(<PosPrintersPanel clientId="c1" />)
  await screen.findAllByText('Counter PC')
  expect(screen.getByText(/Kitchen tickets print on/)).toBeTruthy()
  expect(screen.getByText('Waiting to pair')).toBeTruthy()
  expect(screen.getByText(/Not printing: Out of paper/)).toBeTruthy()
  expect(screen.getByText('Retrying')).toBeTruthy()
  fireEvent.click(screen.getAllByText('+ Add printer computer')[0])
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Kitchen laptop' } })
  fireEvent.click(screen.getByText('Add and make a pairing code'))
  await screen.findByText('ABCD-EFGH')
  expect(api.createPrintDevice).toHaveBeenCalledWith({ clientId: 'c1', name: 'Kitchen laptop', kind: 'page', stations: ['KOT'], printers: [] })
  expect(screen.getByText(/\/print-station/)).toBeTruthy()
})

test('panel: a failed first read is not an empty list', async () => {
  api.listPrintDevices.mockResolvedValue({ data: null, error: { message: 'TypeError: Failed to fetch' } })
  api.listPrintJobs.mockResolvedValue({ data: [], error: null })
  render(<PosPrintersPanel clientId="c1" />)
  await screen.findByText(/Couldn't load the printer computers/)
  expect(screen.queryByText(/No printer computer yet/)).toBeNull()
})

test('panel: a refusal shows the server\'s own plain sentence; no answer claims nothing', async () => {
  api.listPrintDevices.mockResolvedValue({ data: devices, error: null })
  api.listPrintJobs.mockResolvedValue({ data: [], error: null })
  api.issuePrintPairCode
    .mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'pos_print_device_gone', hint: 'This printer computer was removed. Add it again.' } })
    .mockResolvedValueOnce({ data: null, error: Object.assign(new Error('Making a pairing code timed out after 20s'), { name: 'TimeoutError' }) })
  render(<PosPrintersPanel clientId="c1" />)
  await screen.findAllByText('Counter PC')
  fireEvent.click(screen.getAllByText('Pairing code')[0])
  expect(await screen.findByText('No pairing code was made. This printer computer was removed. Add it again.')).toBeTruthy()
  fireEvent.click(screen.getAllByText('Pairing code')[0])
  expect(await screen.findByText(/Crest did not answer, so there is no code to show/)).toBeTruthy()
})
