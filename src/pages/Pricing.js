import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Hexagon, Check, Mail, Calculator, Users, CalendarDays, ChevronDown } from 'lucide-react'
import { useSettings } from '../context/SettingsContext'
import { useAuth } from '../context/AuthContext'
import { useSupportContact } from '../shared/hooks/useSupportContact'
import { useDocumentTitle, pageTitle } from '../shared/hooks/useDocumentTitle'
import Modal from '../components/Modal'
// Prices are NOT imported from here any more (S701) — only the module colours and the trial
// length are constants. What this page prints comes from `useSettings().pricing`, which resolves
// the admin's Settings > Plan Pricing figures over the shipped ones; importing IMS_TIERS et al.
// directly is exactly what made this page immune to a price change.
import { MODULE_COLORS, MODULE_INK, TRIAL_DAYS } from '../data/pricingPlans'
// The registered entity, from the one place it is pinned against the published legal documents.
import { COMPANY } from '../legal'
import './Pricing.css'

// Every style on this page lives in Pricing.css (S852). A module card takes its hue from two
// custom properties rather than from inline colour values, so one rule serves all four modules.
const moduleVars = key => ({ '--pm': MODULE_COLORS[key], '--pm-ink': MODULE_INK[key] })

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

// `color` is the check marks' and the toggle's colour; it rides in as a custom property so the
// list's styles stay in Pricing.css.
function FeatureList({ features, color, collapsible = false }) {
  const [open, setOpen] = useState(false)
  const collapses = collapsible && features.length > COLLAPSE_AFTER + 2
  const shown = collapses && !open ? features.slice(0, COLLAPSE_AFTER) : features
  return (
    <div className="pricing-features" style={color ? { '--pf': color } : undefined}>
      {shown.map((f, i) => (
        <div key={i} className="pricing-feature">
          <Check size={14} strokeWidth={2.5} aria-hidden="true" className="pricing-feature-check" />
          <span className="pricing-feature-text">{f}</span>
        </div>
      ))}
      {collapses && (
        <button type="button" className="pricing-more" onClick={() => setOpen(o => !o)} aria-expanded={open}>
          {open ? 'Show less' : `Show ${features.length - COLLAPSE_AFTER} more`}
          <ChevronDown size={13} strokeWidth={2.5} aria-hidden="true" className="pricing-more-chev" />
        </button>
      )}
    </div>
  )
}

// A price that is not known yet is a shimmer, not a default figure. The numbers arrive with the
// platform settings row a beat after first paint, so printing the shipped price and swapping it
// when the read lands would let a visitor read one price and act on another — on a page
// headlined "Simple, honest pricing". The em-width keeps the swap from moving the layout.
function Amount({ ready, value, width = '3.6em' }) {
  if (!ready) return <span className="skeleton pricing-amount-skel" aria-hidden="true" style={{ width }} />
  return <>{value.toLocaleString('en-IN')}</>
}

function SectionHeading({ color, title, subtitle }) {
  return (
    <div className="pricing-heading">
      <div className="pricing-heading-row">
        <span className="pricing-heading-dot" style={{ '--ps': color }} />
        <h2>{title}</h2>
      </div>
      {subtitle && <p>{subtitle}</p>}
    </div>
  )
}

export default function Pricing() {
  const [annual, setAnnual]   = useState(false)
  const [showFaq, setShowFaq] = useState(false)
  // `pricing` is the live table (the admin's overrides resolved over the shipped defaults), and
  // `loading` spans BOTH reads loadSettings() makes, so it is the right gate for the figures.
  const { settings, pricing, loading: pricesLoading } = useSettings()
  const priceReady = !pricesLoading
  const suite = pricing.suite
  const navigate = useNavigate()
  // A signed-in reader is an OWNER comparing plans, not a visitor deciding whether to sign up.
  // "Login →" and "Start Free Trial →" used to eject them onto the signed-out funnel, with
  // "← Back" the only way home (S683). Signed in, every CTA becomes a request to switch.
  const { session } = useAuth()
  // "Ask about" and "Email us" go to the support address every other screen uses (S852). They
  // mailed a placeholder the code itself said to change "when ready", an address used nowhere
  // else, so every upgrade enquiry from a signed-in Owner went to an inbox nobody reads. The
  // hook resolves the client's consultant, then the admin-edited platform contact, then the
  // constant; COMPANY.supportEmail is the floor under all three.
  const contactEmail = useSupportContact().email || COMPANY.supportEmail
  const askHref = label => `mailto:${contactEmail}?subject=${encodeURIComponent(`Crest Suite: ${label}`)}`
  const brand = settings?.app_name || 'Crest Suite'
  useDocumentTitle(pageTitle('Pricing', brand))

  return (
    <div className="pricing-page">

      {/* Nav */}
      <nav className="pricing-nav" aria-label="Site">
        <div className="pricing-brand">
          {/* Mark and name from the same source — the same S606 fix as Login.js and
              ResetPassword.js. Here the name was a hardcoded literal rather than app_name, so the
              pair agreed only because neither of them could move; a white-labelled client
              following the Pricing link out of the login header still landed on somebody else's
              brand. The plan names below stay "Crest IMS" / "Crest HR" — those are product names
              and are not the client's to rebrand. */}
          {settings?.logo_url
            ? <img src={settings.logo_url} alt="" className="pricing-brand-logo" />
            : <Hexagon size={22} strokeWidth={2.25} aria-hidden="true" className="pricing-brand-mark" />}
          <span className="pricing-brand-name">{brand}</span>
        </div>
        {/* A link, not a button that navigates (S852): it can be opened in a new tab. */}
        <Link to={session ? '/dashboard' : '/login'} className="btn btn-ghost pricing-brass pricing-nav-btn">
          {session ? 'Back to Crest →' : 'Login →'}
        </Link>
      </nav>

      {/* <main> — the page previously had a <nav> and no main landmark at all, so a screen-reader
          user had no way to skip the sticky header to the content. */}
      <main>

      {/* Hero */}
      <div className="pricing-hero">
        {!session && (
          <div className="pricing-trial-chip">
            {TRIAL_DAYS} days free · All three modules · No credit card
          </div>
        )}
        <h1 className="pricing-title">
          Simple, honest pricing
        </h1>
        <p className="pricing-lede">
          Built for Nepal's restaurants and cafes. Works in BS calendar, NPR, and FonePay, with no Western-SaaS workarounds needed.
          Buy Crest IMS, Crest HR, and Crest POS separately, then add Crest Suite Pro on top for the owner-level view across all of them.
        </p>

      </div>

      {/* ── Why Crest — value strip (this page is the single marketing surface per the tool-first
             product charter; a typographic strip, not a hero-plus-three-cards, on purpose) ── */}
      <div className="pricing-wrap pricing-wrap--section">
        <div className="pricing-values">
          {[
            { Icon: Calculator,   title: 'Cost intelligence, not just billing', body: 'True food cost, recipe margins, and variance. The numbers POS-only tools never surface.' },
            { Icon: Users,        title: 'HR and payroll built in',             body: 'SSF, TDS, attendance, and roster in the same product. Nepal-compliant and deadline-ready every month.' },
            { Icon: CalendarDays, title: 'Made for Nepal',                      body: 'Bikram Sambat, NPR, and FonePay native. No Western-SaaS workarounds to fight.' },
          ].map(({ Icon, title, body }, i) => (
            <div key={i} className="pricing-value">
              <Icon size={22} strokeWidth={2} aria-hidden="true" className="pricing-value-icon" />
              <div className="pricing-value-title">{title}</div>
              <div className="pricing-value-body">{body}</div>
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
        <div className="pricing-wrap pricing-wrap--section">
          <div className="pricing-trial">
            <div className="pricing-trial-copy">
              <div className="pricing-eyebrow">
                Free for {TRIAL_DAYS} days
              </div>
              <h2 className="pricing-trial-title">
                Stock, staff and the till — all switched on
              </h2>
              <p className="pricing-trial-body">
                Every trial includes Crest IMS, Crest HR and Crest POS at the <strong>Growth</strong> tier,
                so you can cost a recipe, set up payroll and bill a table in the same week. We open each trial personally — sign up and we will call you within one working day,
                and your {TRIAL_DAYS} days start from that call, not from the form. No card. When the {TRIAL_DAYS} days are
                up you choose what to keep, and everything you entered carries straight over.
              </p>
            </div>
            <Link to="/signup" className="btn btn-primary pricing-commit">
              Start Free Trial →
            </Link>
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
      <div className="pricing-wrap">
        <div className="pricing-billing">
          <div className="pricing-toggle-group">
            <button type="button" className="pricing-toggle" onClick={() => setAnnual(false)} aria-pressed={!annual}>
              Monthly
            </button>
            <button type="button" className="pricing-toggle" onClick={() => setAnnual(true)} aria-pressed={annual}>
              Annual
              <span className="pricing-save-chip">
                Save 25%
              </span>
            </button>
          </div>
          <p className="pricing-vat">
            All prices exclude VAT. 13% VAT is added on invoice.
          </p>
        </div>
      </div>

      {/* ── Crest IMS — 3 tiers ── */}
      <div className="pricing-wrap">
        <SectionHeading color={MODULE_INK.ims} title="Crest IMS" subtitle="Inventory, recipe costing & food-cost intelligence" />
      </div>
      <div className="pricing-wrap pricing-wrap--section pricing-grid">
        {pricing.imsTiers.map(plan => {
          const highlight = plan.key === 'growth'
          const price = annual ? plan.annual : plan.monthly
          return (
            <div key={plan.key} className={`pricing-card${highlight ? ' pricing-card--highlight' : ''}`} style={moduleVars('ims')}>
              {highlight && (
                <div className="pricing-popular">
                  Most Popular
                </div>
              )}

              <div className="pricing-plan-head">
                {/* Georgia removed here and on every other heading but the wordmark — DESIGN.md's
                    One Serif Rule allows exactly one serif element per screen, and this page had
                    twelve. */}
                <span className="pricing-plan-name">{plan.label}</span>
                {highlight && (
                  <span className="pricing-trial-tag">
                    YOUR TRIAL RUNS HERE
                  </span>
                )}
              </div>

              <div className="pricing-price-block">
                <div className="pricing-price" aria-busy={!priceReady || undefined}>
                  NPR <Amount ready={priceReady} value={price} />
                  <span className="pricing-per">/month</span>
                </div>
                {annual && (
                  <div className="pricing-annual">
                    Billed annually · NPR <Amount ready={priceReady} value={price * 12} width="4.2em" />/year
                  </div>
                )}
              </div>

              {/* The highlighted tier's fill is the IMS colour, which is the accent: btn-primary.
                  A link either way: signed out it opens the trial form, signed in it writes to
                  support (S683). */}
              {session ? (
                <a href={askHref(plan.label)} className={`btn ${highlight ? 'btn-primary' : 'btn-ghost pricing-cta--module'} pricing-cta`}>
                  Ask about {plan.label} →
                </a>
              ) : (
                <Link to="/signup" className={`btn ${highlight ? 'btn-primary' : 'btn-ghost pricing-cta--module'} pricing-cta`}>
                  Start Free Trial →
                </Link>
              )}

              <div className="pricing-card-body">
                {plan.includesLabel && (
                  <div className="pricing-includes">
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
      <div className="pricing-wrap">
        <SectionHeading color={MODULE_INK.hr} title="Crest HR, Crest POS & Crest Customization" subtitle="Payroll and floor operations — buy either one on its own. Customization adds on to POS." />
      </div>
      <div className="pricing-wrap pricing-wrap--section pricing-grid pricing-grid--modules">
        {[
          { key: 'hr',  name: 'Crest HR',  tagline: 'Nepal-compliant payroll, attendance, and staff management.', pricing: pricing.hr },
          { key: 'pos', name: 'Crest POS', tagline: 'Tables, orders, billing, and shift reconciliation.',             pricing: pricing.pos },
          { key: 'customization', name: 'Crest Customization', tagline: 'Let guests build their dish — sizes, add-ons, spice — on the till and the QR menu. Requires Crest POS.', pricing: pricing.customization },
        ].map(mod => {
          const price = annual ? mod.pricing.annual : mod.pricing.monthly
          return (
            <div key={mod.key} className="pricing-card" style={moduleVars(mod.key)}>
              <div className="pricing-plan-head pricing-plan-head--module">
                <span className="pricing-plan-name">{mod.name}</span>
              </div>
              <p className="pricing-tagline">{mod.tagline}</p>

              <div className="pricing-price-block">
                <div className="pricing-price" aria-busy={!priceReady || undefined}>
                  NPR <Amount ready={priceReady} value={price} />
                  <span className="pricing-per">/month</span>
                </div>
                {annual && (
                  <div className="pricing-annual">
                    Billed annually · NPR <Amount ready={priceReady} value={price * 12} width="4.2em" />/year
                  </div>
                )}
              </div>

              {session ? (
                <a href={askHref(mod.name)} className="btn btn-ghost pricing-cta--module pricing-cta">
                  Ask about {mod.name} →
                </a>
              ) : (
                <Link to="/signup" className="btn btn-ghost pricing-cta--module pricing-cta">
                  Start Free Trial →
                </Link>
              )}

              <FeatureList features={mod.pricing.features} color={MODULE_INK[mod.key]} collapsible />
            </div>
          )
        })}
      </div>

      {/* ── Crest Suite Pro — add-on, not a bundle ──
          One SKU sitting on top of whatever modules a client bought, with a real feature list.
          This section used to render three bundle cards showing only a strikethrough price and
          no features at all — which was the entire pitch. */}
      <div className="pricing-wrap">
        <SectionHeading color="var(--theme-accent)" title="Crest Suite Pro" subtitle="The owner layer — added on top of your modules, not a separate product" />
      </div>
      <div className="pricing-wrap pricing-wrap--section">
        <div className="pricing-suite">
          <div className="pricing-suite-grid">
            <div>
              <div className="pricing-suite-label">
                {suite.label}
              </div>
              <div className="pricing-suite-price">
                +NPR <Amount ready={priceReady} value={annual ? suite.annual : suite.monthly} />
                <span className="pricing-per">/month per outlet</span>
              </div>
              {annual && (
                <div className="pricing-suite-annual">
                  Billed annually · NPR <Amount ready={priceReady} value={suite.annual * 12} width="4.2em" />/year
                </div>
              )}
              <div className="pricing-suite-requires">
                {suite.requiresLabel}
              </div>
              <div className="pricing-suite-note">
                Not part of the free trial — added once your modules are running.
              </div>
              <a href={askHref(suite.label)} className="btn btn-primary pricing-suite-cta">
                Ask about {suite.label} →
              </a>
            </div>
            {/* Spans two tracks only where the grid has two (Pricing.css, S852). */}
            <div className="pricing-suite-features">
              <FeatureList features={suite.features} color="var(--theme-accent)" />
              <p className="pricing-suite-foot">
                Running more than one outlet? Add Crest Suite Pro to each one and the Group Console
                rolls them all up on a single screen.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* FAQ button */}
      <div className="pricing-faq-open">
        <button type="button" className="btn btn-ghost pricing-brass pricing-faq-btn" onClick={() => setShowFaq(true)}>
          FAQ — Common Questions
        </button>
      </div>

      {/* FAQ dialog — the shared Modal (S852). The hand-rolled overlay it replaced said
          aria-modal but never moved focus in, trapped it or gave it back, and its × was a 13px
          glyph. Modal does all three, closes on Escape and the backdrop, and returns focus to the
          FAQ button. `unstyled` keeps this page's own card. */}
      {showFaq && (
        <Modal
          unstyled
          title="Common Questions"
          onClose={() => setShowFaq(false)}
          zIndex={200}
          panelStyle={{ width: '100%', maxWidth: 640 }}
        >
          <div className="pricing-faq">
            <div className="pricing-faq-head">
              <h2>Common Questions</h2>
              <button type="button" className="btn btn-ghost pricing-faq-close" onClick={() => setShowFaq(false)} aria-label="Close" title="Close">×</button>
            </div>
            {FAQS.map((faq, i) => (
              <div key={i} className="pricing-faq-item">
                <div className="pricing-faq-q">{faq.q}</div>
                <div className="pricing-faq-a">{faq.a}</div>
              </div>
            ))}
          </div>
        </Modal>
      )}

      {/* Footer CTA */}
      <div className="pricing-footer">
        <h2>
          {session ? 'Want to add a module or move up a plan?' : 'Ready to take control of your food costs?'}
        </h2>
        <p className="pricing-footer-body">
          {session
            ? 'Email us what you want switched on. It is done on the account, and nothing you already record changes.'
            : `Sign up in a minute, and we will call you within one working day to open your trial. ${TRIAL_DAYS} days, all three modules, no card.`}
        </p>
        <div className="pricing-footer-actions">
          {session ? (
            <Link to="/dashboard" className="btn btn-ghost pricing-quiet">← Back to Crest</Link>
          ) : (
            <button type="button" className="btn btn-ghost pricing-quiet" onClick={() => navigate(-1)}>
              ← Back
            </button>
          )}
          {!session && (
            <Link to="/signup" className="btn btn-primary pricing-commit pricing-commit--footer">
              Start Free Trial →
            </Link>
          )}
          <a href={`mailto:${contactEmail}`} className="btn btn-ghost pricing-quiet pricing-quiet--mail">
            <Mail size={15} strokeWidth={2} aria-hidden="true" /> Email us
          </a>
        </div>
        <p className="pricing-copyright">© {new Date().getFullYear()} · {COMPANY.name} · Kathmandu, Nepal</p>
          {/* Every public page carries the same pair. Plain anchors rather than router Links so
              the markup is identical to the login and legal footers. */}
          <p className="pricing-legal">
            <a href="/legal/terms">Terms of Service</a>
            <a href="/legal/privacy">Privacy Policy</a>
          </p>
      </div>

      </main>
    </div>
  )
}
