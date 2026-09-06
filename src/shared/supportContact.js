// The one definition of Crest's own support contact — phone, hours, and the email address — used
// on every surface a client needs to reach a human when the app itself can't help: the login
// footer, the crash page, the two offline banners, the Help page's Support tab, and the fallback
// inside SubscriptionLock/PremiumGate (S673).
//
// SUPPORT_EMAIL is not a second copy of COMPANY.supportEmail (src/legal/index.js) — it re-exports
// it. That file's own comment explains why: three copies of a contact fact is how two of them end
// up disagreeing, and it is what legalCompany.test.js already guards on the legal side.
//
// Since S683 the LIVE contact is edited by the admin in Settings → Support and stored as
// `settings.support_contact` (jsonb) on the platform row — the `client_id IS NULL` settings row,
// which every reader including a signed-out visitor can already SELECT and only an admin can
// UPDATE. The constants below are the FLOOR: what renders before the row has been filled, or if
// the read fails. resolveSupportContact() is the one merge — per-client consultant fields win,
// then the platform row, then these constants — and it is a pure function so the precedence can
// be asserted in supportContact.test.js without a database.
import { COMPANY } from '../legal'
import { normalizePhone } from '../utils/phone'

export const SUPPORT_EMAIL = COMPANY.supportEmail

/** General hours only — the emergency promise is a separate, switchable fact (see below). */
export const SUPPORT_HOURS = 'Sun–Fri 9:00–18:00 NPT'

// Filled 2026-09-06 (S683): Bloom Hospitality has no landline yet, so this is the founder's own
// mobile, offered for support "for now". It is the floor under the admin-editable value, not the
// value itself — once Settings → Support holds a number, this is never read. Spaces are display
// only: supportTelHref() strips them and normalizePhone() reduces the string to its digits.
const SUPPORT_PHONE_RAW = '+977 971 459 8771'

const NEEDS_VALUE_RE = /^\[\[NEEDS VALUE:/

/** The floor phone's digits, or null while a [[NEEDS VALUE]] marker stands in its place. */
export function supportPhone() {
  return NEEDS_VALUE_RE.test(SUPPORT_PHONE_RAW) ? null : SUPPORT_PHONE_RAW
}

/** true while the floor phone has not been supplied — mirrors legal/index.js's isDraft(). */
export function supportPhoneMissing() {
  return supportPhone() === null
}

/**
 * A wa.me link for any phone string, reusing the same digit normalisation
 * (src/utils/phone.js) AdminClients.js already hand-rolls for a client's own WhatsApp link.
 * Exported as a pure function so it is testable independent of the live value.
 */
export function whatsappHrefFor(rawPhone) {
  const digits = normalizePhone(rawPhone)
  return digits ? `https://wa.me/977${digits}` : null
}

/**
 * A Viber chat deep link — `viber://chat?number=<country code + number>`, no `+`, no leading
 * zero, no spaces (Viber's own deep-link spec). Viber is the household default in Nepal for free
 * calls, with 10M+ users beside WhatsApp, so a support line that offers one should offer both.
 * Same normalisation as WhatsApp so a number typed either way yields the same link.
 */
export function viberHrefFor(rawPhone) {
  const digits = normalizePhone(rawPhone)
  return digits ? `viber://chat?number=977${digits}` : null
}

/** tel: link for any phone string — spaces and dashes removed, a leading + kept. */
export function telHrefFor(rawPhone) {
  const s = String(rawPhone || '').trim()
  return s ? `tel:${s.replace(/[\s-]+/g, '')}` : null
}

/** tel: link for the floor phone, or null if it hasn't been supplied. */
export function supportTelHref() {
  const phone = supportPhone()
  return phone ? telHrefFor(phone) : null
}

/** wa.me link for the floor phone, or null if it hasn't been supplied. */
export function supportWhatsappHref() {
  const phone = supportPhone()
  return phone ? whatsappHrefFor(phone) : null
}

// ── The admin-editable shape (settings.support_contact on the platform row) ──────────────────
//
// Fixed channel slots, deliberately not a list: the crash page and the offline banners need ONE
// number to put on a button, and a fixed shape keeps "which one" a property of the data rather
// than a per-render guess. `whatsapp`/`viber` are separate slots because the number people chat
// on is often not the number they answer calls on; left blank they fall back to `mobile` (never to
// the landline, which cannot take either). `emergency_channel` names which slot is answered
// outside `hours` — the promise renders only while `emergency_enabled` is on, so "outlet-down
// issues any time" is a switch the business owns, not a sentence the code asserts.
export const SUPPORT_CHANNEL_KEYS = ['mobile', 'landline', 'whatsapp', 'viber', 'email', 'website', 'anydesk']

// AnyDesk is how remote help actually happens on a Nepali till: the client installs it, reads the
// 9-digit address it shows to support over WhatsApp/Viber, and support connects IN. Crest's own
// address is published for the OTHER direction of trust — AnyDesk shows the requester's ID/alias
// in the client's accept dialog, so a client who knows Crest's alias can refuse anything else.
// It is never rendered as a deep link: `anydesk:<id>` would open a session controlling CREST's
// machine, which is the wrong way round.
export const ANYDESK_DOWNLOAD_URL = 'https://anydesk.com/download'

export const EMERGENCY_CHANNELS = [
  { key: 'mobile',   label: 'Mobile' },
  { key: 'landline', label: 'Landline' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'viber',    label: 'Viber' },
]

export const DEFAULT_SUPPORT_CONTACT = {
  mobile: '', landline: '', whatsapp: '', viber: '', email: '', website: '',
  anydesk: '',   // Crest's AnyDesk ID or alias (e.g. 123 456 789 or crest@ad) — platform only
  hours: '',
  // Mirrors the promise the product already made in the S673 hours string, so filling the row
  // never silently withdraws it; the admin can switch it off in Settings → Support.
  emergency_enabled: true,
  emergency_channel: 'mobile',
  // Off = publish NO number (S684). Until this existed a blank Mobile fell through to the floor
  // constant, so the founder's personal phone could only be taken off the eight support surfaces
  // by another number or a deploy. "No phone line" is a state the business can now choose.
  phone_enabled: true,
}

const clean = v => String(v ?? '').trim()

/**
 * The platform row's support contact, from the row itself. `support_contact` wins; when it has
 * never been saved, the row's legacy `contact_phone`/`contact_email`/`contact_website` stand in —
 * those were written by the old per-client Contact tab whenever an admin used it with NO client
 * selected, so on the client_id-NULL row they were always platform values wearing a client's
 * column names. Found live on /login (S683): the footer showed that legacy pair while the Support
 * tab's values lost to it, because the hook mistook them for a consultant override. Seeding from
 * them here means the Support form opens showing what clients currently see, and the first Save
 * retires them.
 */
export function platformSupportFromRow(row) {
  if (!row) return null
  if (row.support_contact && typeof row.support_contact === 'object') return row.support_contact
  const mobile = clean(row.contact_phone), email = clean(row.contact_email), website = clean(row.contact_website)
  if (!mobile && !email && !website) return null
  return { ...DEFAULT_SUPPORT_CONTACT, mobile, email, website }
}

/**
 * The one merge. `client` is a client's own settings row (its `contact_phone`/`contact_email`/
 * `contact_website` are the per-client consultant override an admin sets in Settings → Support,
 * lower section); `platform` is the platform row's `support_contact`. Either may be null.
 *
 * Precedence per field: client consultant → platform row → constant floor. A consultant phone
 * replaces the WHOLE phone family (call, WhatsApp, Viber all derive from it, the landline is
 * dropped) — the point of the override is to route that client to one person, not to mix that
 * person's mobile with Crest's office line.
 */
export function resolveSupportContact({ platform, client } = {}) {
  const p = { ...DEFAULT_SUPPORT_CONTACT, ...(platform || {}) }
  const consultantPhone = clean(client?.contact_phone)

  let mobile, landline, whatsapp, viber
  if (consultantPhone) {
    mobile = consultantPhone; landline = ''
    whatsapp = consultantPhone; viber = consultantPhone
  } else if (p.phone_enabled === false) {
    // No phone line: the floor mobile is NOT read — it is a seed for the first fill, not a line
    // Crest has promised to answer — and a chat number survives only where it was given
    // explicitly, since it can no longer fall back to a mobile that is not published.
    mobile = ''; landline = ''
    whatsapp = clean(p.whatsapp); viber = clean(p.viber)
  } else {
    mobile = clean(p.mobile) || supportPhone() || ''
    landline = clean(p.landline)
    whatsapp = clean(p.whatsapp) || mobile
    viber = clean(p.viber) || mobile
  }

  const email = clean(client?.contact_email) || clean(p.email) || SUPPORT_EMAIL
  const website = clean(client?.contact_website) || clean(p.website)
  const hours = clean(p.hours) || SUPPORT_HOURS
  // Remote help is Crest's, not a consultant's: a consultant override leaves it in place.
  const anydesk = clean(p.anydesk)

  // The primary call number is the mobile when there is one, else the landline. `phone` keeps
  // its S673 meaning (what the inline variant prints) for the existing call sites.
  const phone = mobile || landline

  const emergencyKey = p.emergency_enabled ? p.emergency_channel : null
  const emergencyValue = emergencyKey ? { mobile, landline, whatsapp, viber }[emergencyKey] : ''
  const emergencyLabel = EMERGENCY_CHANNELS.find(c => c.key === emergencyKey)?.label || ''
  const emergency = emergencyKey && emergencyValue
    ? { channel: emergencyKey, label: emergencyLabel, value: emergencyValue }
    : null

  return {
    phone, mobile, landline, whatsapp, viber, email, website, anydesk, hours, emergency,
    telHref: telHrefFor(phone),
    landlineHref: telHrefFor(landline),
    whatsappHref: whatsappHrefFor(whatsapp),
    viberHref: viberHrefFor(viber),
  }
}
