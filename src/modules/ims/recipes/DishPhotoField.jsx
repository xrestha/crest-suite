import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import ActionError, { asActionError } from '../../../components/ActionError'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { withTimeout } from '../../../utils/withTimeout'
import {
  DISH_PHOTO_BUCKET, PHOTO_ACCEPT, PHOTO_EXT,
  photoRefusal, photoPath, versionedUrl, objectPathFromUrl, guestCanLoad, downscalePhoto, storageRefusal,
} from './dishPhoto'

// A dish photo that guests can actually see (S756, owner decision D16).
//
// The field used to be a text box for a link, and the guest QR menu's CSP only loads images from
// our own Supabase storage — so the common case (a photo already on Facebook or Google Drive) was
// saved without complaint and shown to no guest. Upload puts the photo in the `dish-photos` bucket
// (migration 20260918150000) and stores its public URL. The link box survives behind a disclosure
// because existing recipes carry links, and it now says plainly when a link will not show.
//
// WHEN A CHANGE IS SAVED. For a recipe that already exists, Upload / Replace / Remove write
// `recipes.image_url` straight away through `persist`, and only then delete the old file. That is
// the order that can never leave the row pointing at a deleted file: if the row write is refused
// the new file is removed instead, and the recipe keeps the photo it had. The alternative — leave
// it to Save Recipe — would mean either deleting the old file before the save (a cancelled edit
// then shows a broken photo) or never deleting it (the file stays public at its own URL, the S739
// logo finding). For a recipe not yet saved there is no row to point at anything, so the URL
// lives in the form and is written by Save Recipe, as every other field is.
//
// A FAILED UPLOAD CHANGES NOTHING. The existing photo, the form value and the row are untouched
// until the new file has landed and (for a saved recipe) the row has accepted it.

const UPLOAD_TIMEOUT_MS = 60000
const WRITE_TIMEOUT_MS = 20000

function describe(err, lead = '') {
  const own = storageRefusal(err)
  if (own) return { text: lead + own, detail: [err?.statusCode ?? err?.status, err?.message].filter(Boolean).join(' · ') }
  const a = asActionError(err)
  return { text: lead + a.text, detail: a.detail }
}

/**
 * @param {string}   id        control id, for the label
 * @param {string}   clientId  the folder the upload goes into — must be the client being edited
 * @param {string}   recipeId  the saved recipe's id, or null for a recipe not yet saved
 * @param {string}   value     current image_url ('' for none)
 * @param {function} onChange  (url: string) => void — keeps the recipe form in step
 * @param {function} persist   (url: string|null) => Promise<{ data, error }> for a saved recipe; null otherwise
 * @param {boolean}  disabled
 * @param {string}   supabaseUrl  project URL, to recognise our own files (defaults to the env)
 */
export default function DishPhotoField({
  id = 'dish-photo', clientId, recipeId = null, value = '', onChange, persist = null, disabled = false,
  supabaseUrl = process.env.REACT_APP_SUPABASE_URL,
}) {
  const fileRef = useRef(null)
  const [busy, setBusy] = useState('')          // '' | 'upload' | 'remove'
  const [error, setError] = useState('')
  const [imgFailed, setImgFailed] = useState(false)
  const ownPath = objectPathFromUrl(value, supabaseUrl)
  const [showLink, setShowLink] = useState(() => !!value && !ownPath)
  const { ask, confirmEl } = useConfirm()

  useEffect(() => { setImgFailed(false) }, [value])

  const bucket = () => supabase.storage.from(DISH_PHOTO_BUCKET)

  // Best effort, and quiet by design: by the time this runs nothing points at the file any more,
  // so a failure leaves an unused file rather than a wrong screen, and there is nothing the person
  // editing a recipe could do about it. Only a path inside THIS client's folder is attempted —
  // anything else the storage policy would refuse anyway (a restored copy of another outlet's link).
  async function removeObjectQuietly(path) {
    if (!path || !clientId || !path.startsWith(`${clientId}/`)) return
    try {
      const { error: rmErr } = await withTimeout(bucket().remove([path]), WRITE_TIMEOUT_MS, 'Delete photo')
      if (rmErr) console.error('Dish photo file not deleted from storage:', rmErr.message)
    } catch (e) {
      console.error('Dish photo file not deleted from storage:', e?.message)
    }
  }

  // A refused RLS update is 0 rows and no error, so a write that matters reads its count back.
  async function writeRow(url) {
    if (!persist) return null
    try {
      const res = await persist(url)
      if (res?.error) return res.error
      if (res && 'data' in res && Array.isArray(res.data) && res.data.length === 0) {
        return { message: 'recipes: update matched no row (refused, or the recipe no longer exists)' }
      }
      return null
    } catch (e) {
      return e
    }
  }

  async function handleFile(file) {
    if (fileRef.current) fileRef.current.value = ''   // choosing the same file again must re-fire
    if (!file) return
    setError('')
    if (!clientId) { setError('No client selected. Pick a client in the top-left switcher before uploading a photo.'); return }
    if (!PHOTO_EXT[file.type]) { setError(photoRefusal(file)); return }

    setBusy('upload')
    try {
      const toSend = await downscalePhoto(file)
      const refusal = photoRefusal(toSend)
      if (refusal) { setError(refusal); return }

      const path = photoPath(clientId, recipeId, toSend.type)
      let upErr
      try {
        // upsert: false — a plain INSERT. Upsert needs a SELECT policy to pass and is exactly how
        // the 2026-07 staff-photo bucket failed with 42501 (see the migration header).
        const res = await withTimeout(
          bucket().upload(path, toSend, { contentType: toSend.type, cacheControl: '31536000', upsert: false }),
          UPLOAD_TIMEOUT_MS, 'Upload'
        )
        upErr = res?.error
      } catch (e) {
        upErr = e
      }
      if (upErr) { setError(describe(upErr, 'The photo was not uploaded. ')); return }

      const { data: { publicUrl } } = bucket().getPublicUrl(path)
      const url = versionedUrl(publicUrl)
      const previousPath = ownPath

      const rowErr = await writeRow(url)
      if (rowErr) {
        await removeObjectQuietly(path)
        setError(describe(rowErr, 'The photo uploaded, but the recipe could not be updated, so it still shows the previous photo. '))
        return
      }
      onChange(url)
      setShowLink(false)
      // Only once nothing points at it. For a recipe not yet saved the previous file can only be
      // one uploaded in this form (a new recipe starts blank), so it is equally unreferenced.
      if (previousPath && previousPath !== path) await removeObjectQuietly(previousPath)
    } finally {
      setBusy('')
    }
  }

  function handleRemove() {
    setError('')
    ask({
      title: 'Remove this dish photo?',
      confirmLabel: 'Remove photo', danger: true, busyLabel: 'Removing…',
      body: (
        <p style={{ margin: 0 }}>
          Guests will see the dish without a photo on the QR menu.
          {ownPath ? ' The stored photo is deleted, so keep your own copy if you may want it again.' : ''}
          {persist ? ' This takes effect straight away.' : ''}
        </p>
      ),
      run: async () => {
        setBusy('remove')
        try {
          const rowErr = await writeRow(null)
          if (rowErr) { setError(describe(rowErr, 'The photo is still on the recipe — the change did not save. ')); return }
          const path = ownPath
          onChange('')
          await removeObjectQuietly(path)
        } finally {
          setBusy('')
        }
      },
    })
  }

  const locked = disabled || !!busy
  const linkWarning = value && !ownPath && !guestCanLoad(value)

  return (
    <div className="form-field dish-photo-field">
      <label htmlFor={`${id}-upload`}>
        <Tip text="A photo of the dish for the guest QR menu. Upload a JPG, PNG or WebP up to 2 MB — large phone photos are shrunk automatically. It is stored inside Crest, so every guest's phone can load it. Leave empty to show the dish without a photo." width={300}>
          Photo (guest menu)
        </Tip>
      </label>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {value && (
          imgFailed ? (
            <div
              role="img" aria-label="Photo could not be shown"
              style={{
                width: 64, height: 64, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: '1px solid var(--theme-border)', background: 'var(--theme-input-bg)',
                color: 'var(--theme-text3)', fontSize: 11, textAlign: 'center', padding: 4, boxSizing: 'border-box',
              }}
            >
              Can’t show
            </div>
          ) : (
            <img
              src={value} alt="The dish as guests see it" onError={() => setImgFailed(true)}
              style={{ width: 64, height: 64, objectFit: 'cover', flexShrink: 0, border: '1px solid var(--theme-border)', background: 'var(--theme-input-bg)' }}
            />
          )
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            ref={fileRef}
            id={`${id}-upload`}
            type="file"
            accept={PHOTO_ACCEPT}
            style={{ display: 'none' }}
            onChange={e => handleFile(e.target.files && e.target.files[0])}
            disabled={locked}
          />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => fileRef.current && fileRef.current.click()}
            disabled={locked}
            aria-busy={busy === 'upload' ? 'true' : undefined}
          >
            {busy === 'upload' ? 'Uploading…' : value ? 'Replace photo' : 'Upload photo'}
          </button>
          {value && (
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={handleRemove}
              disabled={locked}
              aria-busy={busy === 'remove' ? 'true' : undefined}
            >
              {busy === 'remove' ? 'Removing…' : 'Remove'}
            </button>
          )}
          {!showLink && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setShowLink(true)}
              disabled={locked}
            >
              Paste a link instead
            </button>
          )}
        </div>
      </div>

      {persist && (
        <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>
          Uploading or removing a photo saves straight away.
        </div>
      )}

      {showLink && (
        <div style={{ marginTop: 8 }}>
          <label htmlFor={id} style={{ fontSize: 11 }}>
            <Tip text="Only for a photo already stored in Crest. Links to Facebook, Google Drive, Imgur or other websites are blocked on guests' phones for security, so the dish would show without a photo. A link is saved when you press Save Recipe." width={300}>
              Photo link
            </Tip>
          </label>
          <input
            id={id}
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder="https://..."
            disabled={locked}
            aria-describedby={linkWarning ? `${id}-warning` : undefined}
          />
          {linkWarning && (
            <div id={`${id}-warning`} role="status" style={{ fontSize: 12, color: 'var(--theme-amber-text)', marginTop: 4 }}>
              △ Guests will not see this photo — their phones only load photos stored in Crest. Use Upload photo instead.
            </div>
          )}
        </div>
      )}

      <ActionError error={error} />
      {confirmEl}
    </div>
  )
}
