/**
 * A client backup is all of it or none of it (S852).
 *
 * Four reads in exportClientData (the staff names, the settings row, the login roster and the PIN
 * vault) used to drop their error, so a failed one was written into the backup as an empty part and
 * runBackup still stamped clients.last_backup_at. That stamp is guard 6 of the trial purge and what
 * preflightBackup checks before Delete Client, so a client could be deleted on a backup that cannot
 * restore their logins, PINs, branding, VAT number or payment QR. Each failure must now stop the
 * backup before the stamp, and the first test proves the stamp is written when nothing fails.
 */

const mockFail = {}     // part -> the error that read returns
const mockUpdates = []  // every update the code sends, { table, patch }

function mockResult(part, data) {
  return mockFail[part] ? { data: null, error: mockFail[part] } : { data, error: null }
}

function mockBuilder(table) {
  let patch = null
  const b = {}
  for (const op of ['select', 'eq', 'order', 'in', 'single', 'maybeSingle']) b[op] = () => b
  b.update = p => { patch = p; return b }
  b.then = (resolve, reject) => {
    let res
    if (patch) { mockUpdates.push({ table, patch }); res = { data: null, error: null } }
    else if (table === 'clients') res = mockResult('clients', { id: 'c1', name: 'Casa Acai Cafe' })
    else res = mockResult(table, [])
    return Promise.resolve(res).then(resolve, reject)
  }
  return b
}

jest.mock('../../../supabaseClient', () => ({
  supabase: {
    from: table => mockBuilder(table),
    rpc: () => Promise.resolve(mockResult('get_client_profile_names', [])),
  },
}))

// Every table read through readAll answers empty; the four reads under test bypass it.
jest.mock('../../../shared/fetchAllRows', () => ({
  fetchAllRows: () => Promise.resolve({ data: [], error: null }),
}))

jest.mock('xlsx', () => ({
  utils: { book_new: () => ({}), json_to_sheet: () => ({}), book_append_sheet: () => {} },
  write: () => new ArrayBuffer(0),
}))

jest.mock('./backupDirectory', () => ({
  ensureBackupDirectory: () => Promise.resolve({ handle: {}, state: 'granted' }),
  writeBackup: () => Promise.resolve('CrestBackups/Casa Acai Cafe'),
  downloadFallback: () => Promise.resolve('Downloads'),
  isFileSystemAccessSupported: () => true,
}))

// eslint-disable-next-line import/first
import { exportClientData } from './exportClientData'
// eslint-disable-next-line import/first
import { runBackup } from './runBackup'

beforeEach(() => {
  for (const k of Object.keys(mockFail)) delete mockFail[k]
  mockUpdates.length = 0
})

test('a backup whose every part was read stamps last_backup_at once the files are written', async () => {
  const res = await runBackup('c1', 'Casa Acai Cafe', 'manual')
  expect(res.method).toBe('folder')
  expect(mockUpdates).toEqual([{ table: 'clients', patch: { last_backup_at: expect.any(String) } }])
})

test.each([
  ['get_client_profile_names', /^staff names: /],
  ['settings', /^settings: /],
  ['profiles', /^profiles: /],
  ['staff_pin_vault', /^staff_pin_vault: /],
  ['clients', /^clients: /],
])('a failed %s read stops the backup before last_backup_at is stamped', async (part, named) => {
  mockFail[part] = { code: '08006', message: 'TypeError: Failed to fetch' }
  await expect(runBackup('c1', 'Casa Acai Cafe', 'predelete')).rejects.toThrow(named)
  expect(mockUpdates).toEqual([])
})

test('a client that is not there keeps its own plain sentence', async () => {
  mockFail.clients = { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }
  await expect(exportClientData('c1')).rejects.toThrow('Client not found, or not readable by this account.')
})
