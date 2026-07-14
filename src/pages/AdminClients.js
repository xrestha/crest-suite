import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import { scopedInsert } from '../shared/scopedDb'
import { getBsToday } from '../utils/bsCalendar'
import { getSubStatus } from '../utils/subscription'
import Tip from '../components/Tip'
import ClientDrawer from './adminClients/ClientDrawer'
import FeatureAccessModal from './adminClients/FeatureAccessModal'

// ── Subscription badge ────────────────────────────────────────────────────────
function SubBadge({ client }) {
  const s = getSubStatus(client)
  if (!s.label) return <span style={{ color: 'var(--theme-text3)', fontSize: 12 }}>—</span>
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
      color: s.color, background: s.bg, border: `1px solid ${s.border}`,
      whiteSpace: 'nowrap', display: 'inline-block'
    }}>
      {s.label}
    </span>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
const EMPTY_CLIENT_FORM = { name: '', location: '', contact_person: '', contact_phone: '' }

function relativeTime(iso) {
  if (!iso) return null
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 2)   return 'Just now'
  if (mins < 60)  return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)   return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days === 1) return 'Yesterday'
  return `${days}d ago`
}

export default function AdminClients() {
  const [clients, setClients]         = useState([])
  const [loading, setLoading]         = useState(true)
  const [showNewForm, setShowNewForm] = useState(false)
  const [newForm, setNewForm]         = useState(EMPTY_CLIENT_FORM)
  const [saving, setSaving]           = useState(false)
  const [formError, setFormError]     = useState('')
  const [activeDrawer, setActiveDrawer] = useState(null)
  const [featureModalClient, setFeatureModalClient] = useState(null)
  const [lastSeenMap, setLastSeenMap] = useState({})
  const [lastUserMap, setLastUserMap] = useState({})

  useEffect(() => { loadClients(); loadLastSeen() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadLastSeen() {
    const { data } = await supabase.from('profiles').select('client_id, last_seen_at, full_name').not('client_id', 'is', null).not('last_seen_at', 'is', null)
    const timeMap = {}
    const userMap = {}
    for (const row of (data || [])) {
      if (!timeMap[row.client_id] || row.last_seen_at > timeMap[row.client_id]) {
        timeMap[row.client_id] = row.last_seen_at
        userMap[row.client_id] = row.full_name
      }
    }
    setLastSeenMap(timeMap)
    setLastUserMap(userMap)
  }

  async function loadClients() {
    setLoading(true)
    const { data } = await supabase.from('clients').select('*').order('name')
    const now = new Date().toISOString()
    const expired = (data || []).filter(c => {
      if (!c.is_active) return false
      // Check module-specific dates (+ Suite Bundle's own independent expiry); fall back to
      // legacy subscription_ends_at
      const moduleDates = [c.ims_ends_at, c.hr_ends_at, c.pos_ends_at, c.suite_ends_at].filter(Boolean)
      if (moduleDates.length > 0) {
        // Active if ANY module still has time remaining
        return moduleDates.every(d => d < now)
      }
      if (c.subscription_ends_at) return c.subscription_ends_at < now
      return !!(c.trial_ends_at && c.trial_ends_at < now)
    })
    if (expired.length > 0) {
      await Promise.all(expired.map(c =>
        supabase.from('clients').update({ is_active: false }).eq('id', c.id)
      ))
      const { data: refreshed } = await supabase.from('clients').select('*').order('name')
      setClients(refreshed || [])
    } else {
      setClients(data || [])
    }
    setLoading(false)
  }

  async function createClient() {
    if (!newForm.name.trim()) { setFormError('Client name is required.'); return }
    setSaving(true); setFormError('')
    const trialEnd = new Date()
    trialEnd.setDate(trialEnd.getDate() + 30)
    const { data: clientData, error } = await supabase.from('clients').insert({
      name: newForm.name.trim(),
      location: newForm.location.trim(),
      contact_person: newForm.contact_person.trim(),
      contact_phone: newForm.contact_phone.trim(),
      trial_ends_at: trialEnd.toISOString()
    }).select('id').single()
    if (error) { setFormError(error.message); setSaving(false); return }

    if (clientData?.id) {
      const { year: bsYear, month: bsMonth } = getBsToday()
      await Promise.all([
        // Auto-create opening period for the current BS month
        scopedInsert('monthly_periods', clientData.id, {
          bs_year: bsYear,
          bs_month: bsMonth,
          status: 'open'
        }),
        // Seed settings row so client sees their own name in Settings > Branding
        supabase.from('settings').insert({
          client_id: clientData.id,
          app_name: newForm.name.trim(),
        })
      ])
    }

    setSaving(false)
    setShowNewForm(false)
    setNewForm(EMPTY_CLIENT_FORM)
    loadClients()
  }

  async function extendTrial(client) {
    const current = client.trial_expires_at ? new Date(client.trial_expires_at) : new Date()
    const base    = current > new Date() ? current : new Date()
    const newExp  = new Date(base.getTime() + 7 * 24 * 60 * 60 * 1000)
    const newPurge= new Date(newExp.getTime() + 15 * 24 * 60 * 60 * 1000)
    await supabase.from('clients').update({
      trial_expires_at: newExp.toISOString(),
      trial_purge_at:   newPurge.toISOString(),
    }).eq('id', client.id)
    loadClients()
  }

  async function convertTrialToPaid(client) {
    // Clear trial flags; admin sets plan/sub dates in the drawer
    await supabase.from('clients').update({
      is_trial:            false,
      subscribe_requested: false,
      subscribe_requested_at: null,
    }).eq('id', client.id)
    loadClients()
    setActiveDrawer({ ...client, is_trial: false, subscribe_requested: false })
  }

  async function dismissSubscribeRequest(client) {
    await supabase.from('clients').update({ subscribe_requested: false, subscribe_requested_at: null }).eq('id', client.id)
    loadClients()
  }

  async function toggleActive(client, e) {
    e.stopPropagation()
    await supabase.from('clients').update({ is_active: !client.is_active }).eq('id', client.id)
    loadClients()
    if (activeDrawer?.id === client.id) setActiveDrawer(prev => ({ ...prev, is_active: !prev.is_active }))
  }


  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Clients</h1>
          <p className="page-subtitle">{clients.length} propert{clients.length !== 1 ? 'ies' : 'y'} on the platform</p>
        </div>
        <button className="btn btn-primary" onClick={() => { setShowNewForm(true); setFormError('') }}>+ New Client</button>
      </div>

      {/* New client form */}
      {showNewForm && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ margin: '0 0 20px', fontSize: 15, color: 'var(--theme-text1)' }}>New Client</h3>
          <div className="form-grid form-grid-2">
            <div className="form-field">
              <label>Property / Restaurant Name *</label>
              <input value={newForm.name} onChange={e => setNewForm({ ...newForm, name: e.target.value })} placeholder="e.g. Casa Acai Cafe" autoFocus />
            </div>
            <div className="form-field">
              <label><Tip text="City or area where this property operates. Shown on reports and helps identify multi-location clients.">Location</Tip></label>
              <input value={newForm.location} onChange={e => setNewForm({ ...newForm, location: e.target.value })} placeholder="e.g. Jhamsikhel, Kathmandu" />
            </div>
            <div className="form-field">
              <label><Tip text="Primary contact — owner or manager name used for billing and support correspondence.">Contact Person</Tip></label>
              <input value={newForm.contact_person} onChange={e => setNewForm({ ...newForm, contact_person: e.target.value })} placeholder="Owner / Manager name" />
            </div>
            <div className="form-field">
              <label>Phone</label>
              <input value={newForm.contact_phone} onChange={e => setNewForm({ ...newForm, contact_phone: e.target.value })} placeholder="98XXXXXXXX" />
            </div>
          </div>
          {formError && <p style={{ color: 'var(--theme-red)', fontSize: 13, margin: '12px 0 0' }}>{formError}</p>}
          <div className="form-actions">
            <button className="btn btn-ghost" onClick={() => { setShowNewForm(false); setNewForm(EMPTY_CLIENT_FORM) }}>Cancel</button>
            <button className="btn btn-primary" onClick={createClient} disabled={saving}>{saving ? 'Creating…' : 'Create Client'}</button>
          </div>
        </div>
      )}

      {/* ── Trial Accounts ── */}
      {(() => {
        const trialClients = clients.filter(c => c.is_trial)
        if (trialClients.length === 0) return null
        const now = new Date()
        return (
          <div style={{ marginBottom: 28, border: '2px solid #f87171', borderRadius: 12, overflow: 'hidden' }}>
            {/* Header */}
            <div style={{ background: 'linear-gradient(135deg, #450a0a 0%, #7f1d1d 100%)', padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 18 }}>🧪</span>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#fecaca', letterSpacing: 0.3 }}>
                  Trial Accounts
                  <span style={{ marginLeft: 8, background: '#f87171', color: '#fff', borderRadius: 12, padding: '2px 8px', fontSize: 12, fontWeight: 800 }}>{trialClients.length}</span>
                </div>
                <div style={{ fontSize: 11, color: '#fca5a5', marginTop: 2 }}>
                  {trialClients.filter(c => c.subscribe_requested).length > 0
                    ? `${trialClients.filter(c => c.subscribe_requested).length} requesting to subscribe`
                    : 'Free trial users — 7 days · Starter plan'}
                </div>
              </div>
            </div>
            {/* Rows */}
            <div style={{ background: 'rgba(239,68,68,0.04)' }}>
              {trialClients.map(c => {
                const expAt   = c.trial_expires_at ? new Date(c.trial_expires_at) : null
                const purgeAt = c.trial_purge_at   ? new Date(c.trial_purge_at)   : null
                const expired = expAt && expAt < now
                const daysLeft= expAt && !expired ? Math.ceil((expAt - now) / 86400000) : null
                const purgeDays = purgeAt && expired ? Math.ceil((purgeAt - now) / 86400000) : null
                const wantsToSub = c.subscribe_requested
                return (
                  <div key={c.id} style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px',
                    borderBottom: '1px solid rgba(239,68,68,0.12)',
                    background: wantsToSub ? 'rgba(239,68,68,0.06)' : 'transparent',
                  }}>
                    {/* Subscribe badge */}
                    {wantsToSub && (
                      <div style={{ position: 'relative', flexShrink: 0 }}>
                        <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: '#f87171', boxShadow: '0 0 0 0 rgba(248,113,113,0.5)', animation: 'pulse-dot 1.5s infinite' }} />
                      </div>
                    )}
                    {/* Info */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                        {wantsToSub && (
                          <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color: '#fff', background: '#ef4444', borderRadius: 8, padding: '2px 7px' }}>
                            Wants to Subscribe
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 2 }}>
                        {c.trial_start_date && (
                          <span style={{ color: 'var(--theme-text3)', marginRight: 8 }}>
                            Signed up {relativeTime(c.trial_start_date)}
                            {c.contact_person && c.contact_person !== c.name ? ` · ${c.contact_person}` : ''}
                          </span>
                        )}
                        {expired
                          ? <span style={{ color: '#f87171', fontWeight: 600 }}>
                              · Trial expired{purgeDays != null && purgeDays > 0 ? ` · data purge in ${purgeDays}d` : ' · purge imminent'}
                            </span>
                          : daysLeft != null
                            ? <span style={{ color: daysLeft <= 2 ? '#f59e0b' : 'var(--theme-text2)' }}>
                                · {daysLeft === 0 ? 'Expires today' : `${daysLeft} day${daysLeft !== 1 ? 's' : ''} left`}
                              </span>
                            : ''}
                        {c.contact_phone && (
                          <span style={{ marginLeft: 8, color: 'var(--theme-text3)' }}>
                            · 📱 <a href={`https://wa.me/977${c.contact_phone.replace(/^0/, '')}`} target="_blank" rel="noreferrer" style={{ color: 'var(--theme-green)', textDecoration: 'none' }}>{c.contact_phone}</a>
                          </span>
                        )}
                      </div>
                    </div>
                    {/* Actions */}
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      {wantsToSub && (
                        <button
                          className="btn btn-ghost"
                          style={{ fontSize: 11, padding: '4px 8px', color: 'var(--theme-text2)' }}
                          onClick={() => dismissSubscribeRequest(c)}
                          title="Mark as handled">
                          ✓ Dismiss
                        </button>
                      )}
                      <button
                        className="btn btn-ghost"
                        style={{ fontSize: 11, padding: '4px 8px' }}
                        onClick={() => extendTrial(c)}
                        title="Add 7 more days to the trial">
                        +7 Days
                      </button>
                      <button
                        className="btn btn-primary"
                        style={{ fontSize: 11, padding: '4px 10px' }}
                        onClick={() => convertTrialToPaid(c)}>
                        Convert to Paid
                      </button>
                      <button
                        className="btn btn-ghost"
                        style={{ fontSize: 11, padding: '4px 8px', color: 'var(--theme-red)' }}
                        onClick={() => setActiveDrawer(c)}>
                        Manage
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })()}

      {/* Client cards */}
      {loading ? (
        <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p></div>
      ) : clients.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">⊛</div>
            <p className="empty-state-text">No clients yet. Create your first property to get started.</p>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {clients.filter(c => !c.is_trial).map(c => {
            const rel      = relativeTime(lastSeenMap[c.id])
            const isRecent = lastSeenMap[c.id] && Date.now() - new Date(lastSeenMap[c.id]).getTime() < 86400000
            const lastUser = lastUserMap[c.id]
            const planLabel = p => p === 'pro' ? 'Pro' : p === 'growth' ? 'Growth' : 'Starter'

            return (
              <div
                key={c.id}
                onClick={() => setActiveDrawer(c)}
                style={{
                  background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 8,
                  overflow: 'hidden', cursor: 'pointer', transition: 'border-color 0.15s',
                }}
                onMouseEnter={e => e.currentTarget.style.borderColor = '#3a3f4d'}
                onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--theme-border)'}
              >
                {/* Main row */}
                <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                  {/* Name + status */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>{c.name}</span>
                      <span className={`badge ${c.is_active ? 'badge-green' : 'badge-gray'}`}>{c.is_active ? 'Active' : 'Inactive'}</span>
                      {rel && (
                        <span style={{ fontSize: 11, color: isRecent ? 'var(--theme-green)' : 'var(--theme-text3)', fontWeight: isRecent ? 600 : 400 }}>
                          {rel}{lastUser && <span style={{ color: 'var(--theme-text3)', fontWeight: 400 }}> · {lastUser}</span>}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 2 }}>
                      {[c.location, c.contact_person, c.contact_phone].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>

                  {/* Module pills */}
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                    {[
                      { key: 'IMS', enabled: c.ims_enabled !== false, plan: c.plan,     color: '#60a5fa', borderRgba: 'rgba(96,165,250,0.4)' },
                      { key: 'HR',  enabled: !!c.hr_enabled,          plan: c.hr_plan,  color: '#34d399', borderRgba: 'rgba(52,211,153,0.35)' },
                      { key: 'POS', enabled: !!c.pos_enabled,         plan: c.pos_plan, color: '#a78bfa', borderRgba: 'rgba(167,139,250,0.35)' },
                    ].map(m => (
                      <span key={m.key} style={{
                        fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
                        border: `1px solid ${m.enabled ? m.borderRgba : 'var(--theme-border)'}`,
                        color: m.enabled ? m.color : 'var(--theme-text3)',
                        background: 'transparent',
                      }}>
                        {m.key}{m.enabled ? ` · ${planLabel(m.plan || 'starter')}` : ' · off'}
                      </span>
                    ))}
                  </div>

                  {/* Sub badge + Manage */}
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                    {c.billing_cycle === 'annual' && (c.ims_ends_at || c.subscription_ends_at) && (
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4, color: '#000', background: 'var(--theme-accent)' }}>Annual</span>
                    )}
                    <SubBadge client={c} />
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: 11, padding: '4px 10px', color: 'var(--theme-accent)', borderColor: 'rgba(201,168,76,0.3)' }}
                      onClick={e => { e.stopPropagation(); setActiveDrawer(c) }}
                    >
                      Manage →
                    </button>
                  </div>
                </div>

                {/* Secondary action bar */}
                <div
                  style={{ padding: '6px 16px', borderTop: '1px solid var(--theme-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.15)' }}
                  onClick={e => e.stopPropagation()}
                >
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: 10, padding: '2px 8px', color: '#818cf8', borderColor: 'rgba(129,140,248,0.25)' }}
                    onClick={e => { e.stopPropagation(); setFeatureModalClient(c) }}
                  >
                    Features ⊞
                  </button>
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: 10, padding: '2px 8px' }}
                    onClick={e => toggleActive(c, e)}
                  >
                    {c.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Slide-over drawer */}
      {activeDrawer && (
        <ClientDrawer
          client={activeDrawer}
          onClose={() => setActiveDrawer(null)}
          onClientUpdated={() => { loadClients() }}
        />
      )}

      {/* Feature Access modal */}
      {featureModalClient && (
        <FeatureAccessModal
          client={featureModalClient}
          onClose={() => setFeatureModalClient(null)}
        />
      )}
    </div>
  )
}
