import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../../supabaseClient'
import { withTimeout } from '../../../utils/withTimeout'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'

// The registered tablets of one client and the state of its pre-S754 shared key (migration
// 20260916120000). Both reads are SECURITY DEFINER functions with their own Owner / admin / POS
// manager check: pos_devices has no client grant at all, because a SELECT policy would also show
// the key hash, and Postgres has no column-level RLS.
//
// A failed read is `error`, never an empty list — an empty list here reads as "no tablets are set
// up", which would send a manager to activate a till that is already activated.
export function usePosDevices(clientId) {
  const [devices, setDevices] = useState([])
  // null = the shared key's state is unknown (not loaded, or the read failed);
  // { retired_at, last_used_at } otherwise; { none: true } when the client never had one.
  const [legacy, setLegacy] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const req = useLatestRequest()

  const reload = useCallback(async () => {
    if (!clientId) { setLoading(false); return }
    // Keyed on the client: an admin switching clients with this page open must not have one
    // client's tablets land on another's list.
    const key = req.begin(clientId)
    setLoading(true)
    let results
    try {
      results = await withTimeout(Promise.all([
        supabase.rpc('list_pos_devices', { p_client_id: clientId }),
        supabase.rpc('pos_legacy_device_key_status', { p_client_id: clientId }),
      ]), 20000, 'Loading tablets')
    } catch (e) {
      results = [{ error: e }, { error: e }]
    }
    if (!req.isCurrent(key)) return
    const [list, status] = results
    const failed = list.error || status.error
    if (failed) {
      setError(failed)
      setLegacy(null)
    } else {
      setError(null)
      setDevices(list.data || [])
      const row = (status.data || [])[0]
      setLegacy(row ? { retired_at: row.retired_at, last_used_at: row.last_used_at } : { none: true })
    }
    setLoading(false)
  }, [clientId, req])

  useEffect(() => { reload() }, [reload])

  return { devices, legacy, loading, error, reload }
}
