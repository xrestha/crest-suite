import { useCallback } from 'react'
import { useAuth } from '../../context/AuthContext'

// "Your own record" on HR's decision pages (S798): the signed-in login's linked employee, or an
// employee record carrying this login's email — the same two tests hr_is_own_employee() makes in
// the database. The Owner and the operator are exempt there (hr_self_decision_exempt), so they are
// here. The database refuses regardless (hr_own_request); this only stops a page offering a button
// it will refuse, and keeps own rows out of a batch so one refusal does not read as a failure.
//
// TADA Claims keeps its own isOwnClaim: its guard exempts the operator only, not the Owner.
export function isOwnEmployeeRecord({ employeeId, employee, linkedEmployeeId, email, exempt }) {
  if (exempt || !employeeId) return false
  if (linkedEmployeeId && linkedEmployeeId === employeeId) return true
  const mine = (email || '').trim().toLowerCase()
  const theirs = (employee?.email || '').trim().toLowerCase()
  return !!(mine && theirs && mine === theirs)
}

// `empMap` is the page's id → employee map; its rows must carry `email` for the second test.
export function useIsOwnEmployee(empMap) {
  const { isAdmin, isOwner, profile, session } = useAuth()
  const exempt = !!(isAdmin || isOwner)
  const linkedEmployeeId = profile?.hr_employee_id || null
  const email = session?.user?.email || ''
  return useCallback(
    employeeId => isOwnEmployeeRecord({ employeeId, employee: empMap?.[employeeId], linkedEmployeeId, email, exempt }),
    [empMap, linkedEmployeeId, email, exempt]
  )
}
