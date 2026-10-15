import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { settleWithin } from '../../../utils/withTimeout'
import { customerBookAfterRead } from './customerBook'

// This outlet's membership card types (S843), switched-off ones included: a customer may still hold
// one, and its name is what their badge says. A handful of rows per outlet, so one bounded read, no
// paging. In customerBook.js' shape: a failed first read is `error` (no list), a failed reload keeps
// the list it had as `stale`. A load is keyed on its outlet plus a counter, so only the newest lands.

export const TYPE_COLUMNS = 'id, name, discount_pct, valid_months, is_active, created_at'
const READ_MS = 20000

export function useMembershipTypes() {
  const { clientId, scopedFrom } = useScopedDb()
  const [state, setState] = useState({ clientId: null, rows: null, error: null, stale: null })
  const req = useLatestRequest()
  const seq = useRef(0)

  const reload = useCallback(async () => {
    if (!clientId) return
    const forClient = clientId
    const key = req.begin(`${forClient}#${++seq.current}`) // before any await
    const { data, error } = await settleWithin(
      scopedFrom('pos_membership_types', TYPE_COLUMNS).order('name').order('id'),
      READ_MS, 'Reading the membership card types',
    )
    if (!req.isCurrent(key)) return
    if (error) console.error('membership types read failed:', error)
    setState(prev => customerBookAfterRead(prev, forClient, { data, error }))
  }, [clientId, scopedFrom, req])

  useEffect(() => { reload() }, [reload])

  const loading = !clientId || state.clientId !== clientId
  const types = state.rows
  const byId = useMemo(() => Object.fromEntries((types || []).map(t => [t.id, t])), [types])
  return { types, byId, loading, error: state.error, stale: state.stale, reload }
}
