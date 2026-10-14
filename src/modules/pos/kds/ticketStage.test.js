// S833 (POS_TODO S809.4 3d): the KOT Log tells a ticket the kitchen cleared from one a void cancelled.
import { kotStage, ticketTableLabel } from './ticketStage'
import { CLOSE_TYPE_BADGE } from '../posSignals'

describe('kotStage', () => {
  test('the live stages keep their labels and badges', () => {
    expect(kotStage({ status: 'new' })).toEqual({ label: 'Sent', badge: 'badge-gray' })
    expect(kotStage({ status: 'in_progress' })).toEqual({ label: 'Started', badge: 'badge-yellow' })
    expect(kotStage({ status: 'ready' })).toEqual({ label: 'Ready', badge: 'badge-green' })
    expect(kotStage({ status: 'served', pos_orders: { status: 'voided' } })).toEqual({ label: 'Served', badge: 'badge-green' })
  })

  test('a cancelled ticket of a voided bill reads Voided, in the void red', () => {
    expect(kotStage({ status: 'cancelled', pos_orders: { status: 'voided' } })).toEqual({ label: 'Voided', badge: CLOSE_TYPE_BADGE.void })
  })

  test('a cancelled ticket of any other bill was cleared by the kitchen', () => {
    for (const s of ['open', 'billed']) {
      expect(kotStage({ status: 'cancelled', pos_orders: { status: s } })).toEqual({ label: 'Cleared', badge: 'badge-gray' })
    }
  })

  test('with no order status to go on it stays the plain Cancelled, never a guess', () => {
    expect(kotStage({ status: 'cancelled' })).toEqual({ label: 'Cancelled', badge: 'badge-gray' })
    expect(kotStage({ status: 'cancelled', pos_orders: null })).toEqual({ label: 'Cancelled', badge: 'badge-gray' })
  })

  test('an unknown or missing status is shown as it is', () => {
    expect(kotStage({ status: 'weird' })).toEqual({ label: 'weird', badge: 'badge-gray' })
    expect(kotStage({})).toEqual({ label: '—', badge: 'badge-gray' })
    expect(kotStage(null)).toEqual({ label: '—', badge: 'badge-gray' })
  })
})

// S836: a ticket shows the table its bill is at NOW, and the table it was printed for when they differ.
describe('ticketTableLabel', () => {
  test('a bill still at the table the ticket was printed for shows that table alone', () => {
    expect(ticketTableLabel({ table_name: 'T3', pos_orders: { table_name: 'T3' } })).toEqual({ name: 'T3', was: '' })
  })

  test('a bill moved since shows its new table, and the printed one as was', () => {
    expect(ticketTableLabel({ table_name: 'T3', pos_orders: { table_name: 'T5' } })).toEqual({ name: 'T5', was: 'T3' })
  })

  test('a ticket a join brought over shows the bill that stays', () => {
    expect(ticketTableLabel({ table_name: 'Garden 2', pos_orders: { table_name: 'Garden 1' } })).toEqual({ name: 'Garden 1', was: 'Garden 2' })
  })

  test('a takeaway moved to a table reads was Takeaway', () => {
    expect(ticketTableLabel({ table_name: 'Takeaway', pos_orders: { table_name: 'T2' } })).toEqual({ name: 'T2', was: 'Takeaway' })
    expect(ticketTableLabel({ table_name: null, pos_orders: { table_name: 'T2' } })).toEqual({ name: 'T2', was: 'Takeaway' })
  })

  test('with no embed, or a bill with no table name, the printed table stands', () => {
    expect(ticketTableLabel({ table_name: 'T3' })).toEqual({ name: 'T3', was: '' })
    expect(ticketTableLabel({ table_name: 'T3', pos_orders: null })).toEqual({ name: 'T3', was: '' })
    expect(ticketTableLabel({ table_name: 'Takeaway', pos_orders: { table_name: null } })).toEqual({ name: 'Takeaway', was: '' })
    expect(ticketTableLabel({ table_name: null, pos_orders: { table_name: '  ' } })).toEqual({ name: '', was: '' })
  })

  test('stray spaces are not a move', () => {
    expect(ticketTableLabel({ table_name: 'T3 ', pos_orders: { table_name: 'T3' } })).toEqual({ name: 'T3', was: '' })
  })

  test('a missing ticket is no table, never a throw', () => {
    expect(ticketTableLabel(null)).toEqual({ name: '', was: '' })
    expect(ticketTableLabel(undefined)).toEqual({ name: '', was: '' })
  })
})
