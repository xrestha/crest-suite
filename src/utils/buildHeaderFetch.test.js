import { makeBuildHeaderFetch, BUILD_HEADER, TILL_TOO_OLD_CODE } from './buildHeaderFetch'

const REST_URL = 'https://x.supabase.co/rest/v1/rpc/save_pos_order_items'
const AUTH_URL = 'https://x.supabase.co/auth/v1/token?grant_type=refresh_token'
const FN_URL = 'https://x.supabase.co/functions/v1/pos-staff-login'
const STORAGE_URL = 'https://x.supabase.co/storage/v1/object/logos/a.png'

// A response with just enough of fetch's Response for the wrapper: status and clone().text().
const reply = (status, body = '') => ({ status, ok: status < 400, clone: () => ({ text: () => Promise.resolve(body) }) })
const flush = () => new Promise(r => setTimeout(r, 0))

describe('makeBuildHeaderFetch', () => {
  test('adds the build to a database call and keeps the headers it was given', async () => {
    const seen = []
    const f = makeBuildHeaderFetch((input, init) => { seen.push({ input, init }); return Promise.resolve(reply(200)) }, 'crest-v413')
    await f(REST_URL, { method: 'POST', headers: { apikey: 'k', Authorization: 'Bearer t' } })
    expect(seen[0].init.headers).toEqual({ apikey: 'k', Authorization: 'Bearer t', [BUILD_HEADER]: 'crest-v413' })
    expect(seen[0].init.method).toBe('POST')
  })

  test('works with headers given as pairs, and replaces a build already there', async () => {
    const seen = []
    const f = makeBuildHeaderFetch((input, init) => { seen.push(init); return Promise.resolve(reply(200)) }, 'crest-v413')
    await f(REST_URL, { headers: [['apikey', 'k'], [BUILD_HEADER, 'crest-v1']] })
    expect(seen[0].headers).toEqual([['apikey', 'k'], [BUILD_HEADER, 'crest-v413']])
  })

  test('leaves sign-in, Edge Function and Storage calls untouched', async () => {
    // An Edge Function's CORS list would refuse the preflight for a header it does not name.
    const seen = []
    const f = makeBuildHeaderFetch((input, init) => { seen.push(init); return Promise.resolve(reply(200)) }, 'crest-v413')
    const init = { headers: { apikey: 'k' } }
    for (const url of [AUTH_URL, FN_URL, STORAGE_URL]) await f(url, init)
    expect(seen).toEqual([init, init, init])
  })

  test('passes a Request object through, since new headers would replace its own', async () => {
    const seen = []
    const f = makeBuildHeaderFetch((input, init) => { seen.push({ input, init }); return Promise.resolve(reply(200)) }, 'crest-v413')
    const request = { url: REST_URL, headers: { apikey: 'k' } }
    await f(request, {})
    expect(seen[0]).toEqual({ input: request, init: {} })
  })

  test('reports a too-old refusal, and nothing else', async () => {
    let told = 0
    const bodies = [
      [400, `{"code":"P0001","message":"${TILL_TOO_OLD_CODE}: this page runs crest-v412","hint":"${TILL_TOO_OLD_CODE}"}`],
      [400, '{"code":"P0001","message":"stale_order: changed on another device","hint":"stale_order"}'],
      [200, `[{"note":"${TILL_TOO_OLD_CODE}"}]`],
      [500, `{"message":"${TILL_TOO_OLD_CODE}"}`],
    ]
    for (const [status, body] of bodies) {
      const f = makeBuildHeaderFetch(() => Promise.resolve(reply(status, body)), 'crest-v413', () => { told += 1 })
      const res = await f(REST_URL, {})
      expect(res.status).toBe(status)
    }
    await flush()
    expect(told).toBe(1)
  })
})
