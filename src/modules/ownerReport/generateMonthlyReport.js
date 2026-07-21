// Orchestrates report generation and the frozen-snapshot write path for the Monthly
// Owner/Manager Report. See computeMonthlyReport.js for the actual figures, and CLAUDE.md's
// Monthly Owner/Manager Report section for the freeze/regenerate design.
import { supabase } from '../../supabaseClient'
import { scopedInsert, scopedUpdate } from '../../shared/scopedDb'
import { computeMonthlyReport, CURRENT_SCHEMA_VERSION } from './computeMonthlyReport'

// Resolves modulesIncluded itself from `clients` directly — never trusts a caller-supplied
// clientModules, since Periods.js's adminCloseAndAdvance loops over an arbitrary client id that
// isn't necessarily the admin's own "currently viewed" client.
export async function generateMonthlyReport({ clientId, period }) {
  const { data: client } = await supabase.from('clients')
    .select('ims_enabled, hr_enabled, pos_enabled').eq('id', clientId).single()
  const modulesIncluded = {
    ims: client?.ims_enabled !== false,
    hr: !!client?.hr_enabled,
    pos: !!client?.pos_enabled,
  }
  const snapshot = await computeMonthlyReport({ clientId, period, modulesIncluded })
  return { snapshot, modulesIncluded }
}

// Auto-generation only ever INSERTs — the (client_id, period_id) unique constraint is the freeze
// guarantee. A repeat attempt (a retried close, two admins racing a lazy-generate) 23505s and is
// swallowed here rather than overwriting; anything else is rethrown so the caller's try/catch can
// log it — report generation is a best-effort side effect on the period-close path, never allowed
// to block the close itself.
export async function saveGeneratedReport({ clientId, period, snapshot, modulesIncluded, actorId, source = 'period_close' }) {
  const { error } = await scopedInsert('monthly_owner_reports', clientId, {
    period_id: period.id,
    bs_year: period.bs_year,
    bs_month: period.bs_month,
    modules_included: modulesIncluded,
    snapshot,
    schema_version: CURRENT_SCHEMA_VERSION,
    generation_source: source,
    generated_by: actorId || null,
  })
  if (error && error.code !== '23505') throw error
}

// Admin-only explicit overwrite path — the report page's "Regenerate Snapshot" button. Never
// called automatically (not on a closed-period data edit, not on a retried close) — regeneration
// is the one deliberate exception to the freeze, always an explicit confirmed action.
export async function regenerateReport({ clientId, periodId, snapshot, modulesIncluded, actorId }) {
  return scopedUpdate('monthly_owner_reports', clientId, {
    snapshot,
    modules_included: modulesIncluded,
    schema_version: CURRENT_SCHEMA_VERSION,
    generation_source: 'manual_regenerate',
    generated_by: actorId || null,
    generated_at: new Date().toISOString(),
  }).eq('period_id', periodId)
}
