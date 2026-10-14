// The /print-station page rendered against a mocked server (S837). jsdom has no Worker, so these
// also run the page's setInterval fallback.
import { render, screen, fireEvent } from '@testing-library/react'
import PrintStation from './PrintStation'
import * as api from './printDeviceApi'
import { printHtmlInHiddenFrame } from './iframePrint'

jest.mock('./iframePrint', () => ({ printHtmlInHiddenFrame: jest.fn(() => Promise.resolve()) }))

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

test('print station: pairs, polls, prints nothing on an empty poll', async () => {
  localStorage.clear()
  api.pairPrintDevice.mockResolvedValue({ data: { ok: true, device_id: 'dev', secret: 'sec', device_name: 'Counter PC', client_name: 'Bhatti Choila', kind: 'page' }, error: null })
  api.deviceRpc.mockResolvedValue({ data: { ok: true, device: { id: 'dev', name: 'Counter PC', kind: 'page', stations: ['KOT'] }, client_name: 'Bhatti Choila', jobs: [] }, error: null })
  render(<PrintStation />)
  fireEvent.change(screen.getByLabelText(/Pairing code/), { target: { value: 'ab' } })
  fireEvent.click(screen.getByText('Pair'))
  expect(await screen.findByText(/this has 2/)).toBeTruthy()
  fireEvent.change(screen.getByLabelText(/Pairing code/), { target: { value: 'abcd efgh' } })
  expect(screen.getByLabelText(/Pairing code/).value).toBe('ABCD-EFGH')
  fireEvent.click(screen.getByText('Pair'))
  await screen.findByText('Ready — waiting for tickets')
  expect(api.pairPrintDevice).toHaveBeenCalledWith('ABCDEFGH', expect.objectContaining({ kind: 'page' }))
  expect(JSON.parse(localStorage.getItem('crest_print_device')).deviceId).toBe('dev')
  expect(screen.getByText(/Kitchen tickets print here/)).toBeTruthy()
})

test('print station: removed device goes back to the pair form and clears storage', async () => {
  localStorage.setItem('crest_print_device', JSON.stringify({ deviceId: 'dev', secret: 'sec', deviceName: 'Counter PC', clientName: 'B' }))
  api.deviceRpc.mockResolvedValue({ data: { ok: false, code: 'device_not_active' }, error: null })
  render(<PrintStation />)
  await screen.findByText(/This computer has stopped printing/)
  expect(localStorage.getItem('crest_print_device')).toBeNull()
})

test('print station: wrong kind refusal', async () => {
  localStorage.clear()
  api.pairPrintDevice.mockResolvedValue({ data: { ok: false, code: 'wrong_kind' }, error: null })
  render(<PrintStation />)
  fireEvent.change(screen.getByLabelText(/Pairing code/), { target: { value: 'ABCDEFGH' } })
  fireEvent.click(screen.getByText('Pair'))
  expect(await screen.findByText(/for the Crest Print Helper program, not this page/)).toBeTruthy()
})

test('print station: a polled job prints, is reported, and is listed as printed here', async () => {
  localStorage.setItem('crest_print_device', JSON.stringify({ deviceId: 'dev', secret: 'sec', deviceName: 'Counter PC', clientName: 'B' }))
  const job = { id: 'j1', station: 'BOT', kind: 'ticket', label: 'Table 7 · #41', created_at: new Date().toISOString(), late: true, doc: { v: 1, title: 'BOT', lines: [{ k: 'text', t: 'MOJITO', size: 'xl' }] } }
  api.deviceRpc.mockImplementation(async fn => (fn === 'pos_print_device_poll'
    ? { data: { ok: true, device: { id: 'dev', name: 'Counter PC', kind: 'page', stations: ['BOT'] }, client_name: 'B', jobs: api.deviceRpc.mock.calls.length === 1 ? [job] : [] }, error: null }
    : { data: { ok: true }, error: null }))
  render(<PrintStation />)
  await screen.findByText('Table 7 · #41')
  expect(screen.getByText('Late')).toBeTruthy()
  expect(printHtmlInHiddenFrame).toHaveBeenCalledWith(expect.stringContaining('PRINTED LATE'))
  expect(api.deviceRpc).toHaveBeenCalledWith('pos_print_device_report', { p_device_id: 'dev', p_secret: 'sec', p_printed: ['j1'], p_failed: [] })
})
