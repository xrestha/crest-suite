import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSettings } from '../context/SettingsContext'

const MODULES = [
  {
    icon: '◷', name: 'Periods', color: '#c9a84c',
    guide: 'Create one period per BS month. A period must be open before you can enter purchases, stock, or sales. Close a period at month end to lock the data. Archive old periods to keep dropdowns clean.',
    tips: ['Always create a new period before the month starts', 'Close the period only after entering closing stock', 'You can reopen a closed period if you missed an entry']
  },
  {
    icon: '≡', name: 'Item Master', color: '#c9a84c',
    guide: 'Your ingredient database. Every item needs a name, category, UOM (unit of measure), purchase quantity per pack, and rate per pack. The system calculates Per UOM Rate automatically. Set conversion factors if you buy in bulk packs but use in smaller units.',
    tips: ['Use consistent UOMs — GM for solids, ML for liquids', 'Set conversion factor if 1 case = 24 bottles etc.', 'Hide items you no longer use instead of deleting them']
  },
  {
    icon: '⊙', name: 'Vendors', color: '#c9a84c',
    guide: 'Add all your suppliers here. Linking purchases to vendors lets you track spend per supplier and identify price trends over time.',
    tips: ['Add all vendors before starting purchase entries', 'You can add a vendor mid-month without affecting past entries']
  },
  {
    icon: '↓', name: 'Purchases', color: '#c9a84c',
    guide: 'Record every ingredient purchase here. Select the item, vendor, day of month, quantity, and rate. The rate auto-fills from the item master but can be overridden if the supplier charged a different price. Add expiry date for perishables and select payment method (Cash/Credit/FonePay).',
    tips: ['Enter purchases daily or in batches — both work', 'Always enter the actual invoice rate, not the master rate, if they differ', 'Add invoice reference number for audit trail']
  },
  {
    icon: '⊞', name: 'Stock Count', color: '#c9a84c',
    guide: 'Three tabs: Opening Stock (enter at start of month), Closing Stock (physical count at month end), Wastage (spoilage recorded during the month). The Summary tab shows actual used qty per item automatically.',
    tips: ['Print the Stock Count Sheet and do a physical walk before entering closing stock', 'Enter opening stock before any purchases for accurate COGS', 'Wastage should be recorded as it happens, not estimated at month end']
  },
  {
    icon: '◈', name: 'Recipe Costing', color: '#c9a84c',
    guide: 'Build your menu items here. Add ingredients with qty per portion — the system calculates food cost automatically using latest purchase rates. Enter your selling price to see food cost % and get a suggested price at 30% FC target.',
    tips: ['Food cost % below 30% is excellent, 30-38% is acceptable, above 38% needs review', 'Update recipes when ingredient prices change significantly', 'Use the suggested price as a starting point for menu pricing decisions']
  },
  {
    icon: '↑', name: 'Sales Entry', color: '#c9a84c',
    guide: 'Two modes: Daily Entry (enter qty sold per day) or Bulk Entry (enter total sold for the whole period). Only items with a recipe built appear here. Revenue is calculated automatically from selling price × qty sold.',
    tips: ['Use Bulk Entry if you have a POS report with monthly totals', 'Use Daily Entry for manual tracking or granular reporting', 'Accurate sales data is critical for the Variance Report to work correctly']
  },
  {
    icon: '△', name: 'Variance Report', color: '#c9a84c',
    guide: 'The most important report. Compares theoretical usage (what should have been used based on sales × recipe) against actual usage (opening + purchases − closing − wastage). Positive variance means more was used than sold — pointing to waste, theft, or over-portioning.',
    tips: ['Sort by NPR value to see biggest leaks first', 'Items with no recipe show no theoretical usage — variance equals actual used', 'A variance above 10% on a high-value item needs immediate investigation']
  },
  {
    icon: '◻', name: 'Monthly Summary', color: '#c9a84c',
    guide: 'The month-end financial report. Shows opening stock, purchases, wastage, closing stock, and COGS by category. Food cost % is calculated against sales revenue. Export to Excel for your accountant or management review.',
    tips: ['Food cost % benchmark for cafes is 28-35%', 'High purchase-based FC% vs actual FC% gap suggests closing stock errors', 'Share this report with ownership monthly']
  },
]

const GLOSSARY = [
  { term: 'Food Cost %', def: 'Cost of ingredients used ÷ Revenue × 100. The primary profitability metric for F&B operations. Industry benchmark: 28–35%.' },
  { term: 'COGS', def: 'Cost of Goods Sold. Opening Stock + Purchases − Wastage − Closing Stock. The actual cost of ingredients consumed in the period.' },
  { term: 'Per UOM Rate', def: 'Cost per single unit of measure. If 1 KG of chicken costs NPR 700, the per UOM rate is NPR 0.70 per gram.' },
  { term: 'Theoretical Usage', def: 'What should have been used based on qty sold × recipe ingredient qty. Calculated from sales entries and recipes.' },
  { term: 'Actual Usage', def: 'What was actually used: Opening Stock + Purchases − Closing Stock − Wastage.' },
  { term: 'Variance', def: 'Actual Usage − Theoretical Usage. Positive variance = more used than expected. Indicates waste, theft, or over-portioning.' },
  { term: 'FIFO', def: 'First In, First Out. Use oldest stock before newer stock. Critical for perishables to minimise expiry waste.' },
  { term: 'Opening Stock', def: 'Quantity of each ingredient at the start of the period (carried over from previous month closing stock).' },
  { term: 'Closing Stock', def: 'Physical count of each ingredient at the end of the period.' },
  { term: 'Conversion Factor', def: 'How many base units are in one purchase unit. E.g. 1 case = 24 bottles → conversion factor = 24.' },
  { term: 'BS Calendar', def: 'Bikram Sambat calendar used in Nepal. The system works natively in BS months.' },
  { term: 'Par Level', def: 'Minimum stock quantity before reordering. Used in the Reorder Report to flag items running low.' },
]

const STARTER_FEATURES = [
  'Dashboard & KPI overview',
  'Item Master with unit conversion',
  'Vendor management',
  'BS calendar periods',
  'Purchases + vendor returns',
  'Stock count (opening / closing / wastage)',
]
const GROWTH_EXTRAS = [
  'Sales entry',
  'Recipe costing & live FC%',
  'Variance report',
  'Monthly summary (COGS)',
  'Payment summary (Cash / Credit / FonePay)',
  'Reorder report & par levels',
]
const PRO_EXTRAS = [
  'Menu engineering (Star / Puzzle / Dog)',
  'FIFO / expiry tracking',
  'Vendor spend report',
  'Supplier price tracker',
  'Overheads & true margin analysis',
  'Custom branding & settings',
]
const PRICE_PLANS = [
  { name: 'Starter', icon: '◎', color: '#c9a84c', badge: '1 Month Free', badgeBg: '#c9a84c',              monthly: 8000, annual: 5000, features: STARTER_FEATURES, highlight: false, cta: 'Start Free Trial' },
  { name: 'Growth',  icon: '◈', color: '#34d399', badge: 'Most Popular',   badgeBg: 'rgba(52,211,153,0.9)', monthly: 18000, annual: 10000, features: GROWTH_EXTRAS,    highlight: true,  cta: 'Get Growth' },
  { name: 'Pro',     icon: '⬡', color: '#818cf8', badge: 'Full Suite',     badgeBg: '#818cf8',              monthly: 25000, annual: 15000, features: PRO_EXTRAS,       highlight: false, cta: 'Get Pro' },
]

const FAQ = [
  { q: 'Why is my food cost % so high?', a: 'Common causes: purchases entered without closing stock (inflates COGS), over-portioning, wastage not recorded, theft, or supplier price increases not reflected in selling prices. Check the Variance Report to identify the biggest leaks.' },
  { q: 'What if I forgot to enter a purchase?', a: 'Go to Purchases, select the correct period, and add the entry with the correct day. The system recalculates everything automatically.' },
  { q: 'How do I correct a wrong entry?', a: 'Every entry has an Edit button. Click it, correct the values, and save. No need to delete and re-enter.' },
  { q: 'Why does my Variance Report show no theoretical usage?', a: 'Either you have not entered Sales Entries for the period, or the items have no Recipe built. Both are needed for theoretical usage to calculate.' },
  { q: 'Can two staff members enter data at the same time?', a: 'Yes. The system is cloud-based and supports multiple users simultaneously.' },
  { q: 'What happens to data when I close a period?', a: 'Closing a period locks it from further editing. All data is preserved permanently. You can view closed period reports at any time.' },
  { q: 'How do I add a new menu item to recipe costing?', a: 'Go to Recipe Costing → New Recipe. Add ingredients from your Item Master with qty per portion. The system calculates food cost instantly.' },
]

export default function Help() {
  const [activeSection, setActiveSection] = useState('guide')
  const [expandedModule, setExpandedModule] = useState(null)
  const [expandedFaq, setExpandedFaq] = useState(null)
  const [pricingAnnual, setPricingAnnual] = useState(false)
  const { settings } = useSettings()
  const navigate = useNavigate()
  const phone   = settings?.contact_phone   || ''
  const email   = settings?.contact_email   || ''
  const website = settings?.contact_website || ''

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Help & Guide</h1>
        <p className="page-subtitle">How to use every feature — glossary, FAQ, and tips</p>
      </div>

      {/* Section tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 28, borderBottom: '1px solid #2a2f3d' }}>
        {[
          { id: 'guide', label: 'Getting Started' },
          { id: 'modules', label: 'Module Guide' },
          { id: 'glossary', label: 'Glossary' },
          { id: 'faq', label: 'FAQ' },
          { id: 'pricing', label: '💎 Pricing' },
        ].map(s => (
          <button key={s.id} onClick={() => setActiveSection(s.id)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '10px 20px', fontSize: 13, fontWeight: 500,
            color: activeSection === s.id ? '#c9a84c' : '#6b7280',
            borderBottom: activeSection === s.id ? '2px solid #c9a84c' : '2px solid transparent',
            marginBottom: -1
          }}>{s.label}</button>
        ))}
      </div>

      {/* GETTING STARTED */}
      {activeSection === 'guide' && (
        <div>

          {/* Welcome */}
          <div className="card" style={{ marginBottom: 16, background: 'rgba(201,168,76,0.03)', borderColor: 'rgba(201,168,76,0.2)' }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 32, lineHeight: 1, flexShrink: 0 }}>⬡</span>
              <div>
                <h3 style={{ margin: '0 0 8px', fontSize: 15, color: '#e8e0d0' }}>Welcome to Crest Inventory</h3>
                <p style={{ margin: '0 0 8px', fontSize: 13, color: '#6b7280', lineHeight: 1.75 }}>
                  Crest tracks your ingredient purchases, stock levels, and food cost in real time. The core idea is simple:
                </p>
                <div style={{ background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 6, padding: '10px 16px', display: 'inline-block', marginBottom: 8 }}>
                  <span style={{ fontSize: 13, color: '#c9a84c', fontWeight: 600 }}>Opening Stock + Purchases − Wastage − Closing Stock = COGS (what you actually used)</span>
                </div>
                <p style={{ margin: 0, fontSize: 13, color: '#6b7280', lineHeight: 1.75 }}>
                  Follow the steps below to get set up. First-time setup takes about 30–60 minutes. After that, the monthly routine takes 15–20 minutes of admin at month end.
                </p>
              </div>
            </div>
          </div>

          {/* First-Time Setup */}
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 15, color: '#e8e0d0' }}>First-Time Setup</h3>
            <p style={{ margin: '0 0 20px', fontSize: 12, color: '#6b7280' }}>Do this once when you first log in. Takes 30–60 minutes.</p>
            {[
              {
                step: 1, title: 'Add your Ingredients', route: 'Item Master',
                desc: 'Go to Item Master → add every ingredient you buy. Each item needs a name, category, unit of measure (UOM), pack size, and rate per pack.',
                why: 'Every purchase and stock count is linked to items here. You cannot enter purchases without items.',
              },
              {
                step: 2, title: 'Add your Vendors', route: 'Vendors',
                desc: 'Go to Vendors → add all your suppliers.',
                why: 'Every purchase must be linked to a vendor. Add at least one before entering any purchase.',
              },
              {
                step: 3, title: 'Create your first Period', route: 'Periods',
                desc: 'Go to Periods → New Period → select the current BS year and month → Create.',
                why: 'All purchases, stock, and sales live inside a period. Nothing can be entered without an open period.',
              },
              {
                step: 4, title: 'Enter Opening Stock', route: 'Stock Count',
                desc: 'Go to Stock Count → Opening Stock tab → enter the quantity of each ingredient you have right now.',
                why: 'COGS calculation starts from opening stock. Skip this and your food cost % will be wrong for the first month.',
              },
              {
                step: 5, title: 'Build your Recipes', route: 'Recipe Costing', plan: 'Growth+',
                desc: 'Go to Recipe Costing → New Recipe → add each menu item with its ingredients and selling price.',
                why: 'Required for the Variance Report and food cost % per dish. Skip this step if you are on the Starter plan.',
              },
            ].map((s, i, arr) => (
              <div key={s.step} style={{ display: 'flex', gap: 16, marginBottom: 16, paddingBottom: 16, borderBottom: i < arr.length - 1 ? '1px solid #2a2f3d' : 'none' }}>
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(201,168,76,0.12)', border: '1px solid rgba(201,168,76,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#c9a84c', flexShrink: 0 }}>{s.step}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#e8e0d0' }}>{s.title}</span>
                    {s.plan && <span style={{ fontSize: 10, fontWeight: 700, color: '#818cf8', background: 'rgba(129,140,248,0.1)', border: '1px solid rgba(129,140,248,0.2)', padding: '1px 7px', borderRadius: 8 }}>{s.plan}</span>}
                  </div>
                  <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 6 }}>{s.desc}</div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                    <span style={{ color: '#c9a84c', fontSize: 11, marginTop: 1, flexShrink: 0 }}>Why:</span>
                    <span style={{ fontSize: 12, color: '#6b7280' }}>{s.why}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Monthly Workflow */}
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 15, color: '#e8e0d0' }}>Monthly Workflow</h3>
            <p style={{ margin: '0 0 20px', fontSize: 12, color: '#6b7280' }}>Repeat this every BS month. Steps 1–4 are ongoing during the month; steps 5–9 happen at month end.</p>
            {[
              { step: 1, title: 'Open a new Period',            desc: 'Periods → New Period → select BS month → Create. Do this on day 1 of the month.' },
              { step: 2, title: 'Enter Opening Stock',           desc: 'Stock Count → Opening Stock tab → enter qty for each item. For month 2 onward, this auto-carries from last month\'s closing.' },
              { step: 3, title: 'Record Purchases as they arrive', desc: 'Purchases → Add Purchase → enter vendor, item, qty, rate, payment method. Enter each bill on the day it arrives.' },
              { step: 4, title: 'Record Wastage as it happens',  desc: 'Stock Count → Wastage tab → log any spoilage or discards on the day.' },
              { step: 5, title: 'Enter Sales', plan: 'Growth+',  desc: 'Sales Entry → enter qty sold per menu item. Use Bulk Entry if you have a POS or month-end tally.' },
              { step: 6, title: 'Physical Stock Count',           desc: 'On the last day: print the Stock Count Sheet (Stock → Print Sheet), do a physical walk of your storeroom, enter counts in Stock Count → Closing Stock.' },
              { step: 7, title: 'Review Monthly Summary',        desc: 'Monthly Summary → check food cost %, COGS per category, and revenue. Export to Excel for management.' },
              { step: 8, title: 'Review Variance Report', plan: 'Growth+', desc: 'Variance → sort by NPR value → investigate any item with >10% variance. High variance = waste, theft, or over-portioning.' },
              { step: 9, title: 'Close the Period',              desc: 'Periods → Close → confirm. Locks all data. Closing stock automatically becomes opening stock for next month.' },
            ].map((s, i, arr) => (
              <div key={s.step} style={{ display: 'flex', gap: 14, marginBottom: 12, paddingBottom: 12, borderBottom: i < arr.length - 1 ? '1px solid #1e2330' : 'none' }}>
                <div style={{ width: 26, height: 26, borderRadius: '50%', background: '#0f1117', border: '1px solid #2a2f3d', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#c9a84c', flexShrink: 0 }}>{s.step}</div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#e8e0d0' }}>{s.title}</span>
                    {s.plan && <span style={{ fontSize: 10, fontWeight: 700, color: '#818cf8', background: 'rgba(129,140,248,0.1)', border: '1px solid rgba(129,140,248,0.2)', padding: '1px 7px', borderRadius: 8 }}>{s.plan}</span>}
                  </div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Common Mistakes */}
          <div className="card" style={{ borderColor: 'rgba(248,113,113,0.15)' }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 15, color: '#e8e0d0' }}>Common Mistakes to Avoid</h3>
            {[
              { icon: '✕', text: 'Closing a period before entering closing stock — your COGS will be inflated with no closing offset.' },
              { icon: '✕', text: 'Skipping opening stock in month 1 — your food cost % will be artificially high.' },
              { icon: '✕', text: 'Entering all purchases at month end from memory — enter them daily from the actual invoice for an accurate rate and vendor record.' },
              { icon: '✕', text: 'Ignoring the Variance Report — if you don\'t check it, waste and over-portioning go undetected for months.' },
              { icon: '✕', text: 'Using estimated closing stock — always do a physical count. Estimated numbers make every report inaccurate.' },
            ].map((m, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, marginBottom: i < 4 ? 10 : 0 }}>
                <span style={{ color: '#f87171', fontSize: 12, flexShrink: 0, marginTop: 1 }}>{m.icon}</span>
                <span style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.6 }}>{m.text}</span>
              </div>
            ))}
          </div>

        </div>
      )}

      {/* MODULE GUIDE */}
      {activeSection === 'modules' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {MODULES.map(mod => (
            <div key={mod.name} className="card" style={{ cursor: 'pointer', padding: '0' }}>
              <div
                onClick={() => setExpandedModule(expandedModule === mod.name ? null : mod.name)}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 16, color: mod.color }}>{mod.icon}</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: '#e8e0d0' }}>{mod.name}</span>
                </div>
                <span style={{ color: '#9ca3af', fontSize: 16 }}>{expandedModule === mod.name ? '▲' : '▼'}</span>
              </div>
              {expandedModule === mod.name && (
                <div style={{ padding: '0 20px 20px', borderTop: '1px solid #2a2f3d' }}>
                  <p style={{ fontSize: 13, color: '#6b7280', marginTop: 16, lineHeight: 1.7 }}>{mod.guide}</p>
                  <div style={{ marginTop: 12 }}>
                    <p style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>Tips</p>
                    {mod.tips.map((tip, i) => (
                      <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                        <span style={{ color: '#c9a84c', fontSize: 12, marginTop: 1 }}>→</span>
                        <span style={{ fontSize: 12, color: '#6b7280' }}>{tip}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* GLOSSARY */}
      {activeSection === 'glossary' && (
        <div className="card">
          <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: '30%' }}>Term</th>
                <th>Definition</th>
              </tr>
            </thead>
            <tbody>
              {GLOSSARY.map(g => (
                <tr key={g.term}>
                  <td style={{ fontWeight: 700, color: '#c9a84c' }}>{g.term}</td>
                  <td style={{ color: '#6b7280', lineHeight: 1.6 }}>{g.def}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* PRICING */}
      {activeSection === 'pricing' && (
        <div>
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <h2 style={{ fontSize: 20, margin: '0 0 8px', fontFamily: 'Georgia, serif', color: '#e8e0d0' }}>Plans & Pricing</h2>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 20px' }}>Choose the plan that fits your property</p>
            <div style={{ display: 'inline-flex', background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 8, padding: 3, gap: 2 }}>
              <button onClick={() => setPricingAnnual(false)} style={{ background: !pricingAnnual ? 'rgba(201,168,76,0.15)' : 'none', border: !pricingAnnual ? '1px solid rgba(201,168,76,0.3)' : '1px solid transparent', color: !pricingAnnual ? '#c9a84c' : '#6b7280', padding: '6px 18px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Monthly</button>
              <button onClick={() => setPricingAnnual(true)}  style={{ background:  pricingAnnual ? 'rgba(201,168,76,0.15)' : 'none', border:  pricingAnnual ? '1px solid rgba(201,168,76,0.3)' : '1px solid transparent', color:  pricingAnnual ? '#c9a84c' : '#6b7280', padding: '6px 18px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                Annual <span style={{ background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.25)', color: '#34d399', fontSize: 9, padding: '2px 7px', borderRadius: 8, fontWeight: 700 }}>Save 40%</span>
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
            {PRICE_PLANS.map(plan => (
              <div key={plan.name} className="card" style={{ border: plan.highlight ? '1px solid rgba(201,168,76,0.45)' : '1px solid #2a2f3d', position: 'relative', display: 'flex', flexDirection: 'column', padding: '32px 22px 22px', boxShadow: plan.highlight ? '0 4px 32px rgba(201,168,76,0.07)' : 'none' }}>
                <div style={{ position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)', background: plan.badgeBg, color: '#0f1117', fontSize: 9, fontWeight: 800, padding: '3px 12px', borderRadius: 8, letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                  {plan.badge}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 18, color: plan.color }}>{plan.icon}</span>
                  <span style={{ fontSize: 16, fontWeight: 700, color: '#e8e0d0', fontFamily: 'Georgia, serif' }}>{plan.name}</span>
                </div>

                <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid #2a2f3d' }}>
                  {plan.name === 'Starter' && !pricingAnnual ? (
                    <>
                      <div style={{ fontSize: 10, color: '#c9a84c', fontWeight: 800, marginBottom: 4, letterSpacing: '0.07em' }}>FREE FOR 1 MONTH</div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: '#e8e0d0' }}>NPR {plan.monthly.toLocaleString()}<span style={{ fontSize: 12, fontWeight: 400, color: '#6b7280' }}>/mo after</span></div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 20, fontWeight: 800, color: '#e8e0d0' }}>NPR {(pricingAnnual ? plan.annual : plan.monthly).toLocaleString()}<span style={{ fontSize: 12, fontWeight: 400, color: '#6b7280' }}>/mo</span></div>
                      {pricingAnnual && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>Billed annually · NPR {((pricingAnnual ? plan.annual : plan.monthly) * 12).toLocaleString()}/yr</div>}
                    </>
                  )}
                </div>

                {plan.name !== 'Starter' && (
                  <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                    {plan.name === 'Growth' ? '+ Everything in Starter' : '+ Everything in Growth'}
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7, flex: 1 }}>
                  {plan.features.map((f, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
                      <span style={{ color: plan.color, fontSize: 12, flexShrink: 0, marginTop: 1 }}>✓</span>
                      <span style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.4 }}>{f}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Contact to upgrade */}
          <div className="card" style={{ borderColor: 'rgba(201,168,76,0.2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
              <div>
                <h3 style={{ margin: '0 0 4px', fontSize: 15, color: '#e8e0d0' }}>Ready to upgrade?</h3>
                <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>Contact your Crest consultant to change your plan.</p>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                {phone   && <a href={`tel:${phone}`}   style={{ color: '#c9a84c', fontSize: 13, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>📞 {phone}</a>}
                {email   && <a href={`mailto:${email}`} style={{ color: '#c9a84c', fontSize: 13, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>✉ {email}</a>}
                {website && <a href={website.startsWith('http') ? website : `https://${website}`} target="_blank" rel="noopener noreferrer" style={{ color: '#c9a84c', fontSize: 13, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>🌐 {website}</a>}
                {!phone && !email && !website && <span style={{ fontSize: 13, color: '#9ca3af' }}>Contact your Crest consultant to upgrade.</span>}
                <button onClick={() => navigate('/pricing')} style={{ background: 'rgba(201,168,76,0.1)', border: '1px solid rgba(201,168,76,0.3)', color: '#c9a84c', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                  View full pricing page →
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* FAQ */}
      {activeSection === 'faq' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {FAQ.map((item, i) => (
            <div key={i} className="card" style={{ padding: 0, cursor: 'pointer' }}>
              <div onClick={() => setExpandedFaq(expandedFaq === i ? null : i)}
                style={{ padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14, fontWeight: 500, color: '#e8e0d0' }}>{item.q}</span>
                <span style={{ color: '#9ca3af', fontSize: 14 }}>{expandedFaq === i ? '▲' : '▼'}</span>
              </div>
              {expandedFaq === i && (
                <div style={{ padding: '0 20px 16px', borderTop: '1px solid #2a2f3d' }}>
                  <p style={{ fontSize: 13, color: '#6b7280', marginTop: 12, lineHeight: 1.7 }}>{item.a}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
