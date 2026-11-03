import {
  scrubText,
  cleanUrl,
  areaOfPath,
  keepBreadcrumb,
  scrubEvent,
  monitoringEnabled,
  reportCrash,
} from './monitoring'

// Privacy Policy v1.1 §4 promises that email addresses and phone numbers are removed before an error
// report leaves the device. These tests are that promise; a change that fails one changes the policy.

describe('scrubText', () => {
  it('removes email addresses', () => {
    expect(scrubText('No login for ram.thapa@example.com.np here')).toBe('No login for [email] here')
  })

  it('removes Nepali mobile numbers, written together or in groups', () => {
    expect(scrubText('phone 9812345678 taken')).toBe('phone [phone] taken')
    expect(scrubText('phone 981-234-5678 taken')).toBe('phone [phone] taken')
    expect(scrubText('phone 981 234 5678 taken')).toBe('phone [phone] taken')
  })

  it('removes any run of seven or more digits (landlines, PAN, accounts)', () => {
    expect(scrubText('Key (pan)=(623688353) already exists')).toBe('Key (pan)=([number]) already exists')
    expect(scrubText('call 01-4123456')).toBe('call 01-[number]')
  })

  it('removes credential-shaped text', () => {
    expect(scrubText('token=abc123 failed')).toBe('token: [redacted] failed')
    expect(scrubText('jwt aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc end')).toBe('jwt [redacted] end')
  })

  it('keeps what a fault needs: dates, amounts, line numbers, plain words', () => {
    const text = "Cannot read properties of undefined (reading 'qty') at 2083-07-17, NPR 12,676, line 1234:56"
    expect(scrubText(text)).toBe(text)
  })

  it('passes a non-string through untouched', () => {
    expect(scrubText(undefined)).toBeUndefined()
    expect(scrubText(42)).toBe(42)
  })
})

describe('cleanUrl', () => {
  it('drops the query string and fragment, where PostgREST puts every filter', () => {
    expect(cleanUrl('https://x.supabase.co/rest/v1/pos_customers?phone=eq.9812345678&select=*'))
      .toBe('https://x.supabase.co/rest/v1/pos_customers')
    expect(cleanUrl('/pos/orders?table=5#top')).toBe('/pos/orders')
  })

  it('keeps only the bucket of a storage address', () => {
    expect(cleanUrl('https://x.supabase.co/storage/v1/object/public/dish-photos/abc/momo.jpg'))
      .toBe('https://x.supabase.co/storage/v1/object/public/dish-photos/…')
    expect(cleanUrl('https://x.supabase.co/storage/v1/object/sign/hr-docs/emp/cv.pdf?token=1'))
      .toBe('https://x.supabase.co/storage/v1/object/sign/hr-docs/…')
  })

  it('never carries the body of a data or blob address', () => {
    expect(cleanUrl('data:image/png;base64,AAAA')).toBe('data:…')
    expect(cleanUrl('blob:https://app/123')).toBe('blob:…')
  })
})

describe('areaOfPath', () => {
  it('names the first path segment', () => {
    expect(areaOfPath('/pos/orders')).toBe('pos')
    expect(areaOfPath('/items')).toBe('items')
    expect(areaOfPath('/')).toBe('home')
  })
})

describe('keepBreadcrumb', () => {
  it('drops clicks and console lines', () => {
    expect(keepBreadcrumb({ category: 'ui.click', message: 'button[title="Edit Ram"]' })).toBeNull()
    expect(keepBreadcrumb({ category: 'console', message: 'saved 9812345678' })).toBeNull()
  })

  it('keeps a request by address only', () => {
    const crumb = keepBreadcrumb({
      category: 'fetch',
      data: { method: 'GET', url: 'https://x.supabase.co/rest/v1/members?phone=eq.98', status_code: 200, request_body_size: 9 },
    })
    expect(crumb.data).toEqual({ method: 'GET', url: 'https://x.supabase.co/rest/v1/members', status_code: 200 })
  })

  it('keeps a page move without its query string', () => {
    const crumb = keepBreadcrumb({ category: 'navigation', data: { from: '/a?x=1', to: '/b#y' } })
    expect(crumb.data).toEqual({ from: '/a', to: '/b' })
  })
})

describe('scrubEvent', () => {
  it('drops a stale-deploy chunk failure: a deploy, not a crash', () => {
    const err = new Error('Loading chunk 123 failed.')
    err.name = 'ChunkLoadError'
    expect(scrubEvent({ exception: { values: [] } }, { originalException: err })).toBeNull()
    expect(scrubEvent({ exception: { values: [{ type: 'TypeError', value: 'Failed to fetch dynamically imported module: /x.js' }] } }, {})).toBeNull()
  })

  it('strips the request, the user and the messages down to what the policy allows', () => {
    const out = scrubEvent({
      request: {
        url: 'https://app.example/pos/orders?member=9812345678',
        headers: { 'User-Agent': 'UA', Referer: 'https://app.example/x?q=1' },
        cookies: { a: 'b' },
      },
      user: { id: 'uuid-1', email: 'a@b.co', ip_address: '1.2.3.4' },
      exception: {
        values: [{
          type: 'Error',
          value: 'No member a@b.co with 9812345678',
          stacktrace: { frames: [{ filename: 'https://app.example/static/js/main.abc.js?v=1' }] },
        }],
      },
      breadcrumbs: [{ category: 'console', message: 'x' }, { category: 'navigation', data: { from: '/a?x', to: '/b' } }],
      extra: { __serialized__: { message: 'dup', details: 'Key (phone)=(9812345678) exists' } },
    }, {})

    expect(out.request).toEqual({ url: 'https://app.example/pos/orders', headers: { 'User-Agent': 'UA' } })
    expect(out.user).toEqual({ id: 'uuid-1' })
    expect(out.exception.values[0].value).toBe('No member [email] with [phone]')
    expect(out.exception.values[0].stacktrace.frames[0].filename).toBe('https://app.example/static/js/main.abc.js')
    expect(out.breadcrumbs).toEqual([{ category: 'navigation', data: { from: '/a', to: '/b' } }])
    expect(out.extra.__serialized__.details).toBe('Key (phone)=([phone]) exists')
    expect(out.tags.area).toBeDefined()
  })

  it('sends no user at all when none is signed in', () => {
    expect(scrubEvent({ exception: { values: [] } }, {}).user).toBeUndefined()
  })
})

describe('outside the deployed app', () => {
  it('is off under Jest, so nothing is queued or sent', () => {
    expect(monitoringEnabled()).toBe(false)
    expect(() => reportCrash(new Error('boom'), 'at Page')).not.toThrow()
  })
})
