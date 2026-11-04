/**
 * The command palette and the Quick Calculator load from their own files (S876, PERF-8). What has to
 * hold for that to be invisible: the tool is mounted as soon as its file arrives, so the first press
 * opens it at once; it stays mounted across a close, so the calculator keeps its tape; and a failed
 * download or a crash is a note beside the page, never the page torn down or reloaded.
 */
import { useState } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import LoadOnOpen, { onDemand } from './LoadOnOpen'
import { reportCrash } from '../shared/monitoring'

jest.mock('../shared/monitoring', () => ({ reportCrash: jest.fn() }))

// Stands in for a tool: renders a marker while mounted, and its content (with a little state of its
// own, like the calculator's tape) only while open, as both real tools do.
function Counter({ open, onClose }) {
  const [n, setN] = useState(0)
  return (
    <>
      <span data-testid="mounted" />
      {open && (
        <div>
          <span data-testid="count">{n}</span>
          <button type="button" onClick={() => setN(x => x + 1)}>more</button>
          <button type="button" onClick={onClose}>close</button>
        </div>
      )}
    </>
  )
}
const counterFile = () => Promise.resolve({ default: Counter })

it('fetches the file when the browser is idle and mounts the tool closed, so the first press opens it at once', async () => {
  const load = jest.fn(counterFile)
  const tool = onDemand(load)
  const view = render(<LoadOnOpen tool={tool} label="Page search" open={false} onClose={() => {}} />)
  expect(load).not.toHaveBeenCalled()
  await screen.findByTestId('mounted')
  expect(load).toHaveBeenCalledTimes(1)

  view.rerender(<LoadOnOpen tool={tool} label="Page search" open onClose={() => {}} />)
  // In the same render as the press: nothing to wait for, so no typed key can fall through.
  expect(screen.getByTestId('count').textContent).toBe('0')
})

it('opened before the idle fetch, it fetches at once and opens', async () => {
  const tool = onDemand(counterFile)
  render(<LoadOnOpen tool={tool} label="Page search" open onClose={() => {}} />)
  expect((await screen.findByTestId('count')).textContent).toBe('0')
})

it('stays mounted across a close, so what it holds survives a reopen', async () => {
  const tool = onDemand(counterFile)
  const view = render(<LoadOnOpen tool={tool} label="The calculator" open onClose={() => {}} />)
  fireEvent.click(await screen.findByText('more'))
  view.rerender(<LoadOnOpen tool={tool} label="The calculator" open={false} onClose={() => {}} />)
  expect(screen.queryByTestId('count')).toBeNull()
  view.rerender(<LoadOnOpen tool={tool} label="The calculator" open onClose={() => {}} />)
  expect(screen.getByTestId('count').textContent).toBe('1')
})

it('a later shell mounts the tool at once from the file already fetched', async () => {
  const load = jest.fn(counterFile)
  const tool = onDemand(load)
  const first = render(<LoadOnOpen tool={tool} label="Page search" open onClose={() => {}} />)
  await screen.findByTestId('count')
  first.unmount()
  render(<LoadOnOpen tool={tool} label="Page search" open onClose={() => {}} />)
  expect(screen.getByTestId('count')).toBeTruthy()
  expect(load).toHaveBeenCalledTimes(1)
})

it('a failed download is a note, and the next open tries again', async () => {
  let offline = true
  const tool = onDemand(() => (offline
    ? Promise.reject(Object.assign(new Error('Loading chunk 77 failed.'), { name: 'ChunkLoadError' }))
    : counterFile()))
  const onClose = jest.fn()
  const view = render(<LoadOnOpen tool={tool} label="The calculator" open onClose={onClose} />)

  const note = await screen.findByRole('alert')
  expect(note.textContent).toContain('The calculator could not load. Check the connection and try again, or reload the page if this keeps happening.')
  fireEvent.click(screen.getByText('Dismiss'))
  expect(onClose).toHaveBeenCalledTimes(1)

  view.rerender(<LoadOnOpen tool={tool} label="The calculator" open={false} onClose={onClose} />)
  expect(screen.queryByRole('alert')).toBeNull()
  offline = false
  view.rerender(<LoadOnOpen tool={tool} label="The calculator" open onClose={onClose} />)
  expect((await screen.findByTestId('count')).textContent).toBe('0')
  expect(screen.queryByRole('alert')).toBeNull()
})

it('Escape dismisses the note and only the note: a Modal underneath skips a handled key', async () => {
  const tool = onDemand(() => Promise.reject(new Error('Loading chunk 77 failed.')))
  const onClose = jest.fn()
  render(<LoadOnOpen tool={tool} label="Page search" open onClose={onClose} />)
  await screen.findByRole('alert')

  const key = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  document.body.dispatchEvent(key)
  expect(onClose).toHaveBeenCalledTimes(1)
  expect(key.defaultPrevented).toBe(true)
})

it('a crash inside the tool is a note beside the page, reported, and the next open starts afresh', async () => {
  const quiet = jest.spyOn(console, 'error').mockImplementation(() => {})
  let broken = true
  function Fragile({ open }) {
    if (open && broken) throw new Error('palette render failed')
    return open ? <span data-testid="fresh" /> : null
  }
  const tool = onDemand(() => Promise.resolve({ default: Fragile }))
  const page = open => (
    <div>
      <p>the page</p>
      <LoadOnOpen tool={tool} label="Page search" open={open} onClose={() => {}} />
    </div>
  )
  const view = render(page(true))

  expect((await screen.findByRole('alert')).textContent).toContain('Page search hit an error and closed.')
  expect(screen.getByText('the page')).toBeTruthy()
  expect(reportCrash).toHaveBeenCalled()

  broken = false
  view.rerender(page(false))
  view.rerender(page(true))
  await waitFor(() => expect(screen.getByTestId('fresh')).toBeTruthy())
  expect(screen.queryByRole('alert')).toBeNull()
  quiet.mockRestore()
})
