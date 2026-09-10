import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../../supabaseClient'
import { useSettings } from '../../../context/SettingsContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import ActionError, { asActionError } from '../../../components/ActionError'
import ReportLoadError from '../../../components/ReportLoadError'
import Tip from '../../../components/Tip'
import { IMS_COUNT_HOME } from '../../../shared/imsCountAccess'

// Stock Count → Settings (S737). Manager-only; mounted by Stock.js as one tab body.
//
// It lives in its own file because Stock.js is already ~1,750 lines and none of this is counting —
// it is the configuration ABOVE counting. Nothing here is a security boundary on its own: the
// section scope is a RESTRICTIVE policy on closing_stock writes and recount protection is a BEFORE
// UPDATE trigger (migration 20260910120000). These switches turn those on; they do not implement
// them. Blind count is the exception and says so on screen.

const COUNT_PATH = IMS_COUNT_HOME
const LOGIN_PATH = '/ims/count'

function Toggle({ id, checked, onChange, disabled, label, help }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 14 }}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
        style={{ marginTop: 2, width: 16, height: 16, flexShrink: 0 }}
      />
      <label htmlFor={id} style={{ fontSize: 13, color: 'var(--theme-text1)', cursor: disabled ? 'default' : 'pointer' }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span style={{ display: 'block', color: 'var(--theme-text2)', marginTop: 3, fontWeight: 400 }}>{help}</span>
      </label>
    </div>
  )
}

export default function StockCountSettings({ clientId, categories, uncategorisedCount }) {
  const { settings, saveSettings } = useSettings()
  const { scopedFrom, scopedInsert, scopedDelete } = useScopedDb()

  const [staff, setStaff] = useState([])
  // Set of `${profileId}:${categoryId}` — one lookup per checkbox instead of a scan per cell.
  const [assigned, setAssigned] = useState(new Set())
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState('')
  const [busyCell, setBusyCell] = useState(null)
  const [savingFlag, setSavingFlag] = useState(null)

  // The enrolment QR: { token, expiresAt, dataUrl }. Held in state only — it is short-lived by
  // design, and persisting it across a reload would defeat the expiry.
  const [enrol, setEnrol] = useState(null)
  const [enrolBusy, setEnrolBusy] = useState(false)

  const load = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    setLoadError(null)
    // get_ims_staff_list is the RPC that already exists for the IMS Staff screen (S417). A raw
    // profiles query returns nothing but the caller's own row — profiles_select is self-or-admin.
    const results = await Promise.all([
      supabase.rpc('get_ims_staff_list', { p_client_id: clientId }),
      fetchAllRows(() => scopedFrom('ims_count_assignments', 'id, profile_id, category_id').order('id')),
    ])
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setLoading(false); return }
    const [{ data: people }, { data: rows }] = results
    setStaff((people || []).filter(p => p.ims_role))
    setAssigned(new Set((rows || []).map(r => `${r.profile_id}:${r.category_id}`)))
    setLoading(false)
  }, [clientId, scopedFrom])

  useEffect(() => { load() }, [load])

  async function toggleFlag(field, value) {
    setSavingFlag(field)
    setError(null)
    setNotice('')
    try {
      // A PATCH of the one column, never the whole row: `settings` is written by nine screens and
      // sending the row back would overwrite whatever another of them changed since this page
      // loaded (S730).
      await saveSettings({ [field]: value })
      setNotice('Saved.')
    } catch (e) {
      setError(asActionError(e))
    } finally {
      setSavingFlag(null)
    }
  }

  async function toggleAssignment(profileId, categoryId) {
    const key = `${profileId}:${categoryId}`
    const on = assigned.has(key)
    setBusyCell(key)
    setError(null)
    setNotice('')
    // The write is checked and the checkbox follows the SERVER, not the click. An optimistic tick
    // over a refused insert is the shape that tells a manager someone is assigned when nobody is.
    const res = on
      ? await scopedDelete('ims_count_assignments').eq('profile_id', profileId).eq('category_id', categoryId)
      : await scopedInsert('ims_count_assignments', { profile_id: profileId, category_id: categoryId })
    setBusyCell(null)
    if (res.error) {
      setError(asActionError(res.error))
      return
    }
    setAssigned(prev => {
      const next = new Set(prev)
      if (on) next.delete(key); else next.add(key)
      return next
    })
  }

  const countUrl = useMemo(() => {
    if (typeof window === 'undefined') return LOGIN_PATH
    return `${window.location.origin}${LOGIN_PATH}`
  }, [])

  async function showQr() {
    setEnrolBusy(true)
    setError(null)
    setNotice('')
    try {
      const { data, error: rpcErr } = await supabase.rpc('issue_ims_enrol_token', { p_client_id: clientId })
      if (rpcErr) throw rpcErr
      const row = Array.isArray(data) ? data[0] : data
      if (!row?.token) throw new Error('No enrolment token was returned')
      // Dynamic import, following the S522 rule — qrcode is only ever reached by this click, so a
      // top-level import would ship it to everyone who opens Stock Count.
      const { default: QRCode } = await import('qrcode')
      const url = `${countUrl}#e=${row.token}`
      const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 220 })
      setEnrol({ token: row.token, expiresAt: row.expires_at, dataUrl })
    } catch (e) {
      setError(asActionError(e))
    } finally {
      setEnrolBusy(false)
    }
  }

  async function hideQr() {
    setEnrolBusy(true)
    setError(null)
    try {
      const { error: rpcErr } = await supabase.rpc('revoke_ims_enrol_token', { p_client_id: clientId })
      if (rpcErr) throw rpcErr
      setEnrol(null)
      setNotice('The code was withdrawn. Devices already set up keep working.')
    } catch (e) {
      setError(asActionError(e))
    } finally {
      setEnrolBusy(false)
    }
  }

  function copyUrl() {
    navigator.clipboard?.writeText(countUrl)
      .then(() => setNotice('Link copied.'))
      .catch(() => setNotice(`Copy this by hand: ${countUrl}`))
  }

  if (loadError) return <ReportLoadError error={loadError} />
  if (loading) return <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p></div>

  const scopeOn = !!settings?.ims_count_scope_enforced
  const unassigned = staff.filter(p => p.ims_role === 'staff' && !categories.some(c => assigned.has(`${p.id}:${c.id}`)))

  return (
    <div>
      {error && <ActionError error={error} className="action-error--top" />}
      {notice && (
        <div role="status" style={{ fontSize: 13, color: 'var(--theme-text2)', marginBottom: 12 }}>{notice}</div>
      )}

      {/* ── Who counts what ─────────────────────────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)', margin: '0 0 4px' }}>Who counts what</h3>
        <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 16px' }}>
          Tick the sections each person is responsible for. Supervisors, managers and the account owner
          always count everything.
        </p>

        <Toggle
          id="ims-count-scope"
          checked={scopeOn}
          disabled={savingFlag === 'ims_count_scope_enforced'}
          onChange={v => toggleFlag('ims_count_scope_enforced', v)}
          label="Limit counters to their assigned sections"
          help={
            'While this is on, a staff-level counter can only see and save the sections ticked below — '
            + 'and someone with no ticks at all can save nothing. Tick their sections first, then switch this on.'
          }
        />

        {scopeOn && unassigned.length > 0 && (
          <div role="status" style={{ background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', marginBottom: 14, fontSize: 13, color: 'var(--theme-amber-text)' }}>
            △ {unassigned.map(p => p.full_name || p.email).join(', ')} {unassigned.length === 1 ? 'has' : 'have'} no
            sections ticked, so {unassigned.length === 1 ? 'that person' : 'they'} cannot save a count at all.
          </div>
        )}

        {uncategorisedCount > 0 && (
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', marginBottom: 14 }}>
            {uncategorisedCount} item{uncategorisedCount === 1 ? ' has' : 's have'} no category, so
            {uncategorisedCount === 1 ? ' it' : ' they'} cannot be assigned to anyone. File
            {uncategorisedCount === 1 ? ' it' : ' them'} into a category in Item Master, or leave the counting
            to a supervisor.
          </p>
        )}

        {staff.length === 0 || categories.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--theme-text2)' }}>
            {staff.length === 0
              ? 'No IMS staff accounts yet. Add them under IMS → IMS Staff.'
              : 'No categories yet. Add them in Item Master first.'}
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Staff</th>
                  {categories.map(c => (
                    <th key={c.id} style={{ textAlign: 'center' }}>{c.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {staff.map(p => {
                  const scoped = p.ims_role === 'staff'
                  return (
                    <tr key={p.id}>
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                        <span style={{ whiteSpace: 'nowrap' }}>{p.full_name || p.email}</span>
                        {!scoped && (
                          <span className="badge badge-yellow" style={{ marginLeft: 8 }}>
                            {p.ims_role === 'manager' ? 'Manager' : 'Supervisor'}
                          </span>
                        )}
                      </td>
                      {categories.map(c => {
                        const key = `${p.id}:${c.id}`
                        return (
                          <td key={c.id} style={{ textAlign: 'center' }}>
                            {scoped ? (
                              <input
                                type="checkbox"
                                checked={assigned.has(key)}
                                disabled={busyCell === key}
                                onChange={() => toggleAssignment(p.id, c.id)}
                                aria-label={`${c.name} counted by ${p.full_name || p.email}`}
                                style={{ width: 16, height: 16 }}
                              />
                            ) : (
                              <Tip text="Supervisors and managers count every section, so there is nothing to assign." width={240}>
                                <span style={{ color: 'var(--theme-text3)' }}>—</span>
                              </Tip>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── How the count is taken ──────────────────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)', margin: '0 0 16px' }}>How the count is taken</h3>

        <Toggle
          id="ims-count-blind"
          checked={!!settings?.ims_count_blind}
          disabled={savingFlag === 'ims_count_blind'}
          onChange={v => toggleFlag('ims_count_blind', v)}
          label="Blind count — hide the expected quantities from counters"
          help={
            'On the Closing Stock tab a staff-level counter stops seeing what was purchased, what was '
            + 'returned and what the stock is worth, so they write what is on the shelf instead of confirming '
            + 'a number. This changes what is shown, not what the browser can reach — treat it as counting '
            + 'discipline, not as a lock.'
          }
        />

        <Toggle
          id="ims-count-attribution"
          checked={!!settings?.require_count_attribution}
          disabled={savingFlag === 'require_count_attribution'}
          onChange={v => toggleFlag('require_count_attribution', v)}
          label="Recount protection — one counter cannot overwrite another's figure"
          help={
            'Once someone has counted an item, another staff-level counter cannot change it. A supervisor, '
            + 'manager or the account owner still can. Every closing count records who entered it either way.'
          }
        />
      </div>

      {/* ── The count page ──────────────────────────────────────────────────────────────── */}
      <div className="card">
        <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)', margin: '0 0 4px' }}>The count page</h3>
        <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 16px' }}>
          Counters sign in here with their name and a 4-digit PIN — no email, no password. Set their PIN
          under IMS → IMS Staff. Once signed in, a PIN account reaches Stock Count and nothing else.
        </p>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
          <code style={{ fontSize: 13, background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', color: 'var(--theme-text1)' }}>
            {countUrl}
          </code>
          <button type="button" className="btn btn-ghost btn-sm" onClick={copyUrl}>Copy link</button>
        </div>

        {enrol ? (
          <div>
            <img
              src={enrol.dataUrl}
              alt="QR code to set up a counting device"
              style={{ width: 220, height: 220, background: '#fff', padding: 8, borderRadius: 'var(--radius-sm)', display: 'block' }}
            />
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '10px 0' }}>
              Scan this on the tablet or phone that will be used for counting. It sets that device up and
              opens the PIN screen. The code stops working 15 minutes after it was shown, and any number of
              devices can be set up until then — so show it while the devices are in front of you.
            </p>
            <button type="button" className="btn btn-ghost btn-sm" onClick={hideQr} disabled={enrolBusy}>
              {enrolBusy ? 'Withdrawing…' : 'Hide code'}
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" onClick={showQr} disabled={enrolBusy}>
            {enrolBusy ? 'Preparing…' : 'Show setup QR'}
          </button>
        )}

        <p style={{ fontSize: 13, color: 'var(--theme-text3)', marginTop: 16, marginBottom: 0 }}>
          A device that is already set up keeps working — hiding the code only stops new ones being added.
          The counting page itself is <code>{COUNT_PATH}</code>.
        </p>
      </div>
    </div>
  )
}
