import { useState, useEffect, useCallback, useRef } from 'react'
import { listPrintDevices, listPrintJobs } from './printDeviceApi'
import { setIfChanged } from '../../../shared/setIfChanged'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'

// POS Setup → Printers' two reads: the printer computers and the last 20 jobs, refreshed every
// REFRESH_MS while the tab is open and the window is visible.
//
// A failed read is never an empty list. Before the first good answer it is `devicesError` /
// `jobsError` (the panel says it could not load); after one, the last good list stays on screen and
// `devicesStale` / `jobsStale` carries the failed refresh, so "no printer computers" can only ever
// mean the server said so. One refresh at a time, so a slow answer is never overtaken by an older
// one; a refresh asked for meanwhile (after a save) runs as soon as the current one lands.

export const REFRESH_MS = 10000
export const RECENT_JOBS = 20

// Every field the panel draws comes from these rows, so the whole row is the signature.
const sig = rows => JSON.stringify(rows)

export function usePrintDevices(clientId) {
  const [devices, setDevices] = useState(null) // null until the first good answer
  const [jobs, setJobs] = useState(null)
  const [devicesError, setDevicesError] = useState(null)
  const [jobsError, setJobsError] = useState(null)
  const [devicesStale, setDevicesStale] = useState(null) // { error, at } of the last failed refresh
  const [jobsStale, setJobsStale] = useState(null)
  const [checkedAt, setCheckedAt] = useState(0)
  const req = useLatestRequest()
  const inFlight = useRef(false)
  const again = useRef(false) // a refresh asked for while one was running: run once more after it
  const refreshRef = useRef(null)
  const loadedDevices = useRef(false)
  const loadedJobs = useRef(false)

  const refresh = useCallback(async () => {
    if (!clientId) return
    if (inFlight.current) { again.current = true; return }
    inFlight.current = true
    // Keyed on the client: an answer for the outlet the page has left must not land on this one.
    req.begin(clientId)
    try {
      const [d, j] = await Promise.all([listPrintDevices(clientId), listPrintJobs(clientId, RECENT_JOBS)])
      if (!req.isCurrent(clientId)) return
      const at = Date.now()
      if (d.error) {
        if (loadedDevices.current) setDevicesStale({ error: d.error, at })
        else setDevicesError(d.error)
      } else {
        loadedDevices.current = true
        setDevicesError(null)
        setDevicesStale(null)
        setIfChanged(setDevices, Array.isArray(d.data) ? d.data : [], sig)
      }
      if (j.error) {
        if (loadedJobs.current) setJobsStale({ error: j.error, at })
        else setJobsError(j.error)
      } else {
        loadedJobs.current = true
        setJobsError(null)
        setJobsStale(null)
        setIfChanged(setJobs, Array.isArray(j.data) ? j.data : [], sig)
      }
      setCheckedAt(at)
    } finally {
      inFlight.current = false
      if (again.current) {
        again.current = false
        void refreshRef.current?.()
      }
    }
  }, [clientId, req])
  refreshRef.current = refresh

  useEffect(() => {
    refresh()
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      refresh()
    }, REFRESH_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  return { devices, jobs, devicesError, jobsError, devicesStale, jobsStale, checkedAt, refresh }
}
