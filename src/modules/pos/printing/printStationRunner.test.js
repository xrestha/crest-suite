import { createPrintRunner, failReason, isNoAnswer, SLOW_TICK_MS, FAIL_REASON_MAX } from './printStationRunner'

const DEVICE = { deviceId: 'dev-1', secret: 's3cret' }
const networkError = () => ({ message: 'TypeError: Failed to fetch' })

// A fake server: each call takes the next scripted answer for that function, and is recorded.
function fakeServer(script) {
  const calls = []
  const queues = { pos_print_device_poll: [...(script.poll || [])], pos_print_device_report: [...(script.report || [])] }
  const rpc = jest.fn(async (fn, params) => {
    calls.push({ fn, params })
    const next = queues[fn].shift()
    if (next === undefined) throw new Error(`unscripted ${fn}`)
    return next
  })
  return { rpc, calls }
}

function setup(script, { printHtml, clock } = {}) {
  const server = fakeServer(script)
  const events = []
  const printed = []
  const time = clock || { t: 1_000_000 }
  const runner = createPrintRunner({
    device: DEVICE,
    rpc: server.rpc,
    printHtml: printHtml || jest.fn(async html => { printed.push(html) }),
    renderDoc: doc => `<html>${doc.title}${doc.late ? ' LATE' : ''}</html>`,
    withLate: (doc, createdAt) => ({ ...doc, late: createdAt }),
    appVersion: 'crest-v999',
    now: () => time.t,
    onEvent: e => events.push(e),
  })
  return { runner, server, events, printed, time }
}

const job = (id, extra = {}) => ({ id, station: 'KOT', kind: 'ticket', doc: { v: 1, title: `T-${id}`, lines: [] }, label: `Table ${id}`, created_at: '2026-10-14T06:00:00Z', late: false, ...extra })
const pollOk = jobs => ({ data: { ok: true, device: { id: 'dev-1', name: 'Counter PC', kind: 'page', stations: ['KOT'] }, client_name: 'Bhatti', server_time: 'x', jobs }, error: null })
const reportOk = { data: { ok: true }, error: null }

test('an empty poll prints nothing and sends no report', async () => {
  const { runner, server } = setup({ poll: [pollOk([])] })
  const out = await runner.tick()
  expect(out).toMatchObject({ kind: 'ok', printed: 0, failed: 0, clientName: 'Bhatti' })
  expect(out.device.name).toBe('Counter PC')
  expect(server.calls).toEqual([{
    fn: 'pos_print_device_poll',
    params: { p_device_id: 'dev-1', p_secret: 's3cret', p_info: { app_version: 'crest-v999', printers: [] } },
  }])
})

test('jobs print in order, a late one with its line, then one report', async () => {
  const { runner, server, printed, events } = setup({
    poll: [pollOk([job('a'), job('b', { late: true, created_at: '2026-10-14T05:50:00Z' })])],
    report: [reportOk],
  })
  const out = await runner.tick()
  expect(out).toMatchObject({ kind: 'ok', printed: 2, failed: 0 })
  expect(printed).toEqual(['<html>T-a</html>', '<html>T-b LATE</html>'])
  expect(server.calls[1]).toEqual({
    fn: 'pos_print_device_report',
    params: { p_device_id: 'dev-1', p_secret: 's3cret', p_printed: ['a', 'b'], p_failed: [] },
  })
  expect(events.map(e => `${e.type}:${e.job?.id}`)).toEqual(['job-start:a', 'job-printed:a', 'job-start:b', 'job-printed:b'])
  expect(runner.hasPendingReport).toBe(false)
})

test('a print that throws is reported as failed with its reason, and the rest still print', async () => {
  const printHtml = jest.fn(async html => { if (html.includes('T-a')) throw new Error('x'.repeat(300)) })
  const { runner, server, events } = setup({ poll: [pollOk([job('a'), job('b')])], report: [reportOk] }, { printHtml })
  const out = await runner.tick()
  expect(out).toMatchObject({ kind: 'ok', printed: 1, failed: 1 })
  const report = server.calls[1].params
  expect(report.p_printed).toEqual(['b'])
  expect(report.p_failed).toEqual([{ id: 'a', reason: 'x'.repeat(FAIL_REASON_MAX) }])
  expect(events.find(e => e.type === 'job-failed').job.id).toBe('a')
})

test('a report the server never heard is resent before anything new is printed', async () => {
  const { runner, server, printed, time } = setup({
    poll: [pollOk([job('a')]), pollOk([job('b')])],
    report: [{ data: null, error: networkError() }, { data: null, error: networkError() }, reportOk, reportOk],
  })

  const first = await runner.tick()
  expect(first).toMatchObject({ kind: 'unreachable', during: 'report', noAnswer: true, printed: 1 })
  expect(runner.hasPendingReport).toBe(true)
  expect(runner.safeToReload).toBe(false)

  // Inside the slowdown nothing runs at all.
  expect(runner.due()).toBe(false)
  expect(await runner.tick()).toEqual({ kind: 'skipped' })

  // The next run tries the report again and, when it fails again, does NOT poll.
  time.t += SLOW_TICK_MS
  const second = await runner.tick()
  expect(second).toMatchObject({ kind: 'unreachable', during: 'report' })
  expect(server.calls.map(c => c.fn)).toEqual(['pos_print_device_poll', 'pos_print_device_report', 'pos_print_device_report'])

  // Heard at last: then it polls and prints the next job.
  time.t += SLOW_TICK_MS
  const third = await runner.tick()
  expect(third).toMatchObject({ kind: 'ok', printed: 1 })
  expect(server.calls.map(c => c.fn)).toEqual([
    'pos_print_device_poll', 'pos_print_device_report', 'pos_print_device_report',
    'pos_print_device_report', 'pos_print_device_poll', 'pos_print_device_report',
  ])
  expect(server.calls[3].params.p_printed).toEqual(['a'])
  expect(printed).toEqual(['<html>T-a</html>', '<html>T-b</html>'])
  expect(runner.safeToReload).toBe(true)
})

test('a report the server refuses is dropped, not resent for ever', async () => {
  const { runner, events } = setup({
    poll: [pollOk([job('a')]), pollOk([])],
    report: [{ data: { ok: false, code: 'bad_input', message: 'nope' }, error: null }],
  })
  expect(await runner.tick()).toMatchObject({ kind: 'ok', printed: 1 })
  expect(runner.hasPendingReport).toBe(false)
  expect(events.some(e => e.type === 'report-refused' && e.code === 'bad_input')).toBe(true)
  expect(await runner.tick()).toMatchObject({ kind: 'ok', printed: 0 })
})

test('a removed device stops the loop, from a poll', async () => {
  const { runner } = setup({ poll: [{ data: { ok: false, code: 'device_not_active' }, error: null }] })
  expect(await runner.tick()).toEqual({ kind: 'removed' })
  expect(runner.stopped).toBe(true)
  expect(runner.due()).toBe(false)
  expect(await runner.tick()).toEqual({ kind: 'stopped' })
})

test('a removed device stops the loop, from a report', async () => {
  const { runner } = setup({
    poll: [pollOk([job('a')])],
    report: [{ data: { ok: false, code: 'device_not_active' }, error: null }],
  })
  expect(await runner.tick()).toMatchObject({ kind: 'removed' })
  expect(runner.stopped).toBe(true)
  expect(runner.hasPendingReport).toBe(false)
})

test('POS switched off pauses without printing', async () => {
  const { runner, printed } = setup({ poll: [{ data: { ok: true, paused: 'pos_off', jobs: [] }, error: null }] })
  expect(await runner.tick()).toMatchObject({ kind: 'paused', reason: 'pos_off' })
  expect(printed).toEqual([])
  expect(runner.due()).toBe(true) // a paused answer is an answer: no slowdown
})

test('a dropped connection slows the loop to every 10 s until a call succeeds', async () => {
  const { runner, time } = setup({ poll: [{ data: null, error: networkError() }, pollOk([])] })
  const out = await runner.tick()
  expect(out).toMatchObject({ kind: 'unreachable', during: 'poll', noAnswer: true })
  time.t += SLOW_TICK_MS - 1
  expect(runner.due()).toBe(false)
  time.t += 1
  expect(runner.due()).toBe(true)
  expect(await runner.tick()).toMatchObject({ kind: 'ok' })
  time.t += 1
  expect(runner.due()).toBe(true)
})

test('a refusal or a strange answer from the poll is a retry, not a stop', async () => {
  const { runner, time } = setup({ poll: [{ data: { ok: false, code: 'odd' }, error: null }, { data: 'nonsense', error: null }] })
  expect(await runner.tick()).toMatchObject({ kind: 'unreachable', noAnswer: false })
  time.t += SLOW_TICK_MS
  expect(await runner.tick()).toMatchObject({ kind: 'unreachable' })
  expect(runner.stopped).toBe(false)
})

test('one tick at a time, and a test print waits its turn', async () => {
  let release
  const gate = new Promise(r => { release = r })
  const printHtml = jest.fn(() => gate)
  const { runner } = setup({ poll: [pollOk([job('a')])], report: [reportOk] }, { printHtml })
  const running = runner.tick()
  await Promise.resolve()
  await Promise.resolve()
  expect(runner.busy).toBe(true)
  expect(runner.due()).toBe(false)
  expect(await runner.tick()).toEqual({ kind: 'busy' })
  expect(await runner.printLocal('<html>test</html>')).toEqual({ ok: false, busy: true })
  release()
  expect(await running).toMatchObject({ kind: 'ok', printed: 1 })
  expect(runner.busy).toBe(false)
})

test('a test print goes through the printer and reports a failure in words', async () => {
  const printHtml = jest.fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('The ticket did not load within 10 s, so it was not printed.'))
  const { runner, server } = setup({}, { printHtml })
  expect(await runner.printLocal('<html>test</html>')).toEqual({ ok: true })
  expect(await runner.printLocal('<html>test</html>')).toEqual({ ok: false, reason: 'The ticket did not load within 10 s, so it was not printed.' })
  expect(server.calls).toEqual([]) // no server call
})

test('helpers', () => {
  expect(failReason(new Error('Paper out'))).toBe('Paper out')
  expect(failReason('plain')).toBe('plain')
  expect(failReason(null)).toBe('The print did not start.')
  expect(isNoAnswer(networkError())).toBe(true)
  expect(isNoAnswer(Object.assign(new Error('x timed out after 15s'), { name: 'TimeoutError' }))).toBe(true)
  expect(isNoAnswer({ code: '42501', message: 'permission denied' })).toBe(false)
  expect(isNoAnswer(null)).toBe(false)
})
