import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import { getBsToday } from '../utils/bsCalendar'
import { useNavigate } from 'react-router-dom'
import Tip from '../components/Tip'

const BS_MONTHS = [
  'Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin',
  'Kartik','Mangsir','Poush','Magh','Falgun','Chaitra'
]

export default function Periods() {
  const { isAdmin, clientId, switchAdminClient } = useAuth()
  const navigate = useNavigate()
  const [periods, setPeriods] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ bs_year: 2082, bs_month: 1 })
  const [showForm, setShowForm] = useState(false)
  const [error, setError] = useState('')

  // Inline edit state
  const [editingId, setEditingId] = useState(null)
  const [editForm, setEditForm] = useState({ bs_year: '', bs_month: 1 })
  const [editError, setEditError] = useState('')
  const [saving, setSaving] = useState(false)
  const [showAll, setShowAll] = useState(false)

  // Admin all-clients state
  const [allClients, setAllClients] = useState([])
  const [allClientPeriods, setAllClientPeriods] = useState({})
  const [allLoading, setAllLoading] = useState(false)
  const [actionClientId, setActionClientId] = useState(null)
  const [editingAllClientId, setEditingAllClientId] = useState(null)
  const [editAllForm, setEditAllForm] = useState({ bs_year: '', bs_month: 1 })
  const [editAllError, setEditAllError] = useState('')
  const [savingAll, setSavingAll] = useState(false)

  const effectiveClientId = clientId
  const bsToday = getBsToday()

  useEffect(() => {
    if (isAdmin && !clientId) loadAllClientPeriods()
    else if (clientId) loadPeriods()
    else setLoading(false)
  }, [clientId, isAdmin]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAllClientPeriods() {
    setAllLoading(true)
    const [{ data: clients }, { data: allPeriods }] = await Promise.all([
      supabase.from('clients').select('id, name, is_active').order('name'),
      supabase.from('monthly_periods').select('*')
        .order('bs_year', { ascending: false })
        .order('bs_month', { ascending: false }),
    ])
    setAllClients(clients || [])
    const map = {}
    for (const p of (allPeriods || [])) {
      if (!map[p.client_id]) map[p.client_id] = []
      map[p.client_id].push(p)
    }
    setAllClientPeriods(map)
    setAllLoading(false)
  }

  async function adminCloseAndAdvance(period, cid) {
    const nextMonth = period.bs_month === 12 ? 1 : period.bs_month + 1
    const nextYear  = period.bs_month === 12 ? period.bs_year + 1 : period.bs_year
    if (!window.confirm(`Close ${BS_MONTHS[period.bs_month - 1]} ${period.bs_year} and open ${BS_MONTHS[nextMonth - 1]} ${nextYear}?`)) return
    setActionClientId(cid)
    await supabase.from('monthly_periods').update({ status: 'closed' }).eq('id', period.id)
    await supabase.from('monthly_periods').insert({ client_id: cid, bs_year: nextYear, bs_month: nextMonth, status: 'open' })
    await loadAllClientPeriods()
    setActionClientId(null)
  }

  async function adminEndPeriod(period, cid) {
    if (!window.confirm(`End ${BS_MONTHS[period.bs_month - 1]} ${period.bs_year} for this client without starting a new period?\n\nThe client will be blocked from recording data until a new period is created.`)) return
    setActionClientId(cid)
    await supabase.from('monthly_periods').update({ status: 'closed' }).eq('id', period.id)
    await loadAllClientPeriods()
    setActionClientId(null)
  }

  async function adminCreatePeriod(cid) {
    setActionClientId(cid)
    const existing = (allClientPeriods[cid] || []).find(
      p => p.bs_year === bsToday.year && p.bs_month === bsToday.month
    )
    if (existing) {
      await supabase.from('monthly_periods').update({ status: 'open' }).eq('id', existing.id)
    } else {
      const { error } = await supabase.from('monthly_periods').insert({
        client_id: cid, bs_year: bsToday.year, bs_month: bsToday.month, status: 'open'
      })
      if (error) alert(error.message)
    }
    await loadAllClientPeriods()
    setActionClientId(null)
  }

  async function saveAllEdit(periodId, cid) {
    setEditAllError('')
    const year = parseInt(editAllForm.bs_year)
    const month = parseInt(editAllForm.bs_month)
    if (!year || year < 2070 || year > 2100) { setEditAllError('Enter a valid BS year (2070–2100).'); return }
    const duplicate = (allClientPeriods[cid] || []).find(p => p.id !== periodId && p.bs_year === year && p.bs_month === month)
    if (duplicate) { setEditAllError('A period for this month already exists.'); return }
    setSavingAll(true)
    const { error } = await supabase.from('monthly_periods').update({ bs_year: year, bs_month: month }).eq('id', periodId).eq('status', 'open')
    if (error) { setEditAllError(error.message.includes('unique') ? 'A period for this month already exists.' : error.message) }
    else { setEditingAllClientId(null); await loadAllClientPeriods() }
    setSavingAll(false)
  }

  async function loadPeriods() {
    setLoading(true)
    const { data } = await supabase
      .from('monthly_periods')
      .select('*')
      .eq('client_id', effectiveClientId)
      .order('bs_year', { ascending: false })
      .order('bs_month', { ascending: false })
    setPeriods(data || [])
    setLoading(false)
  }

  async function createPeriod() {
    setError('')
    setCreating(true)
    const { error } = await supabase.from('monthly_periods').insert({
      client_id: clientId,
      bs_year: parseInt(form.bs_year),
      bs_month: parseInt(form.bs_month),
      status: 'open'
    })
    if (error) {
      setError(error.message.includes('unique') ? 'A period for this month already exists.' : error.message)
    } else {
      setShowForm(false)
      loadPeriods()
    }
    setCreating(false)
  }

  async function closeAndAdvance(period) {
    const nextMonth = period.bs_month === 12 ? 1 : period.bs_month + 1
    const nextYear  = period.bs_month === 12 ? period.bs_year + 1 : period.bs_year
    if (!window.confirm(
      `Close ${BS_MONTHS[period.bs_month - 1]} ${period.bs_year} and open ${BS_MONTHS[nextMonth - 1]} ${nextYear}?`
    )) return
    await supabase.from('monthly_periods').update({ status: 'closed' }).eq('id', period.id)
    const { error } = await supabase.from('monthly_periods').insert({
      client_id: effectiveClientId,
      bs_year: nextYear,
      bs_month: nextMonth,
      status: 'open'
    })
    if (error && !error.message.includes('unique') && error.code !== '23505') {
      console.error('Could not create next period:', error)
    }
    loadPeriods()
  }

  async function reopenPeriod(id) {
    await supabase.from('monthly_periods').update({ status: 'open' }).eq('id', id)
    loadPeriods()
  }

  function startEdit(p) {
    setEditingId(p.id)
    setEditForm({ bs_year: p.bs_year, bs_month: p.bs_month })
    setEditError('')
  }

  function cancelEdit() {
    setEditingId(null)
    setEditError('')
  }

  async function saveEdit(id) {
    setEditError('')
    const year = parseInt(editForm.bs_year)
    const month = parseInt(editForm.bs_month)

    if (!year || year < 2070 || year > 2100) {
      setEditError('Enter a valid BS year (2070–2100).')
      return
    }

    // Check for duplicate (exclude current row)
    const duplicate = periods.find(
      p => p.id !== id && p.bs_year === year && p.bs_month === month
    )
    if (duplicate) {
      setEditError('A period for this month already exists.')
      return
    }

    setSaving(true)
    const { error } = await supabase
      .from('monthly_periods')
      .update({ bs_year: year, bs_month: month })
      .eq('id', id)
      .eq('status', 'open') // safety guard — DB-level protection

    if (error) {
      setEditError(error.message.includes('unique') ? 'A period for this month already exists.' : error.message)
    } else {
      setEditingId(null)
      loadPeriods()
    }
    setSaving(false)
  }

  // Archive: hide closed periods older than 12 months by default
  function isRecent(p) {
    const monthsAgo = (bsToday.year - p.bs_year) * 12 + (bsToday.month - p.bs_month)
    return monthsAgo <= 12
  }
  const visiblePeriods = showAll ? periods : periods.filter(p => p.status === 'open' || isRecent(p))
  const archivedCount  = periods.length - visiblePeriods.length

  const openCount   = periods.filter(p => p.status === 'open').length
  const openPeriod  = periods.find(p => p.status === 'open')
  const periodExpired = !isAdmin && openPeriod && (
    openPeriod.bs_year < bsToday.year ||
    (openPeriod.bs_year === bsToday.year && openPeriod.bs_month < bsToday.month)
  )
  const nextAdvMonth = openPeriod ? (openPeriod.bs_month === 12 ? 1 : openPeriod.bs_month + 1) : null

  // ── Admin all-clients view ───────────────────────────────────────────────
  if (isAdmin && !clientId) {
    const needsAttention = allClients.filter(c => {
      if (!c.is_active) return false
      const cp = allClientPeriods[c.id] || []
      const open = cp.find(p => p.status === 'open')
      if (!open) return true
      return open.bs_year < bsToday.year || (open.bs_year === bsToday.year && open.bs_month < bsToday.month)
    })

    return (
      <div>
        <div className="page-header">
          <div>
            <h1 className="page-title">Periods</h1>
            <p className="page-subtitle">
              Manage BS periods across all properties
              {needsAttention.length > 0 && (
                <span style={{ marginLeft: 12, color: '#fbbf24', fontWeight: 600 }}>
                  · {needsAttention.length} need{needsAttention.length === 1 ? 's' : ''} attention
                </span>
              )}
            </p>
          </div>
        </div>

        <div className="card" style={{ padding: 0 }}>
          {allLoading ? (
            <p style={{ padding: 20, color: '#6b7280', fontSize: 13 }}>Loading…</p>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Property</th>
                    <th>Open Period</th>
                    <th>Status</th>
                    <th>Total</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {allClients.map(c => {
                    const cp = allClientPeriods[c.id] || []
                    const openPeriod = cp.find(p => p.status === 'open')
                    const expired = openPeriod && (
                      openPeriod.bs_year < bsToday.year ||
                      (openPeriod.bs_year === bsToday.year && openPeriod.bs_month < bsToday.month)
                    )
                    const isWorking = actionClientId === c.id
                    const isEditingThis = editingAllClientId === c.id

                    return (
                      <tr key={c.id} style={{ opacity: c.is_active ? 1 : 0.45 }}>
                        <td>
                          <button
                            onClick={() => { switchAdminClient(c.id, c.name); navigate('/periods') }}
                            style={{ background: 'none', border: 'none', color: '#e8e0d0', fontWeight: 600, cursor: 'pointer', fontSize: 13, padding: 0, textAlign: 'left' }}
                          >
                            {c.name}
                          </button>
                        </td>

                        {isEditingThis ? (
                          <td colSpan={2}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                              <input
                                type="number" value={editAllForm.bs_year}
                                onChange={e => setEditAllForm(f => ({ ...f, bs_year: e.target.value }))}
                                min="2070" max="2100"
                                style={{ width: 90, padding: '4px 8px', fontSize: 13, background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 6, color: '#e8e0d0' }}
                              />
                              <select
                                value={editAllForm.bs_month}
                                onChange={e => setEditAllForm(f => ({ ...f, bs_month: parseInt(e.target.value) }))}
                                style={{ padding: '4px 8px', fontSize: 13, background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 6, color: '#e8e0d0' }}
                              >
                                {BS_MONTHS.map((m, i) => <option key={i} value={i + 1}>{i + 1} — {m}</option>)}
                              </select>
                              {editAllError && <span style={{ color: '#f87171', fontSize: 11 }}>{editAllError}</span>}
                            </div>
                          </td>
                        ) : (
                          <>
                            <td style={{ color: expired ? '#fbbf24' : '#e8e0d0' }}>
                              {openPeriod ? `${BS_MONTHS[openPeriod.bs_month - 1]} ${openPeriod.bs_year}` : <span style={{ color: '#4b5563' }}>—</span>}
                            </td>
                            <td>
                              {openPeriod
                                ? expired
                                  ? <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, color: '#fbbf24', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)' }}>EXPIRED</span>
                                  : <span className="badge badge-green">OPEN</span>
                                : <span className="badge badge-gray">NO PERIOD</span>
                              }
                            </td>
                          </>
                        )}

                        <td style={{ color: '#6b7280', fontSize: 12 }}>{cp.length}</td>
                        <td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
                            {isEditingThis ? (
                              <>
                                <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                                  onClick={() => { setEditingAllClientId(null); setEditAllError('') }} disabled={savingAll}>
                                  Cancel
                                </button>
                                <button className="btn btn-primary" style={{ fontSize: 11, padding: '4px 10px' }}
                                  onClick={() => saveAllEdit(openPeriod.id, c.id)} disabled={savingAll}>
                                  {savingAll ? 'Saving…' : 'Save'}
                                </button>
                              </>
                            ) : isWorking ? (
                              <span style={{ fontSize: 12, color: '#6b7280' }}>Working…</span>
                            ) : (
                              <>
                                {openPeriod && (
                                  <button
                                    title="Edit period"
                                    onClick={() => { setEditingAllClientId(c.id); setEditAllForm({ bs_year: openPeriod.bs_year, bs_month: openPeriod.bs_month }); setEditAllError('') }}
                                    style={{ fontSize: 13, padding: '4px 9px', borderRadius: 5, cursor: 'pointer', background: 'rgba(201,168,76,0.07)', border: '1px solid rgba(201,168,76,0.35)', color: '#c9a84c' }}
                                  >✏</button>
                                )}
                                {openPeriod ? (
                                  <>
                                    <button
                                      onClick={() => adminCloseAndAdvance(openPeriod, c.id)}
                                      style={{ fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 5, cursor: 'pointer', background: 'rgba(248,113,113,0.07)', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171' }}
                                    >
                                      Close & Start Next
                                    </button>
                                    <button
                                      onClick={() => adminEndPeriod(openPeriod, c.id)}
                                      style={{ fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 5, cursor: 'pointer', background: 'rgba(127,29,29,0.2)', border: '1px solid rgba(185,28,28,0.5)', color: '#b91c1c' }}
                                    >
                                      End Period
                                    </button>
                                    <Tip text="Closes this period without opening the next one. The client will be blocked from recording data until a new period is created." width={240}>ⓘ</Tip>
                                  </>
                                ) : (
                                  <button
                                    onClick={() => adminCreatePeriod(c.id)}
                                    style={{ fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 5, cursor: 'pointer', background: 'rgba(52,211,153,0.07)', border: '1px solid rgba(52,211,153,0.3)', color: '#34d399' }}
                                  >
                                    + Create Period
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Periods</h1>
          <p className="page-subtitle">One period per BS month — all inventory entries are linked to a period</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {archivedCount > 0 && (
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setShowAll(v => !v)}>
              {showAll ? '▴ Hide Archived' : `▾ Show Archived (${archivedCount})`}
            </button>
          )}
          {isAdmin && (
            <button className="btn btn-primary" onClick={() => { setShowForm(!showForm); setError('') }}>
              + New Period
            </button>
          )}
        </div>
      </div>

      {isAdmin && showForm && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ margin: '0 0 20px', fontSize: 15, color: '#e8e0d0' }}>Create Period</h3>
          <div className="form-grid form-grid-2" style={{ maxWidth: 400 }}>
            <div className="form-field">
              <label>BS Year</label>
              <input
                type="number"
                value={form.bs_year}
                onChange={e => setForm({ ...form, bs_year: e.target.value })}
                min="2070" max="2100"
              />
            </div>
            <div className="form-field">
              <label>BS Month</label>
              <select value={form.bs_month} onChange={e => setForm({ ...form, bs_month: e.target.value })}>
                {BS_MONTHS.map((m, i) => (
                  <option key={i} value={i + 1}>{i + 1} — {m}</option>
                ))}
              </select>
            </div>
          </div>
          {error && <p style={{ color: '#f87171', fontSize: 13, margin: '12px 0 0' }}>{error}</p>}
          <div className="form-actions">
            <button className="btn btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={createPeriod} disabled={creating}>
              {creating ? 'Creating…' : 'Create Period'}
            </button>
          </div>
        </div>
      )}

      {periodExpired && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'rgba(251,191,36,0.35)', background: 'rgba(251,191,36,0.04)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
            <div>
              <p style={{ color: '#fbbf24', margin: 0, fontSize: 14, fontWeight: 600 }}>
                ◷ {BS_MONTHS[openPeriod.bs_month - 1]} {openPeriod.bs_year} has ended
              </p>
              <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 12 }}>
                Finish your month-end stock count, then close this period and open {BS_MONTHS[nextAdvMonth - 1]}.
              </p>
            </div>
            <button
              onClick={() => closeAndAdvance(openPeriod)}
              style={{
                flexShrink: 0, background: 'rgba(251,191,36,0.12)',
                border: '1px solid rgba(251,191,36,0.4)', color: '#fbbf24',
                borderRadius: 6, padding: '8px 18px', cursor: 'pointer',
                fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap'
              }}
            >
              End {BS_MONTHS[openPeriod.bs_month - 1]} & Start {BS_MONTHS[nextAdvMonth - 1]} →
            </button>
          </div>
        </div>
      )}

      {openCount > 1 && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'rgba(251,191,36,0.3)' }}>
          <p style={{ color: '#fbbf24', fontSize: 13, margin: 0 }}>
            ⚠ You have {openCount} open periods. It's recommended to keep only one open at a time.
          </p>
        </div>
      )}

      <div className="card">
        {loading ? (
          <p style={{ color: '#6b7280', fontSize: 13 }}>Loading…</p>
        ) : periods.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">◷</div>
            <p className="empty-state-text">No periods yet. Create one to start tracking inventory.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>BS Year</th>
                  <th>BS Month</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visiblePeriods.map(p => {
                  const isEditing = editingId === p.id
                  const canEdit = p.status === 'open' // both admin and client can edit open periods

                  return (
                    <tr key={p.id}>
                      {isEditing ? (
                        <>
                          {/* Inline edit row */}
                          <td colSpan={3}>
                            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                              <input
                                type="number"
                                value={editForm.bs_year}
                                onChange={e => setEditForm({ ...editForm, bs_year: e.target.value })}
                                min="2070" max="2100"
                                style={{
                                  width: 90, padding: '4px 8px', fontSize: 13,
                                  background: '#0f1117', border: '1px solid #2a2f3d',
                                  borderRadius: 6, color: '#e8e0d0'
                                }}
                              />
                              <select
                                value={editForm.bs_month}
                                onChange={e => setEditForm({ ...editForm, bs_month: parseInt(e.target.value) })}
                                style={{
                                  padding: '4px 8px', fontSize: 13,
                                  background: '#0f1117', border: '1px solid #2a2f3d',
                                  borderRadius: 6, color: '#e8e0d0'
                                }}
                              >
                                {BS_MONTHS.map((m, i) => (
                                  <option key={i} value={i + 1}>{i + 1} — {m}</option>
                                ))}
                              </select>
                              {editError && (
                                <span style={{ color: '#f87171', fontSize: 12 }}>{editError}</span>
                              )}
                            </div>
                          </td>
                          <td>
                            <span className="badge badge-green">OPEN</span>
                          </td>
                          <td style={{ color: '#6b7280' }}>
                            {new Date(p.created_at).toLocaleDateString()}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                              <button
                                className="btn btn-ghost"
                                style={{ fontSize: 12, padding: '5px 12px' }}
                                onClick={cancelEdit}
                              >
                                Cancel
                              </button>
                              <button
                                className="btn btn-primary"
                                style={{ fontSize: 12, padding: '5px 12px' }}
                                onClick={() => saveEdit(p.id)}
                                disabled={saving}
                              >
                                {saving ? 'Saving…' : 'Save'}
                              </button>
                            </div>
                          </td>
                        </>
                      ) : (
                        <>
                          {/* Normal display row */}
                          <td style={{ fontWeight: 600, color: '#e8e0d0' }}>
                            {BS_MONTHS[p.bs_month - 1]} {p.bs_year}
                          </td>
                          <td>{p.bs_year}</td>
                          <td>{BS_MONTHS[p.bs_month - 1]}</td>
                          <td>
                            {p.status === 'open' ? (
                              <span className="badge badge-green">OPEN</span>
                            ) : (
                              <span className="badge badge-red">CLOSED</span>
                            )}
                          </td>
                          <td style={{ color: '#6b7280' }}>
                            {new Date(p.created_at).toLocaleDateString()}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
                              {/* Edit pencil — open periods, admin only */}
                              {canEdit && isAdmin && (
                                <button
                                  className="btn btn-ghost"
                                  title="Edit period"
                                  style={{ fontSize: 13, padding: '5px 10px', lineHeight: 1, color: '#c9a84c', borderColor: 'rgba(201,168,76,0.35)', background: 'rgba(201,168,76,0.07)' }}
                                  onClick={() => startEdit(p)}
                                >
                                  ✏
                                </button>
                              )}
                              {/* Close / Reopen — admin only */}
                              {isAdmin && (p.status === 'open' ? (
                                <button
                                  className="btn btn-ghost"
                                  style={{ fontSize: 12, padding: '5px 12px', color: '#f87171', borderColor: 'rgba(248,113,113,0.35)', background: 'rgba(248,113,113,0.07)' }}
                                  onClick={() => closeAndAdvance(p)}
                                >
                                  Close &amp; Start Next
                                </button>
                              ) : (
                                <button
                                  className="btn btn-ghost"
                                  style={{ fontSize: 12, padding: '5px 12px', color: '#34d399', borderColor: 'rgba(52,211,153,0.35)', background: 'rgba(52,211,153,0.07)' }}
                                  onClick={() => reopenPeriod(p.id)}
                                >
                                  Reopen
                                </button>
                              ))}
                            </div>
                          </td>
                        </>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
