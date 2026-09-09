// The three rules Item Master's form is built on, checked here rather than by opening the dialog.
// Each case below is a defect that shipped or a rule the file above exists to hold.
import { nextItemCode, perUnitOf, validateItemForm, itemPayload } from './itemFormRules'

const base = { name: 'CHICKEN BREAST', category_id: 'c1', uom: 'GM', rate: '0.777', yield_pct: '100', purchase_unit: '', conversion_factor: '' }

describe('nextItemCode', () => {
  it('takes the highest number already used, not the count', () => {
    expect(nextItemCode([{ item_code: 'ITM-001' }, { item_code: 'ITM-014' }], 'ITM')).toBe('ITM-015')
  })
  it('ignores codes on another prefix', () => {
    expect(nextItemCode([{ item_code: 'RCP-090' }, { item_code: 'ITM-002' }], 'ITM')).toBe('ITM-003')
  })
  it('starts at 001 with nothing to go on', () => {
    expect(nextItemCode([], 'ITM')).toBe('ITM-001')
    expect(nextItemCode(null, '')).toBe('ITM-001')
  })
  it('survives a prefix carrying a regex metacharacter', () => {
    // "A(" threw a SyntaxError from inside the save, after `saving` was already true.
    expect(nextItemCode([{ item_code: 'A(-004' }], 'A(')).toBe('A(-005')
    expect(nextItemCode([{ item_code: 'C++-002' }], 'c++')).toBe('C++-003')
  })
})

describe('perUnitOf', () => {
  it('divides the pack price by the pack size', () => {
    expect(perUnitOf('500', '388.50')).toBe(0.777)
  })
  it('refuses anything that is not a whole number above zero', () => {
    expect(perUnitOf('0', '100')).toBeNull()
    expect(perUnitOf('500', '0')).toBeNull()
    expect(perUnitOf('-5', '100')).toBeNull()
    // A prefix-parseable string must never price an item: parseFloat would read 500 and 1200.
    expect(perUnitOf('5oo', '100')).toBeNull()
    expect(perUnitOf('500', '1,200')).toBeNull()
  })
})

describe('validateItemForm', () => {
  it('passes a complete form', () => {
    expect(validateItemForm(base).ok).toBe(true)
  })
  it('requires a name and a rate above zero', () => {
    const { fieldErr } = validateItemForm({ ...base, name: '  ', rate: '0' })
    expect(fieldErr.name).toMatch(/required/)
    expect(fieldErr.rate).toMatch(/above zero/)
  })
  it('refuses a name another item already has, and names that item', () => {
    const items = [{ id: 'a', name: 'chicken breast', item_code: 'ITM-014' }]
    const { ok, fieldErr } = validateItemForm(base, { items })
    expect(ok).toBe(false)
    expect(fieldErr.name).toContain('ITM-014')
  })
  it('lets an item keep its own name while being edited', () => {
    const items = [{ id: 'a', name: 'CHICKEN BREAST', item_code: 'ITM-014' }]
    expect(validateItemForm(base, { items, editingId: 'a' }).ok).toBe(true)
  })
  it('says nothing about duplicates when the list is not authoritative', () => {
    const items = [{ id: 'a', name: 'CHICKEN BREAST', item_code: 'ITM-014' }]
    expect(validateItemForm(base, { items, canCheckNames: false }).ok).toBe(true)
  })
  it('holds yield to 1–100, and treats an empty box as no answer', () => {
    expect(validateItemForm({ ...base, yield_pct: '1000' }).fieldErr.yield_pct).toMatch(/between 1/)
    expect(validateItemForm({ ...base, yield_pct: '0' }).fieldErr.yield_pct).toBeDefined()
    expect(validateItemForm({ ...base, yield_pct: '' }).ok).toBe(true)
    expect(validateItemForm({ ...base, yield_pct: '70' }).ok).toBe(true)
  })
  it('refuses half a conversion, and points at the tab holding it', () => {
    const noFactor = validateItemForm({ ...base, purchase_unit: 'CTN' })
    expect(noFactor.ok).toBe(false)
    expect(noFactor.tab).toBe('conversion')
    expect(validateItemForm({ ...base, conversion_factor: '24' }).ok).toBe(false)
  })
  it('refuses a conversion factor of 1 or below — every consumer ignores one', () => {
    expect(validateItemForm({ ...base, purchase_unit: 'CTN', conversion_factor: '1' }).formError).toMatch(/more than 1/)
    expect(validateItemForm({ ...base, purchase_unit: 'CTN', conversion_factor: '0.5' }).ok).toBe(false)
    expect(validateItemForm({ ...base, purchase_unit: 'CTN', conversion_factor: '24' }).ok).toBe(true)
  })
  it('shows the details tab first when both tabs have something wrong', () => {
    expect(validateItemForm({ ...base, name: '', purchase_unit: 'CTN' }).tab).toBe('details')
  })
})

describe('itemPayload', () => {
  it('stores the per-unit price and pins purchase_qty to 1', () => {
    const p = itemPayload({ ...base, name: ' chicken breast ' })
    expect(p).toMatchObject({ name: 'CHICKEN BREAST', purchase_qty: 1, rate: 0.777, uom: 'GM', yield_pct: 100 })
  })
  it('derives base_unit from the UOM, never from the box that used to ask for it', () => {
    const p = itemPayload({ ...base, purchase_unit: 'ctn', conversion_factor: '24' })
    expect(p.purchase_unit).toBe('CTN')
    expect(p.base_unit).toBe('GM')
    expect(p.conversion_factor).toBe(24)
  })
  it('clears the whole conversion when the factor does not convert', () => {
    const p = itemPayload({ ...base, purchase_unit: 'CTN', conversion_factor: '1' })
    expect(p).toMatchObject({ purchase_unit: null, base_unit: null, conversion_factor: 1 })
  })
  it('never emits per_uom_rate — it is a generated column', () => {
    expect(Object.keys(itemPayload(base))).not.toContain('per_uom_rate')
  })
  it('falls back to 100% yield rather than storing something out of range', () => {
    expect(itemPayload({ ...base, yield_pct: '' }).yield_pct).toBe(100)
    expect(itemPayload({ ...base, yield_pct: '150' }).yield_pct).toBe(100)
    expect(itemPayload({ ...base, yield_pct: '70' }).yield_pct).toBe(70)
  })
})
