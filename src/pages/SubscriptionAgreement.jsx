// The printable Subscription Agreement (Part D) — /legal/subscription-agreement/print?client=<id>
//
// A browser-printed A4 document, deliberately not a server-generated PDF: this project has no PDF
// dependency and the print stylesheet plus "Save as PDF" is the pattern every other printable
// document here already uses (EmployeeJoiningForm, PurchaseBillPrint, VendorBalanceConfirmation).
//
// TWO THINGS ABOUT THE GUARD, because this route is a shape that has leaked before.
//
// It is a SUB-ROUTE with no nav item, so nothing advertises it and nothing gates it — a page
// reachable by URL needs the guard its (absent) nav item implies, written INSIDE the component
// after every hook. SuiteGate/PremiumGate/ModuleGate would none of them help: none checks a role.
//
// And the client id is a URL PARAMETER, so "which client" is chosen by whoever types the address.
// A filter the parent screen would have done in memory has to become a real check here: a
// non-admin may only ever print their OWN client's agreement. Without that, any owner could read
// another tenant's legal name, PAN and monthly spend by editing a query string.

import { useEffect, useMemo, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'

import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { supabase } from '../supabaseClient'
import { withTimeout } from '../utils/withTimeout'
import ActionError, { asActionError } from '../components/ActionError'
import { printWithTitle } from '../utils/printTitle'
import { adToBs, BS_MONTHS } from '../utils/bsCalendar'
import { clientMrrBreakdown } from '../shared/clientMrr'
import { COMPANY, DOC_TYPES, PRODUCT_NAME, legalDoc, legalAbsoluteUrl, siteOrigin, legalReadiness } from '../legal'
import './SubscriptionAgreement.css'

// Crest is VAT-registered and every published price is exclusive of VAT, so the agreement has to
// show the tax it will actually be invoiced with. One definition, used for the line and the total.
const VAT_RATE = 0.13

const npr = (n) => `NPR ${Number(n || 0).toLocaleString('en-IN')}`

function bsLabel(date) {
  if (!date) return ''
  const bs = adToBs(date)
  if (!bs) return ''
  return `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}`
}

const adLabel = (date) =>
  date ? date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : ''

/** CS-AGR-<first 8 of the client uuid>-<yyyymmdd>. Stable for a given client on a given day. */
function agreementId(clientId, today) {
  const short = String(clientId || '').replace(/-/g, '').slice(0, 8).toUpperCase()
  const d = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`
  return `CS-AGR-${short}-${d}`
}

export default function SubscriptionAgreement() {
  const [params] = useSearchParams()
  const requestedId = params.get('client')
  const { isAdmin, isOwner, clientId, ready } = useAuth()
  const { settings } = useSettings()

  const [client, setClient] = useState(null)
  const [loadErr, setLoadErr] = useState(null)

  // Admin may print any client's agreement; anyone else only their own, whatever the URL says.
  const targetId = isAdmin ? (requestedId || clientId) : clientId

  useEffect(() => {
    if (!ready || !targetId) return undefined
    let alive = true
    ;(async () => {
      try {
        const { data, error } = await withTimeout(
          supabase.from('clients').select('*').eq('id', targetId).single(),
          20000,
          'Loading the client record'
        )
        if (!alive) return
        if (error) setLoadErr(asActionError(error, 'operator'))
        else setClient(data)
      } catch (e) {
        if (alive) setLoadErr(asActionError(e, 'operator'))
      }
    })()
    return () => { alive = false }
  }, [ready, targetId])

  const today = useMemo(() => new Date(), [])
  const breakdown = useMemo(
    () => (client ? clientMrrBreakdown(client, settings?.plan_prices) : { total: 0, lines: [] }),
    [client, settings]
  )

  // ── Guards. AFTER every hook, so the hook order is identical on every render. ──
  if (!ready) return null
  if (!isAdmin && !isOwner) return <Navigate to="/dashboard" replace />

  const annual = client?.billing_cycle === 'annual'
  const subtotal = breakdown.total
  const vat = Math.round(subtotal * VAT_RATE)
  const total = subtotal + vat
  const agrId = agreementId(targetId, today)
  // The product's own name, matching the hardcoded <h1> two lines below. It read settings.app_name,
  // so the running foot of a signed contract could identify itself by a tenant's trading name —
  // and signed out (or admin with no client selected) that resolves to the global settings row.
  const providerName = PRODUCT_NAME

  return (
    <div className="agr-page">
      <div className="agr-chrome no-print">
        <div>
          <strong>{agrId}</strong>
          <span> · {client ? client.name : 'Loading…'}</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!client}
            onClick={() => printWithTitle(`${agrId} - ${client?.legal_name || client?.name || 'Agreement'}`)}
          >
            Print / Save PDF
          </button>
        </div>
      </div>

      {!legalReadiness().ready && (
        <div className="agr-chrome agr-chrome--warn no-print">
          Not ready for signature — still missing {legalReadiness().missing.join(', ')}. An agreement
          incorporating a draft, or citing a document URL that has not been set, should not go to a
          client. SITE_ORIGIN is the production domain — see src/legal/index.js.
        </div>
      )}

      {loadErr && <div className="agr-chrome no-print"><ActionError error={loadErr} /></div>}

      {!client ? (
        <div className="agr-chrome no-print">Loading the client record…</div>
      ) : (
        <article className="agr-paper">
          <h1 className="agr-title">Crest Suite Subscription Agreement</h1>
          <p className="agr-sub">
            <strong>Agreement no.:</strong> {agrId} &nbsp;·&nbsp;
            <strong>Date:</strong> {adLabel(today)} ({bsLabel(today)} BS)
          </p>

          <h2 className="agr-h">1. Parties</h2>
          <p className="agr-p">
            <strong>Provider:</strong> {COMPANY.name}, registration no. {COMPANY.regNo}, PAN{' '}
            {COMPANY.pan}, {COMPANY.address}, Nepal (&ldquo;Crest&rdquo;)
          </p>
          <p className="agr-p">
            <strong>Customer:</strong> {client.legal_name || <span className="agr-blank">____________________</span>}
            {client.name && client.legal_name !== client.name && <> (trading as {client.name})</>}, PAN/VAT{' '}
            {client.pan_no || <span className="agr-blank">________________</span>},{' '}
            {client.registered_address || <span className="agr-blank">________________________________</span>}
            <br />
            Contact: {client.signatory_name || client.contact_person || <span className="agr-blank">____________</span>}
            {client.signatory_title ? `, ${client.signatory_title}` : ''} ·{' '}
            {client.contact_phone || <span className="agr-blank">____________</span>}
          </p>

          <h2 className="agr-h">2. Order</h2>
          <table className="agr-table">
            <thead>
              <tr>
                <th>Module</th>
                <th>Tier / Plan</th>
                <th>Billing</th>
                <th className="agr-num">Per month (NPR)</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.lines.length === 0 ? (
                <tr>
                  <td colSpan={4}>
                    No module is currently billable on this account. Set the module end dates on the
                    Billing tab before generating the agreement.
                  </td>
                </tr>
              ) : (
                breakdown.lines.map((l) => (
                  <tr key={l.key}>
                    <td>{l.label.split(' · ')[0]}</td>
                    <td>{l.label.includes(' · ') ? l.label.split(' · ')[1] : '—'}</td>
                    <td>{annual ? 'Annual' : 'Monthly'}</td>
                    <td className="agr-num">{npr(l.amount)}</td>
                  </tr>
                ))
              )}
              <tr className="agr-total-row">
                <td colSpan={3}>Subtotal (excl. VAT)</td>
                <td className="agr-num">{npr(subtotal)}</td>
              </tr>
              <tr>
                <td colSpan={3}>VAT @ 13%</td>
                <td className="agr-num">{npr(vat)}</td>
              </tr>
              <tr className="agr-total-row">
                <td colSpan={3}><strong>Total payable per month</strong></td>
                <td className="agr-num"><strong>{npr(total)}</strong></td>
              </tr>
            </tbody>
          </table>
          <p className="agr-note">
            {annual
              ? 'Billed annually in advance at the discounted monthly rate shown (25% off the monthly price). Twelve months payable up front.'
              : 'Billed monthly in advance.'}{' '}
            Prices are exclusive of VAT; 13% is added on invoice.
          </p>
          <p className="agr-p">
            <strong>Billing cycle:</strong> {annual ? 'Annual' : 'Monthly'} &nbsp;·&nbsp;
            <strong>Service start date:</strong> <span className="agr-blank">__________</span> AD
            (<span className="agr-blank">__________</span> BS)
            {client.is_trial && client.trial_start_date && (
              <> &nbsp;·&nbsp; <strong>Trial began:</strong> {adLabel(new Date(client.trial_start_date))}</>
            )}
            <br />
            <strong>Payment method:</strong> [ bank transfer / other: ________ ] &nbsp;·&nbsp;
            <strong>Payment terms:</strong> invoice due within 15 days
          </p>

          <h2 className="agr-h">3. Documents forming this agreement</h2>
          <p className="agr-p">
            The Customer agrees to the following documents, which are incorporated by reference and
            which the Customer confirms it has read at the URLs below. Their integrity can be
            verified by comparing the SHA-256 hash of the published text with the hash printed here.
          </p>
          <table className="agr-table agr-table--docs">
            <thead>
              <tr>
                <th>Document</th>
                <th>Ver.</th>
                <th>Effective</th>
                <th>URL and SHA-256</th>
              </tr>
            </thead>
            <tbody>
              {DOC_TYPES.map((t) => {
                const d = legalDoc(t)
                return (
                  <tr key={t}>
                    <td>Crest Suite {d.title}</td>
                    <td>{d.version}</td>
                    <td>{d.effectiveAdLabel}</td>
                    <td>
                      {/* A real link on screen; on paper the visible text IS the URL, so a reader
                          holding only the printout can still reach and verify the document. */}
                      <a href={legalAbsoluteUrl(t, d.version)} className="agr-url">
                        {legalAbsoluteUrl(t, d.version).replace(/^https?:\/\//, '')}
                      </a>
                      <span className="agr-hash">{d.sha256}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="agr-note">
            Order of precedence: this Agreement, then the Terms of Service, then the Privacy Policy.
          </p>

          <h2 className="agr-h">4. Special terms (if any)</h2>
          <p className="agr-note">
            Support hours or response targets, onboarding or data-migration services and fees,
            training days, custom integrations, any discount and its conditions, and an arbitration
            clause if agreed. Write &ldquo;None&rdquo; if none.
          </p>
          <div className="agr-rule" />
          <div className="agr-rule" />

          <h2 className="agr-h">5. Customer confirmations</h2>
          <p className="agr-p">
            By signing, the Customer confirms that: (a) the signatory is authorised to bind the
            Customer; (b) the Customer has read the Terms of Service and Privacy Policy versions
            listed above; (c) the Customer is responsible for the lawful collection of guest,
            employee and vendor information entered into the Service, including notice to employees
            whose data is processed in the HR module; (d) Crest Suite&rsquo;s tax and payroll
            features are tools and the Customer remains responsible for its own filings; (e) the
            Customer consents to its data being hosted outside Nepal as described in the Privacy
            Policy.
          </p>

          <h2 className="agr-h">6. Signatures</h2>
          <table className="agr-table agr-sign">
            <thead>
              <tr>
                <th>For the Customer</th>
                <th>For Crest ({COMPANY.name})</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Signature: ____________________</td><td>Signature: ____________________</td></tr>
              <tr>
                <td>Name: {client.signatory_name || '____________________'}</td>
                <td>Name: ____________________</td>
              </tr>
              <tr>
                <td>Title: {client.signatory_title || '____________________'}</td>
                <td>Title: ____________________</td>
              </tr>
              <tr><td>Date: __________ AD / __________ BS</td><td>Date: __________ AD / __________ BS</td></tr>
              <tr className="agr-seal-row">
                <td><strong>Company seal / stamp</strong><div className="agr-seal" /></td>
                <td><strong>Company seal / stamp</strong><div className="agr-seal" /></td>
              </tr>
              <tr>
                <td>Witness signature &amp; name: ____________________</td>
                <td>Witness signature &amp; name: ____________________</td>
              </tr>
            </tbody>
          </table>

          <p className="agr-note">
            Two originals: one for each party. After signing, the Customer returns one signed and
            stamped original (or a scan) to Crest; Crest records the acceptance against the
            Customer&rsquo;s account and countersigns.
          </p>

          {/* Repeats on every printed page — a contract sheet has to identify itself. */}
          <div className="agr-print-foot" aria-hidden="true">
            {agrId} · {providerName} Subscription Agreement · {client.legal_name || client.name} ·{' '}
            {adLabel(today)} · {siteOrigin().replace(/^https?:\/\//, '')}
          </div>
        </article>
      )}
    </div>
  )
}
