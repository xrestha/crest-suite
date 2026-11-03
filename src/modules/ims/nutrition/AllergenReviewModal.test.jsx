import { render, screen, fireEvent, within } from '@testing-library/react'
import AllergenReviewModal from './AllergenReviewModal'

// The list's safety rule: a row whose allergens only its label knows (a sauce, a spice mix, a word
// not on the list) is never confirmed on a guess, alone or in Confirm all.

jest.mock('../../../supabaseClient', () => ({ supabase: { from: jest.fn() } }))

const items = [
  { id: 'a', name: 'PANEER', nutrition: null },
  { id: 'b', name: 'BBQ SAUCE', nutrition: null },
  { id: 'c', name: '8 OZ RIPPLE CUP', nutrition: null },
  { id: 'd', name: 'LETTUCE', nutrition: null },
  { id: 'e', name: 'KIWI', nutrition: { allergens: 'kiwi', allergens_checked: false } },
  { id: 'f', name: 'RICE', nutrition: { allergens_checked: true } },
]

function renderList(props = {}) {
  return render(<AllergenReviewModal items={items} onClose={() => {}} onSaved={() => {}} onChange={() => {}} {...props} />)
}
const rowOf = name => screen.getByText(name).closest('tr')

describe('AllergenReviewModal', () => {
  test('lists only the unchecked ingredients, each with its guess and where it came from', () => {
    renderList()
    expect(screen.queryByText('RICE')).toBeNull()
    expect(within(rowOf('PANEER')).getByText('Milk (paneer)')).toBeTruthy()
    expect(within(rowOf('8 OZ RIPPLE CUP')).getByText('(from “cup”)')).toBeTruthy()
    expect(within(rowOf('8 OZ RIPPLE CUP')).getByRole('button', { name: 'Mark as not food: 8 OZ RIPPLE CUP' })).toBeTruthy()
    expect(within(rowOf('LETTUCE')).getByText('No allergen words found')).toBeTruthy()
    expect(within(rowOf('BBQ SAUCE')).getByText(/Check the label \(sauce\)/)).toBeTruthy()
    expect(within(rowOf('KIWI')).getByText(/not on the list: kiwi/)).toBeTruthy()
  })

  test('a row that needs its label has no Confirm, only Open', () => {
    renderList()
    expect(within(rowOf('BBQ SAUCE')).queryByRole('button', { name: /^Confirm/ })).toBeNull()
    expect(within(rowOf('BBQ SAUCE')).getByRole('button', { name: 'Open BBQ SAUCE' })).toBeTruthy()
    expect(within(rowOf('KIWI')).queryByRole('button', { name: /^Confirm/ })).toBeNull()
  })

  test('Confirm all counts everything shown except the label rows', () => {
    renderList()
    // PANEER, the cup and LETTUCE; not BBQ SAUCE or KIWI.
    expect(screen.getByRole('button', { name: 'Confirm all 3 shown' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Check the label/ }))
    expect(screen.getByRole('button', { name: 'Confirm all 0 shown' }).disabled).toBe(true)
  })

  test('Change hands the guess to the Nutrition form', () => {
    const onChange = jest.fn()
    renderList({ onChange })
    fireEvent.click(within(rowOf('PANEER')).getByRole('button', { name: 'Change PANEER' }))
    expect(onChange).toHaveBeenCalledWith(items[0], ['milk'], expect.stringContaining('Milk (paneer)'))
  })
})
