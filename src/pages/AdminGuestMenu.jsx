import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'

// Crest Admin utility: preview the currently-viewed client's guest QR menu (GuestMenu.jsx,
// /pos/menu/:tableId) without needing to scan a printed QR code or ask the client for one.
// Embeds the exact same public, unauthenticated route a guest's phone would load — no separate
// preview-only component to keep in sync, so it's always byte-for-byte what a guest actually sees,
// including live guest ordering if that client has the guest_ordering flag on (a POS-module
// feature since the S548 retier — it is not gated by any IMS tier).
export default function AdminGuestMenu() {
  const { adminViewClientId } = useAuth()
  const [clientName, setClientName] = useState('')
  const [tables, setTables] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState('')
  const [loadError, setLoadError] = useState('')
  // What the guest menu actually has to work with. The page is a price list until someone fills
  // these in, and nothing in the product ever asked the operator to — the preview shows a diner's
  // view of a menu with no photos and no descriptions without ever saying that is a choice being
  // made. Counted here so the gap is stated in words, next to a link to the page that fixes it.
  const [coverage, setCoverage] = useState(null)

  useEffect(() => {
    if (!adminViewClientId) { setTables([]); setClientName(''); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    setLoadError('')
    Promise.all([
      supabase.from('clients').select('name').eq('id', adminViewClientId).single(),
      // NOT `.neq('status', 'inactive')`. `pos_tables.status` is nullable, and a server-side .neq
      // on a nullable column silently excludes every NULL row too — so any table that had never
      // had a status written simply did not appear here, and the operator had no way to preview
      // its QR menu. Filtered in JS instead, where NULL means "not inactive", which is what the
      // column's absence actually says.
      supabase.from('pos_tables').select('id, name, section, status').eq('client_id', adminViewClientId).order('sort_order'),
      // Exactly the rows get_guest_menu itself serves, so the counts describe the menu a guest
      // sees rather than the recipe book behind it.
      supabase.from('recipes').select('id, image_url, description, is_veg')
        .eq('client_id', adminViewClientId).eq('is_active', true).eq('pos_enabled', true)
        .neq('category', 'Sub-Recipe'),
    ]).then(([{ data: client, error: cErr }, { data: rows, error: tErr }, { data: recipes, error: rErr }]) => {
      if (cancelled) return
      // A failed read is not an empty client. Without this, an RLS rejection or a dropped
      // connection rendered "This client has no tables set up yet" — an assertion about their
      // setup, made on no evidence, that sends someone to go and create tables they already have.
      if (cErr || tErr) {
        setLoadError((tErr || cErr).message || "Could not load this client's tables.")
        setTables([]); setLoading(false)
        return
      }
      const active = (rows || []).filter(t => t.status !== 'inactive')
      // A failed coverage read is not zero coverage — leave it null and say nothing rather than
      // telling an operator none of their dishes have a photo on the strength of a dropped request.
      setCoverage(rErr ? null : {
        total: (recipes || []).length,
        images: (recipes || []).filter(r => r.image_url).length,
        descriptions: (recipes || []).filter(r => r.description && r.description.trim()).length,
        vegMarks: (recipes || []).filter(r => r.is_veg != null).length,
      })
      setClientName(client?.name || '')
      setTables(active)
      setSelectedId(active[0]?.id || '')
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [adminViewClientId])

  if (!adminViewClientId) {
    return (
      <div>
        <div className="page-header"><h1 className="page-title">Guest Menu Preview</h1></div>
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>
          Pick a client from the switcher in the sidebar first — this page previews whichever client is currently selected.
        </div>
      </div>
    )
  }

  if (loading) {
    return <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>Loading…</div>
  }

  if (loadError) {
    return (
      <div>
        <div className="page-header"><h1 className="page-title">Guest Menu Preview</h1></div>
        <div className="card report-error" role="alert">
          <div className="report-error-title">Could not load this client's tables</div>
          <p className="report-error-body">{loadError}</p>
          <p className="report-error-hint">
            Nothing below is a statement about this client's setup — the read itself failed.
          </p>
        </div>
      </div>
    )
  }

  if (tables.length === 0) {
    return (
      <div>
        <div className="page-header"><h1 className="page-title">Guest Menu Preview — {clientName}</h1></div>
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>
          This client has no tables set up yet — add one in Tables first, then come back here to preview its guest menu.
        </div>
      </div>
    )
  }

  const url = `${window.location.origin}/pos/menu/${selectedId}`

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Guest Menu Preview — {clientName}</h1>
          <p className="page-subtitle">The exact live page a guest sees after scanning this table's QR code.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label htmlFor="guest-menu-table" className="sr-only">Table to preview</label>
          <select id="guest-menu-table" className="form-select" value={selectedId} onChange={e => setSelectedId(e.target.value)}>
            {tables.map(t => <option key={t.id} value={t.id}>{t.name}{t.section ? ` · ${t.section}` : ''}</option>)}
          </select>
          {/* Feedback both ways — the bare writeText() call gave no signal on success and
              swallowed its own rejection, so a denied clipboard permission meant pasting stale
              clipboard content into a client email with nothing on screen to warn (S574). */}
          <button className="btn btn-ghost" onClick={() => {
            navigator.clipboard.writeText(url)
              .then(() => setCopied('ok'))
              .catch(() => setCopied('fail'))
            setTimeout(() => setCopied(''), 2500)
          }}>{copied === 'ok' ? '✓ Copied' : copied === 'fail' ? 'Copy failed — copy from the address bar' : 'Copy Link'}</button>
          <span role="status" className="sr-only">{copied === 'ok' ? 'Link copied' : copied === 'fail' ? 'Copy failed' : ''}</span>
          <a className="btn btn-ghost" href={url} target="_blank" rel="noopener noreferrer">Open in New Tab ↗</a>
        </div>
      </div>

      {/* Stated in words, because the preview below cannot say it: a menu with no photos and no
          descriptions looks like a finished page rather than an unfinished one, so the person who
          could fix it never learns there is anything to fix. Only shown when there is a real gap —
          a fully-populated menu gets no nag. */}
      {coverage && coverage.total > 0 && (coverage.images < coverage.total || coverage.descriptions < coverage.total) && (
        <div className="card" style={{ padding: '12px 16px', marginBottom: 14, fontSize: 12.5, color: 'var(--theme-text2)' }}>
          <strong style={{ color: 'var(--theme-text1)' }}>This menu is mostly names and prices.</strong>{' '}
          {coverage.images} of {coverage.total} dishes have a photo, {coverage.descriptions} have a description
          {coverage.vegMarks < coverage.total ? `, ${coverage.vegMarks} are marked veg or non-veg` : ''}.
          A photo is the single largest lever on a QR menu, and a description is the only way a
          visitor knows what a dish is — both are fields on the recipe.{' '}
          <Link to="/recipes" style={{ color: 'var(--theme-accent-ink)', fontWeight: 600 }}>Edit dishes in Recipes →</Link>
        </div>
      )}

      <div className="card" style={{ padding: '10px 16px', marginBottom: 14, background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.25)', fontSize: 12, color: 'var(--theme-text2)' }}>
        ⚠ This is the real, live guest menu for {clientName} — if guest ordering is enabled and you place an order below, it creates a genuine pending order their staff will see in POS Orders. Preview only; avoid submitting a test order unless the client knows to expect it.
      </div>

      {/* Constrained to a phone width on purpose. This preview used to render the guest page at
          whatever the admin window was — measured at 1134px — so the one person who could ask for
          the mobile fixes was the one person never seeing the mobile layout: a two-thumb-wide
          menu card, a sticky bar with room to spare, and none of the cramped reality a diner gets.
          390px is the iPhone 14/15 logical width, the most common device to scan one of these. */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <div className="card" style={{ padding: 0, overflow: 'hidden', width: 390, maxWidth: '100%' }}>
          <iframe
            key={selectedId}
            src={url}
            title="Guest Menu Preview"
            style={{ width: '100%', height: 'calc(100vh - 300px)', minHeight: 560, border: 'none', display: 'block' }}
          />
        </div>
      </div>
      <p style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--theme-text3)', margin: '10px 0 0' }}>
        Shown at 390px — a phone. Use “Open in New Tab” to see it at any other size.
      </p>
    </div>
  )
}
