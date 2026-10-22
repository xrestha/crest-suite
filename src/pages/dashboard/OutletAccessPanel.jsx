import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../supabaseClient'
import Tip from '../../components/Tip'
import ReportLoadError from '../../components/ReportLoadError'
import ActionError from '../../components/ActionError'
import { errorInfo, isNetworkError } from '../../shared/errorText'
import { settleWithin, isTimeout } from '../../utils/withTimeout'
import { useLatestRequest } from '../../shared/hooks/useLatestRequest'

// Outlet Access — who in this group may work in which outlet (S617).
//
// Lives on the Group Console rather than beside each staff account, because the question it
// answers is a group-shaped one: "who reaches what" is only legible as a matrix, and the three
// staff screens (POS Staff, IMS staff, HR staff) are each scoped to a single outlet and could
// never show the other columns.
//
// It grants REACH, never RANK. A manager remains a manager wherever they go, and a storekeeper a
// storekeeper — see profile_outlet_access's migration for why a per-outlet role matrix was
// deliberately not built. The home outlet is implicit and always permitted, so it is rendered as
// a fixed marker rather than a checkbox somebody could uncheck to lock a person out of their own
// branch.
//
// Reads go through get_group_outlet_access() and writes through set_outlet_access(): profiles_select
// RLS is self-or-admin only, so an Owner cannot see a sibling outlet's staff rows directly, and
// profile_outlet_access has no write policy at all, so the RPC is the only write path.
//
// S849: each row carries `login_kind` from the server (GROUP-15) — 'owner' (reaches every outlet,
// by the database's own Owner test), 'till_pin' and 'count_pin' (their own outlet's tablets only,
// GROUP-3), 'staff' (an email login of any rank, the only kind with checkboxes). Crest Staff
// self-service logins are not returned at all: a tick there granted nothing.
// Ticks are a draft per person until saved (GROUP-8): a row's Save keeps everyone else's ticks, and
// Save all saves every changed row.

// An older database (before S849) sends no login_kind; the old reading of the same row.
const kindOf = r => r.login_kind || (r.is_owner ? 'owner' : r.pos_role ? 'till_pin' : 'staff')

const sameSet = (a, b) => {
  const x = new Set(a || [])
  const y = new Set(b || [])
  if (x.size !== y.size) return false
  for (const v of x) if (!y.has(v)) return false
  return true
}

const nameOf = r => r.full_name || 'That account'

// A timeout or a dropped connection: the save may still have landed, so the list is re-read and
// the message says we could not confirm (DOCS-8); never "not saved".
const isUnknownOutcome = error => isTimeout(error) || isNetworkError(error)

function failureFor(r, error) {
  const info = errorInfo(error, 'operator')
  if (isUnknownOutcome(error)) {
    return {
      text: `We couldn’t confirm whether ${nameOf(r)}’s outlet access was saved. Check your internet. The list below has been reloaded to show what is stored.`,
      detail: info.detail,
    }
  }
  // set_outlet_access is one statement, so a refusal changed nothing; errorText words the hint
  // (outlet_access_count_pin, outlet_access_self_service, …).
  return { text: `${nameOf(r)}’s outlet access was not changed. ${info.text}`, detail: info.detail }
}

// outlets: every outlet of the group (get_group_summary's rows, not AuthContext's list).
// readGroupId: null for the Owner (the server reads their own group); the viewed client's group for
//   Crest support (S849 ACCESS-8), which reads the matrix but cannot change it.
// readOnly: every checkbox disabled, no Save.
export default function OutletAccessPanel({ outlets, readGroupId = null, readOnly = false }) {
  const [rows, setRows] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [savingId, setSavingId] = useState(null)
  const [savingAll, setSavingAll] = useState(false)
  const [savedIds, setSavedIds] = useState([])
  const [saveErrors, setSaveErrors] = useState([])
  // Local edits, keyed by profile id, so a row can be changed and then saved as one set — the RPC
  // replaces an account's whole allowlist, and one request per checkbox would leave a half-applied
  // state visible if the network dropped mid-way. Only a list that differs from the stored one is
  // kept, so "unsaved" always means a real change.
  const [draft, setDraft] = useState({})
  const req = useLatestRequest()
  const seq = useRef(0)

  const load = useCallback(async () => {
    const key = `${readGroupId || 'own'}-${++seq.current}`
    req.begin(key)
    setLoadError(null)
    const { data, error } = await settleWithin(
      supabase.rpc('get_group_outlet_access', readGroupId ? { p_group_id: readGroupId } : {}),
      20000, 'Outlet Access')
    if (!req.isCurrent(key)) return
    // A failed read here is not "nobody has access" — that reads as a correct, empty matrix and
    // would invite an Owner to re-grant permissions that already exist (S594). The error OBJECT goes
    // to ReportLoadError, which words it and keeps the code.
    if (error) { setLoadError(error); setLoaded(true); return }
    const next = data || []
    setRows(next)
    // S849 GROUP-8: drafts survive a re-read; one that now equals what is stored has landed (or was
    // undone) and is dropped.
    const stored = new Map(next.map(r => [r.profile_id, r.allowed_client_ids || []]))
    setDraft(d => {
      const out = {}
      for (const [id, list] of Object.entries(d)) {
        if (stored.has(id) && !sameSet(list, stored.get(id))) out[id] = list
      }
      return out
    })
    setLoaded(true)
  }, [readGroupId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  const storedFor = r => r.allowed_client_ids || []
  const allowedFor = r => draft[r.profile_id] ?? storedFor(r)
  const isDirty = r => draft[r.profile_id] !== undefined
  const dirtyRows = rows.filter(r => kindOf(r) === 'staff' && isDirty(r))
  const busy = savingAll || savingId != null

  function toggle(r, outletId) {
    const current = allowedFor(r)
    const next = current.includes(outletId)
      ? current.filter(id => id !== outletId)
      : [...current, outletId]
    setDraft(d => {
      const out = { ...d }
      if (sameSet(next, storedFor(r))) delete out[r.profile_id]
      else out[r.profile_id] = next
      return out
    })
    setSavedIds(ids => ids.filter(id => id !== r.profile_id))
  }

  const dropDraft = id => setDraft(d => { const n = { ...d }; delete n[id]; return n })

  async function saveOne(r) {
    const { error } = await settleWithin(
      supabase.rpc('set_outlet_access', { p_profile_id: r.profile_id, p_client_ids: allowedFor(r) }),
      20000, 'Saving outlet access')
    return error
  }

  async function save(r) {
    setSavingId(r.profile_id)
    setSaveErrors([])
    const error = await saveOne(r)
    setSavingId(null)
    // An optimistic paint that drops the error reports as saved what the database refused (S613).
    // A refusal keeps this row's ticks so they can be corrected; an unknown outcome re-reads, and the
    // re-read drops the draft if it did land.
    if (error) {
      setSaveErrors([failureFor(r, error)])
      if (isUnknownOutcome(error)) await load()
      return
    }
    dropDraft(r.profile_id)
    setSavedIds([r.profile_id])
    await load()
  }

  // One request per changed row, in turn: each is its own set_outlet_access call, so one refusal
  // never blocks the rest, and every failure is named.
  async function saveAll() {
    const todo = dirtyRows
    if (todo.length === 0) return
    setSavingAll(true)
    setSaveErrors([])
    const failures = []
    const saved = []
    for (const r of todo) {
      setSavingId(r.profile_id)
      const error = await saveOne(r)
      if (error) failures.push(failureFor(r, error))
      else { saved.push(r.profile_id); dropDraft(r.profile_id) }
    }
    setSavingId(null)
    setSavingAll(false)
    setSaveErrors(failures)
    setSavedIds(saved)
    await load()
  }

  const roleLabel = r => {
    if (kindOf(r) === 'owner') return 'Owner'
    const parts = []
    if (r.ims_role) parts.push(`IMS ${r.ims_role}`)
    if (r.pos_role) parts.push(`POS ${r.pos_role}`)
    if (r.hr_role) parts.push(`HR ${r.hr_role}`)
    return parts.join(' · ') || '—'
  }

  const fixedCell = (key, tip, word) => (
    <td key={key} style={{ textAlign: 'center' }}>
      <Tip text={tip}>
        <span style={{ color: 'var(--theme-text3)', whiteSpace: 'nowrap' }}>{word}</span>
      </Tip>
    </td>
  )

  return (
    <div className="card" style={{ marginTop: 28 }}>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 4px', color: 'var(--theme-text1)' }}>
          Outlet Access
        </h2>
        <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: 0 }}>
          Which outlets each person may switch into. Everyone always has their own outlet; ticking
          another lets them work there at the same rank they already hold.
          {readOnly && ' Read only: only the group’s Owner can change access.'}
        </p>
      </div>

      {saveErrors.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {saveErrors.map((e, i) => <ActionError key={i} error={e} />)}
        </div>
      )}

      {!readOnly && loaded && !loadError && dirtyRows.length > 0 && (
        <div className="note-banner" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '0 0 12px', fontSize: 12 }}>
          <span role="status">{dirtyRows.length} unsaved change{dirtyRows.length === 1 ? '' : 's'}</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={saveAll} disabled={busy}>
            {savingAll ? 'Saving…' : 'Save all'}
          </button>
        </div>
      )}

      {!loaded ? (
        <p role="status" aria-live="polite" style={{ color: 'var(--theme-text2)', fontSize: 13, padding: '8px 0' }}>
          Loading access…
        </p>
      ) : loadError ? (
        <ReportLoadError error={loadError} />
      ) : rows.length === 0 ? (
        <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>No staff accounts in this group yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Home outlet</th>
                <th>Role</th>
                {/* A column heading over a repeating row is a <span>, not a <label>: it names no
                    single control, and a <label> pointing at nothing announces a name the browser
                    never binds. Each checkbox carries its own aria-label naming person + outlet. */}
                {outlets.map(o => (
                  <th key={o.id} style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                    <span>{o.name}</span>
                  </th>
                ))}
                {/* S857: the Save column had a blank header, read as nothing by a screen reader. */}
                <th><span className="sr-only">Save</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const allowed = allowedFor(r)
                const kind = kindOf(r)
                return (
                  <tr key={r.profile_id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.full_name || '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.home_client_name || '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <span className={kind === 'owner' ? 'badge-yellow' : 'badge-gray'}>{roleLabel(r)}</span>
                    </td>
                    {outlets.map(o => {
                      if (o.id === r.home_client_id) {
                        return fixedCell(o.id, 'This is their own outlet — always available, and not something that can be taken away here.', 'home')
                      }
                      if (kind === 'owner') {
                        return fixedCell(o.id, 'An owner reaches every outlet in the group by virtue of being the owner, so there is nothing to grant.', 'all')
                      }
                      // A till PIN works only on its own outlet's tablets (S809 ACCESS-4): set_active_outlet
                      // refuses it every other outlet, and set_outlet_access refuses to grant one.
                      if (kind === 'till_pin') {
                        return fixedCell(o.id, `A till PIN works only on the tablets of its own outlet, so it cannot be given ${o.name}. To let this person bill there too, add them to POS Staff at ${o.name} with a PIN of their own.`, 'till only')
                      }
                      // S849 GROUP-3: a stock-count PIN likewise counts only into its own outlet's month.
                      if (kind === 'count_pin') {
                        return fixedCell(o.id, `A stock-count PIN works only on the tablets of its own outlet, so it cannot be given ${o.name}. To let this person count there too, add a count PIN for them at ${o.name} in Stock Count → Settings.`, 'count tablet only')
                      }
                      return (
                        <td key={o.id} style={{ textAlign: 'center' }}>
                          <input
                            type="checkbox"
                            checked={allowed.includes(o.id)}
                            onChange={() => toggle(r, o.id)}
                            disabled={readOnly || busy}
                            aria-label={`Allow ${r.full_name || 'this account'} to work at ${o.name}`}
                          />
                        </td>
                      )
                    })}
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {readOnly || kind !== 'staff' ? null : isDirty(r) ? (
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => save(r)}
                          disabled={busy}
                        >
                          {savingId === r.profile_id ? 'Saving…' : 'Save'}
                        </button>
                      ) : savedIds.includes(r.profile_id) ? (
                        <span style={{ fontSize: 11, color: 'var(--theme-green-text)', fontWeight: 700 }}>Saved</span>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '10px 0 0' }}>
        Removing an outlet moves that person back to their own outlet straight away. A window they have
        open on the removed outlet shows nothing from it, and moves itself back the next time they
        return to it or open another page. It also removes their link to an employee record there.
      </p>
      {/* S798 3f-1 (GAP-OUTLETS-1): a tick reaches the outlet; only a link makes its record theirs. */}
      <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '6px 0 0' }}>
        If someone you tick is also on that outlet's payroll, open that outlet's HR Staff page and link their login to
        their employee record there. Until you do, Crest does not know the record is theirs, so they could approve their
        own leave, claims and overtime at that outlet.
      </p>
    </div>
  )
}
