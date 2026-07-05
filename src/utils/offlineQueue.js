const DB_NAME = 'crest-offline'
const DB_VERSION = 2

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = e => {
      const db = e.target.result
      if (!db.objectStoreNames.contains('items_cache'))      db.createObjectStore('items_cache',      { keyPath: 'client_id' })
      if (!db.objectStoreNames.contains('categories_cache')) db.createObjectStore('categories_cache', { keyPath: 'client_id' })
      if (!db.objectStoreNames.contains('periods_cache'))    db.createObjectStore('periods_cache',    { keyPath: 'client_id' })
      if (!db.objectStoreNames.contains('stock_cache'))      db.createObjectStore('stock_cache',      { keyPath: 'period_id' })
      if (!db.objectStoreNames.contains('sync_queue'))       db.createObjectStore('sync_queue',       { keyPath: 'id', autoIncrement: true })
      if (!db.objectStoreNames.contains('pos_menu_cache'))     db.createObjectStore('pos_menu_cache',     { keyPath: 'client_id' })
      if (!db.objectStoreNames.contains('pos_tables_cache'))   db.createObjectStore('pos_tables_cache',   { keyPath: 'client_id' })
      if (!db.objectStoreNames.contains('pos_settings_cache')) db.createObjectStore('pos_settings_cache', { keyPath: 'client_id' })
      if (!db.objectStoreNames.contains('pos_order_cache'))    db.createObjectStore('pos_order_cache',    { keyPath: 'table_id' })
      if (!db.objectStoreNames.contains('pos_order_queue'))    db.createObjectStore('pos_order_queue',    { keyPath: 'order_id' })
    }
    req.onsuccess = e => resolve(e.target.result)
    req.onerror  = e => reject(e.target.error)
  })
}

async function idbPut(storeName, record) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).put(record)
    tx.oncomplete = () => resolve()
    tx.onerror    = e => reject(e.target.error)
  })
}

async function idbGet(storeName, key) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readonly')
    const req = tx.objectStore(storeName).get(key)
    req.onsuccess = e => resolve(e.target.result)
    req.onerror   = e => reject(e.target.error)
  })
}

async function idbGetAll(storeName) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readonly')
    const req = tx.objectStore(storeName).getAll()
    req.onsuccess = e => resolve(e.target.result)
    req.onerror   = e => reject(e.target.error)
  })
}

async function idbDelete(storeName, key) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror    = e => reject(e.target.error)
  })
}

// ── Item / category / period caches ────────────────────────────────────────

export async function cacheItems(clientId, items) {
  await idbPut('items_cache', { client_id: clientId, items, updated_at: Date.now() })
}
export async function getCachedItems(clientId) {
  const rec = await idbGet('items_cache', clientId)
  return rec?.items || null
}

export async function cacheCategories(clientId, categories) {
  await idbPut('categories_cache', { client_id: clientId, categories, updated_at: Date.now() })
}
export async function getCachedCategories(clientId) {
  const rec = await idbGet('categories_cache', clientId)
  return rec?.categories || null
}

export async function cachePeriods(clientId, periods) {
  await idbPut('periods_cache', { client_id: clientId, periods, updated_at: Date.now() })
}
export async function getCachedPeriods(clientId) {
  const rec = await idbGet('periods_cache', clientId)
  return rec?.periods || null
}

// ── Stock data cache ────────────────────────────────────────────────────────

export async function cacheStockData(periodId, payload) {
  await idbPut('stock_cache', { period_id: periodId, ...payload, updated_at: Date.now() })
}
export async function getCachedStockData(periodId) {
  return await idbGet('stock_cache', periodId)
}

// ── Sync queue ──────────────────────────────────────────────────────────────

export async function enqueue(op) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('sync_queue', 'readwrite')
    const req = tx.objectStore('sync_queue').add({ ...op, timestamp: Date.now() })
    req.onsuccess = e => resolve(e.target.result)
    tx.onerror    = e => reject(e.target.error)
  })
}
export async function getQueue() {
  return await idbGetAll('sync_queue')
}
export async function dequeue(id) {
  await idbDelete('sync_queue', id)
}

// ── POS: menu / tables / settings caches (order-taking offline mode) ───────

export async function cachePosMenu(clientId, menu, manualSuggestions) {
  await idbPut('pos_menu_cache', { client_id: clientId, menu, manualSuggestions, updated_at: Date.now() })
}
export async function getCachedPosMenu(clientId) {
  return await idbGet('pos_menu_cache', clientId)
}

export async function cachePosTables(clientId, tables) {
  await idbPut('pos_tables_cache', { client_id: clientId, tables, updated_at: Date.now() })
}
export async function getCachedPosTables(clientId) {
  const rec = await idbGet('pos_tables_cache', clientId)
  return rec?.tables || null
}

export async function cachePosSettings(clientId, settings) {
  await idbPut('pos_settings_cache', { client_id: clientId, ...settings, updated_at: Date.now() })
}
export async function getCachedPosSettings(clientId) {
  return await idbGet('pos_settings_cache', clientId)
}

// ── POS: per-table order snapshot (last-known-good, warmed on every online open) ──

export async function cachePosOrderForTable(tableId, snapshot) {
  await idbPut('pos_order_cache', { table_id: tableId, ...snapshot, updated_at: Date.now() })
}
export async function getCachedPosOrderForTable(tableId) {
  return await idbGet('pos_order_cache', tableId)
}

// ── POS: order queue — one row per order touched while offline, upsert-merged ──

export async function enqueuePosOrder(orderId, patch) {
  const existing = await idbGet('pos_order_queue', orderId)
  const merged = {
    ...(existing || {}),
    ...patch,
    order_id: orderId,
    kot_sends: [...(existing?.kot_sends || []), ...(patch.kot_sends || [])],
    updated_at: Date.now(),
  }
  await idbPut('pos_order_queue', merged)
  return merged
}
export async function getPosOrderQueue() {
  return await idbGetAll('pos_order_queue')
}
export async function getQueuedPosOrder(orderId) {
  return await idbGet('pos_order_queue', orderId)
}
export async function dequeuePosOrder(orderId) {
  await idbDelete('pos_order_queue', orderId)
}
