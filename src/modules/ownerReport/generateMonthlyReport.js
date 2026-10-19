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
  const { data: client, error } = await supabase.from('clients')
    .select('ims_enabled, hr_enabled, pos_enabled').eq('id', clientId).single()
  // A failed read here used to fall through to { ims: true, hr: false, pos: false } — an HR+POS
  // client's snapshot silently frozen with two modules missing, permanently. Throw instead: the
  // period-close callers already treat generation as best-effort (try/catch, the close proceeds),
  // and the lazy-generate path on the report page surfaces the message (S612).
  if (error) throw new Error(`Could not resolve the client's modules: ${error.message}`)
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
//
// Since S849 (OWNER-REPORT-4, SU9 a) the database owns who made the report and when:
// `owner_report_2_guard` stamps `generated_at = now()` and `generated_by = auth.uid()` on every
// browser insert, refuses a month that is not closed and anyone but the Owner or Crest support, and
// `owner_report_1_same_client` refuses a month of another business. So neither is sent from here: a
// wrong device clock or a typed-in name cannot become the record. `actorId` from an older caller is
// ignored. Returns `{ inserted }`: false when the row already existed (23505), so a caller that shows
// the report reads the stored one back rather than assuming its own snapshot is what was kept.
export async function saveGeneratedReport({ clientId, period, snapshot, modulesIncluded, source = 'period_close' }) {
  const { error } = await scopedInsert('monthly_owner_reports', clientId, {
    period_id: period.id,
    bs_year: period.bs_year,
    bs_month: period.bs_month,
    modules_included: modulesIncluded,
    snapshot,
    schema_version: CURRENT_SCHEMA_VERSION,
    generation_source: source,
  })
  if (error && error.code !== '23505') throw error
  return { inserted: !error }
}

// The explicit overwrite path (Regenerate Snapshot: Owner or Crest admin, S756). Never called
// automatically (not on a closed-period data edit, not on a retried close) — regeneration is the
// one deliberate exception to the freeze, always an explicit confirmed action.
//
// Returns `{ error, updated }` and never throws (S849, OWNER-REPORT-3). The page used to drop the
// result and say "Regenerated" whatever happened; under the database guard a refused regenerate (the
// month reopened, a login that is not the Owner) is a real outcome, and so is zero rows changed (no
// row to update, or one this login cannot see), which PostgREST answers with no error at all. The
// database stamps `generation_source = 'manual_regenerate'`, `generated_at` and `generated_by`
// itself; `generation_source` is still sent so the row says so on its own.
export async function regenerateReport({ clientId, periodId, snapshot, modulesIncluded }) {
  const { data, error } = await scopedUpdate('monthly_owner_reports', clientId, {
    snapshot,
    modules_included: modulesIncluded,
    schema_version: CURRENT_SCHEMA_VERSION,
    generation_source: 'manual_regenerate',
  }).eq('period_id', periodId).select('id')
  return { error: error || null, updated: error ? 0 : (data || []).length }
}
