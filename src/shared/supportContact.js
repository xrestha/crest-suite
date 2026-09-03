// The one definition of Crest's own support contact — phone, hours, and the email address — used
// on every surface a client needs to reach a human when the app itself can't help: the login
// footer, the crash page, the two offline banners, the Help page's Support tab, and the fallback
// inside SubscriptionLock/PremiumGate (S673).
//
// SUPPORT_EMAIL is not a second copy of COMPANY.supportEmail (src/legal/index.js) — it re-exports
// it. That file's own comment explains why: three copies of a contact fact is how two of them end
// up disagreeing, and it is what legalCompany.test.js already guards on the legal side.
//
// SUPPORT_PHONE ships as an unfilled draft marker, in the SAME [[NEEDS VALUE: X]] convention
// isDraft() (src/legal/index.js) uses for the legal documents — supportPhone() returns null while
// it stands, so every consumer HIDES the phone entirely rather than ever rendering the literal
// placeholder text to a client. Fill in the digits below and every surface picks it up with no
// other change.
import { COMPANY } from '../legal'
import { normalizePhone } from '../utils/phone'

export const SUPPORT_EMAIL = COMPANY.supportEmail

export const SUPPORT_HOURS = 'Sun–Fri 9:00–18:00 NPT · outlet-down issues any time'

const SUPPORT_PHONE_RAW = '[[NEEDS VALUE: SUPPORT_PHONE]]'

const NEEDS_VALUE_RE = /^\[\[NEEDS VALUE:/

/** The support line's digits, or null while the placeholder above stands unfilled. */
export function supportPhone() {
  return NEEDS_VALUE_RE.test(SUPPORT_PHONE_RAW) ? null : SUPPORT_PHONE_RAW
}

/** true while the phone number has not been supplied — mirrors legal/index.js's isDraft(). */
export function supportPhoneMissing() {
  return supportPhone() === null
}

/**
 * A wa.me link for any phone string, reusing the same digit normalisation
 * (src/utils/phone.js) AdminClients.js already hand-rolls for a client's own WhatsApp link.
 * Exported as a pure function (rather than folded into supportWhatsappHref below) so it is
 * testable without needing the live SUPPORT_PHONE_RAW to actually be filled in.
 */
export function whatsappHrefFor(rawPhone) {
  const digits = normalizePhone(rawPhone)
  return digits ? `https://wa.me/977${digits}` : null
}

/** tel: link for the support line, or null if the phone hasn't been supplied. */
export function supportTelHref() {
  const phone = supportPhone()
  return phone ? `tel:${phone.replace(/\s+/g, '')}` : null
}

/** wa.me link for the support line, or null if the phone hasn't been supplied. */
export function supportWhatsappHref() {
  const phone = supportPhone()
  return phone ? whatsappHrefFor(phone) : null
}
