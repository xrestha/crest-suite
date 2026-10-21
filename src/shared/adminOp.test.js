/**
 * adminOp keeps what KIND of failure it rethrows (S852). It used to throw a bare Error carrying only
 * a message, so a request that got no answer at all could be told from a refusal only by matching
 * the words "Failed to send a request". The name and the original error now ride along; the
 * message, the refusal's own words and its `code` are unchanged, which is what every caller reads.
 */
const mockInvoke = jest.fn()
jest.mock('../supabaseClient', () => ({ supabase: { functions: { invoke: (...a) => mockInvoke(...a) } } }))

// eslint-disable-next-line import/first
import { adminOp } from './adminOp'

function fnError(name, message, context) {
  const e = new Error(message)
  e.name = name
  e.context = context
  return e
}

beforeEach(() => mockInvoke.mockReset())

test('a refusal keeps its own words, its code, and supabase-js as the cause', async () => {
  const original = fnError('FunctionsHttpError', 'Edge Function returned a non-2xx status code', {
    status: 409, json: async () => ({ error: 'Rita has recorded bills at the till', code: 'pos_login_has_records' }),
  })
  mockInvoke.mockResolvedValue({ data: null, error: original })
  const err = await adminOp('delete_pos_staff', { userId: 'u1' }).catch(e => e)
  expect(err.message).toBe('Rita has recorded bills at the till')
  expect(err.code).toBe('pos_login_has_records')
  expect(err.name).toBe('FunctionsHttpError')
  expect(err.cause).toBe(original)
})

test('no answer at all keeps the FunctionsFetchError name', async () => {
  const original = fnError('FunctionsFetchError', 'Failed to send a request to the Edge Function', new TypeError('Failed to fetch'))
  mockInvoke.mockResolvedValue({ data: null, error: original })
  const err = await adminOp('deleteUser', { userId: 'u1' }).catch(e => e)
  expect(err.name).toBe('FunctionsFetchError')
  expect(err.message).toBe('Failed to send a request to the Edge Function')
  expect(err.cause).toBe(original)
})

test('an error in a 2xx body is the server speaking, with its code', async () => {
  mockInvoke.mockResolvedValue({ data: { error: 'Forbidden', code: 'not_admin' }, error: null })
  const err = await adminOp('deleteUser', { userId: 'u1' }).catch(e => e)
  expect(err.message).toBe('Forbidden')
  expect(err.code).toBe('not_admin')
  expect(err.cause).toBeUndefined()
})

test('a success returns the body', async () => {
  mockInvoke.mockResolvedValue({ data: { success: true }, error: null })
  await expect(adminOp('deleteUser', { userId: 'u1' })).resolves.toEqual({ success: true })
  expect(mockInvoke).toHaveBeenCalledWith('admin-user-ops', { body: { action: 'deleteUser', userId: 'u1' } })
})
