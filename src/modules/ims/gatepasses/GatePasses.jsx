import { useState, useEffect, useCallback, useRef } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import Fab from '../../../components/Fab'
import Tip from '../../../components/Tip'
import ConfirmModal from '../../../components/ConfirmModal'
import FieldError, { fieldAria } from '../../../components/FieldError'
import ReportLoadError from '../../../components/ReportLoadError'
import ActionError, { asActionError } from '../../../components/ActionError'
import { printWithTitle } from '../../../utils/printTitle'
import { BS_MONTHS } from '../../../utils/bsCalendar'
import GatePassPrint from './GatePassPrint'
import NewGatePassModal from './NewGatePassModal'
// serviceDayStartIso is the POS parking day helper, reused rather than copied (S756, D27) — see
// gatePassDayStartMs. It lives in shared/nepalTime.js, not in a POS modal file.
import { nepalTime, nepalBs, serviceDayStartIso } from '../../../shared/nepalTime'
import { FilterChips } from '../../../components/Tabs'

const PURPOSE_LABELS = { delivery: 'Delivery', pickup: 'Pickup', maintenance: 'Maintenance', other: 'Other' }

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

/**
 * The instant the current gate-pass day began: the most recent 6 AM in Nepal (S756, owner decision
 * D27 — "the gate-pass day ends at 6 AM Nepal time, like POS parking").
 *
 * The sweep used the VIEWER's local midnight, so a delivery van logged in at 11:30 PM during a late
 * service was auto-closed at 12:00 AM while still in the yard, and an operator abroad closed passes
 * on their own clock. `serviceDayStartIso()` is POS parking's helper — Nepal midnight of the BS day
 * that (now − 6h) falls on — and 6 AM of that same day is exactly "the most recent 6 AM". Adding
 * the 6 hours here matters: parking's own sweep compares against the midnight, so a slip issued at
 * 3 AM survives a further day there; a gate pass issued at 3 AM belongs to the day that ended at 6.
 * Exported for GatePasses.test.js.
 */
export function gatePassDayStartMs(nowMs = Date.now()) {
  return Date.parse(serviceDayStartIso(nowMs)) + SIX_HOURS_MS
}

// "14 Bhadra" in Nepal, for a timestamp — so the All tab says which day a time belongs to.
function bsDayLabel(ts) {
  const bs = nepalBs(ts)
  return bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]}` : ''
}

// Voiding writes columns a migration adds (voided_at / voided_by / void_reason, and 'voided' in the
// status CHECK). Until it is applied the write is refused as an unknown column or a CHECK violation
// — a refusal raised for the whole statement, so the pass is genuinely untouched and may be told so.
const VOID_NOT_AVAILABLE = new Set(['PGRST204', '42703', '23514'])

// Route guard: `hasImsAccess('staff')` below (the S417 floor every IMS page uses). Issuing, marking
// exited and reprinting are staff actions; voiding is Supervisor and above (S756, D27). That rank
// check is the page's only enforcement today — the migration in the S756 report adds the trigger.
export default function GatePasses() {
  const { clientId, profile, hasImsAccess } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpdate } = useScopedDb()

  const [passes, setPasses]   = useState([])
  const [vendors, setVendors] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter]   = useState('open') // 'open' | 'all'
  const [showNew, setShowNew] = useState(false)
  const [printPass, setPrintPass] = useState(null)
  const [bizInfo, setBizInfo] = useState({ name: '', address: '', vatNumber: '' })
  const [staffNames, setStaffNames] = useState({})
  // S756: a failed read is not an empty gate. Every read used to destructure `{ data }` alone, so a
  // dead connection rendered "No vehicles currently on the premises" over vans still in the yard.
  const [loadError, setLoadError]     = useState(null)
  const [sweepFailed, setSweepFailed] = useState(false) // some stale passes could not be auto-closed
  const [actionError, setActionError] = useState(null)  // the last list action that did not land
  const [voidDraft, setVoidDraft]     = useState(null)  // { pass, reason, err, busy }
  // The client a load was started for — an admin switching clients must not have the previous
  // client's late response land on the new one's page.
  const loadClientRef = useRef(null)

  const canVoid = hasImsAccess('supervisor')

  const load = useCallback(async () => {
    if (!clientId) return
    loadClientRef.current = clientId
    setLoading(true)
    const results = await Promise.all([
      // S756: paged. Nothing bounds this by date — it is every pass the outlet has ever issued — so
      // a bare select stopped at 1000 with no error, shrinking the list AND the stale sweep below to
      // whatever fitted. `.order('id')` is the unique tiebreaker paging needs.
      fetchAllRows(() => scopedFrom('ims_gate_passes').order('created_at', { ascending: false }).order('id')),
      fetchAllRows(() => scopedFrom('vendors').eq('is_active', true).order('name').order('id')),
      supabase.from('clients').select('name').eq('id', clientId).single(),
      supabase.from('settings').select('property_address, vat_number').eq('client_id', clientId).maybeSingle(),
      // Raw `profiles` reads are RLS-limited to the caller's own row — resolving OTHER staff
      // members' names needs get_client_profile_names(), a SECURITY DEFINER RPC.
      supabase.rpc('get_client_profile_names', { p_client_id: clientId }),
    ])
    if (loadClientRef.current !== clientId) return
    // The error OBJECT rather than firstError()'s string, so its code survives into the card's
    // fine print. The names and the outlet header gate the page too: they are what a printed pass
    // carries, and a pass printed under a blank letterhead is worse than a refusal.
    const readErr = results.find(r => r.error)?.error
    if (readErr) { setPasses([]); setLoadError(readErr); setLoading(false); return }
    setLoadError(null)
    const [{ data: p }, { data: v }, { data: client }, { data: settings }, { data: profs }] = results

    // Sweep-close any pass still "open" from a previous gate-pass day — same reasoning/pattern as
    // PosParkingSlips.jsx's loadSlips(): no server cron in this project, so this runs the moment
    // the page is next opened. Never deletes data, just flags auto_closed so it stays
    // distinguishable from a real staff-confirmed Mark Exited. A voided pass is not 'open', so it
    // is never swept.
    const dayStart = gatePassDayStartMs()
    const stale = (p || []).filter(x => x.status === 'open' && Date.parse(x.time_in) < dayStart)
    setSweepFailed(false)
    if (stale.length > 0) {
      const nowIso = new Date().toISOString()
      // S756: only rows the update actually closed are shown closed. The error used to be dropped
      // while every stale row was flipped on screen. `.eq('status', 'open')` so a pass marked exited
      // or voided on another device in the meantime is not overwritten, and `.select('id')` so a
      // zero-row refusal (which returns no error) is visible too.
      const { data: closed, error: sweepErr } = await scopedUpdate('ims_gate_passes', { status: 'closed', time_out: nowIso, auto_closed: true })
        .in('id', stale.map(x => x.id)).eq('status', 'open').select('id')
      if (loadClientRef.current !== clientId) return
      const closedIds = new Set((sweepErr ? [] : closed || []).map(x => x.id))
      if (closedIds.size < stale.length) setSweepFailed(true)
      ;(p || []).forEach(x => { if (closedIds.has(x.id)) { x.status = 'closed'; x.time_out = nowIso; x.auto_closed = true } })
    }

    setPasses(p || [])
    setVendors(v || [])
    setBizInfo({ name: client?.name || '', address: settings?.property_address || '', vatNumber: settings?.vat_number || '' })
    setStaffNames(Object.fromEntries((profs || []).map(pr => [pr.id, pr.full_name])))
    setLoading(false)
  }, [clientId, scopedFrom, scopedUpdate])

  useEffect(() => { load() }, [load])

  async function handleSaved(payload) {
    const { data: pass, error } = await scopedInsert('ims_gate_passes', { ...payload, issued_by: profile?.id || null }, { single: true })
    if (error) return { error }
    setShowNew(false)
    load()
    setPrintPass(pass)
    setTimeout(() => {
      printWithTitle(`Gate Pass - ${pass.vehicle_number} - G-${pass.pass_no}`)
      setPrintPass(null)
    }, 60)
    return {}
  }

  async function markExited(pass) {
    setActionError(null)
    // S756: writes who confirmed the exit (the column existed and was never filled; PosParkingSlips
    // writes its twin), and no longer drops the error — a refused write reloaded the list unchanged,
    // which reads as "that did nothing". `.eq('status', 'open')` + `.select('id')` so a pass already
    // closed, auto-closed or voided elsewhere is reported rather than silently re-closed.
    const { data, error } = await scopedUpdate('ims_gate_passes', {
      status: 'closed', time_out: new Date().toISOString(), exited_by: profile?.id || null,
    }).eq('id', pass.id).eq('status', 'open').select('id')
    if (error) {
      const { text, detail } = asActionError(error, 'staff')
      setActionError({ text: `${pass.vehicle_number} (G-${pass.pass_no}) could not be marked exited — it still shows as on the premises. ${text}`, detail })
      return
    }
    if (!data?.length) {
      setActionError(`${pass.vehicle_number} (G-${pass.pass_no}) was not marked exited — it was already closed or voided on another device, or this account may not change it. The list has been refreshed.`)
    }
    load()
  }

  async function reprint(pass) {
    setActionError(null)
    setPrintPass(pass)
    setTimeout(() => {
      printWithTitle(`Gate Pass - ${pass.vehicle_number} - G-${pass.pass_no}`)
      setPrintPass(null)
    }, 60)
    // S756: this builder was never awaited, and postgrest-js only sends inside then() — so the
    // request was never made and print_count never moved past its first value. Awaited now; the
    // print still happens whatever the counter does, since the paper is what the gate needs.
    const next = (pass.print_count || 0) + 1
    const { data, error } = await scopedUpdate('ims_gate_passes', { print_count: next }).eq('id', pass.id).select('id')
    if (error || !data?.length) {
      const a = error ? asActionError(error, 'staff') : null
      setActionError({
        text: `G-${pass.pass_no} was reprinted, but the reprint was not counted${a ? ` — ${a.text}` : ' — Crest could not find the pass to update.'}`,
        detail: a?.detail || '',
      })
      return
    }
    setPasses(prev => prev.map(x => x.id === pass.id ? { ...x, print_count: next } : x))
  }

  async function confirmVoid() {
    const draft = voidDraft
    if (!draft) return
    const reason = draft.reason.trim()
    if (!reason) {
      setVoidDraft(d => ({ ...d, err: 'Say why this pass is being voided — the reason stays on the record beside the pass number.' }))
      return
    }
    setVoidDraft(d => ({ ...d, busy: true, err: '' }))
    // S756 (D27): void keeps the number. The row stays, struck through with its reason, so the
    // sequence has no gap and the security desk can still see what was issued and why it was not
    // honoured. Open or closed passes can be voided; `.neq('status', 'voided')` stops a double void
    // from overwriting the first reason.
    const { data, error } = await scopedUpdate('ims_gate_passes', {
      status: 'voided', voided_at: new Date().toISOString(), voided_by: profile?.id || null, void_reason: reason,
    }).eq('id', draft.pass.id).neq('status', 'voided').select('id')
    const label = `G-${draft.pass.pass_no} (${draft.pass.vehicle_number})`
    if (error) {
      setVoidDraft(null)
      if (VOID_NOT_AVAILABLE.has(error.code)) {
        setActionError({ text: `${label} was not voided — voiding needs a database update that has not been applied to this account yet. The pass is unchanged. Ask support to apply the S756 gate-pass migration.`, detail: `${error.code} · ${error.message || ''}` })
      } else {
        const { text, detail } = asActionError(error)
        setActionError({ text: `${label} was not voided — it still shows as issued. ${text}`, detail })
      }
      return
    }
    setVoidDraft(null)
    if (!data?.length) {
      setActionError(`${label} was not voided — it was already voided on another device, or this account may not change it. The list has been refreshed.`)
    }
    load()
  }

  const visible = filter === 'open' ? passes.filter(p => p.status === 'open') : passes

  // Floor tier, matching every other IMS page's guard (S417 convention). This page had none, so
  // the route was reachable by any account at an ims_enabled client regardless of ims_role.
  if (!hasImsAccess('staff')) return <Navigate to="/dashboard" replace />

  // Strike through the identity cells of a voided pass; the number stays readable.
  const struck = p => (p.status === 'voided' ? { textDecoration: 'line-through', color: 'var(--theme-text3)' } : undefined)

  return (
    <>
    <div className={printPass ? 'no-print' : ''}>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Gate Passes</h1>
          <p className="page-subtitle">Issue a printable gate pass for a vendor or delivery vehicle</p>
        </div>
      </div>

      <FilterChips
        label="Filter gate passes"
        style={{ marginBottom: 20 }}
        options={[{ key: 'open', label: 'Open' }, { key: 'all', label: 'All' }]}
        active={filter}
        onChange={setFilter}
      />

      <ActionError error={actionError} className="action-error--top" />
      {!loading && !loadError && sweepFailed && (
        <p role="status" style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
          Some passes from before 6 AM could not be closed automatically, so they still show as on the premises. Mark them Exited, or reload the page to try again.
        </p>
      )}

      {loading ? (
        <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
      ) : loadError ? (
        <ReportLoadError error={loadError} />
      ) : visible.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
          {filter === 'open' ? 'No vehicles currently on the premises.' : 'No gate passes issued yet.'}
        </div>
      ) : (
        <div className="table-wrap table-wrap--fab-clear">
          <table className="data-table">
            <thead>
              <tr>
                <th>Pass No</th>
                <th>Vendor / Company</th>
                <th>Driver</th>
                <th>Vehicle No</th>
                <th><Tip text="Reason for the visit — delivery, pickup, maintenance, or other." width={220}>Purpose</Tip></th>
                <th>Time In</th>
                <th><Tip text="Open means the vehicle is still on the premises; Closed means staff marked it exited (who and when is shown underneath); Auto-Closed means it was still open when the gate-pass day ended at 6 AM and was closed automatically — the vehicle's actual exit was never confirmed; Voided means the pass was issued in error and must not be honoured — the number is kept, with the reason." width={320}>Status</Tip></th>
                <th>Issued By</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map(p => {
                const inDay = bsDayLabel(p.time_in)
                const outDay = bsDayLabel(p.time_out)
                return (
                  <tr key={p.id}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)', whiteSpace: 'nowrap' }}>G-{p.pass_no}</td>
                    <td style={struck(p)}>{p.vendor_name}</td>
                    <td style={struck(p)}>{p.driver_name}</td>
                    <td style={{ fontWeight: 600, ...struck(p) }}>{p.vehicle_number}</td>
                    <td>{PURPOSE_LABELS[p.purpose] || p.purpose}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {nepalTime(p.time_in)}
                      {inDay && <span className="cell-sub">{inDay}</span>}
                    </td>
                    <td>
                      {p.status === 'voided' ? (
                        <>
                          <span className="badge badge-gray">Voided</span>
                          <span className="cell-sub">
                            {p.void_reason || 'No reason recorded'}
                            {(p.voided_by || p.voided_at) && ` — ${staffNames[p.voided_by] || 'unknown'}${p.voided_at ? `, ${nepalTime(p.voided_at)}` : ''}`}
                          </span>
                        </>
                      ) : p.status === 'open' ? (
                        <span className="badge badge-amber">Open</span>
                      ) : p.auto_closed ? (
                        <Tip text="Automatically closed when the page was next opened after this pass's gate-pass day ended at 6 AM — staff never confirmed the vehicle actually exited." width={280}>
                          <span className="badge badge-gray">Auto-Closed</span>
                        </Tip>
                      ) : (
                        <>
                          <span className="badge badge-green">Closed</span>
                          {p.time_out && (
                            <span className="cell-sub">
                              {/* The exit's day is named only when it differs from the entry's (S670). */}
                              Exited {outDay && outDay !== inDay ? `${outDay} ` : ''}{nepalTime(p.time_out)}
                              {p.exited_by ? ` by ${staffNames[p.exited_by] || 'unknown'}` : ''}
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td>{staffNames[p.issued_by] || '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        {p.status === 'open' && (
                          <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => markExited(p)}>Mark Exited</button>
                        )}
                        {/* A voided pass is not reprinted: a fresh print of it is a valid-looking pass. */}
                        {p.status !== 'voided' && (
                          <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => reprint(p)}>Reprint</button>
                        )}
                        {canVoid && p.status !== 'voided' && (
                          <button className="btn btn-danger" style={{ fontSize: 12, padding: '5px 10px' }}
                            onClick={() => { setActionError(null); setVoidDraft({ pass: p, reason: '', err: '', busy: false }) }}>
                            Void
                          </button>
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

      {showNew && (
        <NewGatePassModal vendors={vendors} onClose={() => setShowNew(false)} onSaved={handleSaved} />
      )}

      {voidDraft && (
        <ConfirmModal
          title={`Void gate pass G-${voidDraft.pass.pass_no}?`}
          confirmLabel="Void Pass" busyLabel="Voiding…" danger
          busy={voidDraft.busy}
          onCancel={() => setVoidDraft(null)}
          onConfirm={confirmVoid}
        >
          <p style={{ margin: '0 0 10px' }}>
            {voidDraft.pass.vehicle_number} · {voidDraft.pass.vendor_name}. The pass stays on the list under its number, struck
            through with your reason, and can no longer be marked exited or reprinted. A voided pass cannot be un-voided.
          </p>
          <div className="form-field">
            <label htmlFor="gatepass-void-reason">Reason *</label>
            <textarea id="gatepass-void-reason" rows={2} autoFocus
              value={voidDraft.reason}
              onChange={e => { const reason = e.target.value; setVoidDraft(d => ({ ...d, reason, err: '' })) }}
              placeholder="e.g. Wrong vehicle number — reissued as the next pass"
              style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)', width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }}
              {...fieldAria('gatepass-void-reason', voidDraft.err)} />
            <FieldError id="gatepass-void-reason" message={voidDraft.err} />
          </div>
        </ConfirmModal>
      )}

      <Fab onClick={() => setShowNew(true)} label="+ New Gate Pass" show={!showNew} />
    </div>

      {/* Print-only gate pass — see handleSaved()/reprint(); mounted only for the brief setTimeout
          window it takes to fire the browser print dialog, then unmounted. */}
      {printPass && (
        <div className="print-only">
          <GatePassPrint gatePass={printPass} bizInfo={bizInfo} issuedByName={staffNames[printPass.issued_by]} />
        </div>
      )}
    </>
  )
}
