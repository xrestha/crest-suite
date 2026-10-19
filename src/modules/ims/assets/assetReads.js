// The Fixed Assets page's shared reads, and the refusals of the posts that follow them (S849).
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { isNetworkError } from '../../../shared/errorText'
import { isTimeout } from '../../../utils/withTimeout'

// Every blocking read and post on the page is bounded by this (ASSETS-15).
export const ASSET_CALL_MS = 20000

export const REGISTER_SELECT = '*, assets_categories(name, tax_pool_hint)'

// The whole register, paged (ASSETS-15): one row per asset, but a client past 1,000 assets would
// otherwise lose the rest silently — and the Tax tab's additions and disposals with them. The id
// tiebreaker is what paging needs. Read again by each preview that can be posted (ASSETS-12), so a
// run is never built from the list loaded when the page opened.
export function readRegister(scopedFrom) {
  return fetchAllRows(() => scopedFrom('assets_register', REGISTER_SELECT)
    .order('created_at', { ascending: false }).order('id'))
}

// The post's answer never arrived: a dropped connection or our own time limit. The server may
// still have written it, so the page says "may have been posted" and re-reads (ASSETS-17).
export function answerLost(error) {
  return !!error && (isTimeout(error) || isNetworkError(error))
}

// One refusal by its hint (or, for an older cached server, its message prefix).
export function refusedWith(error, hint) {
  return !!error && (error.hint === hint || new RegExp(`\\b${hint}\\b`).test(error.message || ''))
}

// post_asset_depreciation_run's dep_run_asset_not_active refusal names the asset codes it refused:
// "dep_run_asset_not_active: FA-007, FA-009 is no longer an active asset of this business".
export function notActiveCodes(error) {
  const m = /dep_run_asset_not_active:\s*(.+?)\s+is no longer/i.exec(error?.message || '')
  return m ? m[1] : ''
}
