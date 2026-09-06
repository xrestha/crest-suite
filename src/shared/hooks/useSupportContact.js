import { useSettings } from '../../context/SettingsContext'
import { resolveSupportContact } from '../supportContact'

/**
 * The constant-is-the-floor merge (S673), now three layers deep (S683): a client's own
 * consultant (`settings.contact_phone`/`contact_email`/`contact_website`, the lower section of
 * Settings → Support) wins wherever an admin has set it; the admin-edited platform row
 * (`settings.support_contact` on the client_id-NULL row, the upper section) fills in next; the
 * constants in src/shared/supportContact.js are the floor under both. The merge itself is
 * resolveSupportContact(), a pure function, so precedence is asserted in its test rather than
 * re-derived per surface.
 *
 * `website` has no constant floor — there is no Crest marketing site to point at — so it is
 * whatever the consultant or platform field holds, possibly empty.
 */
export function useSupportContact() {
  const { settings, platformSupport } = useSettings()
  // Only a CLIENT's row carries a consultant. Signed out (and admin-with-no-client) `settings` is
  // the platform row itself, whose contact_* columns are legacy platform values — already folded
  // into `platformSupport` by platformSupportFromRow(). Passing that row as `client` made the
  // /login footer show them over the Support tab (S683).
  const client = settings?.client_id ? settings : null
  return resolveSupportContact({ platform: platformSupport, client })
}
