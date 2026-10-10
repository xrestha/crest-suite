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

// optionCatalog (S758, Crest Customization): { groups, options, attachments } so a customizable dish
// can still be ordered offline. Absent on a copy cached before it existed — the till then treats
// every dish as plain until it is next online, which the server accepts.
export async function cachePosMenu(clientId, menu, manualSuggestions, optionCatalog = null) {
  await idbPut('pos_menu_cache', { client_id: clientId, menu, manualSuggestions, optionCatalog, updated_at: Date.now() })
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
// The snapshot is { orderId, orderNo, covers, items, itemsVersion }. Each item carries sent_to_kot
// AND sent_qty, and itemsVersion is the pos_orders.items_version the lines were read or saved at
// (S754) — an order reopened from here offline queues its edits against that version.

export async function cachePosOrderForTable(tableId, snapshot) {
  await idbPut('pos_order_cache', { table_id: tableId, ...snapshot, updated_at: Date.now() })
}
export async function getCachedPosOrderForTable(tableId) {
  return await idbGet('pos_order_cache', tableId)
}
// Dropped when the table's order closes (S754). The snapshot outlived its order: a table billed
// online and later opened offline reloaded the paid order's lines as if still open, and the next
// save replayed them onto a dead order id. One readwrite transaction (idbDelete), like every write here.
export async function clearCachedPosOrderForTable(tableId) {
  await idbDelete('pos_order_cache', tableId)
}

// ── POS: order queue — one row per order touched while offline, upsert-merged ──
//
// A queued entry's `items` carry sent_to_kot and sent_qty per line. `items_version` is the version of
// the order the FIRST offline edit was made against (S754): the replay passes it to
// save_pos_order_items as p_expected_version, so an order another tablet saved in the meantime is
// refused and surfaced as a conflict rather than overwritten. It is therefore kept from the first
// enqueue — every later offline edit to the same order builds on that same server state, and a later
// patch must not move the base forward to a version this device never saw. An order created offline
// has no version (the server row does not exist yet).
//
// S809 3f: an entry also carries `client_id`, the outlet it was taken for — the store is shared by every
// account that uses the device, and an upload leaves another outlet's entries alone (ORDER-FLOW-15).
// Each queued ticket (`kot_sends`) carries the pos_kot_log id it was minted with, so an upload that runs
// twice logs it once (ORDER-FLOW-7). Tickets whose order is already on the server and whose log insert
// has still to land wait in an entry of their own (posTicketsKey, `tickets_for`). `rev` counts the writes
// to an entry, so an upload can tell whether it changed while it ran (settlePosOrderUpload).

export async function enqueuePosOrder(orderId, patch) {
  // The read (get) and the write (put) MUST live in one readwrite transaction. IndexedDB
  // serialises overlapping readwrite transactions on the same store, so a second enqueue for the
  // same order can't start its get until this one commits — that's what makes the kot_sends append
  // safe. Splitting this into a readonly get + a separate readwrite put (the old shape) let two
  // concurrent callers both read the same pre-image and the second put clobber the first, silently
  // dropping a queued KOT/BOT send. That race is real here: saveOrder() fires logKotSend('KOT') and
  // logKotSend('BOT') un-awaited back-to-back, both routing through this function while offline.
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('pos_order_queue', 'readwrite')
    const store = tx.objectStore('pos_order_queue')
    const getReq = store.get(orderId)
    let merged
    getReq.onsuccess = () => {
      const existing = getReq.result
      const baseVersion = Number.isInteger(existing?.items_version) ? existing.items_version
        : Number.isInteger(patch.items_version) ? patch.items_version
        : undefined
      merged = {
        ...(existing || {}),
        ...patch,
        order_id: orderId,
        kot_sends: [...(existing?.kot_sends || []), ...(patch.kot_sends || [])],
        updated_at: Date.now(),
        rev: (Number(existing?.rev) || 0) + 1,
      }
      // S809 3f: the lines of the entry's FIRST queued save, kept like its version. The rest were built on
      // it, and it may be on the server already (a send whose answer was lost, then queued), so an upload
      // refused as stale can tell this till's own landed save from another device's change.
      if (!Array.isArray(existing?.items) && Array.isArray(patch.items)) merged.first_items = patch.items
      if (baseVersion === undefined) delete merged.items_version
      else merged.items_version = baseVersion
      store.put(merged)
    }
    getReq.onerror = e => reject(e.target.error)
    tx.oncomplete  = () => resolve(merged)
    tx.onerror     = e => reject(e.target.error)
    tx.onabort     = e => reject(e.target.error)
  })
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

/** Which queued ticket a key names: its id, or — for one queued before tickets carried an id — its
 *  contents. */
export const queuedSendKey = send => send?.id || JSON.stringify(send)

/** The key of the entry that holds an order's tickets only (S809 3f): tickets whose log insert has yet to
 *  land, for an order whose lines are already on the server. Never the order's own id: a till still on an
 *  older version uploads every entry as an order to save, and an entry with no lines under the order's
 *  id would save the order with none — every dish deleted. Under this key it finds no order (an invalid
 *  id) and leaves the entry alone; `items` is empty for the same till's floor, which reads it. */
export const posTicketsKey = orderId => `kot:${orderId}`

/** A ticket-only entry with `patch`'s tickets (and outlet, table name) added (pure). */
export function mergedTicketsEntry(existing, orderId, patch = {}) {
  return {
    ...(existing || {}),
    ...patch,
    order_id: posTicketsKey(orderId),
    tickets_for: orderId,
    items: [],
    kot_sends: [...(existing?.kot_sends || []), ...(patch.kot_sends || [])],
    updated_at: Date.now(),
    rev: (Number(existing?.rev) || 0) + 1,
  }
}

/** Queues tickets the till printed but could not log yet (S809 3f, S809.4) — `patch` is { client_id,
 *  table_name, kot_sends }. While the order's own entry still holds lines to upload they go with it, and
 *  are logged once those are saved (not for an entry the floor holds as a conflict: `ontoOrder` false);
 *  otherwise the order is on the server and they go to its ticket-only entry. Decided and written in ONE
 *  readwrite transaction, so an upload that settles the order meanwhile cannot leave them in an entry
 *  with no lines under the order's own id. */
export async function enqueuePosTickets(orderId, patch, { ontoOrder = true } = {}) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('pos_order_queue', 'readwrite')
    const store = tx.objectStore('pos_order_queue')
    const getReq = store.get(orderId)
    let merged
    getReq.onsuccess = () => {
      const order = getReq.result
      if (ontoOrder && Array.isArray(order?.items) && !order.tickets_for) {
        merged = {
          ...order,
          kot_sends: [...(order.kot_sends || []), ...(patch.kot_sends || [])],
          updated_at: Date.now(),
          rev: (Number(order.rev) || 0) + 1,
        }
        store.put(merged)
        return
      }
      const tReq = store.get(posTicketsKey(orderId))
      tReq.onsuccess = () => {
        merged = mergedTicketsEntry(tReq.result, orderId, patch)
        store.put(merged)
      }
      tReq.onerror = e => reject(e.target.error)
    }
    getReq.onerror = e => reject(e.target.error)
    tx.oncomplete  = () => resolve(merged)
    tx.onerror     = e => reject(e.target.error)
    tx.onabort     = e => reject(e.target.error)
  })
}

const sameItems = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null)

/** What is left of a queued entry after an upload (S809 3f) — the pure half of settlePosOrderUpload.
 *  `rev` and `items` are the entry as the upload read it; `lines` is true when those lines are now on the
 *  server at `version`; `doneKeys` are the tickets that need no further try (logged, or refused for good).
 *  Returns { entry, tickets }: what stays under the entry's key (null: delete it), and the tickets still
 *  to log that move to the order's ticket-only entry (posTicketsKey).
 *   - its lines landed and it is unchanged since it was read: tickets not yet logged move;
 *   - changed meanwhile (a newer offline edit, or a ticket, of the same order): the newer edit stays and
 *     now builds on the lines that landed — the order exists, at `version`. Only tickets were added
 *     when its lines are still the ones that landed, so those move too. */
export function settledEntry(entry, { rev, items, lines = false, version = null, doneKeys = [] } = {}) {
  if (!entry) return { entry: null, tickets: [] }
  const done = new Set(doneKeys)
  const logged = new Set(entry.logged_ids || [])
  const left = (entry.kot_sends || []).filter(s => !logged.has(queuedSendKey(s)) && !done.has(queuedSendKey(s)))
  if (!lines) {
    // A ticket-only entry (or one from before them, with no lines): gone once nothing is left to log.
    const keep = { ...entry, kot_sends: left }
    const holdsLines = Array.isArray(entry.items) && !entry.tickets_for
    return { entry: holdsLines || left.length > 0 ? keep : null, tickets: [] }
  }
  if (entry.rev === rev || sameItems(entry.items, items)) return { entry: null, tickets: left }
  const next = { ...entry, kot_sends: left, created_offline: false, first_items: items }
  if (Number.isInteger(version)) next.items_version = version
  else delete next.items_version
  return { entry: next, tickets: [] }
}

/** Applies settledEntry in ONE readwrite transaction (the S440 rule above), so an edit queued while the
 *  upload ran is never deleted with it, and tickets still to log move to the order's ticket-only entry
 *  in the same transaction. `key` is the entry's key; `outcome.orderId` the order it belongs to.
 *  Resolves with what stays under `key` (null: gone). */
export async function settlePosOrderUpload(key, outcome) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('pos_order_queue', 'readwrite')
    const store = tx.objectStore('pos_order_queue')
    const getReq = store.get(key)
    let kept = null
    getReq.onsuccess = () => {
      const entry = getReq.result
      const { entry: next, tickets } = settledEntry(entry, outcome)
      kept = next
      if (next) store.put(next)
      else if (entry) store.delete(key)
      if (tickets.length === 0 || !outcome?.orderId) return
      const tReq = store.get(posTicketsKey(outcome.orderId))
      tReq.onsuccess = () => store.put(mergedTicketsEntry(tReq.result, outcome.orderId, {
        client_id: entry.client_id, table_name: entry.table_name, kot_sends: tickets,
      }))
      tReq.onerror = e => reject(e.target.error)
    }
    getReq.onerror = e => reject(e.target.error)
    tx.oncomplete  = () => resolve(kept)
    tx.onerror     = e => reject(e.target.error)
    tx.onabort     = e => reject(e.target.error)
  })
}

/** Marks queued tickets as logged without removing them (S809 3f, ORDER-FLOW-8): an entry the upload
 *  could not apply stays on the floor as a conflict, and says which of its lines already printed. The
 *  marks are a list on the entry (`logged_ids`), never a field on a ticket: a till on an older version
 *  inserts its queued tickets as they are, and an unknown column would refuse the insert. */
export async function markQueuedSendsLogged(orderId, keys) {
  const done = new Set(keys || [])
  if (done.size === 0) return
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('pos_order_queue', 'readwrite')
    const store = tx.objectStore('pos_order_queue')
    const getReq = store.get(orderId)
    getReq.onsuccess = () => {
      const entry = getReq.result
      if (!entry) return
      store.put({ ...entry, logged_ids: [...new Set([...(entry.logged_ids || []), ...done])] })
    }
    getReq.onerror = e => reject(e.target.error)
    tx.oncomplete  = () => resolve()
    tx.onerror     = e => reject(e.target.error)
    tx.onabort     = e => reject(e.target.error)
  })
}
