import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../supabaseClient'
import Tip from '../../components/Tip'
import ReportLoadError from '../../components/ReportLoadError'

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
export default function OutletAccessPanel({ outlets }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [savingId, setSavingId] = useState(null)
  const [savedId, setSavedId] = useState(null)
  const [saveError, setSaveError] = useState('')
  // Local edits, keyed by profile id, so a row can be changed and then saved as one set — the RPC
  // replaces an account's whole allowlist, and one request per checkbox would leave a half-applied
  // state visible if the network dropped mid-way.
  const [draft, setDraft] = useState({})

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    const { data, error } = await supabase.rpc('get_group_outlet_access')
    // A failed read here is not "nobody has access" — that reads as a correct, empty matrix and
    // would invite an Owner to re-grant permissions that already exist (S594).
    if (error) { setLoadError(error.message); setRows([]) }
    else { setRows(data || []); setDraft({}) }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const allowedFor = r => draft[r.profile_id] ?? (r.allowed_client_ids || [])
  const isDirty = r => draft[r.profile_id] !== undefined

  function toggle(r, outletId) {
    const current = allowedFor(r)
    const next = current.includes(outletId)
      ? current.filter(id => id !== outletId)
      : [...current, outletId]
    setDraft(d => ({ ...d, [r.profile_id]: next }))
    setSavedId(null)
    setSaveError('')
  }

  async function save(r) {
    setSavingId(r.profile_id)
    setSaveError('')
    const { error } = await supabase.rpc('set_outlet_access', {
      p_profile_id: r.profile_id,
      p_client_ids: allowedFor(r),
    })
    setSavingId(null)
    // An optimistic paint that drops the error reports as saved what the database refused
    // (S613). Reload instead of patching local state, so what is on screen is what was stored.
    if (error) { setSaveError(`${r.full_name || 'That account'}: ${error.message}`); return }
    setSavedId(r.profile_id)
    await load()
  }

  const roleLabel = r => {
    if (r.is_owner) return 'Owner'
    const parts = []
    if (r.ims_role) parts.push(`IMS ${r.ims_role}`)
    if (r.pos_role) parts.push(`POS ${r.pos_role}`)
    if (r.hr_role) parts.push(`HR ${r.hr_role}`)
    return parts.join(' · ') || '—'
  }

  return (
    <div className="card" style={{ marginTop: 20 }}>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 4px', color: 'var(--theme-text1)' }}>
          Outlet Access
        </h2>
        <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: 0 }}>
          Which outlets each person may switch into. Everyone always has their own outlet; ticking
          another lets them work there at the same rank they already hold.
        </p>
      </div>

      {saveError && (
        <p role="alert" style={{ fontSize: 12, color: 'var(--theme-red-text)', margin: '0 0 12px' }}>
          Couldn’t save — {saveError}
        </p>
      )}

      {loading ? (
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
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const allowed = allowedFor(r)
                return (
                  <tr key={r.profile_id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.full_name || '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.home_client_name || '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <span className={r.is_owner ? 'badge-yellow' : 'badge-gray'}>{roleLabel(r)}</span>
                    </td>
                    {outlets.map(o => {
                      const isHome = o.id === r.home_client_id
                      if (isHome) {
                        return (
                          <td key={o.id} style={{ textAlign: 'center' }}>
                            <Tip text="This is their own outlet — always available, and not something that can be taken away here.">
                              <span style={{ color: 'var(--theme-text3)' }}>home</span>
                            </Tip>
                          </td>
                        )
                      }
                      if (r.is_owner) {
                        return (
                          <td key={o.id} style={{ textAlign: 'center' }}>
                            <Tip text="An owner reaches every outlet in the group by virtue of being the owner, so there is nothing to grant.">
                              <span style={{ color: 'var(--theme-text3)' }}>all</span>
                            </Tip>
                          </td>
                        )
                      }
                      return (
                        <td key={o.id} style={{ textAlign: 'center' }}>
                          <input
                            type="checkbox"
                            checked={allowed.includes(o.id)}
                            onChange={() => toggle(r, o.id)}
                            disabled={savingId === r.profile_id}
                            aria-label={`Allow ${r.full_name || 'this account'} to work at ${o.name}`}
                          />
                        </td>
                      )
                    })}
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {r.is_owner ? null : isDirty(r) ? (
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => save(r)}
                          disabled={savingId === r.profile_id}
                        >
                          {savingId === r.profile_id ? 'Saving…' : 'Save'}
                        </button>
                      ) : savedId === r.profile_id ? (
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
        Removing an outlet also signs that person out of it if they are working there right now.
      </p>
    </div>
  )
}
