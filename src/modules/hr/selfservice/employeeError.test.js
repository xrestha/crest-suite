import { employeeError, employeeErrorText } from './employeeError'

describe('employeeError', () => {
  it('names the offline case from the bare TypeError supabase-js surfaces', () => {
    expect(employeeErrorText(new TypeError('Failed to fetch'))).toMatch(/offline/i)
    expect(employeeErrorText({ message: 'NetworkError when attempting to fetch resource.' })).toMatch(/offline/i)
  })

  it('sends an unapplied migration to the manager instead of telling the employee to retry', () => {
    const text = employeeErrorText({ code: 'PGRST202', message: 'Could not find the function public.get_my_hr_payslips in the schema cache' })
    expect(text).toMatch(/tell your manager/i)
    expect(text).not.toMatch(/try again/i)
  })

  it('recognises an ended session', () => {
    expect(employeeErrorText({ code: 'PGRST301' })).toMatch(/session has ended/i)
    expect(employeeErrorText({ message: 'JWT expired' })).toMatch(/session has ended/i)
  })

  it('recognises self-service access that was never set up', () => {
    expect(employeeErrorText({ message: 'not authorized' })).toMatch(/self-service access/i)
  })

  it('recognises an RLS refusal', () => {
    expect(employeeErrorText({ code: '42501' })).toMatch(/not allowed/i)
  })

  it('does not say "try again" for a value the database rejected — the same input fails the same way', () => {
    const text = employeeErrorText({ code: '23514', message: 'new row violates check constraint' })
    expect(text).toMatch(/check the dates and amounts/i)
  })

  it('falls back honestly rather than guessing at an unrecognised shape', () => {
    expect(employeeErrorText({ code: '99999', message: 'something new' })).toMatch(/keeps happening/i)
  })

  it('keeps the technical detail alongside, never in the headline', () => {
    const { text, detail } = employeeError({ code: 'PGRST202', message: 'schema cache miss' })
    expect(detail).toBe('PGRST202 · schema cache miss')
    expect(text).not.toMatch(/PGRST202/)
  })

  it('accepts a bare string or nothing at all without throwing', () => {
    expect(employeeError('boom').text).toBe(employeeError(null).text)
    expect(employeeError(null).detail).toBe('')
    expect(employeeError(undefined).text).toMatch(/keeps happening/i)
  })
})
