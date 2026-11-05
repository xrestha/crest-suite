import { renderHook, act, waitFor } from '@testing-library/react'
import { useAutoPurgeBackup } from './useAutoPurgeBackup'
import { runBackup } from './runBackup'
import { ensureBackupDirectory } from './backupDirectory'

jest.mock('./runBackup', () => ({ runBackup: jest.fn() }))
jest.mock('./backupDirectory', () => ({ ensureBackupDirectory: jest.fn() }))

// S890: the pre-purge backup effect listed `busy` and cancelled itself on cleanup, so the
// setBusy(true) that started a backup also cancelled it: the banner stayed on "Backing up…" and the
// list never reloaded. And it was keyed on the pending COUNT, so after "Choose backup folder…"
// granted permission the list reload changed nothing and the backup never started.

const HOUR = 3600_000
const trial = (id, name) => ({
  id, name, is_trial: true,
  trial_purge_at: new Date(Date.now() + 24 * HOUR).toISOString(),
  trial_expires_at: new Date(Date.now() - 24 * HOUR).toISOString(),
  last_backup_at: null,
})

const flush = async () => { await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }) }

beforeEach(() => {
  runBackup.mockReset()
  ensureBackupDirectory.mockReset()
})

test('a backup that starts finishes: the banner leaves "Backing up" and the list reloads once', async () => {
  ensureBackupDirectory.mockResolvedValue({ state: 'granted' })
  // A real export takes seconds, so the page re-renders with busy = true before it ends.
  let finish
  runBackup.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const onDone = jest.fn()
  const { result } = renderHook(p => useAutoPurgeBackup(p.clients, onDone), { initialProps: { clients: [trial('a', 'Alpha')] } })
  await waitFor(() => expect(result.current.busy).toBe(true))
  expect(result.current.message).toBe('Backing up Alpha before its purge deadline…')
  await act(async () => { finish() })
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
  expect(runBackup).toHaveBeenCalledTimes(1)
  expect(result.current.busy).toBe(false)
  expect(result.current.message).toBe('✓ Alpha backed up before its purge deadline.')
})

test('choosing a folder, then the list reload, starts the backup the banner was asking for', async () => {
  ensureBackupDirectory.mockResolvedValue({ state: 'prompt' })
  runBackup.mockResolvedValue(undefined)
  const onDone = jest.fn()
  const { result, rerender } = renderHook(p => useAutoPurgeBackup(p.clients, onDone), { initialProps: { clients: [trial('a', 'Alpha')] } })
  await waitFor(() => expect(result.current.blocked).toBe(true))
  expect(runBackup).not.toHaveBeenCalled()

  // The banner's button grants permission and AdminClients reloads its list: a new array, same rows.
  ensureBackupDirectory.mockResolvedValue({ state: 'granted' })
  rerender({ clients: [trial('a', 'Alpha')] })
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
  expect(runBackup).toHaveBeenCalledTimes(1)
  expect(result.current.blocked).toBe(false)
})

test('no loop: a re-render or a reload that still lists the same client does not back it up again', async () => {
  ensureBackupDirectory.mockResolvedValue({ state: 'granted' })
  runBackup.mockResolvedValue(undefined)
  const onDone = jest.fn()
  const clients = [trial('a', 'Alpha')]
  const { rerender } = renderHook(p => useAutoPurgeBackup(p.clients, onDone), { initialProps: { clients } })
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))

  rerender({ clients })                       // same list: the effect does not run at all
  await flush()
  const checks = ensureBackupDirectory.mock.calls.length
  rerender({ clients: [trial('a', 'Alpha')] }) // a reload where the stamp did not land
  await flush()
  expect(runBackup).toHaveBeenCalledTimes(1)
  expect(onDone).toHaveBeenCalledTimes(1)
  expect(ensureBackupDirectory.mock.calls.length).toBe(checks)
})

test('a reload during a backup does not start a second one', async () => {
  ensureBackupDirectory.mockResolvedValue({ state: 'granted' })
  let finish
  runBackup.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const onDone = jest.fn()
  const { result, rerender } = renderHook(p => useAutoPurgeBackup(p.clients, onDone), { initialProps: { clients: [trial('a', 'Alpha'), trial('b', 'Beta')] } })
  await waitFor(() => expect(result.current.busy).toBe(true))
  rerender({ clients: [trial('a', 'Alpha'), trial('b', 'Beta')] })
  await flush()
  expect(runBackup).toHaveBeenCalledTimes(1)

  await act(async () => { finish() })
  await waitFor(() => expect(result.current.busy).toBe(false))
  expect(onDone).toHaveBeenCalledTimes(1)
})

test('a failed backup says so and is not retried by the next reload', async () => {
  ensureBackupDirectory.mockResolvedValue({ state: 'granted' })
  runBackup.mockRejectedValue(new Error('disk full'))
  const onDone = jest.fn()
  const { result, rerender } = renderHook(p => useAutoPurgeBackup(p.clients, onDone), { initialProps: { clients: [trial('a', 'Alpha')] } })
  await waitFor(() => expect(result.current.message).toBe('Could not back up Alpha: disk full'))
  expect(result.current.busy).toBe(false)
  rerender({ clients: [trial('a', 'Alpha')] })
  await flush()
  expect(runBackup).toHaveBeenCalledTimes(1)
  expect(onDone).not.toHaveBeenCalled()
})
