/**
 * The client drawer's Users tab says what a failed login action left behind (S852). It used to
 * print `'Could not create user: ' + err.message`, so the operator read a library string where the
 * consequence belonged. The consequence leads, raw words are fine print, and a failure with no
 * answer from the server claims nothing about whether the action landed.
 */
import { loginOpFailure, loginWriteFailure, withDetail, gotNoAnswer } from './loginOpError'
import { NO_ANSWER_TEXT } from '../../shared/edgeFunctionError'

// What adminOp throws (S852): the message it could read, supabase-js' error name, and the original as `cause`.
function opError(message, name = 'FunctionsHttpError', causeMessage = 'Edge Function returned a non-2xx status code') {
  const e = new Error(message)
  e.name = name
  e.cause = { name, message: causeMessage }
  return e
}

describe('loginOpFailure (adminOp threw)', () => {
  it('leads with the consequence and follows it with a refusal written for a person', () => {
    const r = loginOpFailure('The login was not created', new Error('This password has appeared in a known data breach'))
    expect(r.text).toBe('The login was not created. This password has appeared in a known data breach.')
    expect(r.detail).toBe('')
  })

  it.each([
    ['Forbidden', opError('Forbidden')],
    ['client_id required', opError('client_id required')],
    ['a body adminOp could not read', opError('Edge Function returned a non-2xx status code')],
  ])('keeps a developer string (%s) out of the headline', (_, err) => {
    const r = loginOpFailure('The login was not deleted, and its email stays in use.', err)
    expect(r.text).toBe('The login was not deleted, and its email stays in use.')
    expect(r.detail).toBe(err.message)
  })

  it('claims nothing when the request got no answer, known by its name rather than its words', () => {
    const err = opError('Failed to send a request to the Edge Function', 'FunctionsFetchError', 'Failed to send a request to the Edge Function')
    expect(gotNoAnswer(err)).toBe(true)
    const r = loginOpFailure('The password was not changed', err)
    expect(r.text).toBe(NO_ANSWER_TEXT)
    expect(r.text).not.toMatch(/not changed/)
    expect(r.detail).toBe(err.message)
  })

  it('a refusal whose words mention a request is still a refusal', () => {
    expect(gotNoAnswer(opError('Failed to send a request to the bank'))).toBe(false)
  })
})

describe('loginWriteFailure (a profiles write returned an error)', () => {
  it('states the consequence of a refusal, which rolled back, with the code as fine print', () => {
    const r = loginWriteFailure('x@casa.com was not moved', { code: '42501', message: 'permission denied for table profiles' })
    expect(r.text).toBe('x@casa.com was not moved.')
    expect(r.detail).toBe('42501 · permission denied for table profiles')
  })

  it('does not say the move failed when the answer was lost', () => {
    const r = loginWriteFailure('x@casa.com was not moved', { message: 'TypeError: Failed to fetch' })
    expect(r.text).toBe(NO_ANSWER_TEXT)
  })
})

it('withDetail keeps the sentence as written and the error as fine print', () => {
  expect(withDetail('Could not check that email, so nothing was changed.', { code: 'PGRST301', message: 'JWT expired' }))
    .toEqual({ text: 'Could not check that email, so nothing was changed.', detail: 'PGRST301 · JWT expired' })
  expect(withDetail('Plain.', null)).toEqual({ text: 'Plain.', detail: '' })
})
