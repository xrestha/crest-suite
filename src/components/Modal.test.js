import { render, fireEvent } from '@testing-library/react'
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
  const { getByText } = render(
    <Modal title="Form" onClose={close}>
      <button onKeyDown={e => e.preventDefault()}>Box</button>
    </Modal>
  )
  fireEvent.keyDown(getByText('Box'), { key: 'Escape' })
  expect(close).not.toHaveBeenCalled()
})
