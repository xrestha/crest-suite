// S834 (D35): a bill or note keeps the code it was printed under; one from before keeps today's.
import { invoiceCodeOf } from './invoiceCode'

test('a stamped code wins, an empty stamp is "no code", no stamp is today\'s', () => {
  expect(invoiceCodeOf({ invoice_prefix: 'CAC' }, 'CASA')).toBe('CAC')
  expect(invoiceCodeOf({ invoice_prefix: '' }, 'CASA')).toBe('')
  expect(invoiceCodeOf({ invoice_prefix: null }, 'CASA')).toBe('CASA')
  expect(invoiceCodeOf({}, 'CASA')).toBe('CASA')
  expect(invoiceCodeOf(null, null)).toBe('')
})
