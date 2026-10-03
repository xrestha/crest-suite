import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../supabaseClient'
import { useAuth } from '../../context/AuthContext'

// "Your own record" on HR's decision pages (S798): the signed-in login's linked employee, its linked
// record at an outlet it reaches through Outlet Access (S798 3f-1), or an employee record carrying this
// login's email — the same three tests hr_is_own_employee() makes in the database. The Owner and the
// operator are exempt there (hr_self_decision_exempt), so they are here. The database refuses
// regardless (hr_own_request); this only stops a page offering a button it will refuse, and keeps own
// rows out of a batch so one refusal does not read as a failure.
//
// TADA Claims keeps its own isOwnClaim: its guard exempts the operator only, not the Owner.
export function isOwnEmployeeRecord({ employeeId, employee, linkedEmployeeId, outletLinkIds, email, exempt }) {
  if (exempt || !employeeId) return false
  if (linkedEmployeeId && linkedEmployeeId === employeeId) return true
  if (outletLinkIds && outletLinkIds.includes(employeeId)) return true
  const mine = (email || '').trim().toLowerCase()
  const theirs = (employee?.email || '').trim().toLowerCase()
  return !!(mine && theirs && mine === theirs)
}

// The signed-in login's employee records at other outlets (profile_employee_links, S798 3f-1; RLS shows a
// login its own rows only). Advisory like the rest of this file: a failed read leaves the list empty and
// is logged, and the database still refuses an own-record decision.
export function useMyOutletLinks(skip = false) {
  const { session } = useAuth()
  const uid = session?.user?.id || null
  const [ids, setIds] = useState([])
  useEffect(() => {
    if (skip || !uid) { setIds([]); return undefined }
    let live = true
    supabase.from('profile_employee_links').select('employee_id').eq('profile_id', uid)
      .then(({ data, error }) => {
        if (!live) return
        if (error) {
          console.error('[ownRecord] your employee links at other outlets could not be read', error)
          setIds([])
          return
        }
        setIds((data || []).map(r => r.employee_id))
      })
    return () => { live = false }
  }, [uid, skip])
  return ids
}

// `empMap` is the page's id → employee map; its rows must carry `email` for the email test.
export function useIsOwnEmployee(empMap) {
  const { isAdmin, isOwner, profile, session } = useAuth()
  const exempt = !!(isAdmin || isOwner)
  const linkedEmployeeId = profile?.hr_employee_id || null
  const outletLinkIds = useMyOutletLinks(exempt)
  const email = session?.user?.email || ''
  return useCallback(
    employeeId => isOwnEmployeeRecord({ employeeId, employee: empMap?.[employeeId], linkedEmployeeId, outletLinkIds, email, exempt }),
    [empMap, linkedEmployeeId, outletLinkIds, email, exempt]
  )
}
