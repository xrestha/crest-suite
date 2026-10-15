import { useState } from 'react'
import { render, fireEvent, screen } from '@testing-library/react'
import RowMenu from './RowMenu'
import Modal from './Modal'

// S841: an item click closed the menu WITHOUT refocusing, then ran the action. An action that opens
// a Modal recorded the vanishing menu item (or <body>) as its opener, so closing the dialog dropped
// focus to the top of the page (Loyalty's Adjust/Move, Reservations' No-show/Cancel/Mark done).
function Row({ className }) {
  const [dialog, setDialog] = useState(false)
  return (
    <>
      <RowMenu
        label="More for Sharma"
        className={className}
        items={[
          { key: 'adjust', label: 'Adjust points', onSelect: () => setDialog(true) },
          '-',
          { key: 'cancel', label: 'Cancel', danger: true, onSelect: () => {} },
        ]}
      />
      {dialog && (
        <Modal title="Adjust points" onClose={() => setDialog(false)}>
          <input aria-label="Points" autoFocus />
        </Modal>
      )}
    </>
  )
}

// Focus tests need the focused node itself, which Testing Library has no query for.
const focused = () => document.activeElement // eslint-disable-line testing-library/no-node-access
const trigger = () => screen.getByRole('button', { name: 'More for Sharma' })

test('closing a dialog opened from a menu item returns focus to the ⋯ trigger', () => {
  render(<Row />)
  const btn = trigger()
  btn.focus()
  fireEvent.click(btn)
  const item = screen.getByRole('menuitem', { name: 'Adjust points' })
  expect(item).toHaveFocus()

  fireEvent.click(item)
  expect(screen.queryByRole('menu')).toBeNull()
  expect(screen.getByLabelText('Points')).toHaveFocus()

  fireEvent.keyDown(focused(), { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(btn).toHaveFocus()
})

test('an item whose action opens nothing still leaves focus on the trigger', () => {
  render(<Row />)
  fireEvent.click(trigger())
  fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel' }))
  expect(trigger()).toHaveFocus()
})

test('className is appended to the trigger, and the default classes are unchanged without it', () => {
  const { rerender } = render(<Row className="till-hit--row" />)
  expect(trigger()).toHaveClass('btn', 'btn-ghost', 'btn-sm', 'btn-icon', 'till-hit--row')
  rerender(<Row />)
  expect(trigger()).toHaveAttribute('class', 'btn btn-ghost btn-sm btn-icon')
})
