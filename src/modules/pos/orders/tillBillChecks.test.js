// S809 2a: the rules behind three of the till's close refusals and its settings read.
//   ORDER-FLOW-1 / CHECKOUT-9 — a failed or stalled settings read is never applied, cached or billed on.
//   CHECKOUT-1 (owner Q8 a)    — an emptied cart cannot be charged or comped; Void is left alone.
//   CHECKOUT-5 (owner Q9 a)    — a VAT bill above NPR 10,000 needs the buyer's name and address.
import {
  ABBREVIATED_INVOICE_LIMIT, tillSettingsReadOutcome, cacheCarriesRouting, tillSettingsNotice,
  tillSettingsBlockText, tillSettingsReprintText, TILL_SETTINGS_FAILED, closeStartRefusal,
  fullInvoiceRequired, fullInvoiceRefusal, optionalBuyerTip, FULL_INVOICE_TIP,
} from './tillBillChecks'

const SETTINGS_ROW = { is_vat_registered: false, invoice_prefix: 'BC', vat_number: '', pos_bot_categories: null }

describe('tillSettingsReadOutcome — only a read that answered is a result', () => {
  test('both reads answered', () => {
    const r = tillSettingsReadOutcome({ data: SETTINGS_ROW, error: null }, { data: { name: 'BLOOM CAFE' }, error: null })
    expect(r).toEqual({ ok: true, settings: SETTINGS_ROW, outletName: 'BLOOM CAFE' })
  })
  test('a settings read with no row is an answer (the defaults are the database default)', () => {
    const r = tillSettingsReadOutcome({ data: null, error: null }, { data: { name: 'X' }, error: null })
    expect(r.ok).toBe(true)
    expect(r.settings).toBeNull()
  })
  test('a failed settings read is a failure, even when the clients read answered', () => {
    const error = { message: 'TypeError: Failed to fetch' }
    expect(tillSettingsReadOutcome({ data: null, error }, { data: { name: 'X' }, error: null })).toEqual({ ok: false, error })
  })
  test('a failed clients read is a failure', () => {
    const error = { code: 'PGRST116', message: 'no rows' }
    expect(tillSettingsReadOutcome({ data: SETTINGS_ROW, error: null }, { data: null, error })).toEqual({ ok: false, error })
  })
  test('a stall arrives as a TimeoutError and is a failure', () => {
    const error = Object.assign(new Error('Loading the till settings timed out after 15s'), { name: 'TimeoutError' })
    expect(tillSettingsReadOutcome({ data: null, error }, { data: null, error }).ok).toBe(false)
  })
  test('a clients read with no data and no error is not taken as an answer', () => {
    expect(tillSettingsReadOutcome({ data: SETTINGS_ROW, error: null }, { data: null, error: null }).ok).toBe(false)
  })
})

describe('cacheCarriesRouting — telling a good offline copy from the empty one older tills wrote', () => {
  test('a copy of an answered read carries routing even when the outlet set none', () => {
    expect(cacheCarriesRouting({ client_id: 'c', ...SETTINGS_ROW, outlet_name: 'X' })).toBe(true)
    expect(cacheCarriesRouting({ client_id: 'c', pos_bot_categories: ['Cocktails'] })).toBe(true)
  })
  test('the copy an old till wrote after a failed read ({ ...null, outlet_name }) does not', () => {
    expect(cacheCarriesRouting({ client_id: 'c', outlet_name: 'X', updated_at: 1 })).toBe(false)
  })
  test('no copy at all does not', () => {
    expect(cacheCarriesRouting(null)).toBe(false)
    expect(cacheCarriesRouting(undefined)).toBe(false)
  })
})

describe('the words', () => {
  test('the notice says bills cannot be charged, and names the routing only when it is the default', () => {
    expect(tillSettingsNotice({ cachedRouting: true })).toBe(TILL_SETTINGS_FAILED)
    expect(tillSettingsNotice({ cachedRouting: false })).toMatch(/^Till settings could not be loaded .* only Beverage items print on the bar ticket\.$/)
  })
  test('the Payment refusal tells a failed read from one still loading', () => {
    expect(tillSettingsBlockText(true)).toBe(TILL_SETTINGS_FAILED)
    expect(tillSettingsBlockText(false)).toMatch(/still loading/)
  })
  test('the reprint refusal says nothing was printed and why', () => {
    expect(tillSettingsReprintText(true)).toMatch(/could not be loaded, so this bill was not reprinted/)
    expect(tillSettingsReprintText(false)).toMatch(/still loading, so this bill was not reprinted/)
  })
})

describe('closeStartRefusal — settings first, then the empty cart', () => {
  const base = { settingsLoaded: true, settingsFailed: false, itemCount: 2, canVoid: false }

  test('a loaded till with lines passes every close type', () => {
    for (const closeType of ['paid', 'writeoff', 'void']) {
      expect(closeStartRefusal({ ...base, closeType })).toBeNull()
    }
  })

  test('Charge and Complimentary wait for a settings read; Void does not', () => {
    const unread = { ...base, settingsLoaded: false }
    expect(closeStartRefusal({ ...unread, closeType: 'paid' }).text).toMatch(/still loading/)
    expect(closeStartRefusal({ ...unread, closeType: 'writeoff' }).label).toBe('Till settings not loaded yet')
    expect(closeStartRefusal({ ...unread, settingsFailed: true, closeType: 'paid' }).text).toBe(TILL_SETTINGS_FAILED)
    expect(closeStartRefusal({ ...unread, closeType: 'void' })).toBeNull()
  })

  test('unread settings are named before an empty cart', () => {
    const r = closeStartRefusal({ ...base, settingsLoaded: false, itemCount: 0, closeType: 'paid' })
    expect(r.label).toBe('Till settings not loaded yet')
  })

  test('an emptied cart: a login without Allow Void is told to ask someone who has it', () => {
    for (const closeType of ['paid', 'writeoff']) {
      const r = closeStartRefusal({ ...base, itemCount: 0, closeType })
      expect(r.text).toBe('Nothing is on this bill. Ask someone who can void bills to void it, or add the items back.')
      expect(r.label).toBe('Nothing on this bill — ask someone with Void')
    }
  })

  test('an emptied cart: a login with Allow Void is sent to the Void tab', () => {
    const r = closeStartRefusal({ ...base, itemCount: 0, canVoid: true, closeType: 'paid' })
    expect(r.text).toBe('Nothing is on this bill — void it from the Void tab, or add the items back.')
  })

  test('an emptied cart can still be voided: the stored lines are the record of what was voided', () => {
    expect(closeStartRefusal({ ...base, itemCount: 0, canVoid: true, closeType: 'void' })).toBeNull()
  })
})

describe('fullInvoiceRequired / fullInvoiceRefusal — NPR 10,000 on a VAT bill', () => {
  test('the limit is the IRD abbreviated-invoice limit', () => {
    expect(ABBREVIATED_INVOICE_LIMIT).toBe(10000)
  })

  test('up to and including the limit, a VAT bill needs no buyer details', () => {
    expect(fullInvoiceRequired({ vatReg: true, payTotal: 10000 })).toBe(false)
    expect(fullInvoiceRefusal({ vatReg: true, payTotal: 10000, buyerName: '', buyerAddress: '' })).toBeNull()
  })

  test('above the limit, a VAT bill needs the name first, then the address', () => {
    expect(fullInvoiceRequired({ vatReg: true, payTotal: 10001 })).toBe(true)
    const noName = fullInvoiceRefusal({ vatReg: true, payTotal: 18600, buyerName: '  ', buyerAddress: '' })
    expect(noName.field).toBe('pos-orders-buyer-name')
    expect(noName.text).toMatch(/over NPR 10,000/)
    expect(noName.label).toBe("Enter the buyer's name and address first")
    const noAddress = fullInvoiceRefusal({ vatReg: true, payTotal: 18600, buyerName: 'Himal Traders', buyerAddress: '' })
    expect(noAddress.field).toBe('pos-orders-buyer-address')
  })

  test('name and address are enough — PAN stays optional', () => {
    expect(fullInvoiceRefusal({ vatReg: true, payTotal: 18600, buyerName: 'Himal Traders', buyerAddress: 'Thamel' })).toBeNull()
  })

  test('a PAN-bill outlet (not VAT-registered) is not affected at any amount', () => {
    expect(fullInvoiceRequired({ vatReg: false, payTotal: 50000 })).toBe(false)
    expect(fullInvoiceRefusal({ vatReg: false, payTotal: 50000, buyerName: '', buyerAddress: '' })).toBeNull()
  })

  test('the Tips read the constant', () => {
    expect(optionalBuyerTip(true)).toMatch(/NPR 10,000/)
    expect(FULL_INVOICE_TIP).toMatch(/NPR 10,000/)
    expect(optionalBuyerTip(false)).not.toMatch(/10,000/)
  })
})
