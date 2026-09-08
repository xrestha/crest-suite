import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Hexagon, Check, Mail, Calculator, Users, CalendarDays, ChevronDown } from 'lucide-react'
import { useSettings } from '../context/SettingsContext'
import { useAuth } from '../context/AuthContext'
import { MODULE_COLORS, MODULE_INK, moduleTint, TRIAL_DAYS, IMS_TIERS, HR_PRICING, POS_PRICING, SUITE_ADDON } from '../data/pricingPlans'
// The registered entity, from the one place it is pinned against the published legal documents.
import { COMPANY } from '../legal'

// ── Change this to the contact email when ready ──────────────────────────────
const CONTACT_EMAIL = 'hello@cresthospitality.com'

const GOLD   = 'var(--theme-accent)'
// The accent AS TEXT. `GOLD` is a fill (button backgrounds, icons, the section dot); on the Light
// preset the base accent measured 3.1–3.35:1 as button text here (S682), below AA — which is the
// whole reason `--theme-accent-ink` exists (DESIGN.md → Brass Ink).
const GOLD_INK = 'var(--theme-accent-ink)'
// Brass tints derived from the live token rather than the Dark preset's rgba literal, so they
// re-tone with the accent on Light (DESIGN.md → "Brass is a range, not one value").
const brassTint = pct => `color-mix(in srgb, var(--theme-accent) ${pct}%, transparent)`
const GREEN  = 'var(--theme-green-text)'   // text use only — see ThemeContext's PRESETS note
const BG     = 'var(--theme-bg)'
const CARD   = 'var(--theme-card)'
const BORDER = 'var(--theme-border)'

const FAQS = [
  {
    q: `Is the ${TRIAL_DAYS}-day trial really free?`,
    a: `Yes — your first ${TRIAL_DAYS} days are free, with no credit card and no hidden fees. The trial runs at the Growth level with all three modules switched on, so you can cost a recipe, set up payroll and bill a table before deciding. We switch every trial on personally: sign up, and we will call you within one working day to open it. After the trial, pick the modules and tier you actually want.`,
  },
  {
    q: 'What happens when the trial ends?',
    a: `Nothing is deleted and nothing is charged automatically. You pick the modules and the tier you actually want — Starter, Growth or Pro, with or without HR and POS — and everything you entered during the trial carries straight over. If you decide against Crest, we keep your data for 15 days in case you change your mind, then remove it as the Privacy Policy says.`,
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
//
// The long lists collapse (S699). Starter names 17 features and Growth 14, and because the three
// tiers share one grid row every card was stretched to the tallest — so the IMS section ran about
// 17 lines deep three times over and pushed Crest HR and Crest POS well below the fold. A visitor
// who is not already sold does not read 39 bullets to find out that payroll exists. Seven is the
// middle of the 5–7 range the pricing-page research converges on, with the rest one click away.
//
// Two decisions worth keeping:
//
// It is a BUTTON, not hover. Hover looks tidier and is the wrong mechanism: most pricing-page
// traffic is on a phone, which has no hover state at all — and worse than absent, a tap on a
// :hover rule latches it until the visitor taps somewhere else, so a card would open and then
// refuse to close. Hover is a bonus for people holding a mouse, never the only way in.
//
// It collapses only where it saves more than two lines, so Pro (8), POS (8), HR (7) and Suite (6)
// stay whole: a control that hides two lines costs more attention than the two lines it saves.
const COLLAPSE_AFTER = 7

function FeatureList({ features, color, collapsible = false }) {
  const [open, setOpen] = useState(false)
  const collapses = collapsible && features.length > COLLAPSE_AFTER + 2
  const shown = collapses && !open ? features.slice(0, COLLAPSE_AFTER) : features
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {shown.map((f, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
          <Check size={14} strokeWidth={2.5} aria-hidden="true" style={{ color, flexShrink: 0, marginTop: 2 }} />
          <span style={{ fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.45 }}>{f}</span>
        </div>
      ))}
      {collapses && (
        <button
          type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
          style={{ background: 'none', border: 'none', padding: '4px 0 0', marginTop: 1, color, fontSize: 12, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, alignSelf: 'flex-start' }}>
          {open ? 'Show less' : `Show ${features.length - COLLAPSE_AFTER} more`}
          <ChevronDown size={13} strokeWidth={2.5} aria-hidden="true"
            style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform var(--motion-fast) var(--ease-standard)' }} />
        </button>
      )}
    </div>
  )
}

function SectionHeading({ color, title, subtitle }) {
  return (
    <div style={{ textAlign: 'center', marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 6 }}>
        <span style={{ width: 10, height: 10, borderRadius: 0, background: color, flexShrink: 0 }} />
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
  // A signed-in reader is an OWNER comparing plans, not a visitor deciding whether to sign up.
  // "Login →" and "Start Free Trial →" used to eject them onto the signed-out funnel, with
  // "← Back" the only way home (S683). Signed in, every CTA becomes a request to switch.
  const { session } = useAuth()
  const askAbout = label => { window.location.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`Crest Suite: ${label}`)}` }

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
            ? <img src={settings.logo_url} alt="" style={{ width: 22, height: 22, objectFit: 'contain', borderRadius: 0, flexShrink: 0 }} />
            : <Hexagon size={22} strokeWidth={2.25} aria-hidden="true" style={{ color: GOLD, flexShrink: 0 }} />}
          <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>{settings?.app_name || 'Crest Suite'}</span>
        </div>
        <button
          onClick={() => navigate(session ? '/dashboard' : '/login')}
          style={{ background: brassTint(10), border: `1px solid ${brassTint(35)}`, color: GOLD_INK, padding: '8px 22px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          {session ? 'Back to Crest →' : 'Login →'}
        </button>
      </nav>

      {/* <main> — the page previously had a <nav> and no main landmark at all, so a screen-reader
          user had no way to skip the sticky header to the content. */}
      <main>

      {/* Hero */}
      <div style={{ textAlign: 'center', padding: '72px 32px 32px' }}>
        {!session && (
          <div style={{ display: 'inline-block', background: 'color-mix(in srgb, var(--theme-green) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-green) 20%, transparent)', borderRadius: 'var(--radius-full)', padding: '5px 18px', fontSize: 12, color: GREEN, marginBottom: 24, letterSpacing: '0.06em', fontWeight: 600 }}>
            {TRIAL_DAYS} days free · All three modules · No credit card
          </div>
        )}
        <h1 style={{ fontSize: 44, fontWeight: 800, margin: '0 0 16px', lineHeight: 1.15, color: 'var(--theme-text1)' }}>
          Simple, honest pricing
        </h1>
        <p style={{ fontSize: 16, color: 'var(--theme-text2)', margin: '0 auto', maxWidth: 560, lineHeight: 1.7 }}>
          Built for Nepal's restaurants and cafes. Works in BS calendar, NPR, and FonePay, with no Western-SaaS workarounds needed.
          Buy Crest IMS, Crest HR, and Crest POS separately, then add Crest Suite Pro on top for the owner-level view across all of them.
        </p>

      </div>

      {/* ── Why Crest — value strip (this page is the single marketing surface per the tool-first
             product charter; a typographic strip, not a hero-plus-three-cards, on purpose) ── */}
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px 64px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 32, borderTop: `1px solid ${BORDER}`, paddingTop: 32 }}>
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

      {/* ── The free trial, stated once (S699) ─────────────────────────────────────────────
             The trial stopped being a property of one tier when it became Growth-with-all-modules
             (S697), and at that moment it also stopped being renderable inside a tier card: the
             "FREE FOR 7 DAYS TRIAL" badge sat on Starter and told a visitor the exact opposite of
             what they would actually get, while "NPR 2,000/mo after trial" underneath it named the
             one tier the trial is not. A claim that spans all three module sections belongs above
             all three of them. Hidden for a signed-in visitor, who has an account already. ── */}
      {!session && (
        <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px 64px' }}>
          <div style={{
            background: CARD, border: `1px solid ${brassTint(30)}`, borderRadius: 'var(--radius-lg)',
            padding: '32px', display: 'flex', gap: 32, alignItems: 'center', flexWrap: 'wrap',
            boxShadow: `0 4px 48px ${brassTint(10)}`,
          }}>
            <div style={{ flex: '1 1 440px', minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: GOLD_INK, marginBottom: 9 }}>
                Free for {TRIAL_DAYS} days
              </div>
              <h2 style={{ fontSize: 22, fontWeight: 800, margin: '0 0 11px', color: 'var(--theme-text1)', lineHeight: 1.25 }}>
                Stock, staff and the till — all switched on
              </h2>
              <p style={{ fontSize: 14, color: 'var(--theme-text2)', margin: 0, lineHeight: 1.7 }}>
                Every trial includes Crest IMS, Crest HR and Crest POS at the <strong style={{ color: 'var(--theme-text1)', fontWeight: 700 }}>Growth</strong> tier,
                so you can cost a recipe, set up payroll and bill a table in the same week. We open each trial personally — sign up and we will call you within one working day,
                and your {TRIAL_DAYS} days start from that call, not from the form. No card. When the {TRIAL_DAYS} days are
                up you choose what to keep, and everything you entered carries straight over.
              </p>
            </div>
            <button
              onClick={() => navigate('/signup')}
              style={{ background: GOLD, border: 'none', color: 'var(--theme-accent-text)', padding: '13px 30px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap' }}>
              Start Free Trial →
            </button>
          </div>
        </div>
      )}

      {/* ── Billing controls (S699) ──────────────────────────────────────────────────────────
             These decide every number below them and lived in the hero, a screen and a half above
             the first price they change — so a visitor comparing NPR 2,000 against NPR 1,500 had
             to scroll back up to learn which one they were reading, and the 25% annual saving was
             announced before there was anything to apply it to. Moved to the head of the pricing
             region, where the numbers are. Deliberately NOT sticky: this page has been bitten by
             sticky-in-body-flow before (S604). The VAT line rides alongside rather than beneath —
             same information, one row instead of two, and it wraps under on a narrow screen. ── */}
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px' }}>
        <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 32, marginBottom: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, flexWrap: 'wrap' }}>
          <div style={{ display: 'inline-flex', background: CARD, border: `1px solid ${BORDER}`, borderRadius: 'var(--radius-md)', padding: 4, gap: 2 }}>
            <button
              onClick={() => setAnnual(false)} aria-pressed={!annual}
              style={{ background: !annual ? brassTint(15) : 'none', border: !annual ? `1px solid ${brassTint(30)}` : '1px solid transparent', color: !annual ? GOLD_INK : 'var(--theme-text2)', padding: '8px 22px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              Monthly
            </button>
            <button
              onClick={() => setAnnual(true)} aria-pressed={annual}
              style={{ background: annual ? brassTint(15) : 'none', border: annual ? `1px solid ${brassTint(30)}` : '1px solid transparent', color: annual ? GOLD_INK : 'var(--theme-text2)', padding: '8px 22px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              Annual
              <span style={{ background: 'color-mix(in srgb, var(--theme-green) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-green) 25%, transparent)', color: GREEN, fontSize: 10, padding: '2px 8px', borderRadius: 'var(--radius-sm)', fontWeight: 700, letterSpacing: '0.04em' }}>
                Save 25%
              </span>
            </button>
          </div>
          <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: 0 }}>
            All prices exclude VAT. 13% VAT is added on invoice.
          </p>
        </div>
      </div>

      {/* ── Crest IMS — 3 tiers ── */}
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px' }}>
        <SectionHeading color={MODULE_INK.ims} title="Crest IMS" subtitle="Inventory, recipe costing & food-cost intelligence" />
      </div>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px 64px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 24 }}>
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
                {highlight && (
                  <span style={{ fontSize: 11, fontStyle: 'italic', fontWeight: 800, color: MODULE_INK.ims, background: moduleTint('ims', 9), border: `1px solid ${moduleTint('ims', 25)}`, padding: '3px 8px', borderRadius: 'var(--radius-sm)', letterSpacing: '0.05em' }}>
                    YOUR TRIAL RUNS HERE
                  </span>
                )}
              </div>

              <div style={{ marginBottom: 22, paddingBottom: 22, borderBottom: `1px solid ${BORDER}` }}>
                <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--theme-text1)', lineHeight: 1 }}>
                  NPR {price.toLocaleString('en-IN')}
                  <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--theme-text2)' }}>/month</span>
                </div>
                {annual && (
                  <div style={{ fontSize: 12, color: 'var(--theme-text3)', marginTop: 6 }}>
                    Billed annually · NPR {(price * 12).toLocaleString('en-IN')}/year
                  </div>
                )}
              </div>

              <button
                onClick={() => session ? askAbout(plan.label) : navigate('/signup')}
                style={{ background: highlight ? MODULE_COLORS.ims : moduleTint('ims', 8), border: `1px solid ${highlight ? MODULE_COLORS.ims : moduleTint('ims', 25)}`, color: highlight ? 'var(--theme-accent-text)' : MODULE_INK.ims, padding: '11px 20px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 14, fontWeight: 700, marginBottom: 22, width: '100%' }}>
                {session ? `Ask about ${plan.label}` : 'Start Free Trial'} →
              </button>

              <div style={{ flex: 1 }}>
                {plan.includesLabel && (
                  <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginBottom: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                    {plan.includesLabel}
                  </div>
                )}
                <FeatureList features={plan.features} color={MODULE_INK.ims} collapsible />
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Crest HR + Crest POS — flat modules ── */}
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px' }}>
        <SectionHeading color={MODULE_INK.hr} title="Crest HR & Crest POS" subtitle="Payroll and floor operations — buy either one on its own" />
      </div>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px 64px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 24 }}>
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
                  NPR {price.toLocaleString('en-IN')}
                  <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--theme-text2)' }}>/month</span>
                </div>
                {annual && (
                  <div style={{ fontSize: 12, color: 'var(--theme-text3)', marginTop: 6 }}>
                    Billed annually · NPR {(price * 12).toLocaleString('en-IN')}/year
                  </div>
                )}
              </div>

              <button
                onClick={() => session ? askAbout(mod.name) : navigate('/signup')}
                style={{ background: moduleTint(mod.key, 8), border: `1px solid ${moduleTint(mod.key, 25)}`, color: MODULE_INK[mod.key], padding: '11px 20px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 14, fontWeight: 700, marginBottom: 22, width: '100%' }}>
                {session ? `Ask about ${mod.name}` : 'Start Free Trial'} →
              </button>

              <FeatureList features={mod.pricing.features} color={MODULE_INK[mod.key]} collapsible />
            </div>
          )
        })}
      </div>

      {/* ── Crest Suite Pro — add-on, not a bundle ──
          One SKU sitting on top of whatever modules a client bought, with a real feature list.
          This section used to render three bundle cards showing only a strikethrough price and
          no features at all — which was the entire pitch. */}
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px' }}>
        <SectionHeading color={GOLD} title="Crest Suite Pro" subtitle="The owner layer — added on top of your modules, not a separate product" />
      </div>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px 64px' }}>
        <div style={{ background: CARD, border: `1px solid color-mix(in srgb, var(--theme-accent) 30%, transparent)`, borderRadius: 'var(--radius-lg)', padding: '32px 28px', position: 'relative' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 32, alignItems: 'start' }}>
            <div>
              <div style={{ fontSize: 19, fontWeight: 700, color: 'var(--theme-text1)', marginBottom: 10 }}>
                {SUITE_ADDON.label}
              </div>
              <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--theme-text1)', marginBottom: 4 }}>
                +NPR {(annual ? SUITE_ADDON.annual : SUITE_ADDON.monthly).toLocaleString('en-IN')}
                <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--theme-text2)' }}>/month per outlet</span>
              </div>
              {annual && (
                <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginBottom: 10 }}>
                  Billed annually · NPR {(SUITE_ADDON.annual * 12).toLocaleString('en-IN')}/year
                </div>
              )}
              <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 8, lineHeight: 1.5 }}>
                {SUITE_ADDON.requiresLabel}
              </div>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginBottom: 20, lineHeight: 1.5 }}>
                Not part of the free trial — added once your modules are running.
              </div>
              <button
                onClick={() => askAbout(SUITE_ADDON.label)}
                style={{ background: GOLD, border: `1px solid ${GOLD}`, color: 'var(--theme-accent-text)', padding: '11px 20px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 14, fontWeight: 700, width: '100%' }}>
                Ask about {SUITE_ADDON.label} →
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
      <div style={{ textAlign: 'center', padding: '0 24px 64px' }}>
        <button
          onClick={() => setShowFaq(true)}
          style={{ background: brassTint(8), border: `1px solid ${brassTint(25)}`, color: GOLD_INK, padding: '11px 28px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
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
          {session ? 'Want to add a module or move up a plan?' : 'Ready to take control of your food costs?'}
        </h2>
        <p style={{ fontSize: 14, color: 'var(--theme-text2)', margin: '0 0 36px', lineHeight: 1.6 }}>
          {session
            ? 'Email us what you want switched on. It is done on the account, and nothing you already record changes.'
            : `Sign up in a minute, and we will call you within one working day to open your trial. ${TRIAL_DAYS} days, all three modules, no card.`}
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 48 }}>
          <button
            onClick={() => session ? navigate('/dashboard') : navigate(-1)}
            style={{ background: 'none', border: `1px solid ${BORDER}`, color: 'var(--theme-text2)', padding: '13px 24px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
            {session ? '← Back to Crest' : '← Back'}
          </button>
          {!session && (
            <button
              onClick={() => navigate('/signup')}
              style={{ background: GOLD, border: 'none', color: 'var(--theme-accent-text)', padding: '13px 32px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 14, fontWeight: 700 }}>
              Start Free Trial →
            </button>
          )}
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
