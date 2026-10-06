import { edgeFunctionFailure, failedMovesMessage, isReadableServerMessage, NO_ANSWER_TEXT } from './edgeFunctionError'

const httpError = (status, body) => ({
  name: 'FunctionsHttpError',
  message: 'Edge Function returned a non-2xx status code',
  context: { status, json: async () => body },
})

describe('edgeFunctionFailure', () => {
  const lead = 'The password was not changed — the old one still works.'

  it('leads with the consequence and keeps a developer string as detail', async () => {
    const r = await edgeFunctionFailure(null, httpError(403, { error: 'Forbidden' }), lead)
    expect(r.text).toBe(lead)
    expect(r.detail).toBe('HTTP 403 · Forbidden')
    expect(r.network).toBe(false)
  })

  it('follows the consequence with a sentence the function wrote for a person', async () => {
    const r = await edgeFunctionFailure(null, httpError(400, { error: 'This password has appeared in a known data breach. Please choose a different one.' }), lead)
    expect(r.text).toBe(`${lead} This password has appeared in a known data breach. Please choose a different one.`)
    expect(r.detail).toBe('HTTP 400')
  })

  it('reads an error carried in a 2xx body', async () => {
    const r = await edgeFunctionFailure({ error: 'Employee not found' }, null, lead)
    expect(r.text).toBe(`${lead} Employee not found.`)
  })

  it('makes no claim when the request got no answer', async () => {
    const err = { name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function', context: new TypeError('Failed to fetch') }
    const r = await edgeFunctionFailure(null, err, lead)
    expect(r.text).toBe(NO_ANSWER_TEXT)
    expect(r.network).toBe(true)
    expect(r.detail).toMatch(/Failed to send/)
  })

  it('keeps the SDK message as detail when the body is unreadable', async () => {
    const err = { name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code', context: { status: 500, json: async () => { throw new Error('not json') } } }
    const r = await edgeFunctionFailure(null, err, '')
    expect(r.text).toBe("That didn't go through.")
    expect(r.detail).toBe('HTTP 500 · Edge Function returned a non-2xx status code')
  })

  it('tells a person-facing message from an identifier', () => {
    expect(isReadableServerMessage('Forbidden')).toBe(false)
    expect(isReadableServerMessage('client_id required')).toBe(false)
    expect(isReadableServerMessage('userId is required')).toBe(false)
    expect(isReadableServerMessage('PIN must be 4–6 digits')).toBe(true)
  })
})

describe('failedMovesMessage', () => {
  const refused = { p: { full_name: 'Sita' }, info: { network: false, serverText: '', detail: 'HTTP 403 · Forbidden' } }
  const unsure = { p: { full_name: 'Ram' }, info: { network: true, serverText: '', detail: 'Failed to send a request to the Edge Function' } }

  it('names a refused login apart from one that got no answer', () => {
    const r = failedMovesMessage([refused, unsure], { prefix: 'Saved the role, but ', fallback: 'Change their level individually.' })
    expect(r.text).toBe('Saved the role, but 1 login(s) could not be moved and keep their previous access: Sita. ' +
      '1 login(s) got no answer from the server and may or may not have moved: Ram. Reload the page to see their level. ' +
      'Change their level individually.')
    expect(r.detail).toBe('HTTP 403 · Forbidden')
  })

  it('claims nothing was kept when every failure was a lost answer', () => {
    const r = failedMovesMessage([unsure])
    expect(r.text).not.toMatch(/keep their previous access/)
    expect(r.text).toMatch(/may or may not have moved: Ram/)
  })
})
