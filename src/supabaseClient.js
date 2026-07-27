import { createClient } from '@supabase/supabase-js'
import { makeAuthTimeoutFetch } from './utils/authFetchTimeout'

const supabaseUrl = process.env.REACT_APP_SUPABASE_URL
const supabaseAnonKey = process.env.REACT_APP_SUPABASE_ANON_KEY

// supabase-js's GoTrueClient serializes every auth call (getSession, signInWithPassword,
// onAuthStateChange, ...) through navigator.locks by default, to coordinate token refresh
// across tabs. A known upstream bug (supabase/supabase-js #2111, #1594, #2013, #1517) can
// orphan that lock — e.g. a backgrounded/suspended tab aborting mid-request — after which
// every future auth call queues behind the dead lock and never resolves, hanging the login
// button on "Signing in..." forever until the tab is fully reloaded. Crest is a single-page
// client app with no cross-tab session sharing to protect, so the safest fix is to bypass
// navigator.locks entirely with a no-op lock rather than eat the deadlock risk.
const noOpLock = async (_name, _acquireTimeout, fn) => fn()

// `global.fetch` is handed straight through to the auth client by supabase-js
// (SupabaseClient.ts:340-344), which is what lets us bound auth requests without touching
// PostgREST/Storage traffic. See src/utils/authFetchTimeout.js for why this is load-bearing.
// autoRefreshToken/persistSession are the library defaults, stated explicitly because this app
// depends on them: tokens live 1 hour and users sit on data-entry screens for longer than that.
// Note that auth-js's refresh ticker only runs while the tab is awake — src/utils/sessionKeepAlive.js
// covers the backgrounded/asleep case that this alone does not (S458).
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { lock: noOpLock, autoRefreshToken: true, persistSession: true },
  global: { fetch: makeAuthTimeoutFetch((...args) => fetch(...args)) },
})
