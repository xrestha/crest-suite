import { supabase } from '../../supabaseClient'

// All auth-admin operations go through an Edge Function — service role key stays server-side
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
