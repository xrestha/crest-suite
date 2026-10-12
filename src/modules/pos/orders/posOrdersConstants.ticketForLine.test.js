// ORDER-FLOW-17 (S817 4i): a cart line's kitchen timer follows its own line, never only its dish.
import { ticketForLine } from './posOrdersConstants'

const MOMO = 'r-momo'
// Newest first, as loadOrderKotTickets reads them.
const tickets = [
  { id: 't-cheese', status: 'new', items: [{ recipe_id: MOMO, name: 'Veg Momo', selection_key: 'o-cheese' }] },
  { id: 't-plain', status: 'ready', items: [{ recipe_id: MOMO, name: 'Veg Momo' }] },
]

describe('ticketForLine', () => {
  it('gives plain Momo its own ticket, not the newer customized one', () => {
    expect(ticketForLine(tickets, { recipe_id: MOMO, selection_key: '' })?.id).toBe('t-plain')
  })

  it('gives "Momo, extra cheese" its own ticket', () => {
    expect(ticketForLine(tickets, { recipe_id: MOMO, selection_key: 'o-cheese' })?.id).toBe('t-cheese')
  })

  it('reads a reopened line whose choices are only option ids', () => {
    expect(ticketForLine(tickets, { recipe_id: MOMO, option_ids: ['o-cheese'] })?.id).toBe('t-cheese')
  })

  it('takes the newest ticket when one line was sent twice', () => {
    const twice = [
      { id: 'second', items: [{ recipe_id: MOMO }] },
      { id: 'first', items: [{ recipe_id: MOMO }] },
    ]
    expect(ticketForLine(twice, { recipe_id: MOMO })?.id).toBe('second')
  })

  it('finds nothing for a line no ticket carries, or a line with no dish', () => {
    expect(ticketForLine(tickets, { recipe_id: MOMO, selection_key: 'o-egg' })).toBeNull()
    expect(ticketForLine(tickets, { name: 'Open item' })).toBeNull()
    expect(ticketForLine(null, { recipe_id: MOMO })).toBeNull()
  })
})
