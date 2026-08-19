// EMVCo merchant-presented QR helpers (NepalPay QR / FonePay / eSewa all follow this standard).
// A payment QR is a TLV string: [2-digit tag][2-digit length][value]..., ending with tag 63 =
// CRC-16/CCITT-FALSE over everything up to and including the literal "6304".
//
// A merchant's STATIC standee QR (tag 01 = "11", no amount) can be turned into a per-bill
// DYNAMIC QR (tag 01 = "12", tag 54 = exact amount) with pure string manipulation — no
// provider API involved. The customer's banking app then shows the amount pre-filled and locked.

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) — the checksum EMVCo QRs use. */
export function crc16(str) {
  let crc = 0xFFFF
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

/** Parse an EMVCo TLV string into [{ id, value }] — null if structurally malformed. */
export function parseEmvQr(str) {
  const tags = []
  let i = 0
  while (i < str.length) {
    if (i + 4 > str.length) return null
    const id = str.slice(i, i + 2)
    const len = parseInt(str.slice(i + 2, i + 4), 10)
    if (!/^\d{2}$/.test(id) || isNaN(len) || i + 4 + len > str.length) return null
    tags.push({ id, value: str.slice(i + 4, i + 4 + len) })
    i += 4 + len
  }
  return tags.length > 0 ? tags : null
}

function serialize(tags) {
  return tags.map(t => t.id + String(t.value.length).padStart(2, '0') + t.value).join('')
}

/**
 * Best-effort network identification from the merchant-account-information tags (02–51), whose
 * values carry the scheme's GUID (e.g. "fonepay.com", "np.com.esewa", NCHL/NepalPay identifiers).
 * Informational only — phrased as "looks like" in the UI, never used to accept or reject a
 * payload. The reason it exists: eSewa's app refuses NepalPay/NCHL QRs ("scan Fonepay Business
 * QR") while bank apps accept both (verified live 2026-07-03), so which network a client's stored
 * QR belongs to decides who can actually pay at the till — and two valid payloads are otherwise
 * indistinguishable in the admin UI. Scan order matters: 'npi' is the loosest match, so the
 * specific GUIDs go first.
 */
function detectQrNetwork(tags) {
  const haystack = tags
    .filter(t => { const n = parseInt(t.id, 10); return n >= 2 && n <= 51 })
    .map(t => t.value.toLowerCase())
    .join('|')
  if (haystack.includes('fonepay')) return 'FonePay'
  if (haystack.includes('esewa')) return 'eSewa'
  if (haystack.includes('khalti')) return 'Khalti'
  if (haystack.includes('nchl') || haystack.includes('nepalpay') || haystack.includes('npi')) return 'NepalPay/NCHL'
  return null
}

/**
 * Validate a pasted merchant QR payload. Returns { ok, merchantName, network, error }.
 * Checks TLV structure, the CRC checksum, and that it looks like a payment QR
 * (payload format indicator + merchant name present). `network` is best-effort
 * (see detectQrNetwork) and may be null.
 */
export function validateEmvQr(str) {
  const s = (str || '').trim()
  if (!s) return { ok: false, error: 'Empty' }
  // A personal "receive money" QR (eSewa/Khalti P2P) decodes to a JSON blob, not EMVCo TLV.
  // Name the real problem instead of the generic parse error — an operator who pastes one is
  // holding the wrong KIND of QR, not a mangled copy of the right one: only that wallet's own app
  // can scan it, no amount can be locked into it, and it pays a personal wallet rather than the
  // business. (Found live 2026-08-19 pasting a personal eSewa QR during the Plan A rail test.)
  if (s.startsWith('{')) {
    return { ok: false, error: 'This is a personal wallet QR (an eSewa/Khalti "receive money" code), not a merchant payment QR — bank apps can\'t scan it and no bill amount can be locked in. Paste the business\'s FonePay Business QR (or EMVCo merchant QR) instead.' }
  }
  const tags = parseEmvQr(s)
  if (!tags) return { ok: false, error: 'Not a valid EMVCo QR payload — check for missing characters.' }
  const crcTag = tags.find(t => t.id === '63')
  if (!crcTag) return { ok: false, error: 'Missing checksum (tag 63) — this is not a complete payment QR.' }
  const body = s.slice(0, s.lastIndexOf('6304') + 4)
  if (crc16(body) !== crcTag.value.toUpperCase()) {
    return { ok: false, error: 'Checksum mismatch — the payload was altered or copied incompletely.' }
  }
  // Tag 00 (payload format indicator) is mandatory per the EMVCo spec, but real-world NepalPay
  // merchant QRs have been seen without it — CRC computed over the tag-00-less body and accepted
  // by banking apps. Since the CRC already proved the payload is exactly what the bank issued,
  // don't reject it for the bank's own spec deviation.
  const merchantName = tags.find(t => t.id === '59')?.value || ''
  if (!merchantName) return { ok: false, error: 'No merchant name (tag 59) found in this QR.' }
  return { ok: true, merchantName, network: detectQrNetwork(tags) }
}

/**
 * Build a per-bill dynamic QR payload from the merchant's static payload:
 * tag 01 → "12" (one-time/dynamic), tag 54 → exact amount, CRC recomputed. An optional
 * `reference` is embedded as tag 62 subfield 05 (EMVCo's "Additional Data — Reference
 * Label") so a provider webhook that echoes it back can be matched to a POS order — see
 * supabase/functions/pos-payment-webhook. Returns the new payload string, or null if the
 * base is invalid.
 */
export function buildDynamicQr(baseStr, amount, reference) {
  const check = validateEmvQr(baseStr)
  if (!check.ok) return null
  // Tag 62 is left in place (not stripped like 54/63) — the merchant's static QR may already
  // carry its own subfields there (e.g. Bill Number, Terminal Label) that a banking app expects
  // to still see. Only subfield 05 (Reference Label) is ours to set, merged in below rather
  // than discarding whatever else was already in tag 62.
  let tags = parseEmvQr(baseStr.trim()).filter(t => t.id !== '63' && t.id !== '54')
  const poi = tags.find(t => t.id === '01')
  if (poi) poi.value = '12'
  else tags.splice(1, 0, { id: '01', value: '12' })
  // Insert amount (tag 54) keeping tags in ascending numeric order, as the spec prefers
  const amtTag = { id: '54', value: Math.round(amount).toFixed(2) }
  const idx54 = tags.findIndex(t => parseInt(t.id, 10) > 54)
  if (idx54 === -1) tags.push(amtTag)
  else tags.splice(idx54, 0, amtTag)
  if (reference) {
    const existing62 = tags.find(t => t.id === '62')
    const subFields = existing62 ? (parseEmvQr(existing62.value) || []) : []
    const refSub = subFields.find(s => s.id === '05')
    if (refSub) refSub.value = String(reference).slice(0, 25)
    else subFields.push({ id: '05', value: String(reference).slice(0, 25) })
    if (existing62) {
      existing62.value = serialize(subFields)
    } else {
      const refTag = { id: '62', value: serialize(subFields) }
      const idx62 = tags.findIndex(t => parseInt(t.id, 10) > 62)
      if (idx62 === -1) tags.push(refTag)
      else tags.splice(idx62, 0, refTag)
    }
  }
  const body = serialize(tags) + '6304'
  return body + crc16(body)
}
