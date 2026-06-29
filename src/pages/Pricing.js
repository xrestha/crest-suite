import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

// ── Change this to the contact email when ready ──────────────────────────────
const CONTACT_EMAIL = 'hello@cresthospitality.com'

const GOLD   = 'var(--theme-accent)'
const GREEN  = 'var(--theme-green)'
const INDIGO = '#4a6fa3'
const BG     = 'var(--theme-bg)'
const CARD   = 'var(--theme-card)'
const BORDER = 'var(--theme-border)'

const STARTER_FEATURES = [
  'Dashboard & KPI Overview',
  'Item Master with Unit Conversion',
  'Vendor Management',
  'BS Calendar Periods',
  'Purchases + Vendor Returns',
  'Stock Count (Opening / Closing / Wastage)',
  'Mobile App — Installable PWA, Offline Stock Counting',
  'Sales Entry (Bulk or Daily)',
  'Payment Summary (Cash / Credit / FonePay)',
  'Monthly & Annual Summary (COGS, BS Fiscal Year)',
  'Reorder Report & Par Levels',
  'VAT & Non-VAT Reports',
  'Wastage Report with Excel Export',
  'Settings & Outlet Customisation',
]

const GROWTH_EXTRAS = [
  'Recipe Costing & Live Food Cost %',
  'Variance Report (Theoretical vs Actual)',
  'Recipe Contribution Margin Report',
  'Menu Repricing (Underpriced Dish Finder)',
  'Best & Worst Sellers Analysis',
  'Budget vs Actual per Category',
  'Outstanding Payables with Aging',
  'Internal Requisitions (Store → Department)',
  'Dead Stock & Slow Mover Detection',
  'Staff Meals Tracking',
  'Nutrition Facts & Allergen Labels',
  'Purchase Orders (PO → GRN Workflow)',
]

const PRO_EXTRAS = [
  'Menu Engineering (Star / Puzzle / Plowhorse / Dog)',
  'Theoretical vs Actual Food Cost Variance',
  'Period Comparison (6 / 12 / 24 / All Periods)',
  'Shrinkage Report (Multi-Period Consistency)',
  'FIFO / Expiry Tracking',
  'Vendor Spend Report',
  'Supplier Price Tracker & Rate Alerts',
  'Overheads & True Margin Analysis',
]

const PLANS = [
  {
    name: 'Starter', icon: '◎', color: GOLD,
    tagline: 'Get your inventory under control',
    badge: '1 Month Free', badgeBg: GOLD,
    monthly: 5000, annual: 3750,
    features: STARTER_FEATURES, highlight: false,
    cta: 'Start Free Trial',
  },
  {
    name: 'Growth', icon: '◈', color: GREEN,
    tagline: 'Understand your food cost',
    badge: 'Most Popular', badgeBg: 'rgba(52,211,153,0.9)',
    monthly: 8000, annual: 6000,
    features: GROWTH_EXTRAS, highlight: true,
    cta: 'Get Growth',
  },
  {
    name: 'Pro', icon: '⬢', color: INDIGO,
    tagline: 'Run your kitchen like a business',
    badge: 'Full Suite', badgeBg: INDIGO,
    monthly: 12000, annual: 9000,
    features: PRO_EXTRAS, highlight: false,
    cta: 'Get Pro',
  },
]

const FAQS = [
  {
    q: 'Is the 1-month trial really free?',
    a: 'Yes — the Starter plan is completely free for the first month with no credit card and no hidden fees. After 1 month it continues at NPR 5,000/mo, or you can upgrade to Growth or Pro at any time.',
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
        <p style={{ fontSize: 16, color: 'var(--theme-text2)', margin: '0 auto 44px', maxWidth: 500, lineHeight: 1.7 }}>
          Built for Nepal's restaurants and cafes. Works in BS calendar, NPR, and FonePay — no Western SaaS workarounds needed.
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

      {/* Plan cards */}
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 24px 80px', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
        {PLANS.map(plan => (
          <div key={plan.name} style={{
            background: CARD,
            border: plan.highlight ? `1px solid rgba(201,168,76,0.45)` : `1px solid ${BORDER}`,
            borderRadius: 14, padding: '36px 28px 28px', position: 'relative',
            display: 'flex', flexDirection: 'column',
            boxShadow: plan.highlight ? '0 4px 48px rgba(201,168,76,0.08)' : 'none',
          }}>
            <div style={{ position: 'absolute', top: -13, left: '50%', transform: 'translateX(-50%)', background: plan.badgeBg, color: 'var(--theme-bg)', fontSize: 10, fontWeight: 800, padding: '4px 14px', borderRadius: 10, letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
              {plan.badge}
            </div>

            <div style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span style={{ fontSize: 22, color: plan.color }}>{plan.icon}</span>
                <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>{plan.name}</span>
              </div>
              <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: 0, lineHeight: 1.5 }}>{plan.tagline}</p>
            </div>

            {/* Price */}
            <div style={{ marginBottom: 22, paddingBottom: 22, borderBottom: `1px solid ${BORDER}` }}>
              {plan.name === 'Starter' && !annual ? (
                <>
                  <div style={{ fontSize: 11, color: GOLD, fontWeight: 800, marginBottom: 5, letterSpacing: '0.07em' }}>FREE FOR 1 MONTH</div>
                  <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--theme-text1)', lineHeight: 1 }}>
                    NPR {plan.monthly.toLocaleString()}
                    <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--theme-text2)' }}>/mo after</span>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--theme-text1)', lineHeight: 1 }}>
                    NPR {(annual ? plan.annual : plan.monthly).toLocaleString()}
                    <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--theme-text2)' }}>/mo</span>
                  </div>
                  {annual && (
                    <div style={{ fontSize: 12, color: 'var(--theme-text3)', marginTop: 6 }}>
                      Billed annually · NPR {((annual ? plan.annual : plan.monthly) * 12).toLocaleString()}/yr
                    </div>
                  )}
                </>
              )}
            </div>

            <button
              onClick={() => plan.name === 'Starter' ? navigate('/login?trial=1') : navigate('/login')}
              style={{ background: plan.highlight ? GOLD : 'rgba(201,168,76,0.08)', border: `1px solid ${plan.highlight ? GOLD : 'rgba(201,168,76,0.25)'}`, color: plan.highlight ? 'var(--theme-bg)' : GOLD, padding: '11px 20px', borderRadius: 7, cursor: 'pointer', fontSize: 14, fontWeight: 700, marginBottom: 22, width: '100%' }}>
              {plan.cta} →
            </button>

            <div style={{ flex: 1 }}>
              {plan.name !== 'Starter' && (
                <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginBottom: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  {plan.name === 'Growth' ? '+ Everything in Starter' : '+ Everything in Growth'}
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {plan.features.map((f, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
                    <span style={{ color: plan.color, fontSize: 13, flexShrink: 0, marginTop: 1 }}>✓</span>
                    <span style={{ fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.45 }}>{f}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
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
