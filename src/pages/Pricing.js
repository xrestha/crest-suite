import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Hexagon, Check, Mail, Calculator, Users, CalendarDays } from 'lucide-react'
import { useSettings } from '../context/SettingsContext'
import { MODULE_COLORS, MODULE_INK, moduleTint, TRIAL_DAYS, IMS_TIERS, HR_PRICING, POS_PRICING, SUITE_ADDON } from '../data/pricingPlans'
// The registered entity, from the one place it is pinned against the published legal documents.
import { COMPANY } from '../legal'

// ── Change this to the contact email when ready ──────────────────────────────
const CONTACT_EMAIL = 'hello@cresthospitality.com'

const GOLD   = 'var(--theme-accent)'
const GREEN  = 'var(--theme-green-text)'   // text use only — see ThemeContext's PRESETS note
const BG     = 'var(--theme-bg)'
const CARD   = 'var(--theme-card)'
const BORDER = 'var(--theme-border)'

const FAQS = [
  {
    q: `Is the ${TRIAL_DAYS}-day trial really free?`,
    a: `Yes — the IMS Starter plan is completely free for the first ${TRIAL_DAYS} days with no credit card and no hidden fees. After that it continues at its listed monthly rate, or you can upgrade to Growth or Pro at any time.`,
  },
  {
    q: 'Can I negotiate the price?',
    a: 'We understand every business is different. Annual commitments come with significant savings built in. Reach out directly to discuss multi-property or long-term deals — we\'re flexible.',
  },
  {
    q: 'Does this work with Nepal\'s BS calendar?',
    a: 'Yes — the entire system runs on Bikram Sambat natively. Periods, dates, reports, and stock count sheets all use BS months. No workarounds needed.',
  },
  {
    q: 'What payment methods are tracked?',
    a: 'Cash, Credit, and FonePay — the three most common methods in Nepal\'s F&B industry. Detailed breakdowns appear in the Payment Summary report.',
  },
  {
    q: 'Can I switch plans later?',
    a: 'Yes. Upgrading or downgrading is handled by your Crest consultant. All your data is preserved when you change plans.',
  },
  {
    q: 'Is my data secure?',
    a: 'Your data is stored in Supabase (PostgreSQL) with row-level security — each property can only see its own data. No other client can access your records.',
  },
]

// Shared feature-list rendering, colored by whichever module owns the card.
function FeatureList({ features, color }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {features.map((f, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
          <Check size={14} strokeWidth={2.5} aria-hidden="true" style={{ color, flexShrink: 0, marginTop: 2 }} />
          <span style={{ fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.45 }}>{f}</span>
        </div>
      ))}
    </div>
  )
}

function SectionHeading({ color, title, subtitle }) {
  return (
    <div style={{ textAlign: 'center', marginBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 6 }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: 'var(--theme-text1)' }}>{title}</h2>
      </div>
      {subtitle && <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: 0 }}>{subtitle}</p>}
    </div>
  )
}

export default function Pricing() {
  const [annual, setAnnual]   = useState(false)
  const [showFaq, setShowFaq] = useState(false)
  const { settings } = useSettings()
  const navigate = useNavigate()

  // Escape closes the FAQ dialog — a hand-rolled fixed-overlay modal (not the shared Modal/native
  // <dialog>), so keyboard dismissal isn't free; the backdrop-click already closes it for pointer users.
  useEffect(() => {
    if (!showFaq) return
    const onKey = e => { if (e.key === 'Escape') setShowFaq(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showFaq])

  return (
    // Its own scrollport rather than `minHeight: 100vh` — index.css's app-wide
    // `html, body { overflow-x: hidden }` makes body a scroll container sized to its content, so
    // the sticky nav below had a scrollport that never scrolled and had never stuck (measured on
    // the built page: nav top 0 -> -250 -> -600). Same root cause and same fix as the guest menu's
    // category bar and .login-page; relaxing the body rule was measured and loses the horizontal
    // guard entirely. dvh so the fold is not under a phone's URL bar.
    <div style={{ height: '100dvh', overflowY: 'auto', overscrollBehaviorY: 'contain', background: BG, color: 'var(--theme-text1)' }}>

      {/* Nav */}
      <nav style={{ background: CARD, borderBottom: `1px solid ${BORDER}`, padding: '0 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 64, position: 'sticky', top: 0, zIndex: 100 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* Mark and name from the same source — the same S606 fix as Login.js and
              ResetPassword.js. Here the name was a hardcoded literal rather than app_name, so the
              pair agreed only because neither of them could move; a white-labelled client
              following the Pricing link out of the login header still landed on somebody else's
              brand. The plan names below stay "Crest IMS" / "Crest HR" — those are product names
              and are not the client's to rebrand. */}
          {settings?.logo_url
            ? <img src={settings.logo_url} alt="" style={{ width: 22, height: 22, objectFit: 'contain', borderRadius: 4, flexShrink: 0 }} />
            : <Hexagon size={22} strokeWidth={2.25} aria-hidden="true" style={{ color: GOLD, flexShrink: 0 }} />}
          <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>{settings?.app_name || 'Crest Suite'}</span>
        </div>
        <button
          onClick={() => navigate('/login')}
          style={{ background: 'rgba(201,168,76,0.1)', border: `1px solid rgba(201,168,76,0.35)`, color: GOLD, padding: '8px 22px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          Login →
        </button>
      </nav>

      {/* <main> — the page previously had a <nav> and no main landmark at all, so a screen-reader
          user had no way to skip the sticky header to the content. */}
      <main>

      {/* Hero */}
      <div style={{ textAlign: 'center', padding: '72px 32px 52px' }}>
        <div style={{ display: 'inline-block', background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)', borderRadius: 'var(--radius-full)', padding: '5px 18px', fontSize: 12, color: GREEN, marginBottom: 24, letterSpacing: '0.06em', fontWeight: 600 }}>
          {TRIAL_DAYS}-day free trial · No credit card required
        </div>
        <h1 style={{ fontSize: 44, fontWeight: 800, margin: '0 0 16px', lineHeight: 1.15, color: 'var(--theme-text1)' }}>
          Simple, honest pricing
        </h1>
        <p style={{ fontSize: 16, color: 'var(--theme-text2)', margin: '0 auto 44px', maxWidth: 560, lineHeight: 1.7 }}>
          Built for Nepal's restaurants and cafes. Works in BS calendar, NPR, and FonePay, with no Western-SaaS workarounds needed.
          Buy Crest IMS, Crest HR, and Crest POS separately, then add Crest Suite Pro on top for the owner-level view across all of them.
        </p>

        {/* Billing toggle */}
        <div style={{ display: 'inline-flex', background: CARD, border: `1px solid ${BORDER}`, borderRadius: 'var(--radius-md)', padding: 4, gap: 2 }}>
          <button
            onClick={() => setAnnual(false)} aria-pressed={!annual}
            style={{ background: !annual ? 'rgba(201,168,76,0.15)' : 'none', border: !annual ? `1px solid rgba(201,168,76,0.3)` : '1px solid transparent', color: !annual ? GOLD : 'var(--theme-text2)', padding: '8px 22px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            Monthly
          </button>
          <button
            onClick={() => setAnnual(true)} aria-pressed={annual}
            style={{ background: annual ? 'rgba(201,168,76,0.15)' : 'none', border: annual ? `1px solid rgba(201,168,76,0.3)` : '1px solid transparent', color: annual ? GOLD : 'var(--theme-text2)', padding: '8px 22px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
            Annual
            <span style={{ background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.25)', color: GREEN, fontSize: 10, padding: '2px 8px', borderRadius: 'var(--radius-sm)', fontWeight: 700, letterSpacing: '0.04em' }}>
              Save 25%
            </span>
          </button>
        </div>
        {/* Every figure on this page is exclusive of VAT, and until now the page made no tax claim
            at all while the Terms said fees are quoted ex-VAT and 13% is added on the invoice. One
            of the two had to move; a price that turns out to be 13% higher on the invoice than on
            the page is the kind of surprise the Consumer Protection Act 2075 exists for. Placed
            with the billing toggle rather than in the footer because that is where the numbers are
            being compared. */}
        <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '12px 0 0', textAlign: 'center' }}>
          All prices exclude VAT. 13% VAT is added on invoice.
        </p>
      </div>

      {/* ── Why Crest — value strip (this page is the single marketing surface per the tool-first
             product charter; a typographic strip, not a hero-plus-three-cards, on purpose) ── */}
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px 72px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 30, borderTop: `1px solid ${BORDER}`, paddingTop: 44 }}>
          {[
            { Icon: Calculator,   title: 'Cost intelligence, not just billing', body: 'True food cost, recipe margins, and variance. The numbers POS-only tools never surface.' },
            { Icon: Users,        title: 'HR and payroll built in',             body: 'SSF, TDS, attendance, and roster in the same product. Nepal-compliant and deadline-ready every month.' },
            { Icon: CalendarDays, title: 'Made for Nepal',                      body: 'Bikram Sambat, NPR, and FonePay native. No Western-SaaS workarounds to fight.' },
          ].map(({ Icon, title, body }, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
              <Icon size={22} strokeWidth={2} aria-hidden="true" style={{ color: GOLD }} />
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)', lineHeight: 1.3 }}>{title}</div>
              <div style={{ fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>{body}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Crest IMS — 3 tiers ── */}
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px 24px' }}>
        <SectionHeading color={MODULE_INK.ims} title="Crest IMS" subtitle="Inventory, recipe costing & food-cost intelligence" />
      </div>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px 64px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 20 }}>
        {IMS_TIERS.map(plan => {
          const highlight = plan.key === 'growth'
          const price = annual ? plan.annual : plan.monthly
          return (
            <div key={plan.key} style={{
              background: CARD,
              border: highlight ? `1px solid ${moduleTint('ims', 45)}` : `1px solid ${BORDER}`,
              borderRadius: 'var(--radius-lg)', padding: '36px 28px 28px', position: 'relative',
              display: 'flex', flexDirection: 'column',
              boxShadow: highlight ? `0 4px 48px ${moduleTint('ims', 13)}` : 'none',
            }}>
              {highlight && (
                <div style={{ position: 'absolute', top: -13, left: '50%', transform: 'translateX(-50%)', background: MODULE_COLORS.ims, color: 'var(--theme-accent-text)', fontSize: 11, fontWeight: 800, padding: '4px 14px', borderRadius: 'var(--radius-sm)', letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                  Most Popular
                </div>
              )}

              <div style={{ marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {/* Georgia removed here and on every other heading but the wordmark — DESIGN.md's
                    One Serif Rule allows exactly one serif element per screen, and this page had
                    twelve. */}
                <span style={{ fontSize: 20, fontWeight: 700, color: MODULE_INK.ims }}>{plan.label}</span>
                {plan.key === 'starter' && !annual && (
                  <span style={{ fontSize: 11, fontStyle: 'italic', fontWeight: 800, color: MODULE_INK.ims, background: moduleTint('ims', 9), border: `1px solid ${moduleTint('ims', 25)}`, padding: '3px 8px', borderRadius: 'var(--radius-sm)', letterSpacing: '0.05em' }}>
                    FREE FOR {TRIAL_DAYS} DAYS TRIAL
                  </span>
                )}
              </div>

              <div style={{ marginBottom: 22, paddingBottom: 22, borderBottom: `1px solid ${BORDER}` }}>
                {plan.key === 'starter' && !annual ? (
                  <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--theme-text1)', lineHeight: 1 }}>
                    NPR {plan.monthly.toLocaleString()}
                    <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--theme-text2)' }}>/mo after trial</span>
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--theme-text1)', lineHeight: 1 }}>
                      NPR {price.toLocaleString()}
                      <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--theme-text2)' }}>/mo</span>
                    </div>
                    {annual && (
                      <div style={{ fontSize: 12, color: 'var(--theme-text3)', marginTop: 6 }}>
                        Billed annually · NPR {(price * 12).toLocaleString()}/yr
                      </div>
                    )}
                  </>
                )}
              </div>

              <button
                onClick={() => plan.key === 'starter' ? navigate('/login?trial=1') : navigate('/login')}
                style={{ background: highlight ? MODULE_COLORS.ims : moduleTint('ims', 8), border: `1px solid ${highlight ? MODULE_COLORS.ims : moduleTint('ims', 25)}`, color: highlight ? 'var(--theme-accent-text)' : MODULE_INK.ims, padding: '11px 20px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 14, fontWeight: 700, marginBottom: 22, width: '100%' }}>
                {plan.key === 'starter' ? 'Start Free Trial' : `Get ${plan.label}`} →
              </button>

              <div style={{ flex: 1 }}>
                {plan.includesLabel && (
                  <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginBottom: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                    {plan.includesLabel}
                  </div>
                )}
                <FeatureList features={plan.features} color={MODULE_INK.ims} />
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Crest HR + Crest POS — flat modules ── */}
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px 24px' }}>
        <SectionHeading color={MODULE_INK.hr} title="Crest HR & Crest POS" subtitle="Payroll and floor operations — buy either one on its own" />
      </div>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px 64px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
        {[
          { key: 'hr',  name: 'Crest HR',  tagline: 'Nepal-compliant payroll, attendance, and staff management.', pricing: HR_PRICING },
          { key: 'pos', name: 'Crest POS', tagline: 'Tables, orders, billing, and shift reconciliation.',             pricing: POS_PRICING },
        ].map(mod => {
          const price = annual ? mod.pricing.annual : mod.pricing.monthly
          return (
            <div key={mod.key} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 'var(--radius-lg)', padding: '36px 28px 28px', display: 'flex', flexDirection: 'column' }}>
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 20, fontWeight: 700, color: MODULE_INK[mod.key] }}>{mod.name}</span>
              </div>
              <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 20px', lineHeight: 1.5 }}>{mod.tagline}</p>

              <div style={{ marginBottom: 22, paddingBottom: 22, borderBottom: `1px solid ${BORDER}` }}>
                <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--theme-text1)', lineHeight: 1 }}>
                  NPR {price.toLocaleString()}
                  <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--theme-text2)' }}>/mo</span>
                </div>
                {annual && (
                  <div style={{ fontSize: 12, color: 'var(--theme-text3)', marginTop: 6 }}>
                    Billed annually · NPR {(price * 12).toLocaleString()}/yr
                  </div>
                )}
              </div>

              <button
                onClick={() => navigate('/login')}
                style={{ background: moduleTint(mod.key, 8), border: `1px solid ${moduleTint(mod.key, 25)}`, color: MODULE_INK[mod.key], padding: '11px 20px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 14, fontWeight: 700, marginBottom: 22, width: '100%' }}>
                Get {mod.name} →
              </button>

              <FeatureList features={mod.pricing.features} color={MODULE_INK[mod.key]} />
            </div>
          )
        })}
      </div>

      {/* ── Crest Suite Pro — add-on, not a bundle ──
          One SKU sitting on top of whatever modules a client bought, with a real feature list.
          This section used to render three bundle cards showing only a strikethrough price and
          no features at all — which was the entire pitch. */}
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px 24px' }}>
        <SectionHeading color={GOLD} title="Crest Suite Pro" subtitle="The owner layer — added on top of your modules, not a separate product" />
      </div>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px 80px' }}>
        <div style={{ background: CARD, border: `1px solid rgba(201,168,76,0.3)`, borderRadius: 'var(--radius-lg)', padding: '32px 28px', position: 'relative' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 28, alignItems: 'start' }}>
            <div>
              <div style={{ fontSize: 19, fontWeight: 700, color: 'var(--theme-text1)', marginBottom: 10 }}>
                {SUITE_ADDON.label}
              </div>
              <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--theme-text1)', marginBottom: 4 }}>
                +NPR {(annual ? SUITE_ADDON.annual : SUITE_ADDON.monthly).toLocaleString()}
                <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--theme-text2)' }}>/mo per outlet</span>
              </div>
              {annual && (
                <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginBottom: 10 }}>
                  Billed annually · NPR {(SUITE_ADDON.annual * 12).toLocaleString()}/yr
                </div>
              )}
              <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 20, lineHeight: 1.5 }}>
                {SUITE_ADDON.requiresLabel}
              </div>
              <button
                onClick={() => navigate('/login')}
                style={{ background: GOLD, border: `1px solid ${GOLD}`, color: 'var(--theme-accent-text)', padding: '11px 20px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 14, fontWeight: 700, width: '100%' }}>
                Add {SUITE_ADDON.label} →
              </button>
            </div>
            <div style={{ gridColumn: 'span 2', minWidth: 0 }}>
              <FeatureList features={SUITE_ADDON.features} color={GOLD} />
              <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '14px 0 0', lineHeight: 1.55 }}>
                Running more than one outlet? Add Crest Suite Pro to each one and the Group Console
                rolls them all up on a single screen.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* FAQ button */}
      <div style={{ textAlign: 'center', padding: '0 24px 80px' }}>
        <button
          onClick={() => setShowFaq(true)}
          style={{ background: 'rgba(201,168,76,0.08)', border: `1px solid rgba(201,168,76,0.25)`, color: GOLD, padding: '11px 28px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
          FAQ — Common Questions
        </button>
      </div>

      {/* FAQ modal */}
      {showFaq && (
        <div
          onClick={() => setShowFaq(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div
            role="dialog" aria-modal="true" aria-labelledby="faq-title"
            onClick={e => e.stopPropagation()}
            style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 'var(--radius-lg)', width: '100%', maxWidth: 640, maxHeight: '80vh', overflow: 'auto', padding: '36px 32px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 }}>
              <h2 id="faq-title" style={{ margin: 0, fontSize: 22, color: 'var(--theme-text1)' }}>Common Questions</h2>
              <button onClick={() => setShowFaq(false)} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--theme-text2)', fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
            </div>
            {FAQS.map((faq, i) => (
              <div key={i} style={{ padding: '18px 0', borderBottom: `1px solid ${BORDER}` }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 7 }}>{faq.q}</div>
                <div style={{ fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.75 }}>{faq.a}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer CTA */}
      <div style={{ background: CARD, borderTop: `1px solid ${BORDER}`, padding: '64px 32px', textAlign: 'center' }}>
        <h2 style={{ fontSize: 28, margin: '0 0 12px', color: 'var(--theme-text1)' }}>
          Ready to take control of your food costs?
        </h2>
        <p style={{ fontSize: 14, color: 'var(--theme-text2)', margin: '0 0 36px', lineHeight: 1.6 }}>
          Start free today. No credit card. No commitment. Cancel any time.
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 48 }}>
          <button
            onClick={() => navigate(-1)}
            style={{ background: 'none', border: `1px solid ${BORDER}`, color: 'var(--theme-text2)', padding: '13px 24px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
            ← Back
          </button>
          <button
            onClick={() => navigate('/login?trial=1')}
            style={{ background: GOLD, border: 'none', color: 'var(--theme-accent-text)', padding: '13px 32px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 14, fontWeight: 700 }}>
            Start Free Trial →
          </button>
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            style={{ background: 'none', border: `1px solid ${BORDER}`, color: 'var(--theme-text2)', padding: '13px 28px', borderRadius: 'var(--radius-md)', textDecoration: 'none', fontSize: 14, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <Mail size={15} strokeWidth={2} aria-hidden="true" /> Email us
          </a>
        </div>
        <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: 0 }}>© {new Date().getFullYear()} · {COMPANY.name} · Kathmandu, Nepal</p>
          {/* Every public page carries the same pair. Plain anchors rather than router Links so
              the markup is identical to the login and legal footers. */}
          <p style={{ fontSize: 11, margin: '8px 0 0', display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap' }}>
            <a href="/legal/terms" style={{ color: 'var(--theme-text2)', textDecoration: 'none' }}>Terms of Service</a>
            <a href="/legal/privacy" style={{ color: 'var(--theme-text2)', textDecoration: 'none' }}>Privacy Policy</a>
          </p>
      </div>

      </main>
    </div>
  )
}
