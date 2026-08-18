import { useState, useEffect } from 'react'
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

  useEffect(() => {
    if (!adminViewClientId) { setTables([]); setClientName(''); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    Promise.all([
      supabase.from('clients').select('name').eq('id', adminViewClientId).single(),
      supabase.from('pos_tables').select('id, name, section, status').eq('client_id', adminViewClientId).neq('status', 'inactive').order('sort_order'),
    ]).then(([{ data: client }, { data: rows }]) => {
      if (cancelled) return
      setClientName(client?.name || '')
      setTables(rows || [])
      setSelectedId(rows?.[0]?.id || '')
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

      <div className="card" style={{ padding: '10px 16px', marginBottom: 14, background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.25)', fontSize: 12, color: 'var(--theme-text2)' }}>
        ⚠ This is the real, live guest menu for {clientName} — if guest ordering is enabled and you place an order below, it creates a genuine pending order their staff will see in POS Orders. Preview only; avoid submitting a test order unless the client knows to expect it.
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <iframe
          key={selectedId}
          src={url}
          title="Guest Menu Preview"
          style={{ width: '100%', height: 'calc(100vh - 260px)', minHeight: 500, border: 'none', display: 'block' }}
        />
      </div>
    </div>
  )
}
