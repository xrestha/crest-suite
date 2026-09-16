import { useEffect, useRef, useState } from 'react'
import { ArrowUp, ArrowDown, ExternalLink } from 'lucide-react'
import { supabase } from '../../../supabaseClient'
import { useAuth } from '../../../context/AuthContext'
import { DEFAULT_RECIPE_CATS } from '../../../context/SettingsContext'
import Tip from '../../../components/Tip'
import ActionError, { asActionError } from '../../../components/ActionError'
import ReportLoadError from '../../../components/ReportLoadError'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { withTimeout } from '../../../utils/withTimeout'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import {
  DISH_PHOTO_BUCKET, PHOTO_ACCEPT, PHOTO_EXT,
  photoRefusal, versionedUrl, objectPathFromUrl, downscalePhoto, storageRefusal,
} from '../../ims/recipes/dishPhoto'
import { tidyName, orderCategories, reorderCategoryList } from '../guestmenu/guestMenuHelpers'

// POS Setup → Guest Menu (S767). What a guest sees at the top of every table's QR menu, and the
// order of its sections.
//
// NAME AND LOGO are the Owner's (owner decision): `settings.guest_menu_name` / `guest_menu_logo_url`
// are fenced to the Owner and admin by settings_guard_staff_roles (migration 20260921100000), so a
// POS manager sees them read-only here rather than a Save that the database refuses. Until the Owner
// sets a name, the menu shows the account name with all-capitals tidied ("BHATTI CHOILA" → "Bhatti
// Choila"), and this page says exactly that in the placeholder.
//
// THE LOGO is uploaded into the `dish-photos` bucket under `<client>/guest-menu-logo-<epoch>.<ext>`.
// That bucket's policies already admit the Owner into their own client's folder, and the guest menu's
// Content-Security-Policy already loads from it — a separate bucket would have needed both again. As
// with a dish photo: never upsert (a new path per upload), write the row before deleting the old
// file, and remove the new file if the row write is refused, so the row can never point at nothing.
//
// SECTION ORDER is the Recipe Categories list (owner decision) — the same `settings.recipe_categories`
// Settings → Recipe Categories edits. It is offered here too because that tab needs Recipe Costing,
// which a POS-only client does not have. Only the categories on the menu are shown; moving them keeps
// every other category where it was in the stored list (reorderCategoryList).

const LOGO_MAX_SIDE = 512
const UPLOAD_TIMEOUT_MS = 60000
const WRITE_TIMEOUT_MS = 20000

function describe(err, lead = '') {
  const own = storageRefusal(err)
  if (own && /Your login is not allowed/.test(own)) {
    return { text: lead + 'Your login is not allowed to upload the menu logo. The account owner can.', detail: [err?.statusCode ?? err?.status, err?.message].filter(Boolean).join(' · ') }
  }
  if (own) return { text: lead + own.replace(/photo/g, 'logo'), detail: [err?.statusCode ?? err?.status, err?.message].filter(Boolean).join(' · ') }
  const a = asActionError(err)
  return { text: lead + a.text, detail: a.detail }
}

export default function GuestMenuSetup({ clientId, tables = [] }) {
  const { isAdmin, isOwner } = useAuth()
  const canBrand = isAdmin || isOwner
  const { ask, confirmEl } = useConfirm()
  const fileRef = useRef(null)

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [settingsId, setSettingsId] = useState(null)
  const [accountName, setAccountName] = useState('')
  const [storedName, setStoredName] = useState('')
  const [name, setName] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [logoFailed, setLogoFailed] = useState(false)
  const [storedCategories, setStoredCategories] = useState(null) // settings.recipe_categories as stored
  const [menuCategories, setMenuCategories] = useState([])       // on the menu, in the order shown
  const [savedOrder, setSavedOrder] = useState([])

  const [nameBusy, setNameBusy] = useState(false)
  const [nameMsg, setNameMsg] = useState('')
  const [nameError, setNameError] = useState('')
  const [logoBusy, setLogoBusy] = useState('')
  const [logoError, setLogoError] = useState('')
  const [orderBusy, setOrderBusy] = useState(false)
  const [orderMsg, setOrderMsg] = useState('')
  const [orderError, setOrderError] = useState('')

  useEffect(() => {
    if (!clientId) return undefined
    let cancelled = false
    setLoading(true); setLoadError(null)
    setNameMsg(''); setNameError(''); setLogoError(''); setOrderMsg(''); setOrderError('')
    Promise.all([
      supabase.from('settings').select('id, guest_menu_name, guest_menu_logo_url, recipe_categories').eq('client_id', clientId).maybeSingle(),
      supabase.from('clients').select('name').eq('id', clientId).maybeSingle(),
      // The same predicate get_guest_menu serves (S746, S714): active, on POS, priced, not a prep item.
      // Paged: a truncated read would silently drop a section from the list being ordered.
      fetchAllRows(() => supabase.from('recipes').select('id, category').eq('client_id', clientId).eq('is_active', true).eq('pos_enabled', true)
        .gt('selling_price', 0).or('category.is.null,category.neq.Sub-Recipe').order('id')),
    ]).then(([s, c, r]) => {
      if (cancelled) return
      const err = s.error || c.error || r.error
      if (err) { setLoadError(err); setLoading(false); return }
      const row = s.data || {}
      setSettingsId(row.id || null)
      setAccountName(c.data?.name || '')
      setStoredName(row.guest_menu_name || '')
      setName(row.guest_menu_name || '')
      setLogoUrl(row.guest_menu_logo_url || '')
      setLogoFailed(false)
      setStoredCategories(row.recipe_categories ?? null)
      // Alphabetical first, as get_guest_menu returns them, so an unlisted category lands where the
      // menu puts it.
      const present = Array.from(new Set((r.data || []).map(x => x.category).filter(Boolean))).sort((a, b) => a.localeCompare(b))
      const ordered = orderCategories(present, row.recipe_categories, DEFAULT_RECIPE_CATS)
      setMenuCategories(ordered)
      setSavedOrder(ordered)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [clientId])

  // A settings write as a PATCH of exactly the columns this card owns (settings-row.md). A failed
  // existing-row read never falls through into INSERT (S613), and a refused RLS update — 0 rows and
  // no error — is reported as a refusal rather than a save.
  async function writeSettings(patch) {
    let id = settingsId
    if (!id) {
      const { data: existing, error: readErr } = await supabase.from('settings').select('id').eq('client_id', clientId).maybeSingle()
      if (readErr) return readErr
      id = existing?.id || null
    }
    if (id) {
      const { data, error } = await withTimeout(supabase.from('settings').update(patch).eq('id', id).select('id'), WRITE_TIMEOUT_MS, 'Saving')
      if (error) return error
      if (!data?.length) return { message: 'settings: update matched no row (refused)' }
      return null
    }
    const { data, error } = await withTimeout(supabase.from('settings').insert({ client_id: clientId, ...patch }).select('id'), WRITE_TIMEOUT_MS, 'Saving')
    if (error) return error
    if (data?.[0]?.id) setSettingsId(data[0].id)
    return null
  }

  const fallbackName = tidyName(accountName) || 'your account name'
  const trimmed = name.trim()
  const nameDirty = trimmed !== (storedName || '').trim()

  async function saveName() {
    if (!canBrand || nameBusy) return
    setNameBusy(true); setNameMsg(''); setNameError('')
    try {
      const err = await writeSettings({ guest_menu_name: trimmed || null })
      if (err) { setNameError(describe(err, 'The name was not saved, so guests still see the previous one. ')); return }
      setStoredName(trimmed)
      setName(trimmed)
      setNameMsg(trimmed ? 'Saved. Guests now see this name.' : `Saved. Guests now see “${fallbackName}”.`)
    } catch (e) {
      setNameError(describe(e, 'The name may not have saved. '))
    } finally {
      setNameBusy(false)
    }
  }

  const bucket = () => supabase.storage.from(DISH_PHOTO_BUCKET)
  const ownPath = objectPathFromUrl(logoUrl, process.env.REACT_APP_SUPABASE_URL)

  async function removeObjectQuietly(path) {
    if (!path || !path.startsWith(`${clientId}/`)) return
    try {
      const { error: rmErr } = await withTimeout(bucket().remove([path]), WRITE_TIMEOUT_MS, 'Delete logo')
      if (rmErr) console.error('Guest menu logo file not deleted from storage:', rmErr.message)
    } catch (e) {
      console.error('Guest menu logo file not deleted from storage:', e?.message)
    }
  }

  async function handleFile(file) {
    if (fileRef.current) fileRef.current.value = ''
    if (!file || !canBrand) return
    setLogoError('')
    if (!PHOTO_EXT[file.type]) { setLogoError('That file is not a JPG, PNG or WebP image. Save the logo as one of those and try again.'); return }
    setLogoBusy('upload')
    try {
      const toSend = await downscalePhoto(file, { maxSide: LOGO_MAX_SIDE })
      const refusal = photoRefusal(toSend)
      if (refusal) { setLogoError(refusal.replace(/photo/g, 'logo')); return }
      const path = `${clientId}/guest-menu-logo-${Date.now()}.${PHOTO_EXT[toSend.type] || 'png'}`
      let upErr
      try {
        const res = await withTimeout(
          bucket().upload(path, toSend, { contentType: toSend.type, cacheControl: '31536000', upsert: false }),
          UPLOAD_TIMEOUT_MS, 'Upload',
        )
        upErr = res?.error
      } catch (e) {
        upErr = e
      }
      if (upErr) { setLogoError(describe(upErr, 'The logo was not uploaded. ')); return }
      const { data: { publicUrl } } = bucket().getPublicUrl(path)
      const url = versionedUrl(publicUrl)
      const previous = ownPath
      const rowErr = await writeSettings({ guest_menu_logo_url: url })
      if (rowErr) {
        await removeObjectQuietly(path)
        setLogoError(describe(rowErr, 'The logo uploaded, but the menu could not be updated, so guests still see the previous one. '))
        return
      }
      setLogoUrl(url)
      setLogoFailed(false)
      if (previous && previous !== path) await removeObjectQuietly(previous)
    } finally {
      setLogoBusy('')
    }
  }

  function removeLogo() {
    setLogoError('')
    ask({
      title: 'Remove the logo from the guest menu?',
      confirmLabel: 'Remove logo', danger: true, busyLabel: 'Removing…',
      body: <p style={{ margin: 0 }}>Guests will see the restaurant name without a logo. This takes effect straight away.</p>,
      run: async () => {
        setLogoBusy('remove')
        try {
          const err = await writeSettings({ guest_menu_logo_url: null })
          if (err) { setLogoError(describe(err, 'The logo is still on the menu — the change did not save. ')); return }
          const path = ownPath
          setLogoUrl('')
          await removeObjectQuietly(path)
        } finally {
          setLogoBusy('')
        }
      },
    })
  }

  function move(i, delta) {
    setOrderMsg(''); setOrderError('')
    setMenuCategories(prev => {
      const j = i + delta
      if (j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }
  const orderDirty = menuCategories.join('|') !== savedOrder.join('|')

  async function saveOrder() {
    if (orderBusy || !orderDirty) return
    setOrderBusy(true); setOrderMsg(''); setOrderError('')
    try {
      const base = Array.isArray(storedCategories) && storedCategories.length > 0 ? storedCategories : DEFAULT_RECIPE_CATS
      const next = reorderCategoryList(base, menuCategories)
      const err = await writeSettings({ recipe_categories: next })
      if (err) { setOrderError(describe(err, 'The section order was not saved, so the menu keeps its previous order. ')); return }
      setStoredCategories(next)
      setSavedOrder(menuCategories)
      setOrderMsg('Saved. The guest menu shows its sections in this order.')
    } catch (e) {
      setOrderError(describe(e, 'The section order may not have saved. '))
    } finally {
      setOrderBusy(false)
    }
  }

  if (!clientId) return null
  if (loading) {
    return <div className="card" style={{ padding: 24, color: 'var(--theme-text2)' }}>Loading the guest menu settings…</div>
  }
  if (loadError) return <ReportLoadError error={loadError} />

  const previewTable = tables.find(t => t.status !== 'inactive') || tables[0]
  const previewUrl = previewTable ? `${window.location.origin}/pos/menu/${previewTable.id}` : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 640 }}>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
        What guests see at the top of every table’s QR menu and your online booking page, and the order of the menu’s sections.
        {previewUrl && (
          <>
            {' '}
            <a href={previewUrl} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm" style={{ marginLeft: 4, verticalAlign: 'middle' }}>
              Open {previewTable.name}’s menu <ExternalLink size={14} aria-hidden="true" />
            </a>
          </>
        )}
      </p>
      {previewUrl && (
        <p style={{ margin: '-8px 0 0', fontSize: 12, color: 'var(--theme-text3)' }}>
          That is the real menu: Place order there sends a real order to your staff.
        </p>
      )}

      {!canBrand && (
        <div className="card card--compact" role="note" style={{ fontSize: 13, color: 'var(--theme-text2)' }}>
          Only the account owner can change the restaurant name and logo guests see. You can change the section order below.
        </div>
      )}

      <section className="card" aria-labelledby="gms-brand">
        <h2 id="gms-brand" style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>Name and logo</h2>

        <div className="form-field" style={{ marginBottom: 20 }}>
          <label htmlFor="gms-name">
            <Tip text="The restaurant's name as guests should read it, in normal capitals. Leave it empty to use your account name — written in all capitals, it is shown with only the first letter of each word in capitals." width={300}>
              Restaurant name on the menu
            </Tip>
          </label>
          <input
            id="gms-name" value={name} maxLength={60} disabled={!canBrand || nameBusy}
            placeholder={fallbackName}
            onChange={e => { setName(e.target.value); setNameMsg(''); setNameError('') }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
            {canBrand && (
              <button type="button" className="btn btn-primary btn-sm" onClick={saveName} disabled={!nameDirty}
                aria-busy={nameBusy ? 'true' : undefined}>
                {nameBusy ? 'Saving…' : 'Save name'}
              </button>
            )}
            {!trimmed && <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>Guests see “{fallbackName}”.</span>}
            {nameMsg && <span role="status" style={{ fontSize: 12, color: 'var(--theme-green-text)' }}>{nameMsg}</span>}
          </div>
          <ActionError error={nameError} />
        </div>

        <div className="form-field" style={{ marginBottom: 0 }}>
          <label htmlFor="gms-logo-upload">
            <Tip text="Shown above the name on the guest menu. A JPG, PNG or WebP up to 2 MB — a square logo works best, and a transparent PNG is fine. It is shown on a dark background, so check the preview here." width={300}>
              Logo
            </Tip>
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            {/* The preview sits on the guest menu's own ground, so a logo that disappears on a dark
                page is caught here rather than by a guest. */}
            <div
              aria-label="How guests see the logo"
              role="img"
              style={{
                width: 88, height: 88, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'var(--theme-bg)', border: '1px solid var(--theme-border)',
              }}
            >
              {logoUrl && !logoFailed ? (
                <img src={logoUrl} alt="" onError={() => setLogoFailed(true)}
                  style={{ width: 64, height: 64, objectFit: 'contain', padding: 6, boxSizing: 'border-box', background: 'var(--theme-card)', border: '1px solid var(--theme-border)' }} />
              ) : (
                <span style={{ fontSize: 11, color: 'var(--theme-text3)', textAlign: 'center', padding: 4 }}>
                  {logoFailed ? 'Can’t show' : 'No logo'}
                </span>
              )}
            </div>
            {canBrand ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input ref={fileRef} id="gms-logo-upload" type="file" accept={PHOTO_ACCEPT} style={{ display: 'none' }}
                  onChange={e => handleFile(e.target.files && e.target.files[0])} disabled={!!logoBusy} />
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileRef.current && fileRef.current.click()}
                  disabled={!!logoBusy} aria-busy={logoBusy === 'upload' ? 'true' : undefined}>
                  {logoBusy === 'upload' ? 'Uploading…' : logoUrl ? 'Replace logo' : 'Upload logo'}
                </button>
                {logoUrl && (
                  <button type="button" className="btn btn-danger btn-sm" onClick={removeLogo} disabled={!!logoBusy}
                    aria-busy={logoBusy === 'remove' ? 'true' : undefined}>
                    {logoBusy === 'remove' ? 'Removing…' : 'Remove'}
                  </button>
                )}
              </div>
            ) : (
              <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>{logoUrl ? 'Set by the owner.' : 'No logo set.'}</span>
            )}
          </div>
          {canBrand && (
            <div style={{ fontSize: 12, color: 'var(--theme-text3)', marginTop: 8 }}>
              Uploading or removing the logo changes the menu straight away.
            </div>
          )}
          <ActionError error={logoError} />
        </div>
      </section>

      <section className="card" aria-labelledby="gms-order">
        <h2 id="gms-order" style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600 }}>Section order</h2>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
          The order of sections on the guest menu. It is the same list as Settings → Recipe Categories.
        </p>
        {menuCategories.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text3)' }}>No priced dishes are switched on for POS yet, so the menu has no sections.</p>
        ) : (
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {menuCategories.map((cat, i) => (
              <li key={cat} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 6px 6px 12px', border: '1px solid var(--theme-border)', background: 'var(--theme-bg)' }}>
                <span style={{ fontSize: 12, color: 'var(--theme-text3)', width: 18, fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
                <span style={{ flex: 1, fontSize: 14, color: 'var(--theme-text1)' }}>{tidyName(cat)}</span>
                <button type="button" className="btn btn-ghost btn-icon" onClick={() => move(i, -1)} disabled={i === 0 || orderBusy}
                  aria-label={`Move ${cat} up`} title={`Move ${cat} up`}><ArrowUp aria-hidden="true" /></button>
                <button type="button" className="btn btn-ghost btn-icon" onClick={() => move(i, 1)} disabled={i === menuCategories.length - 1 || orderBusy}
                  aria-label={`Move ${cat} down`} title={`Move ${cat} down`}><ArrowDown aria-hidden="true" /></button>
              </li>
            ))}
          </ol>
        )}
        {menuCategories.length > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary btn-sm" onClick={saveOrder} disabled={!orderDirty}
              aria-busy={orderBusy ? 'true' : undefined}>
              {orderBusy ? 'Saving…' : 'Save section order'}
            </button>
            {orderDirty && !orderBusy && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setMenuCategories(savedOrder); setOrderError('') }}>Undo changes</button>
            )}
            {orderMsg && <span role="status" style={{ fontSize: 12, color: 'var(--theme-green-text)' }}>{orderMsg}</span>}
          </div>
        )}
        <ActionError error={orderError} />
      </section>
      {confirmEl}
    </div>
  )
}
