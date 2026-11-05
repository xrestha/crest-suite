// The Fixed Assets workbooks (S885, owner decision: an Excel export on all four report tabs, and the
// valuation workbook lists every asset as well as the category totals).
//
// Pure row and note builders, so a test can read every sheet without a browser and the screen, the
// paper and the workbook read one set of figures. The tabs do the `await import('xlsx')` in their
// own click handlers and hand these rows to sheetWithLetterhead. Three rules hold for every sheet:
// a money cell is a NUMBER at two places (text will not sum or sort), a date is BS text, and a TOTAL
// row sits wherever the screen totals, adding only what the screen adds.
import { formatAdAsBs } from '../../../utils/bsCalendar'
import { nprInt } from '../../../shared/nepalMoney'
import { POOL_LABELS } from './taxPoolConstants'

const num = v => parseFloat(v) || 0
export const money = v => Number(num(v).toFixed(2))
const bsDate = d => (d ? formatAdAsBs(d, { fallback: '' }) : '')

export const ASSET_STATUS_LABEL = { active: 'Active', disposed: 'Disposed', written_off: 'Written Off' }
export const MONEY_NOTE = 'All money is in NPR.'

// ── Register ────────────────────────────────────────────────────────────────────────────────────

// `assets` is the list as filtered on screen; `nbvOf(asset)` is the screen's own book value, so the
// sheet and the Current NBV column cannot disagree. Quantities of different assets do not add up, so
// the TOTAL row carries money only, and % Depreciated there is the whole list's (cost less NBV over cost).
export function registerSheetRows(assets, nbvOf) {
  let cost = 0, nbv = 0
  const rows = (assets || []).map(a => {
    const c = num(a.total_cost)
    const v = num(nbvOf(a))
    cost += c; nbv += v
    return {
      'Code': a.asset_code || '',
      'Name': a.name || '',
      'Category': a.assets_categories?.name || '',
      'Qty': num(a.quantity),
      'Unit Cost': money(a.unit_cost),
      'Total Cost': money(c),
      'Acquired (BS)': bsDate(a.acquisition_date),
      'Current NBV': money(v),
      '% Depreciated': c > 0 ? Number((((c - v) / c) * 100).toFixed(1)) : 0,
      'Status': ASSET_STATUS_LABEL[a.status] || a.status || '',
    }
  })
  rows.push({
    'Code': 'TOTAL',
    'Name': `${rows.length} ${rows.length === 1 ? 'asset' : 'assets'}`,
    'Category': '',
    'Qty': '',
    'Unit Cost': '',
    'Total Cost': money(cost),
    'Acquired (BS)': '',
    'Current NBV': money(nbv),
    '% Depreciated': cost > 0 ? Number((((cost - nbv) / cost) * 100).toFixed(1)) : 0,
    'Status': '',
  })
  return rows
}

export const REGISTER_NOTES = [
  'Current NBV is the total cost, less depreciation taken before Crest, less every posted depreciation run (reversals included), as on screen.',
  'The TOTAL row adds money only: quantities of different assets are not added together.',
  MONEY_NOTE,
]

// ── Valuation ───────────────────────────────────────────────────────────────────────────────────

// One row per asset held on the As Of date (computeValuationAsOf's `assets`), in the category order
// of the screen. An asset sold or written off after the date is on the sheet, and the last column
// says when it left the books.
export function valuationAssetRows(valuation) {
  const list = valuation?.assets || []
  const rows = list.map(a => ({
    'Code': a.assetCode || '',
    'Name': a.name || '',
    'Category': a.categoryName,
    'Acquired (BS)': bsDate(a.acquisitionDate),
    'Total Cost': money(a.totalCost),
    'Accumulated Depreciation': money(a.accumulatedDepreciation),
    'NBV': money(a.nbv),
    'Disposed or Written Off (BS)': a.disposalDate ? `${ASSET_STATUS_LABEL[a.status] || ''} ${bsDate(a.disposalDate)}`.trim() : '',
  }))
  rows.push({
    'Code': 'TOTAL',
    'Name': `${list.length} ${list.length === 1 ? 'asset' : 'assets'}`,
    'Category': '',
    'Acquired (BS)': '',
    'Total Cost': money(valuation?.totalCost),
    'Accumulated Depreciation': money(valuation?.accumulatedDepreciation),
    'NBV': money(valuation?.nbv),
    'Disposed or Written Off (BS)': '',
  })
  return rows
}

// The category table on screen, with its Total row.
export function valuationCategoryRows(valuation) {
  const rows = (valuation?.byCategory || []).map(c => ({
    'Category': c.categoryName,
    'Total Cost': money(c.totalCost),
    'Accumulated Depreciation': money(c.accumulatedDepreciation),
    'NBV': money(c.nbv),
  }))
  rows.push({
    'Category': 'TOTAL',
    'Total Cost': money(valuation?.totalCost),
    'Accumulated Depreciation': money(valuation?.accumulatedDepreciation),
    'NBV': money(valuation?.nbv),
  })
  return rows
}

export function valuationNotes(personalUse) {
  const notes = [
    'Every asset owned on the As Of date counts, including one sold or written off later, at its cost less the depreciation posted for periods ending on or before that date, and less any depreciation taken before Crest once the date reaches it.',
    'The Assets sheet lists each asset. The By Category sheet adds the same rows up by category, as on screen, so the two sheets have the same totals.',
  ]
  if (personalUse > 0) {
    notes.push(`${personalUse === 1 ? 'One asset carries' : `${personalUse} assets carry`} a personal-use share. ${personalUse === 1 ? 'It is' : 'They are'} counted in full here, as everywhere in Crest.`)
  }
  notes.push(MONEY_NOTE)
  return notes
}

// ── Disposals ───────────────────────────────────────────────────────────────────────────────────

// The screen's columns and its footer, which totals Proceeds and Gain / (Loss) only. A loss is a
// negative number, where the screen prints a minus sign beside the figure.
export function disposalSheetRows(disposed) {
  let proceeds = 0, gain = 0
  const rows = (disposed || []).map(a => {
    const p = num(a.disposal_proceeds)
    const g = num(a.disposal_gain_loss)
    proceeds += p; gain += g
    return {
      'Code': a.asset_code || '',
      'Name': a.name || '',
      'Outcome': a.status === 'disposed' ? 'Disposed' : 'Written Off',
      'Disposal Date (BS)': bsDate(a.disposal_date),
      'NBV at Disposal': money(p - g),
      'Proceeds': money(p),
      'Gain / (Loss)': money(g),
      'Reason': a.disposal_reason || '',
    }
  })
  rows.push({
    'Code': 'TOTAL',
    'Name': `${rows.length} ${rows.length === 1 ? 'disposal' : 'disposals'}`,
    'Outcome': '',
    'Disposal Date (BS)': '',
    'NBV at Disposal': '',
    'Proceeds': money(proceeds),
    'Gain / (Loss)': money(gain),
    'Reason': '',
  })
  return rows
}

export const DISPOSAL_NOTES = [
  'A disposal belongs to the fiscal year (Shrawan to Ashadh) its disposal date falls in.',
  'NBV at Disposal is Proceeds less Gain / (Loss): the book value on the disposal date. Some older disposals use the value at the last posted run instead.',
  'Gain / (Loss) is positive for a gain and negative for a loss.',
  MONEY_NOTE,
]

// ── Tax pools ───────────────────────────────────────────────────────────────────────────────────

// Whether the schedule shows the Write-off and Income columns: the screen shows them only when a
// pool has one, and so does the sheet.
export const showsWriteOff = lines => (lines || []).some(l => num(l.terminal_deduction) > 0.005 || num(l.balancing_income) > 0.005)

// The previewed schedule, as on paper: Additions split into its three rates so a row can be checked
// by hand, and Repair as its two figures. The TOTAL row adds what the screen footer adds.
export function taxPoolSheetRows(lines) {
  const list = lines || []
  const writeOff = showsWriteOff(list)
  const sum = key => money(list.reduce((s, l) => s + num(l[key]), 0))
  const row = (pool, l, total) => {
    const r = {
      'Pool': pool,
      'Opening WDV': total ? sum('opening_wdv') : money(l.opening_wdv),
      'Repair Carried In': total ? sum('repair_carried_in') : money(l.repair_carried_in),
      'Additions (full rate)': total ? sum('additions_full') : money(l.additions_full),
      'Additions (⅔ rate)': total ? sum('additions_two_third') : money(l.additions_two_third),
      'Additions (⅓ rate)': total ? sum('additions_one_third') : money(l.additions_one_third),
      'Disposals': total ? sum('disposal_proceeds') : money(l.disposal_proceeds),
      'Depreciation Base': total ? '' : money(l.depreciation_base),
      'Repair Deductible': total ? '' : money(l.repair_expense_deductible),
      'Repair Capitalized': total ? '' : money(l.repair_expense_capitalized),
      'Depreciation': total ? sum('depreciation_amount') : money(l.depreciation_amount),
    }
    if (writeOff) {
      r['Write-off'] = total ? sum('terminal_deduction') : money(l.terminal_deduction)
      r['Income'] = total ? sum('balancing_income') : money(l.balancing_income)
    }
    r['Closing WDV'] = total ? sum('closing_wdv') : money(l.closing_wdv)
    return r
  }
  return [...list.map(l => row(POOL_LABELS[l.pool] || `Pool ${l.pool}`, l, false)), row('TOTAL', null, true)]
}

// Every note the screen shows over and under the schedule, as plain sentences, plus what the sheet
// itself is. `notes` is TaxPoolTab's derived notes object, `zeroPoolsText` its "Pools A to D open at
// 0" phrase, `built` the buildTaxPoolLines result and `closedPools` the ticks on screen.
export function taxPoolSheetNotes({ fyLabel, lines, built, notes = {}, zeroPoolsText = '', closedPools = {}, disclaimer }) {
  const out = [
    'PREVIEW, not a posted schedule. These are the figures Preview worked out when this sheet was made. Crest does not read a posted schedule back into a sheet, so export the preview you post.',
    'Additions bought by the end of Poush count in full, from Magh to Chaitra two-thirds, and from Baisakh to Ashadh one-third.',
  ]
  const { openingGap, openingTyped, poolEDisposed, poolECapped } = notes
  if (openingGap) {
    out.push(openingGap.earlierLabel
      ? `${zeroPoolsText}. FY ${openingGap.priorLabel} has no posted schedule, so FY ${fyLabel} has no closing values to open from. FY ${openingGap.earlierLabel} was posted, but its values reach this year only through FY ${openingGap.priorLabel}.`
      : `${zeroPoolsText}. No tax pool schedule is posted for FY ${openingGap.priorLabel}, the year before. That is right only if the business owned none of these assets before FY ${fyLabel}.`)
  }
  if (openingTyped) {
    const parts = []
    if (openingTyped.pools.length > 0) {
      parts.push(`${openingTyped.pools.length === 1 ? 'Pool' : 'Pools'} ${openingTyped.pools.join(', ')} ${openingTyped.pools.length === 1 ? 'opens' : 'open'} from the values typed in from the tax return of the year before.`)
    }
    if (num(openingTyped.eOpening) > 0.005) {
      parts.push(`Pool E opens at NPR ${nprInt(openingTyped.eOpening)}, the part its assets have not yet claimed on their own schedules, counting depreciation taken before Crest.`)
    }
    out.push(`FY ${openingTyped.priorLabel} has no posted schedule here. ${parts.join(' ')}`.trim())
  }
  for (const l of lines || []) {
    if (num(l.balancing_income) > 0.005) {
      out.push(`Pool ${l.pool}: the NPR ${nprInt(l.disposal_proceeds)} received is NPR ${nprInt(l.balancing_income)} more than the pool was worth. Include NPR ${nprInt(l.balancing_income)} in business income for FY ${fyLabel} (Income Tax Act Schedule 2 §4(1)). ${num(l.closing_wdv) > 0.005 ? `The pool closes at NPR ${nprInt(l.closing_wdv)}, the part of the additions of this year that counts from next year.` : 'The pool closes at 0.'}`)
    }
  }
  for (const l of lines || []) {
    if (num(l.terminal_deduction) > 0.005) {
      out.push(`Pool ${l.pool} closed: every asset in it was sold or scrapped. The NPR ${nprInt(l.terminal_deduction)} left is deductible in FY ${fyLabel} (Schedule 2 §4(2)) instead of being depreciated in later years.`)
    }
  }
  for (const l of lines || []) {
    if (num(l.small_balance_written_off) > 0.005) {
      out.push(`Pool ${l.pool}: the NPR ${nprInt(l.small_balance_written_off)} left after the depreciation of this year is under NPR 2,000, so it is written off in full this year (Schedule 2 §2(6)).`)
    }
  }
  for (const p of built?.askDissolve || []) {
    if (closedPools[p]) continue
    out.push(`Pool ${p}: no asset of this pool is left in the Crest register at the end of FY ${fyLabel}, but its value goes back to a figure typed from the tax return, so it is kept open (not dissolved).`)
  }
  if (poolECapped) {
    out.push(`Pool E: the schedules of its assets add up to NPR ${nprInt(poolECapped.scheduled)} this year, but the pool only holds NPR ${nprInt(poolECapped.held)}, so only that much is claimed.`)
  }
  if (poolEDisposed) {
    out.push(`Pool E: software or licences sold or written off this year leave the pool at the value not yet claimed on them (NPR ${nprInt(poolEDisposed.value)}) and are not amortized this year. The NPR ${nprInt(poolEDisposed.proceeds)} received for them is shown under Disposals but not taken off the pool, because each Pool E item is claimed on its own schedule. Ask your accountant how to treat the gain or loss.`)
  }
  if ((built?.untracked || []).length > 0) {
    out.push(`Not in any tax pool, so left out of this schedule: ${built.untracked.map(a => `${a.asset_code || '-'} ${a.name} NPR ${nprInt(a.total_cost)}`).join('; ')}. Give each a pool on the Register (Edit, Tax Pool), then preview again.`)
  }
  out.push(MONEY_NOTE)
  if (disclaimer) out.push(disclaimer)
  return out
}

// A filename-safe piece: "FY 83/84" -> "FY-83-84".
export const fileSafe = s => String(s || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
