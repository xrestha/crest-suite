// UUID v4 generator that prefers the native crypto.randomUUID (Chrome 92+ / Safari 15.4+ /
// Firefox 95+) but falls back to a getRandomValues-based v4 for older POS WebViews where
// randomUUID is missing. This matters most on the offline order-taking path: the returned value
// becomes a permanent pos_orders.id (a uuid column) and a missing crypto.randomUUID would otherwise
// throw mid-save, stranding the order and hanging the save button. getRandomValues has near-
// universal support (and is already used elsewhere in this app), so the fallback is always available
// in the secure contexts the app runs in.
export function randomUUID() {
  const c = (typeof crypto !== 'undefined' && crypto) ||
            (typeof window !== 'undefined' && window.crypto) || null
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('No secure random source available for UUID generation')
  }
  const bytes = new Uint8Array(16)
  c.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40  // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80  // variant 10xx
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
}
