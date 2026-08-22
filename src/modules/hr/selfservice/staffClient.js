// Which company's PIN pad this phone belongs to.
//
// The self-service link is minted per client (`/hr/self-service/login/:clientId`, see
// EmployeeList.jsx) and that id exists nowhere else on the device — but the installed app's
// start_url is a fixed string, so without remembering it, tapping the Crest Staff icon after the
// session expires lands on the admin sign-in page, which no employee has a password for.
//
// It is not a credential and grants nothing: the id is already in the URL every employee was
// sent, and every RPC behind it still authenticates the session.
const KEY = 'crest_staff_client'

export function rememberStaffClient(clientId) {
  if (!clientId) return
  try { localStorage.setItem(KEY, clientId) } catch { /* private mode — the link still works */ }
}

export function rememberedStaffClient() {
  try { return localStorage.getItem(KEY) || '' } catch { return '' }
}
