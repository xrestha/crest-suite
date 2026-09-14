import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import ReportLoadError from '../components/ReportLoadError'

// Crest Admin utility: preview the currently-viewed client's guest QR menu (GuestMenu.jsx,
// /pos/menu/:tableId) without needing to scan a printed QR code or ask the client for one.
// Embeds the exact same public route a guest's phone loads — no separate preview component to keep
// in sync. Two things differ inside the frame, both deliberately: Place Order is switched off
// (GuestMenu detects the frame, S746) so the preview cannot send a real order, and the page is
// pinned to a phone width.
//
// What the preview CANNOT show is why a menu looks the way it does, so everything this page adds
// above the frame is a statement of what get_guest_menu actually serves and why: POS switched off
// (no menu at all), no dish priced and switched on (no menu at all), dishes left off for having no
// price, a table taken out of service (menu, no ordering), and how much of the menu is only names
// and prices.

// The same shape as HR's amber banner (LeaveManagement.jsx, from PayrollRun's stale-draft card) —
// one banner form for a state someone has to act on, never a second one invented here.
const amberBanner = {
  marginBottom: 14, padding: '12px 16px', fontSize: 12.5, color: 'var(--theme-text2)', lineHeight: 1.6,
  borderColor: 'color-mix(in srgb, var(--theme-amber) 35%, transparent)',
  background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)',
}

const linkStyle = { color: 'var(--theme-accent-ink)', fontWeight: 600 }

function Header({ clientName, children, subtitle }) {
  return (
    <div className={children ? 'page-header page-header--split' : 'page-header'}>
      <div>
        <h1 className="page-title">Guest Menu Preview{clientName ? ` — ${clientName}` : ''}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {children}
    </div>
  )
}

export default function AdminGuestMenu() {
  const { adminViewClientId } = useAuth()
  const [client, setClient] = useState(null)       // { name, pos_enabled }
  const [tables, setTables] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState('')
  const copyTimer = useRef(null)
  const [loadError, setLoadError] = useState(null)
  // What the guest menu actually has to work with, counted over exactly the rows get_guest_menu
  // considers. null = the read failed, and a failed read is not zero coverage.
  const [coverage, setCoverage] = useState(null)

  useEffect(() => () => clearTimeout(copyTimer.current), [])

  useEffect(() => {
    if (!adminViewClientId) { setTables([]); setClient(null); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setCoverage(null)
    Promise.all([
      supabase.from('clients').select('name, pos_enabled').eq('id', adminViewClientId).single(),
      // NOT `.neq('status', 'inactive')`: `pos_tables.status` is nullable and a server-side .neq
      // also drops every NULL row. Inactive tables are KEPT — their QR still serves the menu
      // (without ordering), so the operator has to be able to preview exactly that.
      supabase.from('pos_tables').select('id, name, section, status').eq('client_id', adminViewClientId).order('sort_order'),
      // The same predicate get_guest_menu filters with, minus the price test, so the unpriced
      // dishes it leaves off can be counted. NULL-safe category (S714): `category IS DISTINCT FROM
      // 'Sub-Recipe'` in the SQL, which a bare `.neq` does not match.
      supabase.from('recipes').select('id, selling_price, image_url, description, is_veg')
        .eq('client_id', adminViewClientId).eq('is_active', true).eq('pos_enabled', true)
        .or('category.is.null,category.neq.Sub-Recipe'),
    ]).then(([{ data: c, error: cErr }, { data: rows, error: tErr }, { data: recipes, error: rErr }]) => {
      if (cancelled) return
      // A failed read is not an empty client — "no tables set up yet" on a dropped connection
      // sends someone off to create tables the client already has.
      if (cErr || tErr) {
        setLoadError(tErr || cErr)
        setTables([]); setLoading(false)
        return
      }
      const all = rows || []
      if (rErr) {
        setCoverage(null)
      } else {
        // `> 0`, matching the SQL: a NULL or zero price is left off the guest menu (S746).
        const served = (recipes || []).filter(r => (parseFloat(r.selling_price) || 0) > 0)
        setCoverage({
          total: served.length,
          unpriced: (recipes || []).length - served.length,
          images: served.filter(r => r.image_url).length,
          descriptions: served.filter(r => r.description && r.description.trim()).length,
          vegMarks: served.filter(r => r.is_veg != null).length,
        })
      }
      setClient(c || null)
      setTables(all)
      // Open on a table that takes orders when there is one: the inactive case is the exception
      // an operator goes looking for, not the thing to land on.
      setSelectedId((all.find(t => t.status !== 'inactive') || all[0])?.id || '')
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [adminViewClientId])

  if (!adminViewClientId) {
    return (
      <div>
        <Header />
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>
          Pick a client from the client switcher in the top bar first — this page previews whichever client is currently selected.
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div>
        <Header />
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>Loading…</div>
      </div>
    )
  }

  if (loadError) {
    return (
      <div>
        <Header />
        <ReportLoadError error={loadError} />
      </div>
    )
  }

  const clientName = client?.name || ''
  const posOff = client && !client.pos_enabled

  // get_guest_menu returns nothing at all while POS is off, so every QR shows "This menu isn't
  // available right now". Said before anything else, because the frame below would otherwise be
  // the only statement of it — and it reads as a broken page, not a switched-off module.
  if (posOff) {
    return (
      <div>
        <Header clientName={clientName} />
        <div role="alert" className="card" style={amberBanner}>
          <strong style={{ color: 'var(--theme-amber-text)' }}>Crest POS is switched off for {clientName}.</strong>{' '}
          Every guest QR code shows "This menu isn't available right now" until POS is switched on in
          Admin → Clients. The guest menu and guest ordering both come with the POS module.
        </div>
      </div>
    )
  }

  if (tables.length === 0) {
    return (
      <div>
        <Header clientName={clientName} />
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>
          This client has no tables set up yet, and a guest menu is reached through a table's QR code.{' '}
          <Link to="/pos/tables" style={linkStyle}>Add a table in Table Management →</Link>
        </div>
      </div>
    )
  }

  const selected = tables.find(t => t.id === selectedId)
  const selectedInactive = selected?.status === 'inactive'
  const inactiveCount = tables.filter(t => t.status === 'inactive').length
  const url = `${window.location.origin}/pos/menu/${selectedId}`
  const emptyMenu = coverage && coverage.total === 0

  function copyLink() {
    clearTimeout(copyTimer.current)
    // Feedback both ways — a denied clipboard permission must not look like a copied link (S574).
    navigator.clipboard.writeText(url)
      .then(() => setCopied('ok'))
      .catch(() => setCopied('fail'))
    copyTimer.current = setTimeout(() => setCopied(''), 2500)
  }

  return (
    <div>
      <Header clientName={clientName} subtitle="The live page a guest sees after scanning this table's QR code.">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label htmlFor="guest-menu-table" className="sr-only">Table to preview</label>
          <select id="guest-menu-table" className="form-select" value={selectedId} onChange={e => setSelectedId(e.target.value)}>
            {tables.map(t => (
              <option key={t.id} value={t.id}>
                {t.name}{t.section ? ` · ${t.section}` : ''}{t.status === 'inactive' ? ' (inactive)' : ''}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-ghost" onClick={copyLink}>
            {copied === 'ok' ? '✓ Copied' : copied === 'fail' ? 'Copy failed — copy from the address bar' : 'Copy Link'}
          </button>
          <span role="status" className="sr-only">{copied === 'ok' ? 'Link copied' : copied === 'fail' ? 'Copy failed' : ''}</span>
          <a className="btn btn-ghost" href={url} target="_blank" rel="noopener noreferrer">Open in New Tab ↗</a>
        </div>
      </Header>

      {emptyMenu && (
        <div role="alert" className="card" style={amberBanner}>
          <strong style={{ color: 'var(--theme-amber-text)' }}>Guests see no menu at all.</strong>{' '}
          {coverage.unpriced > 0
            ? `${coverage.unpriced} ${coverage.unpriced === 1 ? 'dish is' : 'dishes are'} switched on for POS but ${coverage.unpriced === 1 ? 'has' : 'have'} no selling price, and a dish with no price is left off the guest menu — so every QR code shows "This menu isn't available right now".`
            : 'No active dish is switched on for POS, so every QR code shows "This menu isn\'t available right now".'}{' '}
          <Link to="/menu-pricing" style={linkStyle}>Set prices and POS dishes in Menu Pricing →</Link>
        </div>
      )}

      {!emptyMenu && coverage && coverage.unpriced > 0 && (
        <div role="alert" className="card" style={amberBanner}>
          <strong style={{ color: 'var(--theme-amber-text)' }}>
            {coverage.unpriced} {coverage.unpriced === 1 ? 'dish is' : 'dishes are'} left off the guest menu.
          </strong>{' '}
          {coverage.unpriced === 1 ? 'It is' : 'They are'} switched on for POS but {coverage.unpriced === 1 ? 'has' : 'have'} no
          selling price, so guests cannot see or order {coverage.unpriced === 1 ? 'it' : 'them'} until priced.{' '}
          <Link to="/menu-pricing" style={linkStyle}>Price them in Menu Pricing →</Link>
        </div>
      )}

      {selectedInactive && (
        <div role="alert" className="card" style={amberBanner}>
          <strong style={{ color: 'var(--theme-amber-text)' }}>{selected.name} is marked inactive.</strong>{' '}
          Its QR code still shows the menu, but guests cannot order from it — the POS floor cannot open an
          inactive table, so an order sent from it would have nowhere to go.{' '}
          <Link to="/pos/tables" style={linkStyle}>Change table status in Table Management →</Link>
        </div>
      )}

      {/* Stated in words, because the preview cannot say it: a menu with no photos and no
          descriptions looks like a finished page rather than an unfinished one. Only shown when
          there is a real gap — a fully-populated menu gets no nag. */}
      {coverage && coverage.total > 0 && (coverage.images < coverage.total || coverage.descriptions < coverage.total) && (
        <div className="card" style={{ padding: '12px 16px', marginBottom: 14, fontSize: 12.5, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--theme-text1)' }}>This menu is mostly names and prices.</strong>{' '}
          {coverage.images} of {coverage.total} dishes on it have a photo, {coverage.descriptions} have a description
          {coverage.vegMarks < coverage.total ? `, ${coverage.vegMarks} are marked veg or non-veg` : ''}.
          A photo is the single largest lever on a QR menu, and a description is the only way a
          visitor knows what a dish is — both are fields on the recipe.{' '}
          <Link to="/recipes" style={linkStyle}>Edit dishes in Recipes →</Link>
        </div>
      )}

      <div className="card" style={{ padding: '10px 16px', marginBottom: 14, fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
        This is {clientName}'s real, live guest menu. Ordering is switched off inside this preview, so nothing
        you add here reaches their staff.{' '}
        {inactiveCount > 0 && `${inactiveCount} of ${tables.length} tables are inactive and marked in the list. `}
        “Open in New Tab” is the real page, where Place Order sends a genuine pending order to POS Orders — only
        use it if the client expects a test order.
      </div>

      {/* Constrained to a phone width on purpose: 390px is the iPhone 14/15 logical width, the
          most common device to scan one of these, and the only way the one person who can ask
          for the mobile fixes ever sees the mobile layout. */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <div className="card" style={{ padding: 0, overflow: 'hidden', width: 390, maxWidth: '100%' }}>
          <iframe
            key={selectedId}
            src={url}
            title={`Guest menu preview for ${selected?.name || 'this table'}`}
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
