import { errorInfo, errorText } from './errorText'

describe('errorText', () => {
  it('names the offline case from the bare TypeError supabase-js surfaces', () => {
    expect(errorText(new TypeError('Failed to fetch'), 'operator')).toMatch(/connection dropped/i)
    expect(errorText({ message: 'NetworkError when attempting to fetch resource.' }, 'operator')).toMatch(/couldn't reach the server/i)
  })

  it('never claims a failed write did not land — the response can be lost after the commit', () => {
    const text = errorText(new TypeError('Failed to fetch'), 'operator')
    expect(text).not.toMatch(/nothing was saved|not saved|wasn't saved/i)
  })

  it('speaks to the audience: the same failure, two different next steps', () => {
    const err = { code: 'PGRST202', message: 'Could not find the function in the schema cache' }
    expect(errorText(err, 'staff')).toMatch(/tell your manager/i)
    expect(errorText(err, 'operator')).toMatch(/migration/i)
    expect(errorText(err, 'operator')).not.toMatch(/tell your manager/i)
  })

  it('defaults to the staff wording, and treats an unknown audience as staff', () => {
    const err = { code: '42501' }
    expect(errorText(err)).toBe(errorText(err, 'staff'))
    expect(errorText(err, 'nonsense')).toBe(errorText(err, 'staff'))
  })

  it('recognises a duplicate key', () => {
    expect(errorText({ code: '23505', message: 'duplicate key value violates unique constraint' }, 'operator'))
      .toMatch(/already exists/i)
  })

  it('does not say "try again" for a value the database rejected', () => {
    expect(errorText({ code: '23514' }, 'operator')).toMatch(/fail the same way/i)
  })

  it('keeps the technical detail alongside, never in the headline', () => {
    const { text, detail } = errorInfo({ code: 'PGRST202', message: 'schema cache miss' }, 'operator')
    expect(detail).toBe('PGRST202 · schema cache miss')
    expect(text).not.toMatch(/PGRST202/)
  })

  it('accepts a bare string or nothing at all without throwing', () => {
    expect(errorInfo('boom', 'operator').text).toBe(errorInfo(null, 'operator').text)
    expect(errorInfo(null).detail).toBe('')
  })
})
