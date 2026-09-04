import { supabase } from '../supabaseClient'

// All auth-admin operations go through an Edge Function — service role key stays server-side.
//
// Lives in shared/, not in pages/adminClients/, because it is no longer an admin-screen helper:
// `LegalReacceptance` is mounted from `ProtectedRoute` and calls `record_legal_acceptance` through
// it. Reaching from a route guard into a page directory is the wrong direction, and the reason it
// matters is the unwrapping below — a caller that skips this and invokes the function directly
// shows the user "Edge Function returned a non-2xx status code" instead of the actual refusal,
// which is precisely how "Unknown action" (the function not deployed yet) becomes indistinguishable
// from "Forbidden" and from a failed insert.
export async function adminOp(action, params = {}) {
  const { data, error } = await supabase.functions.invoke('admin-user-ops', {
    body: { action, ...params },
  })
  if (error) {
    // functions.invoke gives a generic "non-2xx status code" message; the real
    // reason is in the response body (error.context) — surface it.
    let detail = error.message || 'Edge function error'
    try {
      const body = await error.context.json()
      detail = body?.error?.message || body?.error || body?.message || detail
    } catch (_) {}
    throw new Error(detail)
  }
  if (data?.error) throw new Error(data.error.message || data.error || 'Admin op failed')
  return data
}
