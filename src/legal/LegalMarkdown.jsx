// A deliberately small Markdown renderer, scoped to the subset the legal documents actually use.
//
// Why not react-markdown. Two reasons, and the second is the decisive one. This codebase has no
// markdown dependency and — checked before writing this — zero `dangerouslySetInnerHTML` anywhere
// in src/, which is a property worth keeping on the one page whose entire job is rendering a
// document. And react-markdown v9 ships ESM-only, while CRA 5's Jest config leaves node_modules
// untransformed, so any test that imported this page would fail on an import it cannot parse. The
// project already carries scars from build-time-only failures; this one would be test-time-only,
// which is worse.
//
// The input is not arbitrary. It is two files in this repo, authored here, byte-asserted by
// legalHash.test.js. That is what makes a 150-line parser the right size of tool rather than a
// liability: it has to handle the constructs those documents use and no others, and if a future
// document reaches for something unsupported, renderMarkdown.test.js is where that shows up.
//
// Output is React elements throughout. No HTML string is ever constructed, so there is no injection
// surface even though the input is trusted.

import React from 'react'
import { Link } from 'react-router-dom'

// ── Inline ───────────────────────────────────────────────────────────────────────────────────
// Order matters: `**` must be tried before `*`, or bold parses as two empty italics.
const INLINE_RE = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]]+\]\([^)\s]+\))/g

function renderInline(text, keyPrefix) {
  const out = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    const key = `${keyPrefix}-i${i++}`

    if (tok.startsWith('**')) {
      out.push(<strong key={key}>{tok.slice(2, -2)}</strong>)
    } else if (tok.startsWith('`')) {
      out.push(
        <code key={key} className="legal-code">
          {tok.slice(1, -1)}
        </code>
      )
    } else if (tok.startsWith('[')) {
      const split = tok.indexOf('](')
      const label = tok.slice(1, split)
      const href = tok.slice(split + 2, -1)
      // An in-app path stays a router Link so a cross-reference between the two documents does not
      // reload the whole bundle. Anything else (mailto:, https:) is a plain anchor.
      out.push(
        href.startsWith('/') ? (
          <Link key={key} to={href} className="legal-link">
            {label}
          </Link>
        ) : (
          <a
            key={key}
            className="legal-link"
            href={href}
            target={href.startsWith('http') ? '_blank' : undefined}
            rel={href.startsWith('http') ? 'noopener noreferrer' : undefined}
          >
            {label}
          </a>
        )
      )
    } else {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>)
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

// ── Blocks ───────────────────────────────────────────────────────────────────────────────────
const HEADING_RE = /^(#{1,4})\s+(.*)$/
const BULLET_RE = /^[-*]\s+(.*)$/
const RULE_RE = /^(-{3,}|_{3,}|\*{3,})$/
const TABLE_SEP_RE = /^\|?[\s:|-]+\|[\s:|-]*$/

function splitRow(line) {
  return line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())
}

/** Turn a markdown string into React elements. Exported for the renderer's own tests. */
export function parseMarkdown(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let i = 0
  let key = 0

  const flushParagraph = (buf) => {
    if (!buf.length) return
    const text = buf.join(' ').trim()
    if (text) {
      blocks.push(
        <p key={`p${key}`} className="legal-p">
          {renderInline(text, `p${key}`)}
        </p>
      )
      key += 1
    }
    buf.length = 0
  }

  const para = []

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (!trimmed) {
      flushParagraph(para)
      i += 1
      continue
    }

    if (RULE_RE.test(trimmed)) {
      flushParagraph(para)
      blocks.push(<hr key={`hr${key++}`} className="legal-hr" />)
      i += 1
      continue
    }

    const heading = trimmed.match(HEADING_RE)
    if (heading) {
      flushParagraph(para)
      const level = heading[1].length
      const body = heading[2]
      // Slug from the visible text, so a table of contents and a deep link agree without a second
      // source of truth for section ids.
      const id = body
        .toLowerCase()
        .replace(/[*`[\]()]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
      const Tag = `h${Math.min(level + 1, 6)}` // document h1 becomes the page h2; the page owns h1
      blocks.push(
        React.createElement(
          Tag,
          { key: `h${key}`, id, className: `legal-h legal-h${level}` },
          renderInline(body, `h${key}`)
        )
      )
      key += 1
      i += 1
      continue
    }

    // Table: a header row followed by a separator row.
    if (trimmed.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1].trim())) {
      flushParagraph(para)
      const header = splitRow(trimmed)
      const rows = []
      i += 2
      while (i < lines.length && lines[i].trim().includes('|')) {
        rows.push(splitRow(lines[i].trim()))
        i += 1
      }
      const tk = key++
      blocks.push(
        // table-wrap is the app's own horizontal-scroll wrapper. A legal document read on a phone
        // has the same overflow problem as any other wide table, and the sub-processor and
        // retention tables are genuinely wide.
        <div key={`tw${tk}`} className="table-wrap legal-table-wrap">
          <table className="data-table legal-table">
            <thead>
              <tr>
                {header.map((h, hi) => (
                  <th key={hi}>{renderInline(h, `t${tk}h${hi}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {header.map((_, ci) => (
                    <td key={ci}>{renderInline(r[ci] || '', `t${tk}r${ri}c${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }

    if (BULLET_RE.test(trimmed)) {
      flushParagraph(para)
      const items = []
      while (i < lines.length && BULLET_RE.test(lines[i].trim())) {
        items.push(lines[i].trim().match(BULLET_RE)[1])
        i += 1
      }
      const lk = key++
      blocks.push(
        <ul key={`ul${lk}`} className="legal-ul">
          {items.map((it, ii) => (
            <li key={ii}>{renderInline(it, `ul${lk}i${ii}`)}</li>
          ))}
        </ul>
      )
      continue
    }

    para.push(trimmed)
    i += 1
  }

  flushParagraph(para)
  return blocks
}

/**
 * Drop the document's own `# ` title and the `**Version … — Effective …**` line beneath it.
 *
 * Both have to stay in the FILE: the hash is taken over those bytes, and the copy the Download
 * button hands to a lawyer has to identify itself without the page around it. On screen they are
 * the page header said twice — the reader crossed a rule to be told "Terms of Service" and
 * "Version 1.0 — Effective 3 September 2026 (18 Bhadra 2083 BS)" again, in a different typeface,
 * having read both in the header a moment earlier.
 *
 * So this strips for RENDER only, and never mutates the text held in state. Written defensively:
 * a document that does not open this way is returned untouched, and the version line is only
 * dropped when it is really the version line.
 */
export function stripDocFrontMatter(md) {
  const lines = String(md || '').split('\n')
  if (!/^#\s+\S/.test(lines[0] || '')) return String(md || '')
  let i = 1
  while (i < lines.length && !lines[i].trim()) i += 1
  if (/^\*\*Version\b.*\*\*$/.test((lines[i] || '').trim())) {
    i += 1
    while (i < lines.length && !lines[i].trim()) i += 1
  }
  return lines.slice(i).join('\n')
}

export default function LegalMarkdown({ text }) {
  return <div className="legal-body">{parseMarkdown(text)}</div>
}
