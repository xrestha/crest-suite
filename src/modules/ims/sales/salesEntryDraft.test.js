import {
  salesDraftId, salesDraftSignature, salesDraftChanges, saveSalesDraft, readSalesDraft, clearSalesDraft,
  draftBaseMoved, DRAFT_MAX_AGE_MS,
} from './salesEntryDraft'

const saved = { r1: 10, r2: 4 }

beforeEach(() => localStorage.clear())

describe('salesDraftId', () => {
  test('a Bulk grid is keyed by its period and by the login', () => {
    expect(salesDraftId({ periodId: 'p1', profileId: 'u1' })).toBe('bulk:p1:u1')
  })

  test('the next login on a shared tablet gets its own key, not the last one typed', () => {
    expect(salesDraftId({ periodId: 'p1', profileId: 'u1' }))
      .not.toBe(salesDraftId({ periodId: 'p1', profileId: 'u2' }))
  })

  test('nothing to key on is null, not a shared bucket', () => {
    expect(salesDraftId({ profileId: 'u1' })).toBeNull()
    expect(salesDraftId({ periodId: 'p1' })).toBeNull()
    expect(salesDraftId({})).toBeNull()
    expect(salesDraftId()).toBeNull()
  })
})

describe('salesDraftSignature', () => {
  test('ignores key order and treats a zero as no row', () => {
    expect(salesDraftSignature({ r2: 4, r1: 10 })).toBe(salesDraftSignature({ r1: 10, r2: 4, r3: 0 }))
  })

  test('sees a changed figure, an added one and a removed one', () => {
    const base = salesDraftSignature(saved)
    expect(salesDraftSignature({ ...saved, r1: 11 })).not.toBe(base)
    expect(salesDraftSignature({ ...saved, r3: 1 })).not.toBe(base)
    expect(salesDraftSignature({ r1: 10 })).not.toBe(base)
  })
})

describe('salesDraftChanges', () => {
  test('keeps only the boxes that differ from what is saved', () => {
    expect(salesDraftChanges({ r1: '10', r2: '5', r3: '' }, saved)).toEqual({ r2: '5' })
  })

  test('a blank over a saved figure is a change, since saving it removes the figure', () => {
    expect(salesDraftChanges({ r1: '', r2: '' }, saved)).toEqual({ r1: '', r2: '' })
  })

  test('a figure typed back to its saved value is not a change', () => {
    expect(salesDraftChanges({ r1: '10.0' }, saved)).toEqual({})
  })
})

describe('saveSalesDraft / readSalesDraft', () => {
  test('keeps typed figures and reads them back', () => {
    expect(saveSalesDraft('bulk:p1:u1', { form: { r1: '12', r3: '7' }, baseline: saved })).toBe(true)
    const back = readSalesDraft('bulk:p1:u1')
    expect(back.form).toEqual({ r1: '12', r3: '7' })
    expect(back.baseSignature).toBe(salesDraftSignature(saved))
  })

  test('stores only the difference from the saved figures', () => {
    saveSalesDraft('bulk:p1:u1', { form: { r1: '10', r2: '6' }, baseline: saved })
    expect(readSalesDraft('bulk:p1:u1').form).toEqual({ r2: '6' })
  })

  test('a form holding nothing beyond the saved figures is not a draft', () => {
    expect(saveSalesDraft('bulk:p1:u1', { form: {}, baseline: saved })).toBe(false)
    expect(saveSalesDraft('bulk:p1:u1', { form: { r1: '10' }, baseline: saved })).toBe(false)
    expect(readSalesDraft('bulk:p1:u1')).toBeNull()
  })

  test('typing back to the saved figures removes the draft already kept', () => {
    saveSalesDraft('bulk:p1:u1', { form: { r1: '99' }, baseline: saved })
    expect(readSalesDraft('bulk:p1:u1')).not.toBeNull()
    saveSalesDraft('bulk:p1:u1', { form: { r1: '10' }, baseline: saved })
    expect(readSalesDraft('bulk:p1:u1')).toBeNull()
  })

  test('two months are kept apart', () => {
    saveSalesDraft('bulk:p1:u1', { form: { r1: '1' }, baseline: saved })
    saveSalesDraft('bulk:p2:u1', { form: { r1: '2' }, baseline: {} })
    expect(readSalesDraft('bulk:p1:u1').form.r1).toBe('1')
    expect(readSalesDraft('bulk:p2:u1').form.r1).toBe('2')
  })

  test('no id keeps nothing rather than sharing a bucket', () => {
    expect(saveSalesDraft(null, { form: { r1: '1' }, baseline: saved })).toBe(false)
    expect(readSalesDraft(null)).toBeNull()
  })
})

describe('expiry and cleanup', () => {
  test('a draft older than the window is not returned', () => {
    const t0 = 1_700_000_000_000
    saveSalesDraft('bulk:p1:u1', { form: { r1: '1' }, baseline: saved }, t0)
    expect(readSalesDraft('bulk:p1:u1', t0 + DRAFT_MAX_AGE_MS)).not.toBeNull()
    expect(readSalesDraft('bulk:p1:u1', t0 + DRAFT_MAX_AGE_MS + 1)).toBeNull()
  })

  test('an expired draft is swept off the next write', () => {
    const t0 = 1_700_000_000_000
    saveSalesDraft('bulk:old:u1', { form: { r1: '1' }, baseline: saved }, t0)
    saveSalesDraft('bulk:p2:u1', { form: { r1: '1' }, baseline: saved }, t0 + DRAFT_MAX_AGE_MS + 1)
    expect(JSON.parse(localStorage.getItem('crest_sales_entry_drafts'))['bulk:old:u1']).toBeUndefined()
  })

  test('clearing forgets only that grid', () => {
    saveSalesDraft('bulk:p1:u1', { form: { r1: '1' }, baseline: saved })
    saveSalesDraft('bulk:p2:u1', { form: { r1: '1' }, baseline: saved })
    clearSalesDraft('bulk:p1:u1')
    expect(readSalesDraft('bulk:p1:u1')).toBeNull()
    expect(readSalesDraft('bulk:p2:u1')).not.toBeNull()
  })

  test('the last draft cleared leaves no key behind', () => {
    saveSalesDraft('bulk:p1:u1', { form: { r1: '1' }, baseline: saved })
    clearSalesDraft('bulk:p1:u1')
    expect(localStorage.getItem('crest_sales_entry_drafts')).toBeNull()
  })
})

describe('a store that cannot be trusted', () => {
  test('unreadable JSON reads as no draft rather than throwing over the grid', () => {
    localStorage.setItem('crest_sales_entry_drafts', '{not json')
    expect(readSalesDraft('bulk:p1:u1')).toBeNull()
    expect(saveSalesDraft('bulk:p1:u1', { form: { r1: '1' }, baseline: saved })).toBe(true)
    expect(readSalesDraft('bulk:p1:u1')).not.toBeNull()
  })

  test('a stored entry with no figures is not restored', () => {
    localStorage.setItem('crest_sales_entry_drafts', JSON.stringify({ 'bulk:p1:u1': { form: {}, savedAt: Date.now() } }))
    expect(readSalesDraft('bulk:p1:u1')).toBeNull()
    localStorage.setItem('crest_sales_entry_drafts', JSON.stringify({ 'bulk:p1:u1': { form: ['1'], savedAt: Date.now() } }))
    expect(readSalesDraft('bulk:p1:u1')).toBeNull()
  })

  test('a storage that throws on write keeps nothing and says so, without throwing', () => {
    const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const err = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(saveSalesDraft('bulk:p1:u1', { form: { r1: '1' }, baseline: saved })).toBe(false)
      expect(err).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
      err.mockRestore()
    }
  })

  test('a storage that throws on read reads as no draft', () => {
    const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    try {
      expect(readSalesDraft('bulk:p1:u1')).toBeNull()
      expect(() => clearSalesDraft('bulk:p1:u1')).not.toThrow()
    } finally {
      spy.mockRestore()
    }
  })
})

// A draft remembers the saved figures it was typed against, so a later visit can tell that someone
// saved this month since, and ask, rather than lay the older typing over the newer figures.
describe('draftBaseMoved', () => {
  const savedSince = { ...saved, r2: 9 }

  test('a draft whose month is unchanged is current', () => {
    saveSalesDraft('bulk:p1:u1', { form: { r1: '12' }, baseline: saved })
    expect(draftBaseMoved(readSalesDraft('bulk:p1:u1'), salesDraftSignature(saved))).toBe(false)
  })

  test('a draft whose month was saved since has moved', () => {
    saveSalesDraft('bulk:p1:u1', { form: { r1: '12' }, baseline: saved })
    expect(draftBaseMoved(readSalesDraft('bulk:p1:u1'), salesDraftSignature(savedSince))).toBe(true)
  })

  test('a draft with no baseline cannot be proven current', () => {
    expect(draftBaseMoved({ form: { r1: '1' }, savedAt: Date.now() }, salesDraftSignature(saved))).toBe(true)
  })

  test('no draft has nothing to move', () => {
    expect(draftBaseMoved(null, salesDraftSignature(saved))).toBe(false)
  })
})
