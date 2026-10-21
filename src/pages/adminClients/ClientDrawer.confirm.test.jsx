/**
 * Admin → Clients → Manage asks every question in the app's own dialog, never the browser's plain
 * OK/Cancel box (owner decision). Each action below is checked three ways: it asks through the
 * dialog, Cancel does nothing, and confirming carries it out. The whole-client delete keeps its
 * type-the-name step.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'

const CLIENT = { id: 'c1', name: 'Casa Acai', location: 'Kathmandu', plan: 'growth', ims_enabled: true }

let mockUsers = []
let mockEmails = []
let mockItems = []
let mockItemsError = null
let mockWrites = []
let mockProfilesError = null // a failed plain read of profiles (S852)
let mockVault = []

function mockBuilder(table) {
  const ops = []
  const b = {}
  const record = (op, args) => {
    ops.push(op)
    if (['delete', 'upsert', 'update'].includes(op)) mockWrites.push({ table, op, args })
    return b
  }
  for (const op of ['select', 'eq', 'or', 'not', 'order', 'in', 'delete', 'upsert', 'update', 'maybeSingle', 'single']) {
    b[op] = (...args) => record(op, args)
  }
  b.then = (resolve, reject) => {
    let result = { data: null, error: null }
    if (table === 'staff_pin_vault') result = { data: mockVault, error: null }
    if (table === 'profiles') {
      if (ops.includes('upsert')) result = { data: [{ id: 'u9' }], error: null }
      else if (ops.includes('maybeSingle')) result = { data: { role: 'client' }, error: null }
      else if (!ops.includes('delete')) result = mockProfilesError ? { data: null, error: mockProfilesError } : { data: mockUsers, error: null }
    }
    return Promise.resolve(result).then(resolve, reject)
  }
  return b
}

jest.mock('../../supabaseClient', () => ({
  supabase: {
    from: table => mockBuilder(table),
    rpc: name => Promise.resolve(
      name === 'client_user_emails' ? { data: mockEmails, error: null }
        : name === 'find_user_id_by_email' ? { data: 'u9', error: null }
          : { data: null, error: null }),
  },
}))

jest.mock('../../shared/scopedDb', () => ({
  scopedFrom: () => ({ not: () => Promise.resolve({ data: mockItems, error: mockItemsError }) }),
  scopedUpdate: (...args) => { mockWrites.push({ table: args[0], op: 'scopedUpdate', args }); return { eq: () => Promise.resolve({ error: null }) } },
  scopedDelete: jest.fn(),
}))

jest.mock('../../context/AuthContext', () => ({ useAuth: () => ({ adminViewClientId: null, refreshViewModules: jest.fn() }) }))
jest.mock('../../context/SettingsContext', () => ({
  useSettings: () => ({ loadClientSettings: jest.fn(), saveClientSettings: jest.fn(), pricing: {} }),
}))
jest.mock('../../shared/adminOp', () => ({ adminOp: jest.fn() }))
jest.mock('../../modules/admin/dataExport/runBackup', () => ({ runBackup: jest.fn() }))
jest.mock('../../modules/admin/dataExport/restoreClientData', () => ({ restoreClientData: jest.fn() }))
jest.mock('../../modules/admin/dataExport/backupDirectory', () => ({
  pickBackupDirectory: jest.fn(),
  ensureBackupDirectory: () => Promise.resolve({ state: 'none' }),
  isFileSystemAccessSupported: () => false,
}))
jest.mock('../../modules/ims/sales/persistSalesDay', () => ({
  findTillCoveredManualDays: jest.fn(),
  recountManualSalesDays: jest.fn(),
  SAVE_TIMEOUT_MS: 1000,
}))
jest.mock('./ClientLegalTab', () => () => null)

/* eslint-disable import/first */
import ClientDrawer from './ClientDrawer'
import { adminOp } from '../../shared/adminOp'
import { runBackup } from '../../modules/admin/dataExport/runBackup'
import { restoreClientData } from '../../modules/admin/dataExport/restoreClientData'
import { CONFIRM_TIMEOUT_MS, CONFIRM_TIMEOUT_TEXT } from '../../shared/hooks/useConfirm'
/* eslint-enable import/first */

let confirmSpy

beforeEach(() => {
  mockUsers = [{ id: 'u1', full_name: 'Ram Sharma', role: 'client', client_id: 'c1', pos_email: null }]
  mockEmails = [{ id: 'u1', email: 'ram@casa.com' }]
  mockItems = []
  mockItemsError = null
  mockWrites = []
  mockProfilesError = null
  mockVault = []
  adminOp.mockReset()
  runBackup.mockReset()
  restoreClientData.mockReset()
  confirmSpy = jest.spyOn(window, 'confirm').mockImplementation(() => { throw new Error('window.confirm must not be called') })
})

afterEach(() => {
  expect(confirmSpy).not.toHaveBeenCalled()
  confirmSpy.mockRestore()
})

const renderDrawer = () => render(<ClientDrawer client={CLIENT} onClose={jest.fn()} onClientUpdated={jest.fn()} />)

const dialogNamed = name => screen.findByRole('dialog', { name })

async function openDanger() {
  renderDrawer()
  fireEvent.click(screen.getByRole('tab', { name: '⚠ Danger' }))
  await screen.findByRole('button', { name: 'Clear IMS Transactions' })
}

describe('deleting a login', () => {
  it('asks in the app dialog, naming the login and the client, and Keep deletes nothing', async () => {
    renderDrawer()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Ram Sharma' }))
    const dialog = await dialogNamed("Delete Ram Sharma's login?")
    expect(dialog).toHaveTextContent('This permanently removes the login "Ram Sharma" (ram@casa.com) from Casa Acai and frees the email to be reused.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: "Delete Ram Sharma's login?" })).toBeNull())
    expect(adminOp).not.toHaveBeenCalled()
  })

  it('deletes on Delete login', async () => {
    adminOp.mockResolvedValue({})
    renderDrawer()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Ram Sharma' }))
    const dialog = await dialogNamed("Delete Ram Sharma's login?")
    expect(within(dialog).getByRole('button', { name: 'Delete login' })).toHaveClass('btn-danger')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete login' }))
    expect(await screen.findByText('✓ User deleted and email freed.')).toBeInTheDocument()
    expect(adminOp).toHaveBeenCalledWith('deleteUser', { userId: 'u1' })
  })
})

describe('a till login that has recorded something is offered Block', () => {
  const refusal = 'Sita Rai has recorded bills at the till; deleting her login would take her name off them.'
  beforeEach(() => {
    mockUsers = [{ id: 'u2', full_name: 'Sita Rai', role: 'client', client_id: 'c1', pos_email: 'x@pos.internal' }]
    mockEmails = [{ id: 'u2', email: 'x@pos.internal' }]
  })

  async function reachBlockQuestion() {
    adminOp.mockImplementation(action => {
      if (action === 'delete_pos_staff') return Promise.reject(Object.assign(new Error(refusal), { code: 'pos_login_has_records' }))
      return Promise.resolve({})
    })
    renderDrawer()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Sita Rai' }))
    fireEvent.click(within(await dialogNamed("Delete Sita Rai's login?")).getByRole('button', { name: 'Delete login' }))
    return dialogNamed('Block Sita Rai now?')
  }

  it('asks in the app dialog with the refusal, and Cancel blocks nothing and says the PIN still works', async () => {
    const dialog = await reachBlockQuestion()
    expect(dialog).toHaveTextContent(refusal)
    expect(dialog).toHaveTextContent('Blocking stops Sita Rai signing in to Casa Acai')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Block Sita Rai now?' })).toBeNull())
    expect(screen.getByText('Sita Rai was not deleted, and their PIN still works.')).toBeInTheDocument()
    expect(adminOp).not.toHaveBeenCalledWith('block_pos_staff', expect.anything())
  })

  it('blocks on Block login', async () => {
    const dialog = await reachBlockQuestion()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Block login' }))
    expect(await screen.findByText(/Sita Rai is blocked: it can no longer sign in/)).toBeInTheDocument()
    expect(adminOp).toHaveBeenCalledWith('block_pos_staff', { client_id: 'c1', userId: 'u2' })
    expect(screen.queryByText('Sita Rai was not deleted, and their PIN still works.')).toBeNull()
  })
})

describe('moving an existing login to this client', () => {
  async function reachMoveQuestion() {
    adminOp.mockImplementation(action => (action === 'createUser'
      ? Promise.reject(new Error('A user with this email address has already been registered'))
      : Promise.resolve({})))
    renderDrawer()
    await screen.findByRole('button', { name: 'Delete Ram Sharma' })
    fireEvent.change(screen.getByLabelText('Email *'), { target: { value: 'owner@other.com' } })
    fireEvent.change(screen.getByLabelText('Password *'), { target: { value: 'longenough1' } })
    fireEvent.click(screen.getByRole('button', { name: '+ Create User' }))
    return dialogNamed('Move owner@other.com to Casa Acai?')
  }

  it('asks in the app dialog, and Cancel writes nothing and frees the Create button', async () => {
    const dialog = await reachMoveQuestion()
    expect(dialog).toHaveTextContent('it loses access to its previous client and arrives as an Owner login')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Move owner@other.com to Casa Acai?' })).toBeNull())
    expect(mockWrites.filter(w => w.op === 'upsert')).toHaveLength(0)
    expect(screen.getByRole('button', { name: '+ Create User' })).toBeEnabled()
  })

  it('moves the login on Move login', async () => {
    const dialog = await reachMoveQuestion()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move login' }))
    expect(await screen.findByText('✓ owner@other.com reassigned to this client.')).toBeInTheDocument()
    const upsert = mockWrites.find(w => w.op === 'upsert')
    expect(upsert.args[0]).toMatchObject({ id: 'u9', client_id: 'c1', role: 'client', active_client_id: null })
  })
})

describe('clearing one module', () => {
  it('asks in the app dialog, naming the client and what goes, and Keep clears nothing', async () => {
    await openDanger()
    fireEvent.click(screen.getByRole('button', { name: 'Clear IMS Transactions' }))
    const dialog = await dialogNamed('Clear IMS transactions for Casa Acai?')
    expect(dialog).toHaveTextContent('This deletes: IMS transactions (purchases')
    expect(dialog).toHaveTextContent('ALSO DELETED: the whole Fixed Assets register')
    expect(dialog).toHaveTextContent('This cannot be undone.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Clear IMS transactions for Casa Acai?' })).toBeNull())
    expect(adminOp).not.toHaveBeenCalled()
    expect(runBackup).not.toHaveBeenCalled()
  })

  it('clears on Clear IMS data', async () => {
    adminOp.mockResolvedValue({})
    await openDanger()
    fireEvent.click(screen.getByLabelText('Skip the backup'))
    fireEvent.click(screen.getByRole('button', { name: 'Clear IMS Transactions' }))
    const dialog = await dialogNamed('Clear IMS transactions for Casa Acai?')
    expect(within(dialog).getByRole('button', { name: 'Clear IMS data' })).toHaveClass('btn-danger')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear IMS data' }))
    expect(await screen.findByText(/IMS transactions and the Fixed Assets register cleared/)).toBeInTheDocument()
    expect(adminOp).toHaveBeenCalledWith('clearModuleData', { clientId: 'c1', module: 'ims' })
  })
})

describe('the downloaded-backup check before a delete', () => {
  beforeEach(() => {
    runBackup.mockResolvedValue({ location: 'Downloads', manifest: { totalRows: 10 }, method: 'download' })
    adminOp.mockResolvedValue({})
  })

  async function reachDownloadQuestion() {
    await openDanger()
    fireEvent.click(screen.getByRole('button', { name: 'Clear HR Transactions' }))
    fireEvent.click(within(await dialogNamed('Clear HR transactions for Casa Acai?')).getByRole('button', { name: 'Clear HR data' }))
    return dialogNamed('Are both backup files safely downloaded?')
  }

  it('asks in the app dialog, and Cancel deletes nothing', async () => {
    const dialog = await reachDownloadQuestion()
    expect(dialog).toHaveTextContent('BOTH files must be there')
    expect(dialog).toHaveTextContent('Nothing has been deleted from Casa Acai yet.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText(/Stopped — nothing was deleted/)).toBeInTheDocument()
    expect(adminOp).not.toHaveBeenCalled()
  })

  it('goes on to the clear once both files are confirmed', async () => {
    const dialog = await reachDownloadQuestion()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Both are there, continue' }))
    expect(await screen.findByText('HR transactions cleared. Setup data was kept.')).toBeInTheDocument()
    expect(adminOp).toHaveBeenCalledWith('clearModuleData', { clientId: 'c1', module: 'hr' })
  })
})

describe('clearing unit conversions', () => {
  beforeEach(() => {
    mockItems = [{ id: 'i1', purchase_qty: 1000, rate: 500 }, { id: 'i2', purchase_qty: 12, rate: 240 }]
  })

  it('asks in the app dialog, and Keep changes nothing', async () => {
    await openDanger()
    fireEvent.click(screen.getByRole('button', { name: 'Clear All Conversions' }))
    const dialog = await dialogNamed('Clear unit conversions on 2 items for Casa Acai?')
    expect(dialog).toHaveTextContent('per-unit rates — and every stock valuation built on them — are unchanged')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Clear unit conversions/ })).toBeNull())
    expect(mockWrites.filter(w => w.op === 'scopedUpdate')).toHaveLength(0)
  })

  it('rescales each item on Clear conversions', async () => {
    await openDanger()
    fireEvent.click(screen.getByLabelText('Skip the backup'))
    fireEvent.click(screen.getByRole('button', { name: 'Clear All Conversions' }))
    fireEvent.click(within(await dialogNamed('Clear unit conversions on 2 items for Casa Acai?')).getByRole('button', { name: 'Clear conversions' }))
    expect(await screen.findByText('Conversions cleared on 2 items. Per-unit rates preserved.')).toBeInTheDocument()
    const updates = mockWrites.filter(w => w.op === 'scopedUpdate')
    expect(updates.map(u => u.args[2].rate)).toEqual([0.5, 20])
  })

  it('a failed read says nothing was changed instead of "no conversions", and asks nothing', async () => {
    mockItemsError = { message: 'network down' }
    await openDanger()
    fireEvent.click(screen.getByRole('button', { name: 'Clear All Conversions' }))
    expect(await screen.findByText(/Nothing was changed — the items with a conversion could not be read/)).toBeInTheDocument()
    expect(screen.queryByText('No items have a conversion set.')).toBeNull()
    expect(screen.queryByRole('dialog', { name: /Clear unit conversions/ })).toBeNull()
  })
})

it('the whole-client delete still asks for the client name to be typed', async () => {
  await openDanger()
  fireEvent.click(screen.getByRole('button', { name: 'Delete Client' }))
  const dialog = await dialogNamed('Permanently DELETE this client?')
  const go = within(dialog).getByRole('button', { name: 'Delete Client' })
  expect(go).toBeDisabled()
  fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'Casa Acai' } })
  expect(go).toBeEnabled()
})

it('a login delete that never answers releases its dialog and says it could not confirm (S803)', async () => {
  adminOp.mockImplementation(() => new Promise(() => {}))
  renderDrawer()
  fireEvent.click(await screen.findByRole('button', { name: 'Delete Ram Sharma' }))
  const dialog = await dialogNamed("Delete Ram Sharma's login?")
  jest.useFakeTimers()
  try {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete login' }))
    // Busy, not disabled (S852): ConfirmModal keeps focus on the pressed button.
    const busy = within(dialog).getByRole('button', { name: 'Deleting…' })
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    await act(async () => { jest.advanceTimersByTime(CONFIRM_TIMEOUT_MS) })
    expect(screen.queryByRole('dialog', { name: "Delete Ram Sharma's login?" })).toBeNull()
    expect(screen.getByText(CONFIRM_TIMEOUT_TEXT)).toBeInTheDocument()
  } finally {
    jest.useRealTimers()
  }
})

// Delete Client read the logins without its error (S852): on a failed read the loop removed nobody,
// the data was cleared anyway, and the final delete was refused under a message saying every login
// had gone. It stops now, before the first delete, and says nothing was changed.
it('Delete Client stops before deleting anything when the logins cannot be read (S852)', async () => {
  runBackup.mockResolvedValue({ location: 'CrestBackups/Casa Acai', manifest: { totalRows: 10 }, method: 'folder' })
  await openDanger()
  fireEvent.click(screen.getByRole('button', { name: 'Delete Client' }))
  const dialog = await dialogNamed('Permanently DELETE this client?')
  fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'Casa Acai' } })
  mockProfilesError = { message: 'TypeError: Failed to fetch' }
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Client' }))
  expect(await screen.findByText(/so nothing was deleted: every login and all of its data are as they were/)).toBeInTheDocument()
  expect(runBackup).toHaveBeenCalledTimes(1)
  expect(adminOp).not.toHaveBeenCalled()
  expect(mockWrites.filter(w => w.op === 'delete')).toEqual([])
})

// The Users tab printed `'Could not create user: ' + err.message` (S852): the consequence leads now
// and the library string is fine print under it.
// What adminOp throws (S852): supabase-js' name and the original error ride along as `cause`.
function opError(message, name = 'FunctionsHttpError') {
  const e = new Error(message)
  e.name = name
  e.cause = { name, message: 'Edge Function returned a non-2xx status code' }
  return e
}

it('a login that could not be created says so, with the raw reason as fine print (S852)', async () => {
  adminOp.mockRejectedValue(opError('Edge Function returned a non-2xx status code'))
  renderDrawer()
  fireEvent.change(screen.getByLabelText('Email *'), { target: { value: 'new@casa.com' } })
  fireEvent.change(screen.getByLabelText('Password *'), { target: { value: 'long-enough-1' } })
  fireEvent.click(screen.getByRole('button', { name: '+ Create User' }))
  expect(await screen.findByText('The login was not created.')).toHaveClass('action-error-text')
  expect(screen.getByText('Edge Function returned a non-2xx status code')).toHaveClass('action-error-detail')
  expect(screen.queryByText(/Could not create user/)).toBeNull()
})

// Archive is two steps (S852). A clear that stops part-way must say so, leave the account unlocked
// rather than lock a half-cleared outlet, and keep the table it stopped at as fine print.
it('an Archive whose clear stops says what is left, and does not lock the account (S852)', async () => {
  runBackup.mockResolvedValue({ location: 'CrestBackups/Casa Acai', manifest: { totalRows: 10 }, method: 'folder' })
  adminOp.mockRejectedValue(opError('Failed to delete purchase_entries: update or delete violates foreign key constraint'))
  await openDanger()
  fireEvent.click(screen.getByRole('button', { name: 'Archive Client' }))
  const dialog = await dialogNamed('Archive this client?')
  fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'Casa Acai' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Archive Client' }))
  const text = await screen.findByText(/^Archive did not finish\. Clearing the data of Casa Acai stopped partway/)
  expect(text).toHaveClass('action-error-text')
  expect(text).toHaveTextContent('The account is not locked yet')
  expect(screen.getByText(/Failed to delete purchase_entries/)).toHaveClass('action-error-detail')
  expect(adminOp).toHaveBeenCalledWith('deleteClientData', { clientId: 'c1', keep_staff_vault: true })
  expect(mockWrites.filter(w => w.table === 'clients')).toEqual([])
})

// The Staff PINs tab printed the reveal error raw (S852).
it('a PIN that could not be revealed says so, with the raw reason as fine print (S852)', async () => {
  mockUsers = [{ id: 'u1', full_name: 'Ram Sharma', pos_email: 'ram@pos.internal', hr_self_service: false }]
  mockVault = [{ user_id: 'u1', updated_at: '2026-10-01T10:00:00+00:00' }]
  adminOp.mockRejectedValue(opError('Forbidden'))
  renderDrawer()
  fireEvent.click(screen.getByRole('tab', { name: 'Staff PINs' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Reveal' }))
  expect(await screen.findByText('The PIN was not shown.')).toHaveClass('action-error-text')
  expect(screen.getByText('Forbidden')).toHaveClass('action-error-detail')
})

// The restore printed `'error:' + err.message` (S852). Before its first insert nothing can have been
// restored and the refusal is its own sentence; after it, part of the backup may be in, and a restore
// will not run again over a client that holds data, so the message says to look, then clear.
describe('a restore that stops', () => {
  // The change is fired by each test right before its findBy, never awaited in between: an await
  // there lets the restore run its updates outside act.
  async function openRestore() {
    renderDrawer()
    fireEvent.click(screen.getByRole('tab', { name: 'Backup' }))
    return screen.findByLabelText('Backup file to restore')
  }
  const choose = (input, contents) =>
    fireEvent.change(input, { target: { files: [{ name: 'casa.json', text: async () => contents }] } })
  const backup = JSON.stringify({ manifest: { schema: 'crest-client-export' }, data: {} })

  it('before any row says nothing was restored, and why', async () => {
    restoreClientData.mockRejectedValue(new Error('This client already has data (3 rows in items). Restore only into an empty client.'))
    choose(await openRestore(), backup)
    expect(await screen.findByText('Nothing was restored into Casa Acai. This client already has data (3 rows in items). Restore only into an empty client.'))
      .toHaveClass('action-error-text')
  })

  it('partway says part of the backup may be in, and to look and clear before restoring again', async () => {
    restoreClientData.mockImplementation(async (_id, _parsed, { onProgress }) => {
      onProgress('items', 1, 60)
      throw new TypeError('Cannot read properties of undefined')
    })
    choose(await openRestore(), backup)
    const text = await screen.findByText(/^The restore into Casa Acai stopped partway: some of the backup may already be in/)
    expect(text).toHaveTextContent('Clear Client Data on the Danger tab')
    expect(screen.getByText(/Cannot read properties of undefined/)).toHaveClass('action-error-detail')
    expect(screen.queryByText(/Nothing was restored/)).toBeNull()
  })

  it('an unreadable file says nothing was restored and which file to choose', async () => {
    choose(await openRestore(), 'not json at all')
    expect(await screen.findByText(/^That file could not be read as a Crest backup, so nothing was restored\./)).toBeInTheDocument()
    expect(restoreClientData).not.toHaveBeenCalled()
  })
})
