import { useSettings } from '../../context/SettingsContext'
import { normalizePhone } from '../../utils/phone'
import { SUPPORT_EMAIL, SUPPORT_HOURS, supportPhone } from '../supportContact'

/**
 * The constant-is-the-floor merge (S673): `settings.contact_phone`/`contact_email` — the
 * per-client "Upgrade Contact Details" an admin can set in Settings → Contact — win wherever an
 * admin has actually set them, routing that client to their own consultant. Crest's own support
 * line (src/shared/supportContact.js) fills in everywhere else, so SubscriptionLock/PremiumGate/
 * Help stop falling through to "Contact your Crest consultant" with no way to actually do that.
 *
 * `website` has no platform-wide fallback — there is no Crest marketing site to point at here —
 * so it stays whatever the per-client field holds, possibly empty.
 */
export function useSupportContact() {
  const { settings } = useSettings()
  const phone = settings?.contact_phone || supportPhone() || ''
  const email = settings?.contact_email || SUPPORT_EMAIL
  const website = settings?.contact_website || ''
  const digits = normalizePhone(phone)

  return {
    phone,
    email,
    website,
    telHref: phone ? `tel:${phone.replace(/\s+/g, '')}` : null,
    whatsappHref: digits ? `https://wa.me/977${digits}` : null,
    hours: SUPPORT_HOURS,
  }
}
