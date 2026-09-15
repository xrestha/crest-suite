import fs from 'fs'
import path from 'path'
import {
  MAX_PHOTO_BYTES, photoRefusal, photoPath, versionedUrl, objectPathFromUrl, guestCanLoad,
  fitWithin, downscalePhoto, storageRefusal,
} from './dishPhoto'

const BASE = 'https://abcd.supabase.co'
const file = (type, size) => ({ type, size })

describe('photoRefusal', () => {
  it('accepts a JPG, PNG or WebP at or under 2 MB', () => {
    expect(photoRefusal(file('image/jpeg', MAX_PHOTO_BYTES))).toBeNull()
    expect(photoRefusal(file('image/png', 10))).toBeNull()
    expect(photoRefusal(file('image/webp', 10))).toBeNull()
  })
  it('refuses other types, including SVG', () => {
    expect(photoRefusal(file('image/svg+xml', 10))).toMatch(/not a JPG, PNG or WebP/)
    expect(photoRefusal(file('application/pdf', 10))).toMatch(/not a JPG, PNG or WebP/)
  })
  it('refuses over 2 MB and says how big it is', () => {
    expect(photoRefusal(file('image/jpeg', 3.4 * 1024 * 1024))).toMatch(/3\.4 MB and the limit is 2 MB/)
  })
})

describe('photoPath', () => {
  it('puts the client id first — the storage policy checks that folder', () => {
    expect(photoPath('client-1', 'rec-9', 'image/png', 123)).toBe('client-1/rec-9-123.png')
  })
  it('names an unsaved recipe "new" and derives the extension from the type', () => {
    expect(photoPath('client-1', null, 'image/jpeg', 5)).toBe('client-1/new-5.jpg')
    expect(photoPath('client-1', null, 'image/webp', 5)).toBe('client-1/new-5.webp')
  })
})

describe('versionedUrl', () => {
  it('appends a version, respecting an existing query', () => {
    expect(versionedUrl('https://x/a.jpg', 7)).toBe('https://x/a.jpg?v=7')
    expect(versionedUrl('https://x/a.jpg?t=1', 7)).toBe('https://x/a.jpg?t=1&v=7')
  })
})

describe('objectPathFromUrl', () => {
  const url = `${BASE}/storage/v1/object/public/dish-photos/client-1/rec-9-123.jpg?v=5`
  it('returns the path of our own bucket URL, query stripped', () => {
    expect(objectPathFromUrl(url, BASE)).toBe('client-1/rec-9-123.jpg')
  })
  it('never returns a path for anything we did not issue — those are never deleted', () => {
    expect(objectPathFromUrl('https://www.facebook.com/photo.jpg', BASE)).toBeNull()
    expect(objectPathFromUrl(`${BASE}/storage/v1/object/public/Logos/client-1/logo.png`, BASE)).toBeNull()
    expect(objectPathFromUrl('https://other.supabase.co/storage/v1/object/public/dish-photos/a/b.jpg', BASE)).toBeNull()
    expect(objectPathFromUrl('not a url', BASE)).toBeNull()
    expect(objectPathFromUrl('', BASE)).toBeNull()
  })
})

describe('guestCanLoad mirrors vercel.json img-src', () => {
  it('matches the deployed directive', () => {
    // If this fails, the CSP changed: update guestCanLoad() with it, or the link warning lies.
    const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../vercel.json'), 'utf8'))
    const csp = JSON.stringify(vercel)
    expect(csp).toMatch(/img-src 'self' data: blob: https:\/\/\*\.supabase\.co;/)
  })
  it('accepts Supabase storage and refuses other websites', () => {
    expect(guestCanLoad(`${BASE}/storage/v1/object/public/dish-photos/a/b.jpg`)).toBe(true)
    expect(guestCanLoad('https://scontent.xx.fbcdn.net/v/photo.jpg')).toBe(false)
    expect(guestCanLoad('https://drive.google.com/uc?id=1')).toBe(false)
    expect(guestCanLoad('https://i.imgur.com/a.jpg')).toBe(false)
    expect(guestCanLoad('http://abcd.supabase.co/a.jpg')).toBe(false)
    expect(guestCanLoad('https://evilsupabase.co/a.jpg')).toBe(false)
  })
})

describe('fitWithin', () => {
  it('never enlarges', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600, scaled: false })
  })
  it('scales the longest side to 1200, keeping the ratio', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1200, height: 900, scaled: true })
    expect(fitWithin(3000, 4000)).toEqual({ width: 900, height: 1200, scaled: true })
  })
})

describe('downscalePhoto', () => {
  const big = { type: 'image/jpeg', size: 4_000_000 }

  function env({ w = 4000, h = 3000, blob } = {}) {
    const ctx = { drawImage: jest.fn() }
    const canvas = { getContext: () => ctx, toBlob: (cb, type) => cb(blob === undefined ? { type, size: 300_000 } : blob) }
    return {
      ctx,
      createImageBitmap: jest.fn(async () => ({ width: w, height: h, close: jest.fn() })),
      document: { createElement: () => canvas },
      canvas,
    }
  }

  it('returns the original file when the browser cannot decode images', async () => {
    expect(await downscalePhoto(big, { createImageBitmap: null, document: null })).toBe(big)
  })
  it('returns the original when the photo is already small enough', async () => {
    const e = env({ w: 1000, h: 800 })
    expect(await downscalePhoto(big, e)).toBe(big)
  })
  it('re-encodes a large JPEG as a smaller JPEG at 1200px', async () => {
    const e = env()
    const out = await downscalePhoto(big, e)
    expect(out).toEqual({ type: 'image/jpeg', size: 300_000 })
    expect(e.ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1200, 900)
  })
  it('keeps PNG transparency by re-encoding as WebP', async () => {
    const out = await downscalePhoto({ type: 'image/png', size: 5_000_000 }, env())
    expect(out.type).toBe('image/webp')
  })
  it('discards a result the bucket would refuse, or one that is not smaller', async () => {
    expect(await downscalePhoto(big, env({ blob: { type: 'image/png', size: 10 } }))).toEqual({ type: 'image/png', size: 10 })
    const pngFallback = await downscalePhoto({ type: 'image/png', size: 5_000_000 }, env({ blob: { type: 'image/bmp', size: 10 } }))
    expect(pngFallback.size).toBe(5_000_000)
    expect(await downscalePhoto(big, env({ blob: { type: 'image/jpeg', size: 5_000_000 } }))).toBe(big)
  })
  it('returns the original if decoding throws', async () => {
    const e = env()
    e.createImageBitmap = jest.fn(async () => { throw new Error('bad image') })
    expect(await downscalePhoto(big, e)).toBe(big)
  })
})

describe('storageRefusal', () => {
  it('names the storage shapes this field can produce', () => {
    expect(storageRefusal({ statusCode: '413', message: 'The object exceeded the maximum allowed size' })).toMatch(/2 MB/)
    expect(storageRefusal({ statusCode: '415', message: 'mime type image/gif is not supported' })).toMatch(/JPG, PNG or WebP/)
    expect(storageRefusal({ statusCode: '404', message: 'Bucket not found' })).toMatch(/not set up/)
    expect(storageRefusal({ statusCode: '403', message: 'new row violates row-level security policy' })).toMatch(/not allowed/)
  })
  it('leaves anything else to the shared error table', () => {
    expect(storageRefusal({ message: 'TypeError: Failed to fetch' })).toBeNull()
    expect(storageRefusal(null)).toBeNull()
  })
})
