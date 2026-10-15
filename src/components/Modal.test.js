import { StrictMode, useState } from 'react'
import { render, fireEvent, screen } from '@testing-library/react'
import Modal from './Modal'

// S791 (hss-suite's Overlay.test.jsx, ported): a Modal rendered inside another that mounts in the
// same commit registers FIRST, because React runs a child's effects before its parent's. Pushed in
// mount order, the outer dialog read as topmost and Escape closed it instead of the inner one.
function Page({ inner, closeOuter, closeInner }) {
  return (
    <Modal title="Outer" onClose={closeOuter}>
      <p>Outer body</p>
      {inner && (
        <Modal title="Inner" onClose={closeInner}>
          <button>Inner action</button>
        </Modal>
      )}
    </Modal>
  )
}

test('Escape closes only the dialog on top when both mount together', () => {
  const closeOuter = jest.fn()
  const closeInner = jest.fn()
  render(<Page inner closeOuter={closeOuter} closeInner={closeInner} />)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(closeInner).toHaveBeenCalledTimes(1)
  expect(closeOuter).not.toHaveBeenCalled()
})

test('Escape closes only the dialog on top when the inner one opens later', () => {
  const closeOuter = jest.fn()
  const closeInner = jest.fn()
  const { rerender } = render(<Page closeOuter={closeOuter} closeInner={closeInner} />)
  rerender(<Page inner closeOuter={closeOuter} closeInner={closeInner} />)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(closeInner).toHaveBeenCalledTimes(1)
  expect(closeOuter).not.toHaveBeenCalled()
})

test('with the inner dialog gone, Escape reaches the outer one', () => {
  const closeOuter = jest.fn()
  const closeInner = jest.fn()
  const { rerender } = render(<Page inner closeOuter={closeOuter} closeInner={closeInner} />)
  rerender(<Page closeOuter={closeOuter} closeInner={closeInner} />)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(closeOuter).toHaveBeenCalledTimes(1)
  expect(closeInner).not.toHaveBeenCalled()
})

test('a key a child already consumed does not close the dialog', () => {
  const close = jest.fn()
  render(
    <Modal title="Form" onClose={close}>
      <button onKeyDown={e => e.preventDefault()}>Box</button>
    </Modal>
  )
  fireEvent.keyDown(screen.getByText('Box'), { key: 'Escape' })
  expect(close).not.toHaveBeenCalled()
})

// S841: the opener is read on the modal's first render. A child's autoFocus runs during React's
// commit, before the mount effect, so reading `document.activeElement` there recorded the input
// inside the dialog as the opener; the modal then moved focus to ×, and on close tried to focus
// the removed input, so focus fell to <body>.
function Opener({ autoFocusField = false, inner = false }) {
  const [open, setOpen] = useState(false)
  const [innerOpen, setInnerOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      {open && (
        <Modal title="Add staff" onClose={() => setOpen(false)}>
          <input aria-label="Name" autoFocus={autoFocusField} />
          {inner && <button onClick={() => setInnerOpen(true)}>Reset PIN</button>}
          {innerOpen && (
            <Modal title="Reset PIN" onClose={() => setInnerOpen(false)}>
              <input aria-label="New PIN" autoFocus={autoFocusField} />
            </Modal>
          )}
        </Modal>
      )}
    </>
  )
}

// Focus tests need the focused node itself, which Testing Library has no query for.
const focused = () => document.activeElement // eslint-disable-line testing-library/no-node-access
const pressEscape = () => fireEvent.keyDown(focused(), { key: 'Escape' })

function openFrom(name = 'Open') {
  const btn = screen.getByText(name)
  btn.focus()
  fireEvent.click(btn)
  return btn
}

test('a field that autofocuses keeps focus when the dialog opens', () => {
  render(<Opener autoFocusField />)
  openFrom()
  expect(screen.getByLabelText('Name')).toHaveFocus()
})

test('without an autofocused field, focus still goes to the first control', () => {
  render(<Opener />)
  openFrom()
  expect(screen.getByLabelText('Close')).toHaveFocus()
})

test('closing returns focus to the button that opened the dialog, autofocus or not', () => {
  for (const autoFocusField of [true, false]) {
    const { unmount } = render(<Opener autoFocusField={autoFocusField} />)
    const btn = openFrom()
    pressEscape()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(btn).toHaveFocus()
    unmount()
  }
})

test('a nested dialog returns focus to its opener inside the outer one, then the outer to the page', () => {
  render(<Opener autoFocusField inner />)
  const pageBtn = openFrom()
  const innerBtn = openFrom('Reset PIN')
  expect(screen.getAllByRole('dialog')).toHaveLength(2)
  expect(screen.getByLabelText('New PIN')).toHaveFocus()
  pressEscape()
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(innerBtn).toHaveFocus()
  pressEscape()
  expect(pageBtn).toHaveFocus()
})

test('an opener removed while the dialog was open is not focused on close', () => {
  function Gone() {
    const [open, setOpen] = useState(false)
    return (
      <>
        {!open && <button onClick={() => setOpen(true)}>Open</button>}
        {open && <Modal title="T" onClose={() => setOpen(false)}><input aria-label="Name" /></Modal>}
      </>
    )
  }
  render(<Gone />)
  openFrom()
  pressEscape()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(focused()).toBe(document.body)
})

test('StrictMode double effects do not move an autofocused field\'s focus to the close button', () => {
  render(<StrictMode><Opener autoFocusField /></StrictMode>)
  openFrom()
  expect(screen.getByLabelText('Name')).toHaveFocus()
})
