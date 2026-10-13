// S833 (POS_TODO S809.4 3d): the KOT Log tells a ticket the kitchen cleared from one a void cancelled.
import { kotStage } from './ticketStage'
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
