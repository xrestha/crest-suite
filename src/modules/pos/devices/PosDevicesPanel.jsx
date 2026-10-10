import { useState } from 'react'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import ActionError, { asActionError } from '../../../components/ActionError'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { withTimeout } from '../../../utils/withTimeout'
import { nepalBsLong, nepalDateLong, nepalTime } from '../../../shared/nepalTime'

// "Tablets" on Till Devices (S754): every till that has its own device key, who activated it, when it
// last reached the sign-in screen, and Revoke. The restaurant's shared key from before per-tablet
// keys, and its Switch off, are gone (S809 3h): it was off at every client.
//
// Data comes in from usePosDevices (Pos.js reads it too, to tell this tablet whether its own key is
// still live). Actions happen here and hand back through `onChanged`.

export function formatMoment(ts) {
  if (!ts) return '—'
  const day = nepalBsLong(ts) || nepalDateLong(ts)
  return `${day} · ${nepalTime(ts)}`
}

// A failed read says so — never an empty list, which would read as "no tablets are set up".
function loadErrorOf(error) {
  const { text, detail } = asActionError(error, 'operator')
  return { text: `Couldn't load the tablet list. ${text}`, detail }
}

export default function PosDevicesPanel({ clientName, devices, loading, error, thisDeviceId, onChanged }) {
  const { ask, confirmEl } = useConfirm()
  const [actionError, setActionError] = useState(null)
  const [notice, setNotice] = useState('')

  const active = devices.filter(d => !d.revoked_at)
  const revoked = devices.filter(d => d.revoked_at)

  function askRevoke(device) {
    setActionError(null); setNotice('')
    const isThis = device.id === thisDeviceId
    ask({
      title: `Revoke “${device.name}”?`,
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>
            That tablet must be activated again before staff can sign in on it. Anyone signed in on
            it with a PIN is signed out too: a till in use goes back to its PIN screen within the
            hour, and no PIN works there.
          </p>
          {isThis && (
            <p style={{ margin: 0, color: 'var(--theme-amber-text)' }}>
              This is the tablet you are using now.
            </p>
          )}
        </>
      ),
      confirmLabel: 'Revoke tablet',
      busyLabel: 'Revoking…',
      danger: true,
      run: async () => {
        let error
        try {
          ({ error } = await withTimeout(supabase.rpc('revoke_pos_device', { p_device_id: device.id }), 20000, 'Revoke'))
        } catch (e) { error = e }
        if (error) { setActionError(asActionError(error, 'operator')); return }
        setNotice(`“${device.name}” was revoked. It must be activated again before staff can sign in on it.`)
        onChanged()
      },
    })
  }

  return (
    <div className="card" style={{ padding: 24, marginBottom: 24 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 16, color: 'var(--theme-text1)' }}>Tablets</h3>
      <p style={{ fontSize: 13, color: 'var(--theme-text3)', margin: '0 0 16px', lineHeight: 1.6 }}>
        Every till activated for {clientName} has its own key. Revoke one that is lost, sold or no
        longer used — the rest keep working.
      </p>

      {notice && <p role="status" style={{ fontSize: 13, color: 'var(--theme-green-text)', margin: '0 0 12px' }}>{notice}</p>}
      <ActionError error={actionError} className="action-error--top" />

      {loading && devices.length === 0 && !error ? (
        <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading tablets…</p>
      ) : error ? (
        <ActionError error={loadErrorOf(error)} />
      ) : devices.length === 0 ? (
        <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>
          No tablet has its own key yet. Activate a till above to add the first one.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Tablet</th>
                <th>Activated by</th>
                <th>
                  <Tip text="The last time this tablet reached the staff sign-in with its key — a PIN attempt, right or wrong. A tablet that has not been used for weeks is worth checking on.">
                    Last used
                  </Tip>
                </th>
                <th>Status</th>
                <th className="no-print"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {[...active, ...revoked].map(d => (
                <tr key={d.id}>
                  <td style={{ minWidth: 140 }}>
                    <span style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{d.name}</span>
                    {d.id === thisDeviceId && (
                      <span style={{ display: 'block', fontSize: 12, color: 'var(--theme-text3)' }}>This tablet</span>
                    )}
                  </td>
                  <td>
                    {d.created_by_name || '—'}
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--theme-text3)', whiteSpace: 'nowrap' }}>
                      {formatMoment(d.created_at)}
                    </span>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{d.last_used_at ? formatMoment(d.last_used_at) : 'Not yet'}</td>
                  <td>
                    {d.revoked_at ? (
                      <>
                        <span className="badge-gray">Revoked</span>
                        <span style={{ display: 'block', fontSize: 12, color: 'var(--theme-text3)', marginTop: 4 }}>
                          {formatMoment(d.revoked_at)}{d.revoked_by_name ? ` by ${d.revoked_by_name}` : ''}
                        </span>
                      </>
                    ) : (
                      <span className="badge-green">Active</span>
                    )}
                  </td>
                  <td className="no-print" style={{ textAlign: 'right' }}>
                    {!d.revoked_at && (
                      <button type="button" className="btn btn-danger btn-sm" onClick={() => askRevoke(d)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirmEl}
    </div>
  )
}
