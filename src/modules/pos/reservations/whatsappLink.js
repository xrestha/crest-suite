import { normalizePhone } from '../../../utils/phone'

// The Phase-1 confirmation channel: a WhatsApp deep link with the message prefilled, opened from
// the host's own phone or the till. Free, no sender-ID registration, and it is how Nepali venues
// already talk to their guests. Paid SMS (Sparrow/Aakash) is a later, opt-in phase — see the
// S677 changelog entry.
//
// These are NAVIGATIONS, not fetches: nothing here touches connect-src.

/** `{name}`-style placeholders → values; an unknown or missing key renders as empty text. */
export function fillTemplate(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) =>
    vars && vars[key] != null ? String(vars[key]) : ''
  )
}

/**
 * wa.me link for a Nepali number. Canonicalises the way pos_customers.phone_canonical does
 * (strip non-digits, a leading 977, leading zeros) and prefixes 977 — the same shape
 * AdminClients.js already uses for a client's contact phone. No usable number → the generic
 * share form, which lets the sender pick the contact themselves.
 */
export function waLink(phone, text) {
  const canonical = normalizePhone(phone)
  const number = canonical ? `977${canonical}` : ''
  const query = text ? `?text=${encodeURIComponent(text)}` : ''
  return `https://wa.me/${number}${query}`
}

/** tel: link in international form, so it dials correctly from any handset. */
export function telLink(phone) {
  const canonical = normalizePhone(phone)
  return canonical ? `tel:+977${canonical}` : `tel:${String(phone || '').replace(/[^\d+]/g, '')}`
}

export function openWhatsApp(phone, text) {
  window.open(waLink(phone, text), '_blank', 'noopener,noreferrer')
}
