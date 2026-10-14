import { useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import Tip from '../../../components/Tip'
import Fab from '../../../components/Fab'
import Modal from '../../../components/Modal'
import RowMenu from '../../../components/RowMenu'
import ActionError, { asActionError } from '../../../components/ActionError'
import FieldError, { fieldAria } from '../../../components/FieldError'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { isNetworkError } from '../../../shared/errorText'
import { isTimeout } from '../../../utils/withTimeout'
import { moveRovingFocus, rovingTabIndex } from '../../../shared/rovingFocus'
import { testDoc } from './ticketDoc'
import { usePrintDevices, REFRESH_MS } from './usePrintDevices'
import {
  createPrintDevice, updatePrintDevice, issuePrintPairCode, removePrintDevice, sendPrintTest, HELPER_DOWNLOAD_URL,
} from './printDeviceApi'
import {
  STATIONS, STATION_NAME, STATION_BADGE, KIND_NAME, PAPER_WIDTHS, NAME_MAX, JOB_KIND_NAME,
  orderedStations, stationsText, momentText, deviceStatus, printerReport, stationRoute, jobStateView,
  emptyDeviceForm, formFromDevice, validateDeviceForm, printersPayload, formatPairCode, pairCodeLive,
} from './printDeviceHelpers'

// POS Setup → Printers (S837; contract in docs/kitchen-printers.md). The computers at the restaurant
// that print kitchen and bar tickets instead of each till's own print window: where each station's
// tickets print now, the computers and their status, adding, pairing, testing, editing and removing
// one, and the last 20 tickets sent to them.
//
// The page around it already sends anyone but a POS manager or the Owner away, and every function
// behind this checks the same rank itself (pos_device_caller_may_manage). Its own component, keyed
// by client in PosTableManagement like Guest Menu, so an outlet switch cannot carry one outlet's
// computers or pairing codes into the next.

const noAnswer = err => isTimeout(err) || isNetworkError(err)

// A manager function that refuses raises, and the whole call rolls back, so "was not …" is true for
// a refusal. A call with no answer may still have landed, so it says only what is not known. A bad
// input (22023) carries its own plain sentence in the HINT (the S837 migration writes one for every
// refusal: "This restaurant already has 20 printer computers…"), and that is the next step to show.
function failure(err, { refused, unknown }) {
  const { text, detail } = asActionError(err, 'operator')
  if (noAnswer(err)) return { text: unknown, detail }
  if (err?.code === '22023') {
    const hint = typeof err.hint === 'string' ? err.hint.trim() : ''
    return { text: `${refused} ${hint || 'Crest did not accept the details as given; check them and try again.'}`, detail }
  }
  return { text: `${refused} ${text}`, detail }
}

// A failed read says so, never an empty list ("no printer computers" would send a manager to add
// one that already exists).
function loadFailure(err, what) {
  const { text, detail } = asActionError(err, 'operator')
  return { text: `Couldn't load ${what}. ${text}`, detail }
}

const H3 = { margin: '0 0 4px', fontSize: 16, color: 'var(--theme-text1)' }
const LEAD = { margin: '0 0 16px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }
const SUB = { display: 'block', fontSize: 12, color: 'var(--theme-text3)', marginTop: 2 }
const QUIET = { color: 'var(--theme-text3)', fontSize: 13, margin: 0 }

function StationBadge({ station }) {
  return <span className={STATION_BADGE[station] || 'badge-gray'}>{STATION_NAME[station] || station}</span>
}

function StaleNote({ stale, what }) {
  if (!stale) return null
  const { text } = asActionError(stale.error, 'operator')
  return (
    <p role="status" style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
      Couldn't refresh {what} at {momentText(stale.at, stale.at)}, so this is the last list that loaded. It tries again every {REFRESH_MS / 1000} seconds. {text}
    </p>
  )
}

function RouteLine({ station, route }) {
  const tickets = `${STATION_NAME[station]} tickets`
  const lower = STATION_NAME[station].toLowerCase()
  const name = route.device ? <strong>{route.device.name}</strong> : null
  if (route.state === 'online') {
    return <li>{tickets} print on {name} <span style={{ color: 'var(--theme-green-text)' }}>(online)</span>.</li>
  }
  if (route.state === 'offline') {
    return (
      <li>
        {tickets} print on {name} — <span style={{ color: 'var(--theme-amber-text)', fontWeight: 600 }}>offline</span>,
        so each till prints them itself.
      </li>
    )
  }
  if (route.state === 'unpaired') {
    return <li>{tickets} will print on {name} once it is paired. Until then each till prints them itself.</li>
  }
  return <li>No printer computer — each till prints {lower} tickets itself.</li>
}

export default function PosPrintersPanel({ clientId }) {
  const { isAdmin, adminViewClientName, profile } = useAuth()
  const outletName = isAdmin ? (adminViewClientName || '') : (profile?.clients?.name || '')
  const { devices, jobs, devicesError, jobsError, devicesStale, jobsStale, checkedAt, refresh } = usePrintDevices(clientId)
  const { ask, confirmEl } = useConfirm()

  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState(null)
  const [formFor, setFormFor] = useState(null)   // { device } to edit, { device: null } to add
  const [pairShow, setPairShow] = useState(null) // { device, code, expiresAt }
  const [issued, setIssued] = useState({})       // deviceId → { code, expiresAt }, codes made this visit
  const [issuingId, setIssuingId] = useState(null)
  const [testFor, setTestFor] = useState(null)   // a device covering both stations: pick which
  const [testingId, setTestingId] = useState(null)

  const nowMs = checkedAt || Date.now()

  function clearMessages() { setNotice(''); setActionError(null) }

  function remember(deviceId, code, expiresAt) {
    if (!code) return
    setIssued(m => ({ ...m, [deviceId]: { code, expiresAt } }))
  }

  function openAdd() { clearMessages(); setFormFor({ device: null }) }
  function openEdit(device) { clearMessages(); setFormFor({ device }) }

  function onSaved(result) {
    setFormFor(null)
    if (result.mode === 'edit') {
      setNotice(`Saved ${result.name}.`)
    } else if (result.device && result.code) {
      remember(result.device.id, result.code, result.expiresAt)
      setPairShow({ device: result.device, code: result.code, expiresAt: result.expiresAt })
    } else {
      setNotice(`${result.name} was added, but no pairing code came back. Press Pairing code on it to make one.`)
    }
    refresh()
  }

  async function issueCode(device) {
    clearMessages()
    setIssuingId(device.id)
    const { data, error } = await issuePrintPairCode(device.id)
    setIssuingId(null)
    if (error || !data?.pair_code) {
      setActionError(failure(error || { message: 'The answer had no pairing code in it.' }, {
        refused: 'No pairing code was made.',
        unknown: 'Crest did not answer, so there is no code to show. Press Pairing code again: a new code replaces one that never arrived.',
      }))
      return
    }
    remember(device.id, data.pair_code, data.pair_code_expires_at)
    setPairShow({ device, code: data.pair_code, expiresAt: data.pair_code_expires_at })
    refresh()
  }

  function startTest(device) {
    clearMessages()
    const stations = orderedStations(device.stations)
    if (stations.length > 1) { setTestFor(device); return }
    sendTest(device, stations[0] || 'KOT')
  }

  async function sendTest(device, station) {
    setTestFor(null)
    clearMessages()
    setTestingId(device.id)
    const doc = testDoc({ outletName, deviceName: device.name, station })
    const { error } = await sendPrintTest({ deviceId: device.id, station, doc })
    setTestingId(null)
    if (error) {
      setActionError(failure(error, {
        refused: 'The test ticket was not sent.',
        unknown: 'Crest did not answer, so it is not known whether the test ticket was sent. Watch Recent prints below before sending another.',
      }))
      refresh()
      return
    }
    const what = `${STATION_NAME[station].toLowerCase()} test ticket`
    setNotice(device.online
      ? `The ${what} was sent to ${device.name}. It shows as Printed under Recent prints once ${device.name} has printed it.`
      : `The ${what} was sent, but ${device.name} is not online, so it waits for it (for up to 15 minutes). Watch Recent prints below.`)
    refresh()
  }

  function askRemove(device) {
    clearMessages()
    const covers = stationsText(device.stations).toLowerCase() || 'kitchen'
    ask({
      title: `Remove “${device.name}”?`,
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>
            {device.name} stops printing at once, and any ticket it was in the middle of goes back in the queue.
          </p>
          <p style={{ margin: 0 }}>
            Unless another printer computer prints {covers} tickets, each till prints them itself from now on.
            To use this computer again, add it again and type the new code on it.
          </p>
        </>
      ),
      confirmLabel: 'Remove',
      busyLabel: 'Removing…',
      danger: true,
      run: async () => {
        const { error } = await removePrintDevice(device.id)
        if (error) {
          setActionError(failure(error, {
            refused: `${device.name} was not removed.`,
            unknown: `Crest did not answer, so it is not known whether ${device.name} was removed. Check the list below; pressing Remove again is safe.`,
          }))
          refresh()
          return
        }
        setIssued(m => { const next = { ...m }; delete next[device.id]; return next })
        setNotice(`${device.name} was removed. Its tickets print on the tills now, unless another printer computer prints them.`)
        refresh()
      },
    })
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
        <p style={{ ...LEAD, margin: 0, flex: '1 1 320px', maxWidth: 680 }}>
          A computer at the restaurant can print kitchen and bar tickets on its own printer, instead of each till
          opening a print window. Whenever that computer is off or offline, each till prints its tickets itself, as before.
        </p>
        <Fab onClick={openAdd} label="+ Add printer computer" />
      </div>

      {notice && <p role="status" style={{ fontSize: 13, color: 'var(--theme-green-text)', margin: '0 0 12px' }}>{notice}</p>}
      <ActionError error={actionError} className="action-error--top" />

      {/* ── Where each station's tickets print now ── */}
      <section className="card" style={{ marginBottom: 16 }} aria-labelledby="pp-where">
        <h3 id="pp-where" style={H3}>Where tickets print</h3>
        {devices === null ? (
          <p style={QUIET}>{devicesError ? 'Not known: the printer computers could not be loaded (see below).' : 'Checking…'}</p>
        ) : (
          <ul style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 14, lineHeight: 1.8, color: 'var(--theme-text1)' }}>
            {STATIONS.map(s => <RouteLine key={s} station={s} route={stationRoute(devices, s)} />)}
          </ul>
        )}
      </section>

      {/* ── The printer computers ── */}
      <section className="card" style={{ marginBottom: 16 }} aria-labelledby="pp-devices">
        <h3 id="pp-devices" style={H3}>Printer computers</h3>
        <p style={LEAD}>
          Each one is paired once with a code from here. Status refreshes every {REFRESH_MS / 1000} seconds while this tab is open.
        </p>
        <StaleNote stale={devicesStale} what="the printer computers" />
        {devices === null ? (
          devicesError
            ? <ActionError error={loadFailure(devicesError, 'the printer computers')} />
            : <p style={QUIET}>Loading printer computers…</p>
        ) : devices.length === 0 ? (
          <p style={QUIET}>
            No printer computer yet, so every till prints its own tickets. Press <strong>+ Add printer computer</strong> to set one up.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Printer computer</th>
                  <th>
                    <Tip text="Which tickets this computer prints: kitchen (KOT), bar (BOT) or both.">Prints</Tip>
                  </th>
                  <th>
                    <Tip text="Online means it checked in with Crest in the last 20 seconds and is printing tickets. While it is offline, each till prints its tickets itself." width={260}>Status</Tip>
                  </th>
                  <th>
                    <Tip text="For a Print helper: each printer's address on the restaurant network and its paper width, with what the helper last said about it. A print station page prints to the computer's default printer in Windows." width={300}>Printers</Tip>
                  </th>
                  <th>
                    <Tip text="The last thing that went wrong on this computer, as it reported it — a printer out of paper, switched off or unreachable." width={260}>Last problem</Tip>
                  </th>
                  <th className="no-print"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {devices.map(d => {
                  const st = deviceStatus(d, nowMs, issued[d.id])
                  const stations = orderedStations(d.stations)
                  return (
                    <tr key={d.id}>
                      <td>
                        <span style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{d.name}</span>
                        <span style={SUB}>{KIND_NAME[d.kind] || d.kind}</span>
                      </td>
                      <td>
                        <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                          {stations.map(s => <StationBadge key={s} station={s} />)}
                        </span>
                      </td>
                      <td>
                        <span className={st.badge}>{st.text}</span>
                        <span style={SUB}>{st.detail}</span>
                        {st.pairing && <span style={SUB}>{st.pairing}</span>}
                      </td>
                      <td>
                        {d.kind === 'helper' ? (
                          (Array.isArray(d.printers) ? d.printers : []).map(p => {
                            const rep = printerReport(d, p.station)
                            return (
                              <span key={p.station} style={{ display: 'block', marginBottom: 4 }}>
                                <span style={{ whiteSpace: 'nowrap' }}>{STATION_NAME[p.station] || p.station}: {p.host}:{p.port}</span>
                                {' · '}<span style={{ whiteSpace: 'nowrap' }}>{p.width} mm</span>
                                {rep && (
                                  <span style={{ ...SUB, color: rep.ok ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
                                    {rep.ok ? 'Working' : `Not printing${rep.error ? `: ${rep.error}` : ''}`}
                                    {!d.online && ' (at its last check-in)'}
                                  </span>
                                )}
                              </span>
                            )
                          })
                        ) : (
                          <span style={{ color: 'var(--theme-text2)' }}>Windows default printer</span>
                        )}
                      </td>
                      <td>
                        {d.last_error ? (
                          <>
                            <span>{d.last_error}</span>
                            {d.last_error_at && <span style={{ ...SUB, whiteSpace: 'nowrap' }}>{momentText(d.last_error_at, nowMs)}</span>}
                          </>
                        ) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                      </td>
                      <td className="no-print" style={{ textAlign: 'right' }}>
                        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                          <Tip text="Sends a short test ticket to this computer's printer. It appears under Recent prints below." width={240}>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => startTest(d)}
                              disabled={testingId === d.id} aria-busy={testingId === d.id ? 'true' : undefined}>
                              {testingId === d.id ? 'Sending…' : 'Test print'}
                            </button>
                          </Tip>
                          <Tip text="Makes a new 8-character code to type on the printer computer, to connect it the first time or to move it to another computer. A computer already paired keeps printing until the new code is used." width={300}>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => issueCode(d)}
                              disabled={issuingId === d.id} aria-busy={issuingId === d.id ? 'true' : undefined}>
                              {issuingId === d.id ? 'Making…' : 'Pairing code'}
                            </button>
                          </Tip>
                          <RowMenu
                            label={`More for ${d.name}`}
                            items={[
                              { key: 'edit', label: 'Edit', onSelect: () => openEdit(d) },
                              '-',
                              { key: 'remove', label: 'Remove', danger: true, onSelect: () => askRemove(d) },
                            ]}
                          />
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── The last tickets sent to a printer computer ── */}
      <section className="card fab-clear" aria-labelledby="pp-recent">
        <h3 id="pp-recent" style={H3}>Recent prints</h3>
        <p style={LEAD}>The last 20 tickets sent to a printer computer, newest first.</p>
        <StaleNote stale={jobsStale} what="recent prints" />
        {jobs === null ? (
          jobsError
            ? <ActionError error={loadFailure(jobsError, 'recent prints')} />
            : <p style={QUIET}>Loading recent prints…</p>
        ) : jobs.length === 0 ? (
          <p style={QUIET}>
            No ticket has gone to a printer computer yet. Tickets a till prints in its own print window are not listed here.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Sent</th>
                  <th>Ticket</th>
                  <th>What</th>
                  <th>
                    <Tip text="Printed: a printer computer printed it. Printed on the till: nobody's printer computer did, so a waiter printed it on a till. Retrying: a printer computer tried and will try again. Failed: five tries failed. Expired: nothing printed it within 15 minutes." width={320}>Result</Tip>
                  </th>
                  <th>
                    <Tip text="The printer computer that printed it, or is printing it now." width={220}>Printer computer</Tip>
                  </th>
                </tr>
              </thead>
              <tbody>
                {jobs.map(j => {
                  const view = jobStateView(j)
                  const kind = JOB_KIND_NAME[j.kind]
                  return (
                    <tr key={j.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{momentText(j.created_at, nowMs)}</td>
                      <td><StationBadge station={j.station} /></td>
                      <td>
                        {kind && <span style={{ fontWeight: 600 }}>{kind}{j.label ? ' · ' : ''}</span>}
                        {j.label || (kind ? '' : '—')}
                      </td>
                      <td>
                        <span className={view.badge}>{view.text}</span>
                        {view.reason && <span style={SUB}>{view.reason}</span>}
                      </td>
                      <td>
                        {j.state === 'printed' && j.printed_via === 'till'
                          ? <span style={{ color: 'var(--theme-text2)' }}>A till</span>
                          : (j.device_name || <span style={{ color: 'var(--theme-text3)' }}>—</span>)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {formFor && (
        <DeviceFormModal
          clientId={clientId}
          device={formFor.device}
          onClose={() => setFormFor(null)}
          onSaved={onSaved}
          onRefresh={refresh}
        />
      )}
      {pairShow && (
        <PairCodeModal {...pairShow} nowMs={Date.now()} onClose={() => setPairShow(null)} />
      )}
      {testFor && (
        <Modal title={`Test print on ${testFor.name}`} onClose={() => setTestFor(null)} maxWidth={440}>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--theme-text1)', lineHeight: 1.6 }}>
            {testFor.name} prints both kitchen and bar tickets. Which test ticket should it print?
          </p>
          <div className="form-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setTestFor(null)}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={() => sendTest(testFor, 'KOT')}>Kitchen test</button>
            <button type="button" className="btn btn-primary" onClick={() => sendTest(testFor, 'BOT')}>Bar test</button>
          </div>
        </Modal>
      )}
      {confirmEl}
    </div>
  )
}

// ── Add / Edit ──────────────────────────────────────────────────────────────────────────────────

const KINDS = [
  {
    key: 'page',
    title: 'Print station page',
    example: 'A printer plugged into this computer by USB, or installed in Windows.',
    hint: 'Chrome stays open on a Crest page that prints each ticket. One window per printer.',
  },
  {
    key: 'helper',
    title: 'Crest Print Helper',
    example: 'Printers on the restaurant network, by their address.',
    hint: 'A small Windows program. One helper can drive the kitchen and the bar printer.',
  },
]

function DeviceFormModal({ clientId, device, onClose, onSaved, onRefresh }) {
  const editing = !!device
  const [initial] = useState(() => (device ? formFromDevice(device) : emptyDeviceForm()))
  const [form, setForm] = useState(initial)
  const [tried, setTried] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)

  const errors = tried ? validateDeviceForm(form) : {}
  const dirty = JSON.stringify(form) !== JSON.stringify(initial)
  const chosen = orderedStations(form.stations)

  const set = (key, value) => setForm(f => ({ ...f, [key]: value }))
  const setPrinter = (station, key, value) =>
    setForm(f => ({ ...f, printers: { ...f.printers, [station]: { ...f.printers[station], [key]: value } } }))
  const toggleStation = station =>
    setForm(f => ({ ...f, stations: f.stations.includes(station) ? f.stations.filter(s => s !== station) : [...f.stations, station] }))

  async function submit(e) {
    e.preventDefault()
    if (saving) return
    setTried(true)
    setSaveError(null)
    if (Object.keys(validateDeviceForm(form)).length) return
    const name = form.name.trim()
    const stations = orderedStations(form.stations)
    const printers = printersPayload(form)
    setSaving(true)
    if (editing) {
      const { error } = await updatePrintDevice({ deviceId: device.id, name, stations, printers })
      setSaving(false)
      if (error) {
        setSaveError(failure(error, {
          refused: 'Nothing was changed.',
          unknown: 'Crest did not answer, so it is not known whether the change was saved. Close this and check the list before saving again.',
        }))
        onRefresh()
        return
      }
      onSaved({ mode: 'edit', name })
      return
    }
    const { data, error } = await createPrintDevice({ clientId, name, kind: form.kind, stations, printers })
    setSaving(false)
    if (error) {
      setSaveError(failure(error, {
        refused: 'The printer computer was not added.',
        unknown: 'Crest did not answer, so it is not known whether the printer computer was added. Close this and check the list before adding it again.',
      }))
      onRefresh()
      return
    }
    onSaved({
      mode: 'add',
      name,
      device: data?.device_id ? { id: data.device_id, name, kind: form.kind, stations, paired: false } : null,
      code: data?.pair_code || '',
      expiresAt: data?.pair_code_expires_at || null,
    })
  }

  return (
    <Modal
      title={editing ? `Edit ${device.name}` : 'Add a printer computer'}
      onClose={() => { if (!saving) onClose() }}
      maxWidth={640}
      dirty={dirty}
    >
      <form onSubmit={submit} noValidate>
        <ActionError error={saveError} className="action-error--top" />

        <div className="form-field">
          <label htmlFor="pp-name">
            Name <Tip text="A name your staff will recognise: where the computer sits, like Counter PC or Kitchen laptop. It shows on the tills and on the test ticket." width={260}>ⓘ</Tip>
          </label>
          <input id="pp-name" value={form.name} maxLength={NAME_MAX} autoComplete="off" placeholder="e.g. Counter PC"
            onChange={e => set('name', e.target.value)} {...fieldAria('pp-name', errors.name)} />
          <FieldError id="pp-name" message={errors.name} />
        </div>

        {editing ? (
          <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--theme-text2)' }}>
            <strong style={{ color: 'var(--theme-text1)' }}>{KIND_NAME[device.kind] || device.kind}.</strong>{' '}
            To switch between the print station page and the Print Helper, remove this one and add it again.
          </p>
        ) : (
          <div className="form-field">
            <span className="field-label" id="pp-kind-label">
              How does this computer reach the printer? <Tip text="If the kitchen printer has a USB cable into this computer (or Windows already prints to it), choose the print station page. If the printers sit on the restaurant's network with their own address, choose the Print Helper." width={300}>ⓘ</Tip>
            </span>
            <div role="radiogroup" aria-labelledby="pp-kind-label"
              onKeyDown={e => moveRovingFocus(e, '[role="radio"]')?.click()}
              style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: 8 }}>
              {KINDS.map(k => {
                const on = form.kind === k.key
                return (
                  <button key={k.key} type="button" role="radio" aria-checked={on} className="kind-card"
                    tabIndex={rovingTabIndex(on)} onClick={() => set('kind', k.key)}>
                    <span className="kind-card__title">{k.title}</span>
                    <span className="kind-card__example">{k.example}</span>
                    <span className="kind-card__hint">{k.hint}</span>
                  </button>
                )
              })}
            </div>
            <FieldError id="pp-kind" message={errors.kind} />
          </div>
        )}

        <div className="form-field">
          <span className="field-label" id="pp-stations-label">
            Prints <Tip text="Which tickets this computer prints. It can print both. If two computers print the same tickets, whichever is online prints each ticket, once." width={280}>ⓘ</Tip>
          </span>
          <div role="group" aria-labelledby="pp-stations-label" aria-describedby={errors.stations ? 'pp-stations-err' : undefined}
            style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            {STATIONS.map(s => (
              <label key={s} className="form-check">
                <input type="checkbox" checked={form.stations.includes(s)} onChange={() => toggleStation(s)} />
                {s === 'KOT' ? 'Kitchen tickets (KOT)' : 'Bar tickets (BOT)'}
              </label>
            ))}
          </div>
          <FieldError id="pp-stations" message={errors.stations} />
        </div>

        {form.kind === 'helper' ? chosen.map(s => {
          const p = form.printers[s]
          const id = k => `pp-${s}-${k}`
          return (
            <fieldset key={s} style={{ border: 0, borderTop: '1px solid var(--theme-border)', margin: '0 0 8px', padding: '12px 0 0', minWidth: 0 }}>
              <legend style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)', padding: '0 8px 0 0' }}>
                {STATION_NAME[s]} printer
              </legend>
              <div className="field-grid">
                <div className="form-field">
                  <label htmlFor={id('host')}>
                    Address <Tip text="The printer's own address on the restaurant network, like 192.168.1.50. To find it: switch the printer off, hold its feed button while switching it back on, and let go when it prints a self-test page. The address is on that page, often as IP Address." width={320}>ⓘ</Tip>
                  </label>
                  <input id={id('host')} value={p.host} inputMode="decimal" autoComplete="off" spellCheck={false} placeholder="192.168.1.50"
                    onChange={e => setPrinter(s, 'host', e.target.value)} {...fieldAria(id('host'), errors[`${s}.host`])} />
                  <FieldError id={id('host')} message={errors[`${s}.host`]} />
                </div>
                <div className="form-field">
                  <label htmlFor={id('port')}>
                    Port <Tip text="Leave this at 9100 unless the printer's self-test page names a different port, which is rare." width={240}>ⓘ</Tip>
                  </label>
                  <input id={id('port')} value={p.port} inputMode="numeric" autoComplete="off"
                    onChange={e => setPrinter(s, 'port', e.target.value)} {...fieldAria(id('port'), errors[`${s}.port`])} />
                  <FieldError id={id('port')} message={errors[`${s}.port`]} />
                </div>
                <div className="form-field">
                  <label htmlFor={id('width')}>
                    Paper width <Tip text="The width of the paper roll. 80 mm is the usual kitchen roll; 58 mm is the narrow roll some small printers take." width={260}>ⓘ</Tip>
                  </label>
                  <select id={id('width')} value={p.width} onChange={e => setPrinter(s, 'width', Number(e.target.value))}
                    {...fieldAria(id('width'), errors[`${s}.width`])}>
                    {PAPER_WIDTHS.map(w => <option key={w} value={w}>{w} mm</option>)}
                  </select>
                  <FieldError id={id('width')} message={errors[`${s}.width`]} />
                </div>
              </div>
            </fieldset>
          )
        }) : (
          <div className="note-banner" style={{ margin: '0 0 8px' }}>
            <strong>It prints to that computer's default printer.</strong> In Windows on that computer, set the kitchen
            printer as the default. For a second printer, add a second print station page on the computer it is plugged into.
          </div>
        )}

        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving} aria-busy={saving ? 'true' : undefined}>
            {saving ? (editing ? 'Saving…' : 'Adding…') : (editing ? 'Save' : 'Add and make a pairing code')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ── The pairing code ────────────────────────────────────────────────────────────────────────────

function PairCodeModal({ device, code, expiresAt, nowMs, onClose }) {
  const url = `${window.location.origin}/print-station`
  const live = pairCodeLive(expiresAt, nowMs)
  const until = momentText(expiresAt, nowMs)
  const step = { margin: '0 0 10px', lineHeight: 1.6 }
  const link = { color: 'var(--theme-accent-ink)', fontWeight: 600 }
  return (
    <Modal title={`Pair ${device.name}`} onClose={onClose} maxWidth={600}>
      <p style={{ margin: '0 0 4px', fontSize: 13, color: 'var(--theme-text2)' }}>Pairing code</p>
      <p style={{
        margin: '0 0 8px', fontSize: 32, fontWeight: 700, letterSpacing: 6, color: 'var(--theme-text1)',
        fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', lineHeight: 1.1,
      }}>
        {formatPairCode(code)}
      </p>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: live ? 'var(--theme-text2)' : 'var(--theme-amber-text)' }}>
        {live
          ? `Good for 15 minutes, until ${until}, and it works once.`
          : 'This code has run out. Press Pairing code on the computer again for a new one.'}
      </p>
      {device.paired && (
        <div className="note-banner" style={{ margin: '0 0 16px' }}>
          <strong>{device.name} is paired now.</strong> It keeps printing until this code is typed on a computer;
          that computer then takes over.
        </div>
      )}
      <ol style={{ margin: 0, paddingLeft: 22, fontSize: 14, color: 'var(--theme-text1)' }}>
        {device.kind === 'helper' ? (
          <>
            <li style={step}>
              On a computer at the restaurant, on the same network as the printers,{' '}
              <a href={HELPER_DOWNLOAD_URL} style={link} rel="noopener noreferrer">download the Crest Print Helper</a>.
            </li>
            <li style={step}>
              Unzip it and run <strong>CrestPrintHelper.exe</strong>. If Windows says “Windows protected your PC”,
              click <strong>More info</strong>, then <strong>Run anyway</strong>.
            </li>
            <li style={step}>Type this code into it.</li>
            <li style={step}>Leave it running. Tickets print on the printers from then on.</li>
          </>
        ) : (
          <>
            <li style={step}>
              On the counter computer, open Chrome with the silent-printing shortcut (Help → Kitchen and bar printers shows
              how to make it). Without it, every ticket opens a print window someone has to press.
            </li>
            <li style={step}>
              Go to <strong style={{ wordBreak: 'break-all' }}>{url}</strong>
            </li>
            <li style={step}>Type this code and press Pair.</li>
            <li style={step}>Leave that window open. Tickets print there from then on.</li>
          </>
        )}
      </ol>
      <div className="form-actions">
        <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  )
}
