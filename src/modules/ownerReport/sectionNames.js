// The Monthly Owner Report's sections, named in words (S849, OWNER-REPORT-2/-3).
//
// A section that fails while the report is made is frozen out of it (`snapshot.sectionErrors`, and
// Inventory Depth's own `inventoryDepth.sectionErrors` for its four sub-sections). The page, the
// workbook and the close all used to name those by their code ("hr, laborAnalytics"), and the close
// did not name them at all: it said the report was ready. One table of names, used by all three.
// Pure: no React, no Supabase.
import { BS_MONTHS } from '../../utils/bsCalendar'

const LABELS = {
  ims: 'Crest IMS',
  hr: 'Crest HR',
  pos: 'Crest POS',
  trend: 'Trend',
  menuEngineering: 'Menu Engineering',
  laborAnalytics: 'Labor Analytics',
  vendorPurchasing: 'Vendor & Purchasing',
  inventoryDepth: 'Inventory Depth',
  deliveryCommission: 'Delivery commission',
  // Inventory Depth's sub-sections.
  deadSlowStock: 'Dead & Slow Stock',
  turnover: 'Inventory Turnover',
  variance: 'Item Variance',
  shrinkageTrend: 'Shrinkage Trend',
}

// Inventory Depth's sub-sections, which fail on their own inside a section that otherwise stands.
export const INVENTORY_DEPTH_SUBSECTIONS = ['deadSlowStock', 'turnover', 'variance', 'shrinkageTrend']

/** The words for one section key; an unknown key comes back as itself rather than as nothing. */
export function sectionLabel(key) {
  return LABELS[key] || String(key)
}

/** "Crest HR", "Crest HR and Labor Analytics", "Crest HR, Trend and Labor Analytics". */
export function sectionList(keys) {
  const words = (keys || []).map(sectionLabel)
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/**
 * Every section this snapshot is missing because it failed when the report was made: the top-level
 * keys of `sectionErrors`, then Inventory Depth's failed sub-sections, each once.
 */
export function failedSectionKeys(snapshot) {
  const top = Object.keys(snapshot?.sectionErrors || {})
  const sub = Object.keys(snapshot?.inventoryDepth?.sectionErrors || {})
  return [...new Set([...top, ...sub])]
}

// Whether a snapshot HAS a section: present, and not recorded as failed.
function hasSection(snapshot, key) {
  if (!snapshot) return false
  if (INVENTORY_DEPTH_SUBSECTIONS.includes(key)) {
    const inv = snapshot.inventoryDepth
    return !!inv && inv[key] != null && !(inv.sectionErrors && key in inv.sectionErrors)
  }
  return snapshot[key] != null && !(snapshot.sectionErrors && key in snapshot.sectionErrors)
}

/**
 * The sections a freshly computed snapshot failed to read that the STORED report has (OWNER-REPORT-3).
 * Regenerate must not overwrite a complete report with a partial one: a network blip on the HR reads
 * would otherwise replace a report that has Crest HR with one that does not. A section the stored
 * report never had (its module was off then) is not "lost", so it does not block the write.
 */
export function newlyMissingSections(storedSnapshot, freshSnapshot) {
  return failedSectionKeys(freshSnapshot).filter(key => hasSection(storedSnapshot, key))
}

// ── Trend: why a comparison is missing (S849, OWNER-REPORT-19 / -18) ──────────────────────────────

/**
 * The sentence for a Trend comparison that is not available, in words, for the page and the workbook
 * (the workbook used to print the raw codes `no_period` / `not_closed` / `no_report`). `t` is one
 * `snapshot.trend.vsLastPeriod` / `vsSameMonthLastYear` entry.
 *
 * A prior month whose report was not made yet froze "No report was generated for that period", which
 * read as though it never would be: the report never makes a prior as a side effect, so it names the
 * two presses that fix it.
 */
export function trendUnavailableText(t) {
  const month = t?.period ? BS_MONTHS[t.period.bs_month - 1] : null
  const label = month ? `${month} ${t.period.bs_year}` : null
  if (t?.reason === 'no_period') return 'No period exists for this comparison.'
  if (t?.reason === 'not_closed') return label ? `${label} is still open.` : 'That period is still open.'
  if (t?.reason === 'no_report') {
    return label
      ? `${label}'s report had not been made when this one was. Open ${month}'s report, then Regenerate this one to compare.`
      : 'That month\'s report had not been made when this one was.'
  }
  return 'Not available.'
}
