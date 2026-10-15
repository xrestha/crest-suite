// The till's memoised menu grid (S842): what it shows, and when it may skip a render.
import { render, screen, within } from '@testing-library/react'
import MenuGrid, { filterMenu, sameTiles } from './MenuGrid'

const MENU = [
  { id: 'r1', name: 'Veg Momo', category: 'Momo', recipe_code: 'MOM-01', selling_price: 200, vat_rate: 0, is_veg: true, is_egg: false },
  { id: 'r2', name: 'Chicken Momo', category: 'Momo', recipe_code: 'MOM-02', selling_price: 250, vat_rate: 0, is_veg: false, is_egg: false },
  { id: 'r3', name: 'Lemon Tea', category: 'Beverage', recipe_code: 'BEV-01', selling_price: 80, vat_rate: 0 },
  { id: 'r4', name: 'Egg Fried Rice', category: 'Rice', recipe_code: 'RIC-01', selling_price: 220, vat_rate: 0, is_veg: false, is_egg: true },
]
const base = {
  menu: MENU, menuTab: 'All', menuQuery: '', orderItems: [], vatReg: false,
  dishGroupsByRecipe: {}, orderKotTickets: [], kotNow: 0, addRef: { current: () => {} },
}

it('filters by category tab, then by name or Product Code', () => {
  expect(filterMenu(MENU, 'Momo', '').map(r => r.id)).toEqual(['r1', 'r2'])
  expect(filterMenu(MENU, 'All', 'bev-').map(r => r.id)).toEqual(['r3'])
  expect(filterMenu(MENU, 'All', 'chicken').map(r => r.id)).toEqual(['r2'])
})

it('counts every line of a dish on its one tile, and leaves a combo dish to its combo', () => {
  render(<MenuGrid {...base} orderItems={[
    { recipe_id: 'r1', qty: 2 },
    { recipe_id: 'r1', qty: 1, option_ids: ['o1'] },
    { recipe_id: 'r2', qty: 1, combo_line_id: 'c1', selection_key: '@c1/g1' },
  ]} />)
  expect(screen.getByRole('button', { name: /Veg Momo/ }).textContent).toMatch(/^3/)
  expect(screen.getByRole('button', { name: /Chicken Momo/ }).textContent).not.toMatch(/^\d/)
})

it('calls the latest add handler through the ref', () => {
  const added = []
  const addRef = { current: r => added.push(`old:${r.id}`) }
  render(<MenuGrid {...base} addRef={addRef} />)
  addRef.current = r => added.push(`new:${r.id}`)
  screen.getByRole('button', { name: /Lemon Tea/ }).click()
  expect(added).toEqual(['new:r3'])
})

it('skips a render for a cart change no tile shows, and not for one a tile shows', () => {
  const lines = [{ recipe_id: 'r1', qty: 1, notes: '' }]
  const noted = [{ recipe_id: 'r1', qty: 1, notes: 'no onion' }]
  const more = [{ recipe_id: 'r1', qty: 2, notes: '' }]
  const sent = [{ recipe_id: 'r1', qty: 1, notes: '', sent_to_kot: true }]
  expect(sameTiles({ ...base, orderItems: lines }, { ...base, orderItems: noted })).toBe(true)
  expect(sameTiles({ ...base, orderItems: lines }, { ...base, orderItems: more })).toBe(false)
  expect(sameTiles({ ...base, orderItems: lines }, { ...base, orderItems: sent })).toBe(false)
  expect(sameTiles(base, { ...base, menuQuery: 'mo' })).toBe(false)
  expect(sameTiles(base, { ...base, kotNow: 1 })).toBe(false)
})

it('leads a dish name with its food mark when the recipe states one (S846)', () => {
  render(<MenuGrid {...base} />)
  expect(within(screen.getByRole('button', { name: /Veg Momo/ })).getByRole('img', { name: 'Vegetarian' })).toBeTruthy()
  expect(within(screen.getByRole('button', { name: /Egg Fried Rice/ })).getByRole('img', { name: 'Contains egg' })).toBeTruthy()
  expect(within(screen.getByRole('button', { name: /Chicken Momo/ })).getByRole('img', { name: 'Non-vegetarian' })).toBeTruthy()
  // Not stated: no mark at all, rather than a guess.
  expect(within(screen.getByRole('button', { name: /Lemon Tea/ })).queryByRole('img')).toBeNull()
})
