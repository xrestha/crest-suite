import { useState, useEffect, useRef } from 'react'
import './PrintStation.css'
import Tip from '../../../components/Tip'
import ActionError, { asActionError } from '../../../components/ActionError'
import FieldError, { fieldAria } from '../../../components/FieldError'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { useReleaseReload } from '../../../shared/releaseWatch'
import { APP_VERSION } from '../../../shared/appVersion'
import { nepalTime } from '../../../shared/nepalTime'
import { renderTicketDocHtml, withLateLine, testDoc } from './ticketDoc'
import { pairPrintDevice, deviceRpc } from './printDeviceApi'
import { createPrintRunner, isNoAnswer, TICK_MS } from './printStationRunner'
import { printHtmlInHiddenFrame } from './iframePrint'
import { readStoredDevice, writeStoredDevice, clearStoredDevice } from './printStationStorage'
import {
  formatPairCode, normalizePairCode, pairCodeProblem, orderedStations, stationsText, agoText,
  STATION_NAME, STATION_BADGE, JOB_KIND_NAME,
} from './printDeviceHelpers'

// /print-station (S837; contract in docs/kitchen-printers.md): the no-login page that turns the
// counter computer into the kitchen or bar printer. Chrome is started with --kiosk-printing, so
// window.print() goes straight to the default printer; this page polls Crest every 2 s for tickets,
// prints each through a hidden frame and reports back. The loop itself is printStationRunner.js.
//
// A computer is paired once with a code from POS Setup → Printers; the device id and secret are kept
// in localStorage (printStationStorage.js) so a Chrome restart keeps printing. Whoever is signed in
// on this computer does not matter: the device functions take the device's own id and secret, through
// a client that never holds a session (printDeviceApi.js), so a lapsed sign-in cannot stop printing.

const RELOAD_IDLE_MS = 30000
const RECENT_MAX = 20

// ── Pairing ─────────────────────────────────────────────────────────────────────────────────────

const PAIR_REFUSAL = {
  pair_code_invalid: 'That code is not right, or it has run out or been used already. Check it, or make a new one in POS Setup → Printers (a code lasts 15 minutes).',
  wrong_kind: 'This code is for the Crest Print Helper program, not this page. Type it into the Print Helper, or in POS Setup → Printers add a printer computer of the kind “Print station page” for this computer.',
  too_many_attempts: 'Too many wrong codes were typed from this network. Wait 15 minutes, then try again with a fresh code.',
  pos_off: 'POS is switched off for this restaurant, so this computer cannot be paired. The account owner can switch POS back on.',
}

function pairRefusal(data) {
  return {
    text: PAIR_REFUSAL[data?.code] || 'Crest did not accept the code. Make a new one in POS Setup → Printers and try again.',
    detail: [data?.code, data?.message].filter(Boolean).join(' · '),
  }
}

function pairCallFailure(err) {
  const { text, detail } = asActionError(err, 'operator')
  if (isNoAnswer(err)) {
    return {
      text: "Crest did not answer. Check this computer's internet connection and press Pair again. If the code is then refused as used, make a new one in POS Setup → Printers.",
      detail,
    }
  }
  return { text: `This computer could not be paired. ${text}`, detail }
}

export default function PrintStation() {
  const [device, setDevice] = useState(() => readStoredDevice())
  const [memoryOnly, setMemoryOnly] = useState(false) // paired, but the pairing could not be saved
  const [ended, setEnded] = useState('')              // 'removed' | 'unpaired': why the pair form is back

  useEffect(() => {
    const before = document.title
    document.title = 'Crest print station'
    return () => { document.title = before }
  }, [])

  if (!device) {
    return (
      <PairScreen
        ended={ended}
        onPaired={(paired, saved) => { setDevice(paired); setMemoryOnly(!saved); setEnded('') }}
      />
    )
  }
  return (
    <StationScreen
      key={device.deviceId}
      device={device}
      memoryOnly={memoryOnly}
      onEnd={reason => { clearStoredDevice(); setDevice(null); setMemoryOnly(false); setEnded(reason) }}
    />
  )
}

function Checklist() {
  return (
    <section className="card ps-card" aria-labelledby="ps-check">
      <h2 id="ps-check">Keep it printing</h2>
      <ul className="ps-list">
        <li>
          <strong>Start Chrome with the silent-printing shortcut.</strong> Without it, every ticket opens a print
          window that someone has to press. In Crest, Help → Kitchen and bar printers shows how to make the
          shortcut.
        </li>
        <li><strong>Keep this window open.</strong> Tickets print here only while it is open.</li>
        <li>
          <strong>Set Windows to never sleep.</strong> In Windows Settings → System → Power, set the screen and sleep to
          Never when plugged in. A sleeping computer prints nothing, and the tills print instead.
        </li>
        <li><strong>Make the kitchen printer the default printer</strong> in Windows on this computer. Tickets go to the default printer.</li>
      </ul>
    </section>
  )
}

function PairScreen({ ended, onPaired }) {
  const [code, setCode] = useState('')
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  useReleaseReload(!busy, RELOAD_IDLE_MS)

  const problem = tried ? pairCodeProblem(code) : ''

  async function submit(e) {
    e.preventDefault()
    if (busy) return
    setTried(true)
    setError(null)
    if (pairCodeProblem(code)) return
    setBusy(true)
    const { data, error: callError } = await pairPrintDevice(normalizePairCode(code), { kind: 'page', app_version: APP_VERSION })
    setBusy(false)
    if (callError) { setError(pairCallFailure(callError)); return }
    if (!data || data.ok !== true) { setError(pairRefusal(data)); return }
    if (!data.device_id || !data.secret) {
      setError({ text: 'Crest answered without the pairing in it. Make a new code in POS Setup → Printers and try again.', detail: '' })
      return
    }
    const paired = { deviceId: data.device_id, secret: data.secret, deviceName: data.device_name || '', clientName: data.client_name || '' }
    onPaired(paired, writeStoredDevice(paired))
  }

  return (
    <div className="ps-root">
      <main className="ps-main">
        <header className="ps-head">
          <div>
            <p className="ps-brand">Crest</p>
            <h1 className="ps-title">Print station</h1>
          </div>
        </header>

        {ended === 'removed' && (
          <div className="ps-warn" role="alert">
            <strong>This computer has stopped printing.</strong> It was removed in POS Setup → Printers, or its pairing code
            was used on another computer. The tills print their own tickets until it is paired again.
          </div>
        )}
        {ended === 'unpaired' && (
          <div className="note-banner" style={{ marginBottom: 20 }}>
            <strong>This computer is no longer paired.</strong> The tills print their own tickets. Type a new code to pair it again.
          </div>
        )}

        <section className="card ps-card" aria-labelledby="ps-pair">
          <h2 id="ps-pair">Pair this computer</h2>
          <ol className="ps-list" style={{ marginBottom: 20 }}>
            <li>In Crest, open <strong>POS Setup → Printers</strong>.</li>
            <li>Add a printer computer and choose <strong>Print station page</strong>, or press <strong>Pairing code</strong> on one already listed.</li>
            <li>Type the code shown there, below. It lasts 15 minutes.</li>
          </ol>
          <form onSubmit={submit} noValidate>
            <div className="form-field">
              <label htmlFor="ps-code">
                Pairing code <Tip text="8 letters and numbers, shown as two groups of four. Spaces, dashes and small letters are fine." width={240}>ⓘ</Tip>
              </label>
              <input
                id="ps-code"
                className="ps-code-input"
                value={code}
                onChange={e => setCode(formatPairCode(e.target.value))}
                placeholder="ABCD-EFGH"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="characters"
                spellCheck={false}
                autoFocus
                {...fieldAria('ps-code', problem)}
              />
              <FieldError id="ps-code" message={problem} />
            </div>
            <ActionError error={error} />
            <div className="ps-actions">
              <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy ? 'true' : undefined}>
                {busy ? 'Pairing…' : 'Pair'}
              </button>
            </div>
          </form>
        </section>

        <Checklist />
      </main>
    </div>
  )
}

// ── Printing ────────────────────────────────────────────────────────────────────────────────────

// A closed set: a status this map does not name renders nothing rather than a guess.
const STATUS_VIEW = {
  connecting: { tone: '', title: 'Connecting to Crest…', detail: 'Checking for tickets.' },
  ready: { tone: 'ok', title: 'Ready — waiting for tickets', detail: null },
  printing: { tone: 'busy', title: null, detail: 'Tickets print one after another, in the order they were sent.' },
  retrying: {
    tone: 'warn',
    title: "Can't reach Crest — retrying",
    detail: "Until this computer is back in touch, each till prints its own tickets. Check this computer's internet connection.",
  },
  paused: {
    tone: 'warn',
    title: 'Paused: POS is switched off for this outlet',
    detail: 'Nothing prints here until POS is switched back on. This page keeps checking by itself.',
  },
}

const recentOf = (job, extra) => ({
  id: job.id, station: job.station, kind: job.kind, label: job.label || '', late: !!job.late, ...extra,
})

function useScreenWakeLock() {
  useEffect(() => {
    let lock = null
    let alive = true
    const acquire = async () => {
      if (!alive || lock || document.visibilityState !== 'visible' || !navigator.wakeLock?.request) return
      try {
        lock = await navigator.wakeLock.request('screen')
        lock.addEventListener?.('release', () => { lock = null })
      } catch (_) {
        lock = null // refused (battery saver, an unfocused window): the setup checklist covers sleep
      }
    }
    const onVisibility = () => { if (document.visibilityState === 'visible') acquire() }
    acquire()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVisibility)
      lock?.release?.().catch(() => {})
    }
  }, [])
}

function StationScreen({ device, memoryOnly, onEnd }) {
  const { ask, confirmEl } = useConfirm()
  const [status, setStatus] = useState('connecting')
  const [printingLabel, setPrintingLabel] = useState('')
  const [lastError, setLastError] = useState(null)
  const [info, setInfo] = useState({ name: device.deviceName, clientName: device.clientName, stations: [] })
  const [recent, setRecent] = useState([])
  const [inFlight, setInFlight] = useState(false)
  const [pendingReport, setPendingReport] = useState(false)
  const [lastOkAt, setLastOkAt] = useState(0)
  const [testBusy, setTestBusy] = useState(false)
  const [testMsg, setTestMsg] = useState(null) // { ok, text }

  const runnerRef = useRef(null)
  const onEventRef = useRef(null)
  const applyRef = useRef(null)
  const savedNames = useRef({ deviceName: device.deviceName, clientName: device.clientName })

  useScreenWakeLock()
  // A release reloads this page only between ticks, with no report unheard and no test printing, and
  // never while the pairing lives only in memory (a reload would lose it).
  useReleaseReload(!memoryOnly && !inFlight && !pendingReport && !testBusy, RELOAD_IDLE_MS)

  const addRecent = entry => setRecent(list => [entry, ...list].slice(0, RECENT_MAX))

  onEventRef.current = e => {
    if (e.type === 'job-start') {
      setStatus('printing')
      setPrintingLabel(e.job.label || `${STATION_NAME[e.job.station] || 'a'} ticket`)
    } else if (e.type === 'job-printed') {
      addRecent(recentOf(e.job, { at: e.at, ok: true }))
    } else if (e.type === 'job-failed') {
      addRecent(recentOf(e.job, { at: e.at, ok: false, reason: e.reason }))
    } else if (e.type === 'report-refused') {
      console.error('print station: Crest refused the printed-ticket report', e.code, e.message)
    }
  }

  applyRef.current = out => {
    if (out.kind === 'removed') { onEnd('removed'); return }
    if (out.kind === 'unreachable') {
      setStatus('retrying')
      setPrintingLabel('')
      setLastError(out.error)
      return
    }
    if (out.kind !== 'ok' && out.kind !== 'paused') return
    setStatus(out.kind === 'paused' ? 'paused' : 'ready')
    setPrintingLabel('')
    setLastError(null)
    setLastOkAt(Date.now())
    const name = out.device?.name || info.name
    const clientName = out.clientName || info.clientName
    const stations = out.device ? orderedStations(out.device.stations) : info.stations
    setInfo(prev => (prev.name === name && prev.clientName === clientName && prev.stations.join() === stations.join())
      ? prev
      : { name, clientName, stations })
    // Keep the names on this computer current, so the page reads right after a restart.
    if (name !== savedNames.current.deviceName || clientName !== savedNames.current.clientName) {
      savedNames.current = { deviceName: name, clientName }
      writeStoredDevice({ ...device, deviceName: name, clientName })
    }
  }

  useEffect(() => {
    const runner = createPrintRunner({
      device: { deviceId: device.deviceId, secret: device.secret },
      rpc: deviceRpc,
      printHtml: html => printHtmlInHiddenFrame(html),
      renderDoc: renderTicketDocHtml,
      withLate: withLateLine,
      appVersion: APP_VERSION,
      onEvent: e => onEventRef.current?.(e),
    })
    runnerRef.current = runner
    let alive = true

    const onTick = async () => {
      if (!alive || !runner.due()) return
      setInFlight(true)
      const out = await runner.tick()
      if (!alive) return
      setInFlight(false)
      setPendingReport(runner.hasPendingReport)
      applyRef.current?.(out)
    }

    // The worker's clock keeps its 2 s pace in a background window, where the page's own timers are
    // slowed to once a minute. If it cannot start, the page's own interval is the fallback.
    let worker = null
    let interval = null
    const fallback = () => { if (!interval) interval = setInterval(onTick, TICK_MS) }
    try {
      worker = new Worker('/print-station-tick.js')
      worker.onmessage = onTick
      worker.onerror = () => {
        worker?.terminate()
        worker = null
        fallback()
      }
    } catch (_) {
      fallback()
    }
    onTick()

    return () => {
      alive = false
      worker?.terminate()
      if (interval) clearInterval(interval)
      runnerRef.current = null
    }
  }, [device.deviceId, device.secret])

  async function printTest() {
    const runner = runnerRef.current
    if (!runner || testBusy) return
    setTestBusy(true)
    setTestMsg(null)
    const station = info.stations[0] || 'KOT'
    const html = renderTicketDocHtml(testDoc({ outletName: info.clientName, deviceName: info.name, station }))
    const result = await runner.printLocal(html)
    setTestBusy(false)
    if (result.busy) setTestMsg({ ok: false, text: 'A ticket is printing right now. Press the test again in a moment.' })
    else if (!result.ok) setTestMsg({ ok: false, text: `The test ticket did not print. ${result.reason}` })
    else setTestMsg({ ok: true, text: 'The test ticket went to the printer. If nothing came out, or a print window opened, see the checklist below.' })
  }

  function askUnpair() {
    ask({
      title: 'Unpair this computer?',
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>
            This computer stops printing tickets now. The tills print their own tickets instead, unless another printer
            computer prints them.
          </p>
          <p style={{ margin: 0 }}>
            It stays listed in POS Setup → Printers, as offline, until someone removes it there. To print here again,
            type a new code from POS Setup.
          </p>
        </>
      ),
      confirmLabel: 'Unpair',
      danger: true,
      run: () => onEnd('unpaired'),
    })
  }

  const view = STATUS_VIEW[status]
  const title = status === 'printing' ? `Printing ${printingLabel}…` : view?.title
  const covers = stationsText(info.stations)
  const readyDetail = covers
    ? `${covers} tickets print here as soon as a till sends them.`
    : 'Tickets print here as soon as a till sends them.'
  const errorLine = status === 'retrying' && lastError ? asActionError(lastError, 'operator') : null

  return (
    <div className="ps-root">
      <main className="ps-main">
        <header className="ps-head">
          <div>
            <p className="ps-brand">Crest print station</p>
            <h1 className="ps-title">{info.name || 'This computer'}</h1>
            <p className="ps-device">
              {info.clientName && <><strong>{info.clientName}</strong> · </>}
              {covers ? `prints ${covers.toLowerCase()} tickets` : 'printer computer'}
            </p>
          </div>
        </header>

        {memoryOnly && (
          <div className="ps-warn" role="alert">
            <strong>This computer could not save its pairing.</strong> Chrome is not letting this site keep data (an
            Incognito window does this). It prints for now, but if this page is reloaded or Chrome restarts, it will need a
            new code from POS Setup → Printers.
          </div>
        )}

        <section className={`card ps-card ps-status${view?.tone ? ` ps-status--${view.tone}` : ''}`} aria-live="polite">
          <span className="ps-dot" aria-hidden="true" />
          <div style={{ minWidth: 0 }}>
            <p className="ps-status__title">{title}</p>
            <p className="ps-status__detail">{status === 'ready' ? readyDetail : view?.detail}</p>
            {errorLine && (
              <p className="ps-status__meta">{errorLine.text}{errorLine.detail ? ` (${errorLine.detail})` : ''}</p>
            )}
            {lastOkAt > 0 && status !== 'retrying' && (
              <p className="ps-status__meta">Last checked with Crest {agoText(new Date(lastOkAt).toISOString())}.</p>
            )}
          </div>
        </section>

        <section className="card ps-card" aria-labelledby="ps-recent">
          <h2 id="ps-recent">Printed here</h2>
          {recent.length === 0 ? (
            <p style={{ margin: 0, fontSize: 14, color: 'var(--theme-text2)' }}>
              Nothing yet since this page was opened. The last {RECENT_MAX} tickets show here.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Ticket</th>
                    <th>What</th>
                    <th>
                      <Tip text="Late: the ticket was sent more than 2 minutes before it printed here, so the paper says PRINTED LATE and the time it was sent." width={280}>Note</Tip>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map(r => {
                    const kind = JOB_KIND_NAME[r.kind]
                    return (
                      <tr key={`${r.id}-${r.at}`}>
                        <td style={{ whiteSpace: 'nowrap' }}>{nepalTime(r.at)}</td>
                        <td><span className={STATION_BADGE[r.station] || 'badge-gray'}>{STATION_NAME[r.station] || r.station}</span></td>
                        <td>
                          {kind && <span style={{ fontWeight: 600 }}>{kind}{r.label ? ' · ' : ''}</span>}
                          {r.label}
                        </td>
                        <td>
                          {!r.ok ? (
                            <>
                              <span className="badge-red">Not printed</span>
                              {r.reason && <span style={{ display: 'block', fontSize: 12, color: 'var(--theme-text2)', marginTop: 2 }}>{r.reason}</span>}
                            </>
                          ) : r.late ? <span className="badge-amber">Late</span> : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card ps-card" aria-labelledby="ps-test">
          <h2 id="ps-test">Check the printer</h2>
          <div className="ps-actions">
            <button type="button" className="btn btn-ghost" onClick={printTest} disabled={testBusy} aria-busy={testBusy ? 'true' : undefined}>
              {testBusy ? 'Printing…' : 'Print a test ticket'}
            </button>
            <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>Prints on this computer's printer only; nothing is sent to Crest.</span>
          </div>
          {testMsg && <p role="status" className={testMsg.ok ? 'ps-test-ok' : 'ps-test-fail'}>{testMsg.text}</p>}
        </section>

        <Checklist />

        <div className="ps-foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={askUnpair}>Unpair this computer</button>
        </div>
      </main>
      {confirmEl}
    </div>
  )
}
