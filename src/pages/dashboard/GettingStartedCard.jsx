import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { useSupportContact } from '../../shared/hooks/useSupportContact'

// The one place a new owner is told what to do first, in order, with a tick that appears the
// moment each step is done — and with an HR and a POS list beside the IMS one when those modules
// are on and empty (S697). Before this the card covered IMS only, so an owner whose real interest
// was payroll or the till got no nudge at all on the dashboard, only a static page under Help.
//
// Two visibility rules, decided by the parent and this card together:
//   - The PARENT renders it when IMS is empty (no items, no purchases) or the client is on a trial.
//     That keeps the paying-client rule from before: items exist, the card is gone, because every
//     new month starts at purchaseTotal 0 and this must never reappear monthly.
//   - THIS card decides which sections to show. On a trial every enabled module's list stays until
//     its steps are all done, and the card removes itself when none remain. Off-trial, HR and POS
//     appear only while their FIRST step is undone — a paying client with 40 employees does not
//     need to be told to add an employee.
//
// The HR and POS counts are read HERE, not in ClientDashboard's already-fifteen-query load: they
// are only needed when the card is on screen, which for most clients is never. A failed count is
// treated as "unknown" and that section is simply not shown — this is guidance, not a figure, and
// the firstError() rule for reports does not apply to a checklist.
export default function GettingStartedCard({ periodLabel, stats, isTrial, showHr, showPos }) {
  const navigate = useNavigate()
  const { clientId } = useAuth()
  const { scopedFrom } = useScopedDb()
  const support = useSupportContact()
  // null = not loaded yet; a section with a null count is withheld rather than shown at zero.
  const [counts, setCounts] = useState({ employees: null, attendance: null, tables: null, orders: null })
  const needHr  = !!showHr
  const needPos = !!showPos

  useEffect(() => {
    if (!clientId || (!needHr && !needPos)) return
    let cancelled = false
    const head = table => scopedFrom(table, '*', { count: 'exact', head: true })
    Promise.all([
      needHr  ? head('hr_employees')  : Promise.resolve(null),
      needHr  ? head('hr_attendance') : Promise.resolve(null),
      needPos ? head('pos_tables')    : Promise.resolve(null),
      needPos ? head('pos_orders')    : Promise.resolve(null),
    ]).then(([emp, att, tab, ord]) => {
      if (cancelled) return
      const n = r => (r && !r.error && typeof r.count === 'number') ? r.count : null
      setCounts({ employees: n(emp), attendance: n(att), tables: n(tab), orders: n(ord) })
    })
    return () => { cancelled = true }
  }, [clientId, needHr, needPos]) // eslint-disable-line react-hooks/exhaustive-deps

  const imsSteps = [
    { n: 1, label: 'Add your items', hint: 'Everything you buy — ingredients, drinks, supplies', to: '/items', done: stats.itemCount > 0 },
    { n: 2, label: 'Record your purchases', hint: 'Bills from your vendors for this period', to: '/purchases', done: stats.purchaseTotal > 0 },
    { n: 3, label: 'Build your recipes', hint: 'What each dish uses — this is what costs it', to: '/recipes', done: stats.recipeCount > 0 },
    { n: 4, label: 'Enter your sales', hint: 'Daily or bulk — this is the base every % is measured against', to: '/sales', done: stats.revenueTotal > 0 },
  ]
  const hrSteps = counts.employees === null ? null : [
    { n: 1, label: 'Add your employees', hint: 'Name, designation, join date and pay basis — then Pay Setup for their salary', to: '/hr/employees', done: counts.employees > 0 },
    { n: 2, label: 'Mark this month’s attendance', hint: 'Payroll reads attendance — Generate from Roster fills the month in one click', to: '/hr/attendance', done: (counts.attendance ?? 0) > 0 },
  ]
  const posSteps = counts.tables === null ? null : [
    { n: 1, label: 'Set up your tables', hint: 'Tables → Quick Setup builds a floor plan in one click', to: '/pos/tables', done: counts.tables > 0 },
    { n: 2, label: 'Bill your first order', hint: 'Open a shift, take an order, print the bill', to: '/pos', done: (counts.orders ?? 0) > 0 },
  ]

  const allDone = steps => steps.every(s => s.done)
  const sections = [
    { key: 'ims', title: 'Stock & costing', steps: imsSteps, show: isTrial ? !allDone(imsSteps) : true },
    { key: 'hr',  title: 'Staff & payroll', steps: hrSteps,  show: !!hrSteps  && (isTrial ? !allDone(hrSteps)  : !hrSteps[0].done) },
    { key: 'pos', title: 'Billing',         steps: posSteps, show: !!posSteps && (isTrial ? !allDone(posSteps) : !posSteps[0].done) },
  ].filter(s => s.show)
  if (sections.length === 0) return null
  const multi = sections.length > 1

  return (
    <div className="card" style={{ marginBottom: 20, borderColor: 'color-mix(in srgb, var(--theme-accent) 30%, transparent)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <p style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)' }}>
          {isTrial ? 'Your first week with Crest' : `Let’s get ${periodLabel} set up`}
        </p>
        <Link to="/help?section=guide" style={{ fontSize: 12, fontWeight: 600 }}>Full guide →</Link>
      </div>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
        {multi
          ? 'Your figures stay at zero until there’s something to count. Each list is in order — start with whichever part of the business matters most to you.'
          : 'Your figures below stay at zero until there’s something to count. Four steps, in order — each one feeds the next.'}
      </p>
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: multi ? 'repeat(auto-fit, minmax(260px, 1fr))' : '1fr' }}>
        {sections.map(sec => (
          <div key={sec.key}>
            {multi && (
              <p style={{ margin: '0 0 8px', fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--theme-text2)' }}>{sec.title}</p>
            )}
            <ol style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'grid', gap: 8 }}>
              {sec.steps.map(s => (
                <li key={s.n}>
                  <button
                    className="btn btn-ghost"
                    style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px' }}
                    onClick={() => navigate(s.to)}
                  >
                    <span style={{
                      flexShrink: 0, width: 22, height: 22, borderRadius: 'var(--radius-full)',
                      display: 'inline-grid', placeItems: 'center', fontSize: 11, fontWeight: 800,
                      background: s.done ? 'color-mix(in srgb, var(--theme-green) 18%, transparent)' : 'var(--theme-input-bg)',
                      color: s.done ? 'var(--theme-green-text)' : 'var(--theme-text2)',
                      border: '1px solid var(--theme-border)',
                    }}>{s.done ? '✓' : s.n}</span>
                    <span style={{ display: 'grid', gap: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>{s.label}</span>
                      <span style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{s.hint}</span>
                    </span>
                    <span style={{ marginLeft: 'auto', color: 'var(--theme-text3)' }} aria-hidden="true">→</span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
      {/* A person, not a tooltip. The support contact already exists (useSupportContact); on a
          trial the cheapest welcome available is a twenty-minute call, so offer it where the
          owner is deciding what to do first. */}
      {isTrial && (support.whatsappHref || support.telHref) && (
        <p style={{ margin: '14px 0 0', fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
          Stuck, or want a hand entering your first items? A twenty-minute call gets most kitchens set up.{' '}
          {support.whatsappHref && <a href={support.whatsappHref} target="_blank" rel="noreferrer">WhatsApp us</a>}
          {support.whatsappHref && support.telHref && ' or '}
          {support.telHref && <a href={support.telHref}>call {support.phone}</a>}.
        </p>
      )}
    </div>
  )
}
