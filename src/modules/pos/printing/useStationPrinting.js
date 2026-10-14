import { useCallback, useEffect, useRef, useState } from 'react'
import { randomUUID } from '../../../utils/uuid'
import { renderTicketDocHtml, ticketDocFits } from './ticketDoc'
import {
  readPrintRoutes, onlineRouteFor, queuePrintJobs, readPrintJobStatus, claimPrintJobForTill, watchVerdict,
  ROUTES_REFRESH_MS, WATCH_POLL_MS,
} from './printQueue'

// The till's print window, opened BEFORE any await so a tap's permission to open one is still fresh
// (viewPosBill.js does the same); the caller writes into it once it knows what to print.
function openPrintWindow() {
  const w = window.open('', '_blank', 'width=340,height=480,left=200,top=100')
  if (w) w.opener = null
  return w
}
function printInto(w, html) {
  w.document.write(html)
  w.document.close()
  w.focus()
  setTimeout(() => { w.print(); w.close() }, 300)
}

/**
 * Kitchen and bar printers on the till (S837, docs/kitchen-printers.md).
 *
 * `deliver({ station, kind, doc, label, local })` sends one station slip where it should print: to
 * the station's print device when one is online and the till is online, else through the till's own
 * print window (`printHtml`), exactly as before. It answers synchronously, so the send paths keep
 * their order (the save lands → the ticket goes → it is logged): `{ via: 'device', deviceName }` or
 * `{ via: 'till', printed }`.
 *
 * Every queued slip is watched until it is on paper. One that has not printed in PRINT_FALLBACK_MS,
 * or that a device gave up on, becomes an alert with Print here; Print here's claim decides who
 * prints, so a ticket cannot come out twice. A failed status read keeps the last known state.
 */
export function useStationPrinting({ clientId, isOffline, printHtml }) {
  const routesRef    = useRef({})
  const watchRef     = useRef([])
  const busyRef      = useRef(false)
  const isOfflineRef = useRef(isOffline)
  const printHtmlRef = useRef(printHtml)
  isOfflineRef.current = isOffline
  printHtmlRef.current = printHtml

  const [watch, setWatch]   = useState([])
  const [busyId, setBusyId] = useState(null)
  const [notice, setNotice] = useState('')

  const updateWatch = useCallback(fn => {
    setWatch(prev => {
      const next = fn(prev)
      watchRef.current = next
      return next
    })
  }, [])

  // Which stations have a device, re-read every ROUTES_REFRESH_MS. A failed read keeps the last good
  // answer; another outlet's answer never survives a client switch.
  useEffect(() => {
    let live = true
    routesRef.current = {}
    watchRef.current = []
    setWatch([])
    if (!clientId) return undefined
    const load = async () => {
      const { routes } = await readPrintRoutes(clientId)
      if (live && routes) routesRef.current = routes
    }
    void load()
    const timer = setInterval(load, ROUTES_REFRESH_MS)
    return () => { live = false; clearInterval(timer) }
  }, [clientId])

  const deliver = useCallback(({ station, kind, doc, label = '', local = false }) => {
    const route = onlineRouteFor(routesRef.current, station)
    if (local || !route || !clientId || isOfflineRef.current() || !ticketDocFits(doc)) {
      return { via: 'till', printed: printHtmlRef.current(renderTicketDocHtml(doc)) }
    }
    const job = { id: randomUUID(), station, kind, doc, label: String(label).slice(0, 80) }
    updateWatch(prev => [...prev, { job, queuedAt: Date.now(), deviceName: route.device_name, sendFailed: false, row: undefined, needsAction: false, reason: '' }])
    void queuePrintJobs(clientId, [job]).then(res => {
      // A lost answer may still have landed: the watch reads it, and Print here's claim settles it.
      if (res.ok || res.noAnswer) return
      console.error('queue_pos_print_jobs refused:', res.error)
      updateWatch(prev => prev.map(e => (e.job.id === job.id
        ? { ...e, sendFailed: true, needsAction: true, reason: 'It could not be sent to the printer computer.' }
        : e)))
    })
    return { via: 'device', deviceName: route.device_name }
  }, [clientId, updateWatch])

  const watching = watch.length > 0
  useEffect(() => {
    if (!clientId || !watching) return undefined
    let live = true
    const tick = async () => {
      const ids = watchRef.current.filter(e => !e.sendFailed).map(e => e.job.id).slice(0, 100)
      const res = ids.length ? await readPrintJobStatus(clientId, ids) : { rows: [], error: null }
      if (!live) return
      if (res.error) console.error('get_pos_print_job_status failed:', res.error)
      const now = Date.now()
      updateWatch(prev => prev.flatMap(e => {
        const row = res.rows ? res.rows.find(r => r.id === e.job.id) : e.row
        const v = watchVerdict(e, row, now)
        return v.done ? [] : [{ ...e, row, needsAction: v.needsAction, reason: v.reason }]
      }))
    }
    const timer = setInterval(tick, WATCH_POLL_MS)
    return () => { live = false; clearInterval(timer) }
  }, [clientId, watching, updateWatch])

  useEffect(() => {
    if (!notice) return undefined
    const timer = setTimeout(() => setNotice(''), 8000)
    return () => clearTimeout(timer)
  }, [notice])

  const printHere = useCallback(async id => {
    const entry = watchRef.current.find(e => e.job.id === id)
    if (!entry || busyRef.current) return
    busyRef.current = true
    setBusyId(id)
    const w = openPrintWindow()
    try {
      const { data, error } = await claimPrintJobForTill(clientId, entry.job)
      const what = `${entry.job.station === 'BOT' ? 'bar' : 'kitchen'} ticket`
      if (error || data?.ok) {
        const html = renderTicketDocHtml(entry.job.doc)
        let printed = true
        if (w) printInto(w, html)
        else printed = printHtmlRef.current(html)
        updateWatch(prev => prev.filter(e => e.job.id !== id))
        // Crest could not be asked: the kitchen getting the order matters more than a second copy.
        if (error) setNotice(`Printed here. Crest could not be reached to check the printer computer, so the ${entry.job.station === 'BOT' ? 'bar' : 'kitchen'} may get a second copy.`)
        else if (!printed) setNotice(`The ${what} did not open here — allow pop-ups for this site, then press Reprint KOT/BOT.`)
        return
      }
      if (w) w.close()
      const device = data?.device_name || 'The printer computer'
      if (data?.state === 'printed') {
        updateWatch(prev => prev.filter(e => e.job.id !== id))
        setNotice(`${device} has already printed the ${what}.`)
        return
      }
      // A device is printing it right now: give it another round before asking again.
      updateWatch(prev => prev.map(e => (e.job.id === id ? { ...e, queuedAt: Date.now(), needsAction: false, reason: '' } : e)))
      setNotice(`${device} is printing the ${what} now.`)
    } finally {
      busyRef.current = false
      setBusyId(null)
    }
  }, [clientId, updateWatch])

  const dismiss = useCallback(id => updateWatch(prev => prev.filter(e => e.job.id !== id)), [updateWatch])

  return { deliver, alerts: watch.filter(e => e.needsAction), printHere, dismiss, busyId, notice }
}
