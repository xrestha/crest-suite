import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MODULE_COLORS, IMS_TIERS, HR_PRICING, POS_PRICING, SUITE_BUNDLES } from '../data/pricingPlans'

// ── Change this to the contact email when ready ──────────────────────────────
const CONTACT_EMAIL = 'hello@cresthospitality.com'

const GOLD   = 'var(--theme-accent)'
const GREEN  = 'var(--theme-green)'
const BG     = 'var(--theme-bg)'
const CARD   = 'var(--theme-card)'
const BORDER = 'var(--theme-border)'

const FAQS = [
  {
    q: 'Is the 1-month trial really free?',
    a: 'Yes — the IMS Starter plan is completely free for the first month with no credit card and no hidden fees. After 1 month it continues at its listed monthly rate, or you can upgrade to Growth or Pro at any time.',
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
          <span style={{ color, fontSize: 13, flexShrink: 0, marginTop: 1 }}>✓</span>
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
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, fontFamily: 'Georgia, serif', color: 'var(--theme-text1)' }}>{title}</h2>
      </div>
      {subtitle && <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: 0 }}>{subtitle}</p>}
    </div>
  )
}

export default function Pricing() {
  const [annual, setAnnual]   = useState(false)
  const [showFaq, setShowFaq] = useState(false)
  const navigate = useNavigate()

  return (
    <div style={{ minHeight: '100vh', background: BG, color: 'var(--theme-text1)', fontFamily: 'system-ui, -apple-system, sans-serif' }}>

      {/* Nav */}
      <nav style={{ background: CARD, borderBottom: `1px solid ${BORDER}`, padding: '0 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 64, position: 'sticky', top: 0, zIndex: 100 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 24, color: GOLD }}>⬢</span>
          <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>Crest Inventory</span>
        </div>
        <button
          onClick={() => navigate('/login')}
          style={{ background: 'rgba(201,168,76,0.1)', border: `1px solid rgba(201,168,76,0.35)`, color: GOLD, padding: '8px 22px', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          Login →
        </button>
      </nav>

      {/* Hero */}
      <div style={{ textAlign: 'center', padding: '72px 32px 52px' }}>
        <div style={{ display: 'inline-block', background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)', borderRadius: 20, padding: '5px 18px', fontSize: 12, color: GREEN, marginBottom: 24, letterSpacing: '0.06em', fontWeight: 600 }}>
          1-week free trial · No credit card required
        </div>
        <h1 style={{ fontSize: 44, fontWeight: 800, margin: '0 0 16px', fontFamily: 'Georgia, serif', lineHeight: 1.15, color: 'var(--theme-text1)' }}>
          Simple, honest pricing
        </h1>
        <p style={{ fontSize: 16, color: 'var(--theme-text2)', margin: '0 auto 44px', maxWidth: 560, lineHeight: 1.7 }}>
          Built for Nepal's restaurants and cafes. Works in BS calendar, NPR, and FonePay — no Western SaaS workarounds needed.
          Buy Crest IMS, Crest HR, and Crest POS separately, or bundle all three as Crest Suite for a discount.
        </p>

        {/* Billing toggle */}
        <div style={{ display: 'inline-flex', background: CARD, border: `1px solid ${BORDER}`, borderRadius: 9, padding: 4, gap: 2 }}>
          <button
            onClick={() => setAnnual(false)}
            style={{ background: !annual ? 'rgba(201,168,76,0.15)' : 'none', border: !annual ? `1px solid rgba(201,168,76,0.3)` : '1px solid transparent', color: !annual ? GOLD : 'var(--theme-text2)', padding: '8px 22px', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            Monthly
          </button>
          <button
            onClick={() => setAnnual(true)}
            style={{ background: annual ? 'rgba(201,168,76,0.15)' : 'none', border: annual ? `1px solid rgba(201,168,76,0.3)` : '1px solid transparent', color: annual ? GOLD : 'var(--theme-text2)', padding: '8px 22px', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
            Annual
            <span style={{ background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.25)', color: GREEN, fontSize: 10, padding: '2px 8px', borderRadius: 10, fontWeight: 700, letterSpacing: '0.04em' }}>
              Save 25%
            </span>
          </button>
        </div>
      </div>

      {/* ── Crest IMS — 3 tiers ── */}
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px 24px' }}>
        <SectionHeading color={MODULE_COLORS.ims} title="Crest IMS" subtitle="Inventory, recipe costing & food-cost intelligence" />
      </div>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px 64px', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
        {IMS_TIERS.map(plan => {
          const highlight = plan.key === 'growth'
          const price = annual ? plan.annual : plan.monthly
          return (
            <div key={plan.key} style={{
              background: CARD,
              border: highlight ? `1px solid ${MODULE_COLORS.ims}70` : `1px solid ${BORDER}`,
              borderRadius: 14, padding: '36px 28px 28px', position: 'relative',
              display: 'flex', flexDirection: 'column',
              boxShadow: highlight ? `0 4px 48px ${MODULE_COLORS.ims}22` : 'none',
            }}>
              {highlight && (
                <div style={{ position: 'absolute', top: -13, left: '50%', transform: 'translateX(-50%)', background: MODULE_COLORS.ims, color: '#0b0b0b', fontSize: 10, fontWeight: 800, padding: '4px 14px', borderRadius: 10, letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                  Most Popular
                </div>
              )}

              <div style={{ marginBottom: 20 }}>
                <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>{plan.label}</span>
              </div>

              <div style={{ marginBottom: 22, paddingBottom: 22, borderBottom: `1px solid ${BORDER}` }}>
                {plan.key === 'starter' && !annual ? (
                  <>
                    <div style={{ fontSize: 11, color: MODULE_COLORS.ims, fontWeight: 800, marginBottom: 5, letterSpacing: '0.07em' }}>FREE FOR 1 MONTH</div>
                    <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--theme-text1)', lineHeight: 1 }}>
                      NPR {plan.monthly.toLocaleString()}
                      <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--theme-text2)' }}>/mo after</span>
                    </div>
                  </>
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
                style={{ background: highlight ? MODULE_COLORS.ims : `${MODULE_COLORS.ims}14`, border: `1px solid ${highlight ? MODULE_COLORS.ims : MODULE_COLORS.ims + '40'}`, color: highlight ? '#0b0b0b' : MODULE_COLORS.ims, padding: '11px 20px', borderRadius: 7, cursor: 'pointer', fontSize: 14, fontWeight: 700, marginBottom: 22, width: '100%' }}>
                {plan.key === 'starter' ? 'Start Free Trial' : `Get ${plan.label}`} →
              </button>

              <div style={{ flex: 1 }}>
                {plan.includesLabel && (
                  <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginBottom: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                    {plan.includesLabel}
                  </div>
                )}
                <FeatureList features={plan.features} color={MODULE_COLORS.ims} />
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Crest HR + Crest POS — flat modules ── */}
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px 24px' }}>
        <SectionHeading color={MODULE_COLORS.hr} title="Crest HR & Crest POS" subtitle="Payroll and floor operations — buy either one on its own" />
      </div>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px 64px', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 20 }}>
        {[
          { key: 'hr',  name: 'Crest HR',  color: MODULE_COLORS.hr,  tagline: 'Nepal-compliant payroll, attendance, and staff management.', pricing: HR_PRICING },
          { key: 'pos', name: 'Crest POS', color: MODULE_COLORS.pos, tagline: 'Tables, orders, billing, and shift reconciliation.',             pricing: POS_PRICING },
        ].map(mod => {
          const price = annual ? mod.pricing.annual : mod.pricing.monthly
          return (
            <div key={mod.key} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: '36px 28px 28px', display: 'flex', flexDirection: 'column' }}>
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>{mod.name}</span>
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
                style={{ background: `${mod.color}14`, border: `1px solid ${mod.color}40`, color: mod.color, padding: '11px 20px', borderRadius: 7, cursor: 'pointer', fontSize: 14, fontWeight: 700, marginBottom: 22, width: '100%' }}>
                Get {mod.name} →
              </button>

              <FeatureList features={mod.pricing.features} color={mod.color} />
            </div>
          )
        })}
      </div>

      {/* ── Crest Suite — bundle ── */}
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px 24px' }}>
        <SectionHeading color={GOLD} title="Crest Suite" subtitle="IMS + HR + POS together, at a discount vs buying each separately" />
      </div>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px 80px', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
        {SUITE_BUNDLES.map((bundle, i) => {
          const imsTier = IMS_TIERS[i]
          const price = annual ? bundle.annual : bundle.monthly
          const sumMonthly = imsTier.monthly + HR_PRICING.monthly + POS_PRICING.monthly
          const sumPrice = annual ? Math.round((imsTier.annual + HR_PRICING.annual + POS_PRICING.annual)) : sumMonthly
          return (
            <div key={bundle.key} style={{ background: CARD, border: `1px solid rgba(201,168,76,0.3)`, borderRadius: 14, padding: '30px 24px', textAlign: 'center' }}>
              <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif', marginBottom: 12 }}>{bundle.label}</div>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)', textDecoration: 'line-through', marginBottom: 2 }}>NPR {sumPrice.toLocaleString()}/mo separately</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--theme-text1)', marginBottom: 4 }}>
                NPR {price.toLocaleString()}<span style={{ fontSize: 13, fontWeight: 400, color: 'var(--theme-text2)' }}>/mo</span>
              </div>
              {annual && <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginBottom: 14 }}>Billed annually · NPR {(price * 12).toLocaleString()}/yr</div>}
              <div style={{ fontSize: 11, fontWeight: 700, color: GREEN, marginBottom: 18 }}>
                Save NPR {(sumMonthly - bundle.monthly).toLocaleString()}/mo vs buying separately
              </div>
              <button
                onClick={() => navigate('/login')}
                style={{ background: i === 2 ? GOLD : `${GOLD}14`, border: `1px solid ${GOLD}`, color: i === 2 ? '#0b0b0b' : GOLD, padding: '11px 20px', borderRadius: 7, cursor: 'pointer', fontSize: 14, fontWeight: 700, width: '100%' }}>
                Get {bundle.label} →
              </button>
            </div>
          )
        })}
      </div>

      {/* FAQ button */}
      <div style={{ textAlign: 'center', padding: '0 24px 80px' }}>
        <button
          onClick={() => setShowFaq(true)}
          style={{ background: 'rgba(201,168,76,0.08)', border: `1px solid rgba(201,168,76,0.25)`, color: GOLD, padding: '11px 28px', borderRadius: 7, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
          FAQ — Common Questions
        </button>
      </div>

      {/* FAQ modal */}
      {showFaq && (
        <div
          onClick={() => setShowFaq(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, width: '100%', maxWidth: 640, maxHeight: '80vh', overflow: 'auto', padding: '36px 32px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 }}>
              <h2 style={{ margin: 0, fontSize: 22, fontFamily: 'Georgia, serif', color: 'var(--theme-text1)' }}>Common Questions</h2>
              <button onClick={() => setShowFaq(false)} style={{ background: 'none', border: 'none', color: 'var(--theme-text2)', fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
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
        <h2 style={{ fontSize: 28, margin: '0 0 12px', fontFamily: 'Georgia, serif', color: 'var(--theme-text1)' }}>
          Ready to take control of your food costs?
        </h2>
        <p style={{ fontSize: 14, color: 'var(--theme-text2)', margin: '0 0 36px', lineHeight: 1.6 }}>
          Start free today. No credit card. No commitment. Cancel any time.
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 48 }}>
          <button
            onClick={() => navigate(-1)}
            style={{ background: 'none', border: `1px solid ${BORDER}`, color: 'var(--theme-text2)', padding: '13px 24px', borderRadius: 7, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
            ← Back
          </button>
          <button
            onClick={() => navigate('/login?trial=1')}
            style={{ background: GOLD, border: 'none', color: 'var(--theme-bg)', padding: '13px 32px', borderRadius: 7, cursor: 'pointer', fontSize: 14, fontWeight: 700 }}>
            Start Free Trial →
          </button>
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            style={{ background: 'none', border: `1px solid ${BORDER}`, color: 'var(--theme-text2)', padding: '13px 28px', borderRadius: 7, textDecoration: 'none', fontSize: 14, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            ✉ Email us
          </a>
        </div>
        <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: 0 }}>© 2083 BS · Crest Hospitality · Kathmandu, Nepal</p>
      </div>
    </div>
  )
}
