import { printHtmlInHiddenFrame, LOAD_TIMEOUT_MS, PRINT_SETTLE_MS } from './iframePrint'

// A stand-in document: jsdom does not load srcdoc frames, so the test fires `load` itself.
function fakeDoc({ printThrows = false } = {}) {
  const frames = []
  const body = {
    children: [],
    appendChild(el) { this.children.push(el); el.parentNode = this },
    removeChild(el) { this.children = this.children.filter(c => c !== el); el.parentNode = null },
  }
  return {
    body,
    frames,
    createElement(tag) {
      const el = {
        tag, style: {}, attrs: {}, parentNode: null, onload: null, srcdoc: '',
        setAttribute(k, v) { this.attrs[k] = v },
        contentWindow: { print: jest.fn(() => { if (printThrows) throw new Error('Printing is blocked') }) },
      }
      frames.push(el)
      return el
    },
  }
}

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

test('loads the ticket into a sandboxed, hidden frame, prints it, and removes it after the settle time', async () => {
  const doc = fakeDoc()
  const done = printHtmlInHiddenFrame('<html>KOT</html>', { doc })
  const frame = doc.frames[0]
  expect(frame.tag).toBe('iframe')
  expect(frame.attrs.sandbox).toBe('allow-same-origin allow-modals') // no allow-scripts: the text is untrusted
  expect(frame.srcdoc).toBe('<html>KOT</html>')
  expect(frame.style).toMatchObject({ width: '0', height: '0', position: 'fixed' })
  expect(doc.body.children).toContain(frame)

  frame.onload()
  expect(frame.contentWindow.print).toHaveBeenCalledTimes(1)
  expect(doc.body.children).toContain(frame) // kept while Chrome spools the job

  jest.advanceTimersByTime(PRINT_SETTLE_MS)
  await expect(done).resolves.toBeUndefined()
  expect(doc.body.children).not.toContain(frame)
})

test('a frame that never loads is removed and the print fails in words', async () => {
  const doc = fakeDoc()
  const done = printHtmlInHiddenFrame('<html/>', { doc })
  jest.advanceTimersByTime(LOAD_TIMEOUT_MS)
  await expect(done).rejects.toThrow('did not load within 10 s')
  expect(doc.body.children).toEqual([])
  // A late load after the timeout prints nothing.
  doc.frames[0].onload?.()
  expect(doc.frames[0].contentWindow.print).not.toHaveBeenCalled()
})

test('a print that throws fails the job and removes the frame', async () => {
  const doc = fakeDoc({ printThrows: true })
  const done = printHtmlInHiddenFrame('<html/>', { doc })
  doc.frames[0].onload()
  await expect(done).rejects.toThrow('Printing is blocked')
  expect(doc.body.children).toEqual([])
})

test('no document to print in', async () => {
  await expect(printHtmlInHiddenFrame('<html/>', { doc: null })).rejects.toThrow('cannot print')
})
