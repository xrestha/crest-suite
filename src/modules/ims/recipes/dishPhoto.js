// Dish photos stored inside Crest (S756, owner decision D16). Pure helpers behind DishPhotoField —
// kept apart from the component so the path, URL and size rules are tested without a DOM.
//
// Why an upload at all: the guest QR menu runs under vercel.json's Content-Security-Policy, whose
// `img-src` admits only 'self', data:, blob: and https://*.supabase.co. A pasted Facebook, Google
// Drive or Imgur link was saved happily and then rendered as a blank monogram tile on every
// guest's phone. A photo uploaded to the `dish-photos` bucket gets a URL the policy already allows.

export const DISH_PHOTO_BUCKET = 'dish-photos'

// Mirrors the bucket's own limits (migration 20260918150000). The bucket refuses anything else
// anyway; checking first is what lets the message be a sentence rather than a Storage error.
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024
export const PHOTO_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
export const PHOTO_ACCEPT = Object.keys(PHOTO_EXT).join(',')

// Longest side a guest's phone ever needs: the menu card draws the photo at 84px, and a detail
// view at full phone width is ~430 CSS px at 2–3x density. 1200 covers that with room to spare and
// takes a 12-megapixel phone photo from ~4 MB to a few hundred KB.
export const MAX_PHOTO_SIDE = 1200

/** Which of the refusals applies to a chosen file, or null if it may be uploaded as-is. */
export function photoRefusal(file) {
  if (!file) return 'No file was chosen.'
  if (!PHOTO_EXT[file.type]) {
    return 'That file is not a JPG, PNG or WebP photo. Save it as one of those and try again.'
  }
  if (file.size > MAX_PHOTO_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1)
    return `That photo is ${mb} MB and the limit is 2 MB. Take a smaller photo, or shrink it on your phone or computer, and try again.`
  }
  return null
}

/**
 * The object path inside the bucket. The first folder MUST be the client id — the storage
 * policies admit a write only into `<my_client_id()>/`. A fresh name per upload rather than a
 * stable one: nothing ever overwrites an object (so no upsert, which is what needs a SELECT policy
 * and is how the 2026-07 staff-photo bucket failed), and a replaced photo can never be served
 * stale from a cache under the old URL.
 */
export function photoPath(clientId, recipeId, mimeType, now = Date.now()) {
  const ext = PHOTO_EXT[mimeType] || 'jpg'
  const stem = recipeId ? String(recipeId) : 'new'
  return `${clientId}/${stem}-${now}.${ext}`
}

/** getPublicUrl() plus a version, per the S739 stable-path rule. */
export function versionedUrl(publicUrl, now = Date.now()) {
  return `${publicUrl}${publicUrl.includes('?') ? '&' : '?'}v=${now}`
}

/**
 * The object path of a URL this bucket issued, or null for anything else. Used before a delete,
 * so it is strict: only `/storage/v1/object/public/dish-photos/<path>`, query string stripped.
 * A pasted link, a Logos URL or another project's URL all return null and are never deleted.
 */
export function objectPathFromUrl(url, supabaseUrl) {
  if (!url || !supabaseUrl) return null
  let u, base
  try { u = new URL(url); base = new URL(supabaseUrl) } catch { return null }
  if (u.origin !== base.origin) return null
  const prefix = `/storage/v1/object/public/${DISH_PHOTO_BUCKET}/`
  if (!u.pathname.startsWith(prefix)) return null
  const path = decodeURIComponent(u.pathname.slice(prefix.length))
  return path || null
}

/**
 * Will a guest's phone load this URL? Mirrors vercel.json's img-src for an absolute URL, which is
 * the only thing a recipe stores. Kept as a mirror rather than a guess: if the CSP changes, this
 * is the line that must change with it, and `dishPhoto.test.js` names the directive.
 */
export function guestCanLoad(url) {
  if (!url) return true
  let u
  try { u = new URL(url) } catch { return false }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return true
  return u.protocol === 'https:' && (u.hostname === 'supabase.co' || u.hostname.endsWith('.supabase.co'))
}

/** Scale (w, h) to fit within `max` on its longest side; never enlarges. */
export function fitWithin(width, height, max = MAX_PHOTO_SIDE) {
  const w = Number(width) || 0
  const h = Number(height) || 0
  if (w <= 0 || h <= 0) return { width: w, height: h, scaled: false }
  const longest = Math.max(w, h)
  if (longest <= max) return { width: w, height: h, scaled: false }
  const k = max / longest
  return { width: Math.round(w * k), height: Math.round(h * k), scaled: true }
}

/**
 * Downscale a photo to MAX_PHOTO_SIDE before upload, in the browser. Best effort by design: any
 * missing capability or failure returns the ORIGINAL file, and the size refusal is applied to
 * whatever comes back — so a browser without canvas support still uploads a small photo and
 * still refuses a large one, it just cannot rescue the large one.
 *
 * PNG and WebP are re-encoded as WebP (keeps transparency); JPEG stays JPEG. A result that is not
 * smaller than the original, or came back in a type the bucket refuses (toBlob silently falls
 * back to PNG where a type is unsupported), is discarded in favour of the original.
 */
export async function downscalePhoto(file, env = {}) {
  const createBitmap = env.createImageBitmap ?? (typeof createImageBitmap === 'function' ? createImageBitmap : null)
  const doc = env.document ?? (typeof document !== 'undefined' ? document : null)
  if (!file || !PHOTO_EXT[file.type] || !createBitmap || !doc) return file
  let bitmap
  try {
    bitmap = await createBitmap(file)
    const fit = fitWithin(bitmap.width, bitmap.height)
    if (!fit.scaled) return file
    const canvas = doc.createElement('canvas')
    canvas.width = fit.width
    canvas.height = fit.height
    const ctx = canvas.getContext && canvas.getContext('2d')
    if (!ctx || !canvas.toBlob) return file
    ctx.drawImage(bitmap, 0, 0, fit.width, fit.height)
    const outType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp'
    const blob = await new Promise(resolve => canvas.toBlob(resolve, outType, 0.85))
    if (!blob || !PHOTO_EXT[blob.type] || blob.size >= file.size) return file
    return blob
  } catch {
    return file
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close()
  }
}

/**
 * A Storage failure worded for the person holding the photo. Storage errors are not PostgREST
 * errors — they carry an HTTP `statusCode`/`status` and a message, and errorText.js has no rule for
 * them — so the shapes this field can actually produce are named here. Returns null for anything
 * else, and the caller falls back to asActionError, which still keeps the detail.
 */
export function storageRefusal(err) {
  if (!err) return null
  const status = String(err.statusCode ?? err.status ?? '')
  const msg = String(err.message || '')
  if (status === '413' || /exceeded the maximum allowed size|payload too large/i.test(msg)) {
    return 'That photo is over the 2 MB limit. Take a smaller photo and try again.'
  }
  if (status === '415' || /mime type .* is not supported|invalid mime/i.test(msg)) {
    return 'That file type is not accepted. Use a JPG, PNG or WebP photo.'
  }
  if (/bucket not found/i.test(msg)) {
    return 'Photo storage is not set up for this account yet, so the photo could not be uploaded. Ask Crest support to finish the dish-photo setup.'
  }
  if (status === '403' || /row-level security|unauthori[sz]ed|permission denied/i.test(msg)) {
    return 'Your login is not allowed to change dish photos. An IMS supervisor or manager, or the account owner, can upload it.'
  }
  return null
}
