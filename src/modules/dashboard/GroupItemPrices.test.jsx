/**
 * The Group Console's "Same item, different price" panel (S800). Only a grouped Owner can open the
 * Group Console, so its three states are pinned here: prices to compare, nothing linked to compare,
 * and a failed read — which must say so rather than read as "nothing to compare".
 * S849: the read is paged on the RPC's unique order (GROUP-6), Crest support names the group
 * (ACCESS-8), and the page's Refresh re-reads it (GROUP-16).
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'

const mockRpc = jest.fn()
jest.mock('../../supabaseClient', () => ({ supabase: { rpc: (...args) => mockRpc(...args) } }))

// eslint-disable-next-line import/first
import GroupItemPrices from './GroupItemPrices'

const row = (item_key, client_id, client_name, qty, net_value, extra = {}) => ({
  item_key, client_id, client_name, item_name: 'Flour', uom: 'GM', qty, net_value, lines: 1, ...extra,
})

// supabase.rpc(...) returns a builder: .order() chains, .range() answers (fetchAllRows pages with it).
const builders = []
function answer(result) {
  mockRpc.mockImplementation(() => {
    const b = { orders: [], ranges: [] }
    b.order = jest.fn(col => { b.orders.push(col); return b })
    b.range = jest.fn((from, to) => { b.ranges.push([from, to]); return Promise.resolve(result) })
    builders.push(b)
    return b
  })
}

beforeEach(() => { mockRpc.mockReset(); builders.length = 0 })

test('asks for the picked month in pages and shows each outlet per KG, the cheapest, and what was paid above it', async () => {
  answer({
    data: [
      row('k1', 'a', 'Bloom Cafe', 1000, 100),          // NPR 100 / KG
      row('k1', 'b', 'Bloom PKR', 500, 54),             // NPR 108 / KG
      row('s', 'a', 'Bloom Cafe', 2, 200, { uom: 'KG', item_name: 'Sugar' }),
      row('s', 'b', 'Bloom PKR', 1000, 100, { item_name: 'Sugar' }),
    ],
    error: null,
  })
  render(<GroupItemPrices bsYear={2083} bsMonth={6} />)
  expect(await screen.findByRole('columnheader', { name: 'Bloom PKR' })).toBeTruthy()
  expect(mockRpc).toHaveBeenCalledWith('get_group_item_prices', { p_bs_year: 2083, p_bs_month: 6 })
  // The RPC's own unique order, so a page boundary can neither repeat nor skip a row.
  expect(builders[0].orders).toEqual(['item_key', 'client_id', 'uom'])
  expect(builders[0].ranges[0]).toEqual([0, 999])
  expect(screen.getByText('100.00 / KG')).toBeTruthy()
  expect(screen.getByText('108.00 / KG')).toBeTruthy()
  expect(screen.getAllByText('Lowest')).toHaveLength(1)
  expect(screen.getByText('Units differ')).toBeTruthy()
  // (0.108 − 0.10) × 500 GM = NPR 4, in the row and in the note.
  expect(screen.getByText(/would have cost/).textContent).toMatch(/would have cost NPR 4 less/)
})

test('Crest support names the viewed group, and Refresh reads again', async () => {
  answer({ data: [], error: null })
  const { rerender } = render(<GroupItemPrices bsYear={2083} bsMonth={6} readGroupId="g1" refreshKey={0} />)
  await screen.findByText(/No linked item was bought/)
  expect(mockRpc).toHaveBeenCalledWith('get_group_item_prices', { p_bs_year: 2083, p_bs_month: 6, p_group_id: 'g1' })
  expect(mockRpc).toHaveBeenCalledTimes(1)
  rerender(<GroupItemPrices bsYear={2083} bsMonth={6} readGroupId="g1" refreshKey={1} />)
  await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(2))
})

test('with nothing linked, says why and how items get linked', async () => {
  answer({ data: [], error: null })
  render(<GroupItemPrices bsYear={2083} bsMonth={6} />)
  expect(await screen.findByText(/No linked item was bought by two or more outlets/)).toBeTruthy()
  expect(screen.getByText(/Push master data/)).toBeTruthy()
})

test('a failed read is a failure card, never the empty state', async () => {
  answer({ data: null, error: { message: 'Not permitted: only an owner can see group figures.', code: 'P0001' } })
  render(<GroupItemPrices bsYear={2083} bsMonth={6} />)
  await waitFor(() => expect(screen.queryByText(/Comparing prices/)).toBeNull())
  expect(screen.queryByText(/No linked item was bought/)).toBeNull()
  expect(screen.getByRole('alert')).toBeTruthy()
})
