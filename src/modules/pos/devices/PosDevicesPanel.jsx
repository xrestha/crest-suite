import { useState } from 'react'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import ActionError, { asActionError } from '../../../components/ActionError'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { withTimeout } from '../../../utils/withTimeout'
import { nepalBsLong, nepalDateLong, nepalTime } from '../../../shared/nepalTime'

// "Tablets" on POS Setup (S754): every till that has its own device key, who activated it, when it
// last reached the sign-in screen, and Revoke. Below the list, the restaurant's shared key from
// before per-tablet keys, and the one control that switches it off.
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

export default function PosDevicesPanel({ clientId, clientName, devices, legacy, loading, error, thisDeviceId, onChanged }) {
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
            That tablet will be signed out of PIN login and must be activated again. Staff can no
            longer sign in on it, and anyone already signed in there is returned to the PIN screen
            the next time the till locks.
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

  function askRetireLegacy() {
    setActionError(null); setNotice('')
    ask({
      title: 'Switch off the shared key?',
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>
            Any tablet still signing in with {clientName}&rsquo;s shared key stops showing staff at once,
            and must be activated again by a manager before it can be used as a till.
          </p>
          <p style={{ margin: 0 }}>
            The {active.length} tablet{active.length === 1 ? '' : 's'} in the list above {active.length === 1 ? 'has' : 'have'} its own
            key and {active.length === 1 ? 'is' : 'are'} not affected. The shared key cannot be switched back on.
          </p>
        </>
      ),
      confirmLabel: 'Switch it off',
      busyLabel: 'Switching off…',
      danger: true,
      run: async () => {
        let error
        try {
          ({ error } = await withTimeout(supabase.rpc('retire_pos_legacy_device_key', { p_client_id: clientId }), 20000, 'Switch off'))
        } catch (e) { error = e }
        if (error) { setActionError(asActionError(error, 'operator')); return }
        setNotice('The shared key is off. Only tablets in the list above can sign staff in now.')
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

      {/* The pre-S754 shared key. Hidden while its state is unknown, so a failed read never shows
          a switch-off button beside a guess. */}
      {legacy && !legacy.none && (
        legacy.retired_at ? (
          <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '16px 0 0' }}>
            The restaurant&rsquo;s shared key was switched off {formatMoment(legacy.retired_at)}.
          </p>
        ) : (
          <div style={{
            marginTop: 20, padding: '14px 16px',
            border: '1px solid color-mix(in srgb, var(--theme-amber) 35%, transparent)',
            background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)',
          }}>
            <div style={{ fontWeight: 600, color: 'var(--theme-amber-text)', marginBottom: 4 }}>
              The shared key is still on
            </div>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 10px', lineHeight: 1.6 }}>
              Tills activated before tablets had their own keys still sign in with one key shared by
              the whole restaurant, and it cannot be revoked for one tablet alone. Activate each of
              those tills again so it appears in the list above, then switch the shared key off.
              {' '}Last used by a tablet: <strong>{legacy.last_used_at ? formatMoment(legacy.last_used_at) : 'not since this update'}</strong>.
            </p>
            <button type="button" className="btn btn-danger btn-sm" onClick={askRetireLegacy}>
              Switch off the shared key
            </button>
          </div>
        )
      )}

      {confirmEl}
    </div>
  )
}
