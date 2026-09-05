// The plain-language "In short" box that sits above §1 of each legal document.
//
// Page CHROME, not document text — deliberately. The two `.md` files are hashed byte for byte and
// every acceptance in the ledger records that hash, so a sentence added to the markdown would be
// a new version of the contract, a re-hash, and a re-acceptance for every Owner. This box makes
// no such claim: it is a reader's aid, and the page says so above it. The numbered sections are
// what a customer accepts; this is the six things a restaurant owner reading English as a second
// language most needs to know before they do.
//
// Every line paraphrases ONE clause and names it, and the wording was checked against the clause
// when written. That check is the whole discipline here: a summary that promises more than the
// section it cites is worse than no summary. Keyed by doc type AND version, so a v1.1 that changes
// a cited clause cannot inherit a summary written for v1.0 — the page renders no box for a version
// with no entry, and the "Adding version 1.1" checklist in ./index.js says to write one.
//
// `section` is the number that opens the `## ` heading ("7" for "## 7. Customer Data"). Legal.jsx
// resolves it to the heading's real id from the same contents list the rail is built from, so a
// renumbered heading breaks the link visibly (falls back to plain text) rather than silently.

export const LEGAL_SUMMARIES = {
  'terms-1.0': [
    { section: '7', text: 'Your data belongs to you. We use it only to run the Service for you.' },
    {
      section: '4',
      text: 'The free trial is 7 days, no card needed. If you do not subscribe, your data is deleted 15 days after it ends.',
    },
    {
      section: '6',
      text: 'Prices are in NPR before 13% VAT, billed in advance. We give 30 days’ notice before a price changes.',
    },
    {
      section: '15',
      text: 'You can cancel a monthly plan at any time; it ends with the current billing period.',
    },
    {
      section: '7',
      text: 'Ask us for a full copy of your data at any time while your account is open, and for 30 days after it closes.',
    },
    { section: '17', text: 'Nepali law applies, and disputes go to the courts of Kathmandu.' },
  ],
  'privacy-1.0': [
    {
      section: '1',
      text: 'The records you enter about guests, staff and vendors are yours. We handle them only on your instructions.',
    },
    {
      section: '6',
      text: 'Your data is stored with Supabase in Tokyo, Japan, and delivered through Vercel.',
    },
    {
      section: '5',
      text: 'We share it only with the service providers listed below, or where Nepali law requires.',
    },
    {
      section: '9',
      text: 'After an account closes we delete its data within 90 days. A trial that does not subscribe is deleted 15 days after it ends.',
    },
    {
      section: '10',
      text: 'You can ask what we hold about you, have it corrected, or have it deleted. We answer within 15 days.',
    },
  ],
}

/** The summary for one published version, or null when none has been written for it. */
export function legalSummary(docType, version) {
  return LEGAL_SUMMARIES[`${docType}-${version}`] || null
}
