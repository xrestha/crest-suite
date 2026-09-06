import { useSupportContact } from '../shared/hooks/useSupportContact'
import { ANYDESK_DOWNLOAD_URL } from '../shared/supportContact'

const linkStyle = { color: 'var(--theme-accent-ink)', textDecoration: 'none' }

/**
 * Crest's support contact, rendered one of three ways so five call sites don't each invent their
 * own row (S673): `inline` (one text line, · separated — the login footer, the two offline
 * banners), `buttons` (Call/WhatsApp/Viber/Email as `btn btn-ghost` — the crash page,
 * SubscriptionLock, the module/suite cards), `block` (labelled rows plus the hours line and the
 * emergency promise — the Help page's Support tab).
 *
 * Channels (S683): a mobile ("Call"), an office landline ("Call office"), WhatsApp and Viber chat
 * links, and email. Every one renders only when it resolves to something — a landline-only line
 * shows no chat buttons, and a blank slot is simply absent. Social handles are deliberately not
 * here: a crashed till does not need a TikTok link (decided 2026-09-06).
 *
 * `contact` is optional. Every caller with client `settings` in scope (anything inside
 * SettingsProvider) can omit it and gets `useSupportContact()`'s merge. AppErrorBoundary at APP
 * scope passes nothing too — it may render outside every provider, and the hook degrades to the
 * platform constants on its own since `useSettings()`'s default context is `{}`.
 */
export default function SupportContactLine({ variant = 'inline', contact, className = '', leadSeparator = false }) {
  const fallback = useSupportContact()
  const c = contact || fallback
  const { phone, mobile, landline, email, website, anydesk, telHref, landlineHref, whatsappHref, viberHref, hours, emergency } = c
  const cls = className ? `no-print ${className}` : 'no-print'
  // When the primary call number IS the landline (no mobile), one Call button says it all.
  const showLandline = !!(landline && landlineHref && mobile)

  if (variant === 'buttons') {
    if (!telHref && !whatsappHref && !viberHref && !email) return null
    return (
      <div className={cls} style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
        {telHref && <a className="btn btn-ghost" href={telHref}>Call {phone}</a>}
        {showLandline && <a className="btn btn-ghost" href={landlineHref}>Call office {landline}</a>}
        {whatsappHref && <a className="btn btn-ghost" href={whatsappHref} target="_blank" rel="noopener noreferrer">WhatsApp</a>}
        {viberHref && <a className="btn btn-ghost" href={viberHref}>Viber</a>}
        {email && <a className="btn btn-ghost" href={`mailto:${email}`}>Email us</a>}
      </div>
    )
  }

  if (variant === 'block') {
    return (
      <div className={cls} style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: 'var(--theme-text2)' }}>
        {telHref && (
          <div>
            📞 <a href={telHref} style={linkStyle}>{phone}</a>
            {showLandline && <>{' '}·{' '}<a href={landlineHref} style={linkStyle}>Office {landline}</a></>}
          </div>
        )}
        {(whatsappHref || viberHref) && (
          <div>
            💬{' '}
            {whatsappHref && <a href={whatsappHref} target="_blank" rel="noopener noreferrer" style={linkStyle}>WhatsApp</a>}
            {whatsappHref && viberHref && <>{' '}·{' '}</>}
            {viberHref && <a href={viberHref} style={linkStyle}>Viber</a>}
          </div>
        )}
        {email && <div>✉ <a href={`mailto:${email}`} style={linkStyle}>{email}</a></div>}
        {website && (
          <div>🌐 <a href={website.startsWith('http') ? website : `https://${website}`} target="_blank" rel="noopener noreferrer" style={linkStyle}>{website}</a></div>
        )}
        {anydesk && (
          // Remote help, Help → Support only (S683). Deliberately NOT an `anydesk:` deep link —
          // that would open a session onto Crest's machine. The client installs, sends US their
          // address, and uses Crest's alias to verify the incoming request before accepting.
          <div>
            🖥 Remote help:{' '}
            <a href={ANYDESK_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" style={linkStyle}>install AnyDesk</a>, send us the
            9-digit address it shows, and accept only a request from{' '}
            <strong style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{anydesk}</strong>
          </div>
        )}
        <div style={{ color: 'var(--theme-text3)', fontSize: 12 }}>
          {hours}
          {emergency && (
            <> · If your outlet can't take orders or bill guests, {emergency.label} <strong style={{ fontWeight: 600 }}>{emergency.value}</strong> is answered any time</>
          )}
        </div>
      </div>
    )
  }

  // inline — one text line, · separated, for tight spaces. Colour is deliberately `inherit`: the
  // login footer and the two offline banners each set their own text colour on the container, and
  // this variant is meant to read as part of that sentence, not as a differently-coloured intrusion.
  const inl = { color: 'inherit', textDecoration: 'underline' }
  const parts = []
  if (telHref) parts.push(<a key="tel" href={telHref} style={inl}>{phone}</a>)
  if (whatsappHref) parts.push(<a key="wa" href={whatsappHref} target="_blank" rel="noopener noreferrer" style={inl}>WhatsApp</a>)
  if (viberHref) parts.push(<a key="vb" href={viberHref} style={inl}>Viber</a>)
  if (email) parts.push(<a key="email" href={`mailto:${email}`} style={inl}>{email}</a>)
  if (!parts.length) return null

  return (
    <span className={cls}>
      {leadSeparator && <span aria-hidden="true"> · </span>}
      {parts.reduce((acc, el, i) => (i === 0 ? [el] : [...acc, <span key={`sep${i}`} aria-hidden="true"> · </span>, el]), [])}
    </span>
  )
}
