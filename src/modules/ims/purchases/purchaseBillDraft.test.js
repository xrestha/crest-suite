import {
  billDraftId, billDraftSignature, saveBillDraft, readBillDraft, clearBillDraft, DRAFT_MAX_AGE_MS,
} from './purchaseBillDraft'

const header = { vendor_id: 'v1', bs_day: '15', invoice_ref: 'B-9', payment_method: 'Cash', discount: '', vat_inclusive: false, invoice_vat: '', invoice_total: '' }
const line = (over = {}) => ({ _key: 1, item_id: 'i1', qty: '2', rate: '100', expiry_date: '', shelf_life: '', vat_inclusive: false, _amtDraft: '', ...over })

const EMPTY_HEADER = { vendor_id: '', bs_day: '', invoice_ref: '', payment_method: 'Cash', discount: '', vat_inclusive: false, invoice_vat: '', invoice_total: '' }
const blankBase = () => billDraftSignature(EMPTY_HEADER, [line({ _key: 99, item_id: '', qty: '', rate: '' })])

beforeEach(() => localStorage.clear())

describe('billDraftId', () => {
  test('an edit is keyed by its bill, a new bill by its period, both by the login', () => {
    expect(billDraftId({ groupId: 'g1', periodId: 'p1', profileId: 'u1' })).toBe('edit:g1:u1')
    expect(billDraftId({ periodId: 'p1', profileId: 'u1' })).toBe('new:p1:u1')
  })

  test('the next login on a shared tablet gets its own key, not the last one typed', () => {
    expect(billDraftId({ periodId: 'p1', profileId: 'u1' }))
      .not.toBe(billDraftId({ periodId: 'p1', profileId: 'u2' }))
  })

  test('nothing to key on is null, not a shared bucket', () => {
    expect(billDraftId({ profileId: 'u1' })).toBeNull()
    expect(billDraftId({ periodId: 'p1' })).toBeNull()
    expect(billDraftId({})).toBeNull()
    expect(billDraftId()).toBeNull()
  })
})

describe('billDraftSignature', () => {
  test('ignores the per-mount line key, which differs on every mount', () => {
    expect(billDraftSignature(header, [line({ _key: 1 })]))
      .toBe(billDraftSignature(header, [line({ _key: 2 })]))
  })

  test('sees a changed line and a changed header', () => {
    expect(billDraftSignature(header, [line({ qty: '3' })])).not.toBe(billDraftSignature(header, [line()]))
    expect(billDraftSignature({ ...header, discount: '50' }, [line()])).not.toBe(billDraftSignature(header, [line()]))
  })
})

describe('saveBillDraft / readBillDraft', () => {
  test('keeps a typed bill and reads it back', () => {
    expect(saveBillDraft('new:p1', { header, lines: [line()], baseSignature: blankBase() })).toBe(true)
    const back = readBillDraft('new:p1')
    expect(back.header.invoice_ref).toBe('B-9')
    expect(back.lines).toHaveLength(1)
    expect(back.lines[0].rate).toBe('100')
  })

  test('a bill identical to the one that was opened is not a draft', () => {
    const base = billDraftSignature(header, [line()])
    expect(saveBillDraft('edit:g1', { header, lines: [line()], baseSignature: base })).toBe(false)
    expect(readBillDraft('edit:g1')).toBeNull()
  })

  test('undoing back to the opened bill removes the draft already kept', () => {
    const base = billDraftSignature(header, [line()])
    saveBillDraft('edit:g1', { header, lines: [line({ qty: '9' })], baseSignature: base })
    expect(readBillDraft('edit:g1')).not.toBeNull()
    saveBillDraft('edit:g1', { header, lines: [line()], baseSignature: base })
    expect(readBillDraft('edit:g1')).toBeNull()
  })

  test('two bills are kept apart', () => {
    saveBillDraft('new:p1', { header, lines: [line()], baseSignature: blankBase() })
    saveBillDraft('edit:g1', { header: { ...header, invoice_ref: 'OTHER' }, lines: [line()], baseSignature: blankBase() })
    expect(readBillDraft('new:p1').header.invoice_ref).toBe('B-9')
    expect(readBillDraft('edit:g1').header.invoice_ref).toBe('OTHER')
  })

  test('no id keeps nothing rather than sharing a bucket', () => {
    expect(saveBillDraft(null, { header, lines: [line()], baseSignature: blankBase() })).toBe(false)
    expect(readBillDraft(null)).toBeNull()
  })
})

describe('expiry and cleanup', () => {
  test('a draft older than the window is not returned', () => {
    const t0 = 1_700_000_000_000
    saveBillDraft('new:p1', { header, lines: [line()], baseSignature: blankBase() }, t0)
    expect(readBillDraft('new:p1', t0 + DRAFT_MAX_AGE_MS)).not.toBeNull()
    expect(readBillDraft('new:p1', t0 + DRAFT_MAX_AGE_MS + 1)).toBeNull()
  })

  test('an expired draft is swept off the next write', () => {
    const t0 = 1_700_000_000_000
    saveBillDraft('new:old', { header, lines: [line()], baseSignature: blankBase() }, t0)
    const later = t0 + DRAFT_MAX_AGE_MS + 1
    saveBillDraft('new:p2', { header, lines: [line()], baseSignature: blankBase() }, later)
    expect(JSON.parse(localStorage.getItem('crest_purchase_bill_drafts'))['new:old']).toBeUndefined()
  })

  test('clearing forgets only that bill', () => {
    saveBillDraft('new:p1', { header, lines: [line()], baseSignature: blankBase() })
    saveBillDraft('edit:g1', { header, lines: [line()], baseSignature: blankBase() })
    clearBillDraft('new:p1')
    expect(readBillDraft('new:p1')).toBeNull()
    expect(readBillDraft('edit:g1')).not.toBeNull()
  })

  test('the last draft cleared leaves no key behind', () => {
    saveBillDraft('new:p1', { header, lines: [line()], baseSignature: blankBase() })
    clearBillDraft('new:p1')
    expect(localStorage.getItem('crest_purchase_bill_drafts')).toBeNull()
  })
})

describe('a store that cannot be trusted', () => {
  test('unreadable JSON reads as no draft rather than throwing over the form', () => {
    localStorage.setItem('crest_purchase_bill_drafts', '{not json')
    expect(readBillDraft('new:p1')).toBeNull()
    expect(saveBillDraft('new:p1', { header, lines: [line()], baseSignature: blankBase() })).toBe(true)
    expect(readBillDraft('new:p1')).not.toBeNull()
  })

  test('a stored entry with no lines is not restored', () => {
    localStorage.setItem('crest_purchase_bill_drafts', JSON.stringify({ 'new:p1': { header, lines: [], savedAt: Date.now() } }))
    expect(readBillDraft('new:p1')).toBeNull()
  })

  test('a stored entry with no header is not restored', () => {
    localStorage.setItem('crest_purchase_bill_drafts', JSON.stringify({ 'new:p1': { lines: [line()], savedAt: Date.now() } }))
    expect(readBillDraft('new:p1')).toBeNull()
  })
})
