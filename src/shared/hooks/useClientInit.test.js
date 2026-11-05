import { renderHook } from '@testing-library/react'
import { useClientInit } from './useClientInit'

const run = (props) => renderHook(p => useClientInit(p.clientId, p.authLoading, p.init, p.keyValue), { initialProps: props })

it('loads once when the sign-in is ready', () => {
  const init = jest.fn()
  const { rerender } = run({ clientId: 'c1', authLoading: false, init })
  rerender({ clientId: 'c1', authLoading: false, init })
  expect(init).toHaveBeenCalledTimes(1)
})

it('a page opened during a profile re-fetch loads when the re-fetch ends (the S890 skeleton)', () => {
  const init = jest.fn()
  const { rerender } = run({ clientId: 'c1', authLoading: true, init })
  expect(init).not.toHaveBeenCalled()
  rerender({ clientId: 'c1', authLoading: false, init })
  expect(init).toHaveBeenCalledTimes(1)
})

it('a later re-fetch does not load again, so the month and tab picked are kept', () => {
  const init = jest.fn()
  const { rerender } = run({ clientId: 'c1', authLoading: false, init })
  rerender({ clientId: 'c1', authLoading: true, init })
  rerender({ clientId: 'c1', authLoading: false, init })
  expect(init).toHaveBeenCalledTimes(1)
})

it('waits for an outlet, and loads again for another outlet or another record', () => {
  const init = jest.fn()
  const { rerender } = run({ clientId: null, authLoading: false, init, keyValue: 'b1' })
  expect(init).not.toHaveBeenCalled()
  rerender({ clientId: 'c1', authLoading: false, init, keyValue: 'b1' })
  rerender({ clientId: 'c1', authLoading: false, init, keyValue: 'b2' })
  rerender({ clientId: 'c2', authLoading: false, init, keyValue: 'b2' })
  expect(init).toHaveBeenCalledTimes(3)
})

it('calls the init of the latest render', () => {
  const first = jest.fn()
  const latest = jest.fn()
  const { rerender } = run({ clientId: 'c1', authLoading: true, init: first })
  rerender({ clientId: 'c1', authLoading: false, init: latest })
  expect(first).not.toHaveBeenCalled()
  expect(latest).toHaveBeenCalledTimes(1)
})

// S890: the gate this hook replaced stood on 26 pages in two forms. Any start-up
// effect gated on the sign-in flag goes through useClientInit instead.
it('no page gates its first load on the sign-in flag by hand', () => {
  const fs = require('fs')
  const path = require('path')
  const walk = d => fs.readdirSync(d, { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
  const SRC = path.join(__dirname, '..', '..')
  const offenders = walk(SRC)
    .filter(f => /\.(js|jsx)$/.test(f) && !/\.test\./.test(f))
    .filter(f => /useEffect\(\(\) => \{ if \(!authLoading\b/.test(fs.readFileSync(f, 'utf8').replace(/\/\/[^\n]*/g, '')))
    .map(f => path.relative(SRC, f))
  expect(offenders).toEqual([])
})
