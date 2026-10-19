// S849 (the Crest Suite batch): every refusal code the seven S849 migrations raise has its own
// sentence, ahead of the generic rule its errcode would otherwise fall to. Kept apart from
// errorText.test.js so clusters drafted at the same time do not collide in one file.
import { errorText } from './errorText'

// [hint, errcode] exactly as the migrations raise them.
const CODES = [
  ['suite_other_client', '23503'],
  ['owner_report_locked', '42501'],
  ['owner_report_owner_only', '42501'],
  ['owner_report_period_open', '42501'],
  ['owner_report_other_client', '23503'],
  ['snapshot_rank', '42501'],
  ['group_hq_outside', '42501'],
  ['ims_count_pin_outlet_pinned', '42501'],
  ['outlet_access_count_pin', '42501'],
  ['outlet_access_self_service', '42501'],
  ['stock_transfer_rank', '42501'],
  ['stock_transfer_not_sibling', '42501'],
  ['stock_transfer_rpc_only', '42501'],
  ['stock_transfer_period_other_client', '23503'],
  ['stock_transfer_no_inventory', '22023'],
  ['stock_transfer_no_open_period', '22023'],
  ['stock_transfer_month_ahead', '22023'],
  ['stock_transfer_empty', '22023'],
  ['stock_transfer_too_many_lines', '22023'],
  ['stock_transfer_item_hidden', '22023'],
  ['stock_transfer_lines_bad', '22023'],
  ['stock_transfer_bad', '22023'],
  ['stock_transfer_not_found', '22023'],
  ['stock_transfer_not_on_the_way', '22023'],
  ['stock_transfer_outlet_gone', '22023'],
  ['stock_transfer_receiver_behind', '22023'],
  ['stock_transfer_sender_behind', '22023'],
  ['stock_transfer_item_changed', '22023'],
  ['stock_transfer_reason', '22023'],
  ['demand_forecast_forbidden', '42501'],
  ['demand_forecast_range', '22023'],
  ['asset_run_posted', '42501'],
  ['asset_code_locked', '42501'],
  ['asset_other_client', '23503'],
  ['dep_run_asset_not_active', 'P0001'],
  ['tax_run_duplicate', 'P0001'],
  ['tax_pool_fy_format', '22023'],
  ['tax_pool_no_lines', '22023'],
  ['tax_pool_correction_denied', '42501'],
  ['tax_pool_correction_reason', '22023'],
  ['tax_pool_correction_values', '22023'],
  ['tax_pool_correction_unchanged', 'P0001'],
  ['tax_pool_opening_unused', 'P0001'],
  ['tax_pool_opening_not_locked', 'P0001'],
  ['tax_pool_opening_year', 'P0001'],
  ['tax_pool_opening_locked', '42501'],
]

const FALLBACK_RE = /reason isn't one we recognise|That didn't work\. Try again/i

describe('S849 refusal codes', () => {
  it.each(CODES)('%s (%s) has its own sentence for both audiences', (hint, code) => {
    const err = { code, hint, message: `${hint}: refused` }
    const generic = { code, message: 'refused' }
    for (const aud of ['staff', 'operator']) {
      const text = errorText(err, aud)
      expect(text).not.toMatch(FALLBACK_RE)
      // Not the sentence the bare errcode gets: the specific rule answered first.
      expect(text).not.toBe(errorText(generic, aud))
      // Matched by the hint alone too (a wrapper that dropped the message).
      expect(errorText({ code, hint }, aud)).toBe(text)
    }
  })

  it('the stock transfer rank refusal is the transfer sentence, not the generic 42501 one', () => {
    const text = errorText({ code: '42501', hint: 'stock_transfer_rank', message: 'stock_transfer_rank: stock is sent by …' }, 'operator')
    expect(text).toMatch(/Stock is sent by/)
  })

  it("an unknown group id (the operator's support view) names the group, not a missing record", () => {
    const err = { code: 'P0002', message: 'That outlet group does not exist.' }
    expect(errorText(err, 'operator')).toMatch(/outlet group no longer exists/i)
    expect(errorText({ code: 'P0002', message: 'something else' }, 'operator')).not.toMatch(/outlet group/i)
  })

  it('a transferred item refuses force-delete with the transfer reason', () => {
    const err = { code: 'P0001', hint: 'Hide the item instead — both outlets keep the transfer on their books.', message: 'force_delete_item_transferred: that item was sent or received between outlets, so it cannot be force-deleted' }
    expect(errorText(err, 'operator')).toMatch(/sent or received between outlets/i)
  })

  it('codes do not swallow each other: a longer code is never matched by a shorter one', () => {
    // owner_report_period_open must not read as a plain period refusal, nor tax_pool_opening_locked
    // as tax_pool_opening_* siblings.
    expect(errorText({ code: '42501', hint: 'owner_report_period_open' }, 'operator')).toMatch(/still open/i)
    expect(errorText({ code: '42501', hint: 'tax_pool_opening_locked' }, 'operator')).toMatch(/locked/i)
    expect(errorText({ code: 'P0001', hint: 'tax_pool_opening_year' }, 'operator')).toMatch(/different fiscal year/i)
  })
})
