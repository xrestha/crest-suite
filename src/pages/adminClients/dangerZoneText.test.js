/**
 * The Danger tab says what a stopped destructive action left behind (S852): what was erased, what
 * was not, and what to press next, with the raw text as fine print. A failure with no answer from
 * the server never says how far it got, and no message says a failed delete did not happen.
 */
import { clearStopped, archiveLockFailed, loginsStopped, deleteStageFailed, dangerUnexpected, restoreStopped, KEEP_BACKUP } from './dangerZoneText'

function opError(message, name = 'FunctionsHttpError') {
  const e = new Error(message)
  e.name = name
  e.cause = { name, message: 'Edge Function returned a non-2xx status code' }
  return e
}
const refused = opError('Failed to delete purchase_entries: update or delete violates foreign key constraint')
const unanswered = opError('Failed to send a request to the Edge Function', 'FunctionsFetchError')

describe('clearStopped', () => {
  const args = { what: 'the data of Casa', button: 'Clear Client Data', kept: 'Logins, settings and the client record are kept.' }

  it('a refusal says the clear is part-done, what is kept, to keep the first backup, and that retry carries on', () => {
    const r = clearStopped({ ...args, err: refused })
    expect(r.text).toMatch(/^Clearing the data of Casa stopped partway: some of it may already be erased, and the rest is still there\./)
    expect(r.text).toContain('Logins, settings and the client record are kept.')
    expect(r.text).toContain(KEEP_BACKUP)
    expect(r.text).toContain('Press Clear Client Data again to carry on.')
    expect(r.text).toMatch(/same place again/)
    expect(r.text).not.toContain('purchase_entries')
    expect(r.detail).toContain('Failed to delete purchase_entries')
  })

  it('no answer says it is not known how much was erased, and offers no blind retry', () => {
    const r = clearStopped({ ...args, prefix: 'Archive did not finish. ', err: unanswered })
    expect(r.text).toMatch(/^Archive did not finish\. No answer came back while clearing the data of Casa, so it is not known how much was erased\./)
    expect(r.text).toContain('Reload the page and look at this client before pressing Clear Client Data again.')
    expect(r.text).not.toMatch(/stopped partway|carry on/)
  })
})

it('a lock that did not confirm says the data is gone and the logins may still sign in', () => {
  const r = archiveLockFailed('Casa', { code: '42501', message: 'permission denied' })
  expect(r.text).toMatch(/^The data of Casa was cleared and its logins kept, but locking the account could not be confirmed/)
  expect(r.text).toContain('Deactivate on its card')
  expect(r.detail).toBe('42501 · permission denied')
})

it('a stopped login loop names who could not be confirmed and that the data was not touched', () => {
  const r = loginsStopped('Casa', 2, 4, [{ name: 'Ram', err: refused }, { name: 'Sita', err: unanswered }])
  expect(r.text).toMatch(/^Delete Client stopped after removing 2 of 4 logins of Casa\. Its data and the client record were not touched\./)
  expect(r.text).toContain('These logins could not be confirmed as removed: Ram, Sita.')
  expect(r.text).toContain('may be gone already')
  expect(r.text).toContain('a login already removed is not tried again')
  expect(r.detail).toMatch(/^Ram: .*; Sita: /)
})

describe('deleteStageFailed', () => {
  it('a part-done data clear after every login went keeps the clear wording', () => {
    const r = deleteStageFailed('Casa', 'operational data', refused)
    expect(r.text).toMatch(/^Every login was removed\. Clearing the data of Casa stopped partway/)
    expect(r.text).toContain('The client record is still there.')
  })

  it('a later stage says what is still there and to press Delete Client again', () => {
    const r = deleteStageFailed('Casa', 'settings', { message: 'TypeError: Failed to fetch' })
    expect(r.text).toMatch(/deleting its settings could not be confirmed, so the client record is still there/)
    expect(r.text).toContain('Press Delete Client again to finish.')
  })

  it('the record itself sends the operator to look before pressing again', () => {
    const r = deleteStageFailed('Casa', 'the client record', { message: 'TypeError: Failed to fetch' })
    expect(r.text).toMatch(/deleting the client record itself could not be confirmed\. Reload Admin → Clients: if Casa is still listed/)
  })
})

it('an unexpected error claims nothing about how far it got', () => {
  const r = dangerUnexpected('Casa', new TypeError('x is undefined'))
  expect(r.text).toMatch(/before it could say how far it got/)
  expect(r.detail).toBe('x is undefined')
})

it('no message says a failed delete did not happen', () => {
  const all = [
    clearStopped({ what: 'w', button: 'b', kept: 'k', err: refused }),
    clearStopped({ what: 'w', button: 'b', kept: 'k', err: unanswered }),
    archiveLockFailed('Casa', unanswered),
    loginsStopped('Casa', 0, 1, [{ name: 'Ram', err: unanswered }]),
    deleteStageFailed('Casa', 'settings', unanswered),
    deleteStageFailed('Casa', 'the client record', unanswered),
    dangerUnexpected('Casa', unanswered),
  ]
  for (const { text } of all) expect(text).not.toMatch(/nothing was (deleted|erased|saved)|was not (deleted|erased)/i)
})

describe('restoreStopped', () => {
  it('an unreadable file restored nothing', () => {
    const r = restoreStopped({ clientName: 'Casa', stage: 'file', started: false, err: new SyntaxError('Unexpected token n') })
    expect(r.text).toMatch(/^That file could not be read as a Crest backup, so nothing was restored\./)
    expect(r.detail).toBe('Unexpected token n')
  })

  it('a refusal before the first row keeps its own sentence as the reason', () => {
    const r = restoreStopped({ clientName: 'Casa', stage: 'restore', started: false, err: new Error('Not a Crest client export file.') })
    expect(r).toEqual({ text: 'Nothing was restored into Casa. Not a Crest client export file.', detail: '' })
  })

  it('after the first row never says nothing landed, and sends the operator to look, then clear', () => {
    const r = restoreStopped({ clientName: 'Casa', stage: 'restore', started: true, err: { message: 'TypeError: Failed to fetch' } })
    expect(r.text).toMatch(/stopped partway: some of the backup may already be in/)
    expect(r.text).toContain('Clear Client Data')
    expect(r.text).not.toMatch(/nothing was restored/i)
  })

  it('after the data, it says the data is in and the logins need looking at', () => {
    const r = restoreStopped({ clientName: 'Casa', stage: 'logins', started: true, err: new TypeError('x') })
    expect(r.text).toMatch(/^The backup was restored into Casa, but the staff-login steps after it stopped/)
  })
})
