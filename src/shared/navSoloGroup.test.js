import { isSoloGroup } from './navSoloGroup'

const one = [{ to: '/menu-pricing', label: 'Menu Pricing' }]
const two = [...one, { to: '/recipes', label: 'Recipe Costing' }]

describe('isSoloGroup', () => {
  it('flattens a labelled group left with one reachable item', () => {
    expect(isSoloGroup({ key: 'costing', label: 'Costing' }, one)).toBe(true)
  })

  it('keeps a group with two or more items', () => {
    expect(isSoloGroup({ key: 'costing', label: 'Costing' }, two)).toBe(false)
  })

  it('keeps a PRO-badged upsell group, whose heading is the pitch', () => {
    expect(isSoloGroup({ key: 'suite', label: 'Crest Suite', badge: 'PRO' }, one)).toBe(false)
  })

  it('keeps Pinned, whose rows carry the unpin star', () => {
    expect(isSoloGroup({ key: 'pinned', label: 'Pinned' }, one)).toBe(false)
  })

  it('leaves an unlabelled group to its own flat path', () => {
    expect(isSoloGroup({ key: 'cust-setup', label: null }, one)).toBe(false)
  })
})
