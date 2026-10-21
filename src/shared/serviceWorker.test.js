// public/service-worker.js is served as written, never bundled, so nothing runs it before a device
// does. This evaluates the real file against an in-memory Cache Storage and drives its handlers
// (S855, PERF-4): /static/ files live in a cache no release clears, and activate keeps only the new
// build and the build before it.
import fs from 'fs'
import path from 'path'
import vm from 'vm'

const ORIGIN = 'https://crest.test'
const SW_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'service-worker.js'), 'utf8')
const CACHE_NAME = SW_SRC.match(/const CACHE_NAME = '([^']+)'/)[1]
const STATIC = SW_SRC.match(/const STATIC_CACHE = '([^']+)'/)[1]
const TIME_LIMIT = Number(SW_SRC.match(/const TIDY_TIME_LIMIT_MS = (\d+)/)[1])
const BUILDS = '/__crest-sw/builds'
const PENDING = '/__crest-sw/manifest-pending'

const abs = key => new URL(typeof key === 'string' ? key : key.url, ORIGIN).href

class FakeResponse {
  constructor(body = '', init = {}) {
    this.body = body
    this.init = init
    this.status = init.status ?? 200
    this.ok = this.status >= 200 && this.status < 300
    this.type = init.type ?? 'default'
    const h = {}
    for (const [k, v] of Object.entries(init.headers || {})) h[k.toLowerCase()] = v
    this.headers = { get: name => h[name.toLowerCase()] ?? null }
  }
  clone() { return new FakeResponse(this.body, this.init) }
  async json() { return JSON.parse(this.body) }
  async text() { return this.body }
}

const file = (body, contentType = 'application/javascript', status = 200, type = 'basic') =>
  new FakeResponse(body, { status, type, headers: { 'content-type': contentType } })
const json = value => new FakeResponse(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })

class FakeCache {
  constructor(storage) { this.entries = new Map(); this.storage = storage }
  async match(key) { const r = this.entries.get(abs(key)); return r ? r.clone() : undefined }
  async put(key, res) { this.entries.set(abs(key), res) }
  async add(key) {
    const res = await this.storage.fetchFn(key)
    if (!res.ok) throw new TypeError('add failed')
    this.entries.set(abs(key), res)
  }
  async delete(key) { return this.entries.delete(abs(key)) }
  async keys() { return [...this.entries.keys()].map(url => ({ url })) }
  paths() { return [...this.entries.keys()].map(u => new URL(u).pathname).sort() }
}

function makeCaches() {
  const store = new Map()
  const storage = {
    store,
    fetchFn: null, // the loaded worker's fetch, so a device carried to the next release uses that one
    async open(name) {
      if (!store.has(name)) store.set(name, new FakeCache(storage))
      return store.get(name)
    },
    async keys() { return [...store.keys()] },
    async delete(name) { return store.delete(name) },
    async match(key, opts = {}) {
      for (const name of opts.cacheName ? [opts.cacheName] : [...store.keys()]) {
        const hit = store.has(name) ? await store.get(name).match(key) : undefined
        if (hit) return hit
      }
      return undefined
    },
  }
  return storage
}

/** Loads the worker. `cacheName` stands in for a later release's bump; `cachesFrom` carries a device over. */
function loadWorker({ network = {}, cacheName, cachesFrom } = {}) {
  const handlers = {}
  const env = { handlers, network }
  env.fetch = jest.fn(async input => {
    const res = env.network[new URL(abs(input)).pathname]
    if (res instanceof Error) throw res
    if (!res) return file('Not Found', 'text/plain', 404)
    return res.clone()
  })
  env.caches = cachesFrom || makeCaches()
  env.caches.fetchFn = env.fetch
  env.self = {
    location: { origin: ORIGIN, href: `${ORIGIN}/service-worker.js` },
    addEventListener: (type, fn) => { handlers[type] = fn },
    skipWaiting: jest.fn(),
    clients: { claim: jest.fn(() => Promise.resolve()), matchAll: jest.fn(async () => []), openWindow: jest.fn() },
    registration: { showNotification: jest.fn(() => Promise.resolve()) },
  }
  const src = cacheName ? SW_SRC.replace(/const CACHE_NAME = '[^']+'/, `const CACHE_NAME = '${cacheName}'`) : SW_SRC
  vm.runInNewContext(src, {
    self: env.self,
    caches: env.caches,
    fetch: env.fetch,
    Response: FakeResponse,
    URL,
    // Looked up at call time, so jest fake timers reach the worker too.
    setTimeout: (...a) => setTimeout(...a),
    clearTimeout: (...a) => clearTimeout(...a),
  })
  return env
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

async function runLifecycle(env, type) {
  let work
  env.handlers[type]({ waitUntil: p => { work = p } })
  await work
}

async function request(env, pathname, mode = 'no-cors') {
  let reply
  env.handlers.fetch({ request: { method: 'GET', url: ORIGIN + pathname, mode }, respondWith: p => { reply = p } })
  const res = await reply
  await flush() // the cache write is fire-and-forget
  return res
}

/** A CRA asset manifest: main js/css plus the named chunks, and the index.html CRA also lists. */
function manifest({ js, css, chunks = [] }) {
  const files = { 'main.css': css, 'main.js': js, 'index.html': '/index.html' }
  chunks.forEach((c, i) => { files[`chunk${i}`] = c })
  return { files, entrypoints: [css.slice(1), js.slice(1)] }
}

const record = (version, m) => ({
  version,
  files: Object.values(m.files).filter(f => f.startsWith('/static/')),
  entrypoints: m.entrypoints.map(f => `/${f}`),
})

function networkFor(m) {
  const net = { '/': file('<html>shell</html>', 'text/html'), '/asset-manifest.json': json(m) }
  for (const f of Object.values(m.files)) net[f] = file(`/* ${f} */`, f.endsWith('.css') ? 'text/css' : 'application/javascript')
  return net
}

async function seed(env, name, entries) {
  const cache = await env.caches.open(name)
  for (const [key, res] of Object.entries(entries)) await cache.put(key, res)
  return cache
}

const staticPaths = env => env.caches.store.get(STATIC).paths()

// Three builds: A is two releases old, B is the one devices run now, C is the release arriving.
const A = manifest({ js: '/static/js/main.aaa.js', css: '/static/css/main.aaa.css', chunks: ['/static/js/10.aaa.chunk.js'] })
const B = manifest({
  js: '/static/js/main.bbb.js',
  css: '/static/css/main.bbb.css',
  chunks: ['/static/js/20.bbb.chunk.js', '/static/js/30.same.chunk.js'],
})
// C keeps B's stylesheet and one chunk unchanged, which is the whole point of a fixed cache.
const C = manifest({
  js: '/static/js/main.ccc.js',
  css: '/static/css/main.bbb.css',
  chunks: ['/static/js/30.same.chunk.js', '/static/js/40.ccc.chunk.js'],
})

const filesOf = m => Object.values(m.files).filter(f => f.startsWith('/static/'))
const seedStatic = (env, ...builds) =>
  seed(env, STATIC, Object.fromEntries(builds.flatMap(filesOf).map(f => [f, file(`/* ${f} */`)])))

describe('service worker fetch', () => {
  it('keeps /static/ files in the fixed cache and never stores an HTML page or a failed reply', async () => {
    const env = loadWorker({
      network: {
        '/static/js/1.aaa.chunk.js': file('chunk one'),
        '/static/js/2.bbb.chunk.js': file('<!doctype html>', 'text/html; charset=utf-8'),
        '/static/js/4.ddd.chunk.js': file('cors', 'application/javascript', 200, 'cors'),
        '/static/js/5.eee.chunk.js': file('server error', 'text/plain', 500),
        '/manifest.json': file('{}', 'application/manifest+json'),
      },
    })
    await request(env, '/static/js/1.aaa.chunk.js')
    await request(env, '/static/js/2.bbb.chunk.js')
    const missing = await request(env, '/static/js/3.ccc.chunk.js')
    await request(env, '/static/js/4.ddd.chunk.js')
    await request(env, '/static/js/5.eee.chunk.js')
    await request(env, '/manifest.json')

    expect(missing.status).toBe(404)
    expect(staticPaths(env)).toEqual(['/static/js/1.aaa.chunk.js'])
    // Unhashed files stay in the cache every release replaces.
    expect(env.caches.store.get(CACHE_NAME).paths()).toEqual(['/manifest.json'])

    env.fetch.mockClear()
    const again = await request(env, '/static/js/1.aaa.chunk.js')
    expect(await again.text()).toBe('chunk one')
    expect(env.fetch).not.toHaveBeenCalled()
  })

  it('never answers for its own bookkeeping rows', async () => {
    const env = loadWorker()
    const respondWith = jest.fn()
    env.handlers.fetch({ request: { method: 'GET', url: ORIGIN + BUILDS, mode: 'no-cors' }, respondWith })
    expect(respondWith).not.toHaveBeenCalled()
  })
})

describe('service worker install and activate', () => {
  it('keeps the new build and the build before it, and deletes every other /static/ file', async () => {
    const env = loadWorker({ network: networkFor(C) })
    await seedStatic(env, A, B)
    await seed(env, STATIC, { [BUILDS]: json({ current: record('crest-vB', B), previous: record('crest-vA', A) }) })
    await seed(env, 'crest-v1', { '/': file('<html>old</html>', 'text/html'), '/manifest.json': file('{}', 'application/json') })

    await runLifecycle(env, 'install')
    expect(env.self.skipWaiting).toHaveBeenCalled()
    // The unchanged stylesheet is not downloaded again.
    expect(env.fetch.mock.calls.map(([u]) => new URL(abs(u)).pathname)).not.toContain('/static/css/main.bbb.css')
    await runLifecycle(env, 'activate')

    expect([...env.caches.store.keys()].sort()).toEqual([CACHE_NAME, STATIC].sort())
    expect(env.caches.store.get(CACHE_NAME).paths()).toEqual(['/'])
    const expected = [...new Set([...filesOf(B), ...filesOf(C)].filter(f => f !== '/static/js/40.ccc.chunk.js'))]
    // 40.ccc was never fetched (only entrypoints are precached), so it is simply absent.
    expect(staticPaths(env)).toEqual([BUILDS, ...expected].sort())

    const builds = await (await env.caches.store.get(STATIC).match(BUILDS)).json()
    expect(builds.current).toEqual(record(CACHE_NAME, C))
    expect(builds.previous).toEqual(record('crest-vB', B))
    expect(env.self.clients.claim).toHaveBeenCalled()
  })

  it.each([
    ['could not be read', { '/asset-manifest.json': file('down', 'text/plain', 500) }],
    ['was unreachable', { '/asset-manifest.json': new TypeError('Failed to fetch') }],
    ['does not name its entrypoints', { '/asset-manifest.json': json({ files: { a: '/static/js/1.x.js' }, entrypoints: ['static/js/main.zzz.js'] }) }],
  ])('prunes nothing when the new manifest %s', async (_, override) => {
    const env = loadWorker({ network: { ...networkFor(C), ...override } })
    await seedStatic(env, A, B)
    await seed(env, STATIC, {
      [BUILDS]: json({ current: record('crest-vB', B), previous: record('crest-vA', A) }),
      // A list an earlier install left behind must not be taken for this build.
      [PENDING]: json(record(CACHE_NAME, B)),
    })

    await runLifecycle(env, 'install')
    await runLifecycle(env, 'activate')

    for (const f of [...filesOf(A), ...filesOf(B)]) expect(staticPaths(env)).toContain(f)
    // And the next release keeps everything too: nothing knows what this build consists of.
    expect(staticPaths(env)).not.toContain(BUILDS)
    expect(staticPaths(env)).not.toContain(PENDING)
  })

  it('on the first release adopts /static/ files from the old cache, deletes it, and starts pruning one release later', async () => {
    const env = loadWorker({ network: networkFor(C) })
    await seed(env, 'crest-v468', {
      '/': file('<html>old</html>', 'text/html'),
      '/manifest.json': file('{}', 'application/json'),
      ...Object.fromEntries(filesOf(B).map(f => [f, file(`/* ${f} */`)])),
      '/static/js/50.html.chunk.js': file('<html></html>', 'text/html'),
    })

    await runLifecycle(env, 'install')
    await runLifecycle(env, 'activate')

    expect(env.caches.store.has('crest-v468')).toBe(false)
    const adopted = staticPaths(env)
    for (const f of filesOf(B)) expect(adopted).toContain(f)
    expect(adopted).toContain('/static/js/main.ccc.js')
    expect(adopted).not.toContain('/static/js/50.html.chunk.js')
    expect(adopted).not.toContain('/manifest.json')
    // B was adopted, not downloaded: its stylesheet is also C's entrypoint.
    expect(env.fetch.mock.calls.map(([u]) => new URL(abs(u)).pathname)).not.toContain('/static/css/main.bbb.css')
    const builds = await (await env.caches.store.get(STATIC).match(BUILDS)).json()
    expect(builds).toEqual({ current: record(CACHE_NAME, C), previous: null })

    // The next release (build D): keeps D and C, so B's own files go now.
    const D = manifest({ js: '/static/js/main.ddd.js', css: '/static/css/main.ddd.css' })
    const next = loadWorker({ network: networkFor(D), cacheName: 'crest-vNEXT', cachesFrom: env.caches })
    await runLifecycle(next, 'install')
    await runLifecycle(next, 'activate')

    expect([...next.caches.store.keys()].sort()).toEqual(['crest-vNEXT', STATIC].sort())
    expect(staticPaths(next)).toEqual(
      [BUILDS, '/static/css/main.bbb.css', '/static/css/main.ddd.css', '/static/js/30.same.chunk.js', '/static/js/main.ccc.js', '/static/js/main.ddd.js'].sort()
    )
  })

  it('activates even when the tidy-up fails', async () => {
    const env = loadWorker({ network: networkFor(C) })
    await seedStatic(env, A)
    env.caches.keys = () => Promise.reject(new Error('storage gone'))
    await expect(runLifecycle(env, 'activate')).resolves.toBeUndefined()
    expect(env.self.clients.claim).toHaveBeenCalled()
    expect(staticPaths(env)).toEqual(filesOf(A).sort())
  })

  it('activates within the time limit when the tidy-up stalls', async () => {
    jest.useFakeTimers()
    try {
      const env = loadWorker({ network: networkFor(C) })
      env.caches.keys = () => new Promise(() => {})
      let settled = false
      let work
      env.handlers.activate({ waitUntil: p => { work = p } })
      work.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      jest.advanceTimersByTime(TIME_LIMIT)
      await work
      expect(settled).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('service worker push', () => {
  it('still registers the push and notification handlers', async () => {
    const env = loadWorker()
    expect(Object.keys(env.handlers).sort()).toEqual(['activate', 'fetch', 'install', 'notificationclick', 'push'])
    let work
    env.handlers.push({ data: { json: () => ({ title: 'Roster Published', body: 'Week 3' }) }, waitUntil: p => { work = p } })
    await work
    expect(env.self.registration.showNotification).toHaveBeenCalledWith('Roster Published', expect.objectContaining({ body: 'Week 3' }))
  })
})
