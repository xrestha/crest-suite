import { useSupportContact } from '../shared/hooks/useSupportContact'

/**
 * Crest's support contact, rendered one of three ways so five call sites don't each invent their
 * own row (S673): `inline` (one text line, · separated — the login footer, the two offline
 * banners), `buttons` (Call/WhatsApp/Email as `btn btn-ghost` — the crash page, SubscriptionLock,
 * PremiumGate), `block` (labelled rows plus the hours line — the Help page's Support tab).
 *
 * `contact` is optional. Every caller with client `settings` in scope (anything inside
 * SettingsProvider) can omit it and gets `useSupportContact()`'s constant-is-the-floor merge.
 * AppErrorBoundary at APP scope passes nothing too — it may render outside every provider, and the
 * hook degrades to the platform constant on its own since `useSettings()`'s default context is `{}`.
 */
export default function SupportContactLine({ variant = 'inline', contact, className = '', leadSeparator = false }) {
  const fallback = useSupportContact()
  const c = contact || fallback
  const { phone, email, website, telHref, whatsappHref, hours } = c
  const cls = className ? `no-print ${className}` : 'no-print'

  if (variant === 'buttons') {
    if (!telHref && !whatsappHref && !email) return null
    return (
      <div className={cls} style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
        {telHref && <a className="btn btn-ghost" href={telHref}>Call {phone}</a>}
        {whatsappHref && <a className="btn btn-ghost" href={whatsappHref} target="_blank" rel="noopener noreferrer">WhatsApp</a>}
        {email && <a className="btn btn-ghost" href={`mailto:${email}`}>Email us</a>}
      </div>
    )
  }

  if (variant === 'block') {
    return (
      <div className={cls} style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: 'var(--theme-text2)' }}>
        {telHref && (
          <div>
            📞 <a href={telHref} style={{ color: 'var(--theme-accent-ink)', textDecoration: 'none' }}>{phone}</a>
            {whatsappHref && <>
              {' '}·{' '}
              <a href={whatsappHref} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--theme-accent-ink)', textDecoration: 'none' }}>WhatsApp</a>
            </>}
          </div>
        )}
        {email && <div>✉ <a href={`mailto:${email}`} style={{ color: 'var(--theme-accent-ink)', textDecoration: 'none' }}>{email}</a></div>}
        {website && (
          <div>🌐 <a href={website.startsWith('http') ? website : `https://${website}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--theme-accent-ink)', textDecoration: 'none' }}>{website}</a></div>
        )}
        <div style={{ color: 'var(--theme-text3)', fontSize: 12 }}>{hours}</div>
      </div>
    )
  }

  // inline — one text line, · separated, for tight spaces. Colour is deliberately `inherit`: the
  // login footer and the two offline banners each set their own text colour on the container, and
  // this variant is meant to read as part of that sentence, not as a differently-coloured intrusion.
  const parts = []
  if (telHref) parts.push(<a key="tel" href={telHref} style={{ color: 'inherit', textDecoration: 'underline' }}>{phone}</a>)
  if (whatsappHref) parts.push(<a key="wa" href={whatsappHref} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>WhatsApp</a>)
  if (email) parts.push(<a key="email" href={`mailto:${email}`} style={{ color: 'inherit', textDecoration: 'underline' }}>{email}</a>)
  if (!parts.length) return null

  return (
    <span className={cls}>
      {leadSeparator && <span aria-hidden="true"> · </span>}
      {parts.reduce((acc, el, i) => (i === 0 ? [el] : [...acc, <span key={`sep${i}`} aria-hidden="true"> · </span>, el]), [])}
    </span>
  )
}
