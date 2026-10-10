import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../../supabaseClient'
import { withTimeout } from '../../../utils/withTimeout'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'

// The registered tablets of one client (migration 20260916120000). The read is a SECURITY DEFINER
// function with its own Owner / admin / POS manager check: pos_devices has no client grant at all,
// because a SELECT policy would also show the key hash, and Postgres has no column-level RLS.
// The restaurant's pre-S754 shared key, and its status read, are gone (S809 3h): it was off at every
// client, and nothing reads it any more.
//
// A failed read is `error`, never an empty list — an empty list here reads as "no tablets are set
// up", which would send a manager to activate a till that is already activated.
export function usePosDevices(clientId) {
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const req = useLatestRequest()

  const reload = useCallback(async () => {
    if (!clientId) { setLoading(false); return }
    // Keyed on the client: an admin switching clients with this page open must not have one
    // client's tablets land on another's list.
    const key = req.begin(clientId)
    setLoading(true)
    let list
    try {
      list = await withTimeout(supabase.rpc('list_pos_devices', { p_client_id: clientId }), 20000, 'Loading tablets')
    } catch (e) {
      list = { error: e }
    }
    if (!req.isCurrent(key)) return
    if (list.error) {
      setError(list.error)
    } else {
      setError(null)
      setDevices(list.data || [])
    }
    setLoading(false)
  }, [clientId, req])

  useEffect(() => { reload() }, [reload])

  return { devices, loading, error, reload }
}
