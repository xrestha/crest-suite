import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import { scopedInsert as scopedInsertRaw, scopedUpdate as scopedUpdateRaw } from '../shared/scopedDb'
import { useScopedDb } from '../shared/hooks/useScopedDb'
import { getBsToday } from '../utils/bsCalendar'
import { useNavigate, Navigate } from 'react-router-dom'
import Tip from '../components/Tip'
import { generateMonthlyReport, saveGeneratedReport } from '../modules/ownerReport/generateMonthlyReport'

const BS_MONTHS = [
  'Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin',
  'Kartik','Mangsir','Poush','Magh','Falgun','Chaitra'
]

export default function Periods() {
  const { isAdmin, clientId, profile, switchAdminClient, hasImsAccess, clientModules } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpdate } = useScopedDb()
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

  // Set right after a client-view close — surfaces a "your report is ready" banner. Not used in
  // the admin all-clients batch-close loop (a redirect/nudge per client there would be
  // disruptive across many clients closed in a row).
  const [justClosedReport, setJustClosedReport] = useState(null)

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

  // Copies each item's counted closing qty (closing_stock.physical_qty) into the new period's
  // opening_stock — "this month's closing IS next month's opening," a real physical count, not
  // recomputed. Only ever adds a row for an item that was actually counted (no closing_stock row
  // = nothing carried, same as never entering it manually); upserts rather than plain-inserts so
  // re-running this (e.g. a retried close after a network blip) can't fail on a conflict. Both
  // tables are period-scoped, not client-scoped (see CLAUDE.md), so this stays on raw
  // supabase.from() like the rest of Stock.js's opening/closing reads and writes.
  async function carryForwardOpeningStock(closedPeriodId, newPeriodId) {
    if (!closedPeriodId || !newPeriodId) return
    const { data: closingRows } = await supabase.from('closing_stock')
      .select('item_id, physical_qty').eq('period_id', closedPeriodId)
    const rows = (closingRows || [])
      .filter(r => r.physical_qty != null)
      .map(r => ({ period_id: newPeriodId, item_id: r.item_id, qty: r.physical_qty }))
    if (rows.length === 0) return
    await supabase.from('opening_stock').upsert(rows, { onConflict: 'period_id,item_id' })
  }

  // Best-effort, non-blocking — report generation touches ~10 tables across 3 modules and must
  // never prevent the period itself from actually closing. Swallowed to console.error; the
  // lazy-generate fallback on MonthlyOwnerReport.jsx covers a failed attempt on next view.
  async function generateReportBestEffort(cid, closedPeriod) {
    try {
      const { snapshot, modulesIncluded } = await generateMonthlyReport({ clientId: cid, period: closedPeriod })
      await saveGeneratedReport({ clientId: cid, period: closedPeriod, snapshot, modulesIncluded, actorId: profile?.id, source: 'period_close' })
    } catch (e) {
      console.error('Monthly owner report generation failed (non-blocking):', e)
    }
  }

  async function adminCloseAndAdvance(period, cid) {
    const nextMonth = period.bs_month === 12 ? 1 : period.bs_month + 1
    const nextYear  = period.bs_month === 12 ? period.bs_year + 1 : period.bs_year
    if (!window.confirm(`Close ${BS_MONTHS[period.bs_month - 1]} ${period.bs_year} and open ${BS_MONTHS[nextMonth - 1]} ${nextYear}?`)) return
    setActionClientId(cid)
    await scopedUpdateRaw('monthly_periods', cid, { status: 'closed' }).eq('id', period.id)
    const { data: newPeriod } = await scopedInsertRaw('monthly_periods', cid, { bs_year: nextYear, bs_month: nextMonth, status: 'open' }, { single: true })
    if (newPeriod?.id) await carryForwardOpeningStock(period.id, newPeriod.id)
    await generateReportBestEffort(cid, { ...period, status: 'closed' })
    await loadAllClientPeriods()
    setActionClientId(null)
  }

  async function adminEndPeriod(period, cid) {
    if (!window.confirm(`End ${BS_MONTHS[period.bs_month - 1]} ${period.bs_year} for this client without starting a new period?\n\nThe client will be blocked from recording data until a new period is created.`)) return
    setActionClientId(cid)
    await scopedUpdateRaw('monthly_periods', cid, { status: 'closed' }).eq('id', period.id)
    await generateReportBestEffort(cid, { ...period, status: 'closed' })
    await loadAllClientPeriods()
    setActionClientId(null)
  }

  async function adminCreatePeriod(cid) {
    setActionClientId(cid)
    const existing = (allClientPeriods[cid] || []).find(
      p => p.bs_year === bsToday.year && p.bs_month === bsToday.month
    )
    if (existing) {
      await scopedUpdateRaw('monthly_periods', cid, { status: 'open' }).eq('id', existing.id)
    } else {
      const { error } = await scopedInsertRaw('monthly_periods', cid, {
        bs_year: bsToday.year, bs_month: bsToday.month, status: 'open'
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
    const { error } = await scopedUpdateRaw('monthly_periods', cid, { bs_year: year, bs_month: month }).eq('id', periodId).eq('status', 'open')
    if (error) { setEditAllError(error.message.includes('unique') ? 'A period for this month already exists.' : error.message) }
    else { setEditingAllClientId(null); await loadAllClientPeriods() }
    setSavingAll(false)
  }

  async function loadPeriods() {
    setLoading(true)
    const { data } = await scopedFrom('monthly_periods')
      .order('bs_year', { ascending: false })
      .order('bs_month', { ascending: false })
    setPeriods(data || [])
    setLoading(false)
  }

  async function createPeriod() {
    if (!clientId) { setError('No client selected. Pick a client in the top-left switcher before creating a period.'); return }
    setError('')
    setCreating(true)
    const { error } = await scopedInsert('monthly_periods', {
      bs_year: parseInt(form.bs_year),
      bs_month: parseInt(form.bs_month),
      status: 'open'
    })
    if (error) {
      // Two distinct unique constraints can fire here — the message must distinguish them, or
      // trying to open a new period while a DIFFERENT month is already open would confusingly
      // say "a period for THIS month already exists" (the wrong constraint's message).
      setError(
        error.message.includes('one_open_per_client') ? 'A period is already open for this client. Close it before opening another.'
          : error.message.includes('unique') ? 'A period for this month already exists.'
          : error.message
      )
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
    await scopedUpdate('monthly_periods', { status: 'closed' }).eq('id', period.id)
    const { data: newPeriod, error } = await scopedInsert('monthly_periods', {
      bs_year: nextYear,
      bs_month: nextMonth,
      status: 'open'
    }, { single: true })
    let nextPeriodId = newPeriod?.id
    if (error) {
      if (error.message.includes('unique') || error.code === '23505') {
        // Next period already existed (e.g. a retried click) — still carry forward into it.
        const { data: existing } = await scopedFrom('monthly_periods', 'id')
          .eq('bs_year', nextYear).eq('bs_month', nextMonth).maybeSingle()
        nextPeriodId = existing?.id
      } else {
        console.error('Could not create next period:', error)
      }
    }
    if (nextPeriodId) await carryForwardOpeningStock(period.id, nextPeriodId)
    await generateReportBestEffort(clientId, { ...period, status: 'closed' })
    setJustClosedReport({ bsYear: period.bs_year, bsMonth: period.bs_month })
    loadPeriods()
  }

  async function reopenPeriod(id) {
    // monthly_periods_one_open_per_client (a partial unique index on client_id WHERE status='open')
    // blocks this whenever a later period is already open — which is virtually always true, since
    // the only real reason to reopen a PAST period is to fix a mistake discovered after the client
    // already moved on to the current one. Previously this error was silently swallowed, so the
    // button looked broken with zero explanation. Surfaced here; "Resync Opening Stock" below is
    // the actual fix for that scenario — it doesn't touch status at all, so it can never hit this.
    const { error } = await scopedUpdate('monthly_periods', { status: 'open' }).eq('id', id)
    if (error) {
      window.alert(
        error.code === '23505' || error.message?.includes('one_open_per_client')
          ? 'Can\'t reopen — a more recent period is already open for this client (only one period can be open at a time). To correct a closed period\'s numbers instead, edit it directly as admin (Stock Count already allows this on a closed period) and use "Resync Opening Stock" to push the correction into whatever period comes next.'
          : `Failed to reopen: ${error.message}`
      )
      return
    }
    loadPeriods()
  }

  // Admin-only correction path that never touches status, so it can never collide with
  // monthly_periods_one_open_per_client — admin can already edit a closed period's Closing Stock
  // directly (Stock.js's isLocked is `!isAdmin && closed`), this just re-runs the same carry-
  // forward a normal Close & Start Next would have done, into whichever period comes right after.
  async function resyncOpeningStock(period) {
    const nextMonth = period.bs_month === 12 ? 1 : period.bs_month + 1
    const nextYear  = period.bs_month === 12 ? period.bs_year + 1 : period.bs_year
    const { data: nextPeriod } = await scopedFrom('monthly_periods', 'id')
      .eq('bs_year', nextYear).eq('bs_month', nextMonth).maybeSingle()
    if (!nextPeriod) {
      window.alert(`No ${BS_MONTHS[nextMonth - 1]} ${nextYear} period exists yet for this client — nothing to sync into.`)
      return
    }
    if (!window.confirm(
      `Copy ${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}'s closing stock into ${BS_MONTHS[nextMonth - 1]} ${nextYear}'s opening stock?\n\nThis overwrites ${BS_MONTHS[nextMonth - 1]} ${nextYear}'s existing opening stock for any item that has a closing count in ${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}.`
    )) return
    await carryForwardOpeningStock(period.id, nextPeriod.id)
    window.alert(`Opening stock re-synced into ${BS_MONTHS[nextMonth - 1]} ${nextYear}.`)
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
    const { error } = await scopedUpdate('monthly_periods', { bs_year: year, bs_month: month })
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
  // Periods is a shared cross-module page (HR/POS-only clients use it too, not just IMS) — the
  // role gate must only apply when the client actually has IMS, same reasoning as MenuPricing.js.
  if (clientModules?.ims && !hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />

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
                <span style={{ marginLeft: 12, color: 'var(--theme-amber)', fontWeight: 600 }}>
                  · {needsAttention.length} need{needsAttention.length === 1 ? 's' : ''} attention
                </span>
              )}
            </p>
          </div>
        </div>

        <div className="card" style={{ padding: 0 }}>
          {allLoading ? (
            <p style={{ padding: 20, color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
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
                            style={{ background: 'none', border: 'none', color: 'var(--theme-text1)', fontWeight: 600, cursor: 'pointer', fontSize: 13, padding: 0, textAlign: 'left' }}
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
                                style={{ width: 90, padding: '4px 8px', fontSize: 13, background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 6, color: 'var(--theme-text1)' }}
                              />
                              <select
                                value={editAllForm.bs_month}
                                onChange={e => setEditAllForm(f => ({ ...f, bs_month: parseInt(e.target.value) }))}
                                style={{ padding: '4px 8px', fontSize: 13, background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 6, color: 'var(--theme-text1)' }}
                              >
                                {BS_MONTHS.map((m, i) => <option key={i} value={i + 1}>{i + 1} — {m}</option>)}
                              </select>
                              {editAllError && <span style={{ color: 'var(--theme-red)', fontSize: 11 }}>{editAllError}</span>}
                            </div>
                          </td>
                        ) : (
                          <>
                            <td style={{ color: expired ? 'var(--theme-amber)' : 'var(--theme-text1)' }}>
                              {openPeriod ? `${BS_MONTHS[openPeriod.bs_month - 1]} ${openPeriod.bs_year}` : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                            </td>
                            <td>
                              {openPeriod
                                ? expired
                                  ? <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, color: 'var(--theme-amber)', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)' }}>EXPIRED</span>
                                  : <span className="badge badge-green">OPEN</span>
                                : <span className="badge badge-gray">NO PERIOD</span>
                              }
                            </td>
                          </>
                        )}

                        <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{cp.length}</td>
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
                              <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Working…</span>
                            ) : (
                              <>
                                {openPeriod && (
                                  <button
                                    title="Edit period"
                                    onClick={() => { setEditingAllClientId(c.id); setEditAllForm({ bs_year: openPeriod.bs_year, bs_month: openPeriod.bs_month }); setEditAllError('') }}
                                    style={{ fontSize: 13, padding: '4px 9px', borderRadius: 5, cursor: 'pointer', background: 'rgba(201,168,76,0.07)', border: '1px solid rgba(201,168,76,0.35)', color: 'var(--theme-accent)' }}
                                  >✏</button>
                                )}
                                {openPeriod ? (
                                  <>
                                    <button
                                      onClick={() => adminCloseAndAdvance(openPeriod, c.id)}
                                      style={{ fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 5, cursor: 'pointer', background: 'rgba(248,113,113,0.07)', border: '1px solid rgba(248,113,113,0.3)', color: 'var(--theme-red)' }}
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
                                    style={{ fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 5, cursor: 'pointer', background: 'rgba(52,211,153,0.07)', border: '1px solid rgba(52,211,153,0.3)', color: 'var(--theme-green)' }}
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
          <h3 style={{ margin: '0 0 20px', fontSize: 15, color: 'var(--theme-text1)' }}>Create Period</h3>
          <div className="form-grid form-grid-2" style={{ maxWidth: 400 }}>
            <div className="form-field">
              <label><Tip text="Bikram Sambat year. Nepal fiscal year runs Shrawan (month 4) to Ashadh (month 3) of the following BS year." width={270}>BS Year</Tip></label>
              <input
                type="number"
                value={form.bs_year}
                onChange={e => setForm({ ...form, bs_year: e.target.value })}
                min="2070" max="2100"
              />
            </div>
            <div className="form-field">
              <label><Tip text="Bikram Sambat month (1 = Baisakh … 12 = Chaitra). One period per month — purchases, stock, and sales are all scoped to this period." width={280}>BS Month</Tip></label>
              <select value={form.bs_month} onChange={e => setForm({ ...form, bs_month: e.target.value })}>
                {BS_MONTHS.map((m, i) => (
                  <option key={i} value={i + 1}>{i + 1} — {m}</option>
                ))}
              </select>
            </div>
          </div>
          {error && <p style={{ color: 'var(--theme-red)', fontSize: 13, margin: '12px 0 0' }}>{error}</p>}
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
              <p style={{ color: 'var(--theme-amber)', margin: 0, fontSize: 14, fontWeight: 600 }}>
                ◷ {BS_MONTHS[openPeriod.bs_month - 1]} {openPeriod.bs_year} has ended
              </p>
              <p style={{ color: 'var(--theme-text2)', margin: '4px 0 0', fontSize: 12 }}>
                Finish your month-end stock count, then close this period and open {BS_MONTHS[nextAdvMonth - 1]}.
              </p>
            </div>
            <button
              onClick={() => closeAndAdvance(openPeriod)}
              style={{
                flexShrink: 0, background: 'rgba(251,191,36,0.12)',
                border: '1px solid rgba(251,191,36,0.4)', color: 'var(--theme-amber)',
                borderRadius: 6, padding: '8px 18px', cursor: 'pointer',
                fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap'
              }}
            >
              End {BS_MONTHS[openPeriod.bs_month - 1]} & Start {BS_MONTHS[nextAdvMonth - 1]} →
            </button>
          </div>
        </div>
      )}

      {justClosedReport && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'color-mix(in srgb, var(--theme-accent) 30%, transparent)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
            <p style={{ color: 'var(--theme-text1)', margin: 0, fontSize: 13 }}>
              Report for {BS_MONTHS[justClosedReport.bsMonth - 1]} {justClosedReport.bsYear} is ready.
            </p>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button className="btn btn-primary" style={{ fontSize: 12, padding: '6px 14px' }} onClick={() => navigate('/owner-report')}>
                View Report →
              </button>
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 10px' }} onClick={() => setJustClosedReport(null)} aria-label="Dismiss">×</button>
            </div>
          </div>
        </div>
      )}

      {openCount > 1 && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'rgba(251,191,36,0.3)' }}>
          <p style={{ color: 'var(--theme-amber)', fontSize: 13, margin: 0 }}>
            ⚠ You have {openCount} open periods. It's recommended to keep only one open at a time.
          </p>
        </div>
      )}

      <div className="card">
        {loading ? (
          <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
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
                  <th><Tip text="Bikram Sambat year this period belongs to." width={200}>BS Year</Tip></th>
                  <th><Tip text="Bikram Sambat month (1 = Baisakh … 12 = Chaitra)." width={220}>BS Month</Tip></th>
                  <th><Tip text="Open: data entry is active. Closed: period is locked — no further purchases, stock, or sales can be added." width={280}>Status</Tip></th>
                  <th><Tip text="Date the period was created in the system." width={200}>Created</Tip></th>
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
                                  background: 'var(--theme-bg)', border: '1px solid var(--theme-border)',
                                  borderRadius: 6, color: 'var(--theme-text1)'
                                }}
                              />
                              <select
                                value={editForm.bs_month}
                                onChange={e => setEditForm({ ...editForm, bs_month: parseInt(e.target.value) })}
                                style={{
                                  padding: '4px 8px', fontSize: 13,
                                  background: 'var(--theme-bg)', border: '1px solid var(--theme-border)',
                                  borderRadius: 6, color: 'var(--theme-text1)'
                                }}
                              >
                                {BS_MONTHS.map((m, i) => (
                                  <option key={i} value={i + 1}>{i + 1} — {m}</option>
                                ))}
                              </select>
                              {editError && (
                                <span style={{ color: 'var(--theme-red)', fontSize: 12 }}>{editError}</span>
                              )}
                            </div>
                          </td>
                          <td>
                            <span className="badge badge-green">OPEN</span>
                          </td>
                          <td style={{ color: 'var(--theme-text2)' }}>
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
                          <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
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
                          <td style={{ color: 'var(--theme-text2)' }}>
                            {new Date(p.created_at).toLocaleDateString()}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
                              {/* Edit pencil — open periods, admin only */}
                              {canEdit && isAdmin && (
                                <button
                                  className="btn btn-ghost"
                                  title="Edit period"
                                  style={{ fontSize: 13, padding: '5px 10px', lineHeight: 1, color: 'var(--theme-accent)', borderColor: 'rgba(201,168,76,0.35)', background: 'rgba(201,168,76,0.07)' }}
                                  onClick={() => startEdit(p)}
                                >
                                  ✏
                                </button>
                              )}
                              {/* Close / Reopen / Resync — admin only */}
                              {isAdmin && (p.status === 'open' ? (
                                <button
                                  className="btn btn-ghost"
                                  style={{ fontSize: 12, padding: '5px 12px', color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.35)', background: 'rgba(248,113,113,0.07)' }}
                                  onClick={() => closeAndAdvance(p)}
                                >
                                  Close &amp; Start Next
                                </button>
                              ) : (
                                <>
                                  <Tip text="Fix a mistake in this closed period directly (Stock Count already lets admin edit a closed period), then use this to push the correction into the next period's opening stock — no reopening needed.">
                                    <button
                                      className="btn btn-ghost"
                                      style={{ fontSize: 12, padding: '5px 12px', color: 'var(--theme-accent)', borderColor: 'rgba(201,168,76,0.35)', background: 'rgba(201,168,76,0.07)' }}
                                      onClick={() => resyncOpeningStock(p)}
                                    >
                                      Resync Opening Stock →
                                    </button>
                                  </Tip>
                                  <Tip text="Resumes full data entry for this month — blocked whenever a later period is already open (only one period can be open per client). Use Resync Opening Stock above for a one-off correction instead.">
                                    <button
                                      className="btn btn-ghost"
                                      style={{ fontSize: 12, padding: '5px 12px', color: 'var(--theme-green)', borderColor: 'rgba(52,211,153,0.35)', background: 'rgba(52,211,153,0.07)' }}
                                      onClick={() => reopenPeriod(p.id)}
                                    >
                                      Reopen
                                    </button>
                                  </Tip>
                                </>
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
