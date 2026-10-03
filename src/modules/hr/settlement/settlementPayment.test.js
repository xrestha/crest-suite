import { settlementPaymentState, settlementAdjustments, settlementStillOwed } from './settlementPayment'

const row = over => ({ status: 'finalized', net_payout: 120000, paid_at: null, paid_amount: null, paid_adjustments: [], ...over })

describe('settlementPaymentState — where a settlement\'s money stands (S798 3b, H4)', () => {
  it('reads draft, unpaid and paid', () => {
    expect(settlementPaymentState(row({ status: 'draft' })).state).toBe('draft')
    expect(settlementPaymentState(row()).state).toBe('unpaid')
    expect(settlementPaymentState(row({ paid_at: '2026-09-20T05:00:00Z', paid_amount: 120000 })))
      .toMatchObject({ state: 'paid', paid: 120000, due: 0 })
  })

  it('names what is still to pay after a reopen raised the net (the Bikash example)', () => {
    const s = settlementPaymentState(row({ net_payout: 126000, paid_at: '2026-09-20T05:00:00Z', paid_amount: 120000 }))
    expect(s).toMatchObject({ state: 'short', paid: 120000, due: 6000 })
  })

  it('names an overpayment after a reopen lowered the net', () => {
    const s = settlementPaymentState(row({ net_payout: 116000, paid_at: '2026-09-20T05:00:00Z', paid_amount: 120000 }))
    expect(s).toMatchObject({ state: 'over', due: -4000 })
  })

  it('treats a paid mark with no stored amount as paid in full (rows paid before amounts were stamped)', () => {
    expect(settlementPaymentState(row({ paid_at: '2026-09-20T05:00:00Z', paid_amount: null })).state).toBe('paid')
  })

  it('keeps a reopened draft\'s paid record visible', () => {
    const s = settlementPaymentState(row({ status: 'draft', paid_at: '2026-09-20T05:00:00Z', paid_amount: 120000 }))
    expect(s).toMatchObject({ state: 'draft', recorded: true, paid: 120000 })
  })

  it('ignores paisa noise', () => {
    expect(settlementPaymentState(row({ net_payout: 120000.004, paid_at: 'x', paid_amount: 120000 })).state).toBe('paid')
  })
})

describe('settlementStillOwed — the Gratuity Tracker banner', () => {
  it('lists unpaid and paid-short settlements, never drafts or overpaid ones', () => {
    expect(settlementStillOwed(row())).toBe(true)
    expect(settlementStillOwed(row({ net_payout: 126000, paid_at: 'x', paid_amount: 120000 }))).toBe(true)
    expect(settlementStillOwed(row({ paid_at: 'x', paid_amount: 120000 }))).toBe(false)
    expect(settlementStillOwed(row({ net_payout: 116000, paid_at: 'x', paid_amount: 120000 }))).toBe(false)
    expect(settlementStillOwed(row({ status: 'draft' }))).toBe(false)
  })
})

describe('settlementAdjustments', () => {
  it('returns the recorded top-ups, signed, and survives a missing or odd column', () => {
    expect(settlementAdjustments(row({ paid_adjustments: [{ amount: 6000, method: 'Cash', at: '2026-10-01' }, { amount: -500, method: 'Bank', at: null }, { bad: true }] })))
      .toEqual([{ amount: 6000, method: 'Cash', at: '2026-10-01' }, { amount: -500, method: 'Bank', at: null }])
    expect(settlementAdjustments({})).toEqual([])
    expect(settlementAdjustments({ paid_adjustments: null })).toEqual([])
  })
})
