---
target: terms of service and privacy policy
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-09-05T05-20-54Z
slug: src-pages-legal-jsx
---
Method: dual-agent (A: design review · B: detector + browser). Target: /legal/terms and /legal/privacy (src/pages/Legal.jsx, Legal.css, src/legal/LegalMarkdown.jsx). Dev server started for the run and stopped after. Mode: Read.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | No current-section marker on a 7,700px scroll; "Copied" is visual-only; old-version page keeps the current-doc pill lit |
| 2 | Match System / Real World | 3 | BS beside AD, "Print / Save PDF"; "Verify this document" reads as an instruction to an ESL owner |
| 3 | User Control and Freedom | 3 | Every destination a real link; no way back to top/contents on a phone after 18 sections |
| 4 | Consistency and Standards | 2 | Not-found links fall to UA blue; loading/not-found paragraphs 16px vs 14px body; verify panel is border-only in both presets |
| 5 | Error Prevention | 4 | Old-version branch withholds text and hash rather than mislabel; drafts cannot present as in force |
| 6 | Recognition Rather Than Recall | 3 | Numbered rail and run-in clause numbers; no active-section marker after a jump |
| 7 | Flexibility and Efficiency | 3 | Print, Copy, Download, deep-linkable ids; no jump-to-top on phone |
| 8 | Aesthetic and Minimalist Design | 3 | Restrained, one accent; phone first screen is all chrome; Sign in x2, Terms x2, Privacy x2 |
| 9 | Error Recovery | 3 | Banners name consequence and address; not-found is right in copy, broken in colour |
| 10 | Help and Documentation | 2 | Verify panel explains itself; nothing helps the READER of the contract (no summary, Definitions not surfaced) |
| **Total** | | **28/40** | **Good** |

## Design Specificity Verdict

LLM assessment: authored for Crest, but the authorship lives in the frame rather than the document. Georgia 32/22 over Poppins 14 is the Signature Serif Rule applied exactly where it is allowed; the BS date beside AD, the single filled button, the brass-tinted current-doc pill and the SHA-256 verify disclosure all read as this product. The document itself has no typographic event after the title: eighteen identical headings, and s4 Free trial / s7 Customer Data / s14 Liability look like s18 General. PRODUCT.md calls data ownership a positioning asset; s7.1 "Customer Data belongs to you" sits mid-page in body weight.

Deterministic scan: file-mode detector on Legal.jsx + LegalMarkdown.jsx (and Legal.css, with and without config) = 0 findings, exit 0. Browser detector (detect.js injected on 4 pages at 1440 and 390): line-length x68 on Terms / x28 on Privacy (p.legal-p ~95 chars per line, li ~92); tiny-text x1 (11px p.legal-verify-note); first-viewport-column-overflow x1 per doc (article column 769%/607% of viewport tall vs the rail at 14%); layout-transition x1 on every page (body width 0.22s, already in config ignoreValues, false positive); cream-palette x1 on the Light preset run (the product's own Light bg token, false positive). The column-overflow finding is a false positive on desktop because the rail is sticky; it is the real problem on the phone.

Visual overlays: injection succeeded; findings were read from the console. The tab was shared with the other assessment and was closed at the end, so no overlay is left open.

## Overall Impression

A correct, calm, auditable legal page whose integrity design (hash withheld where it would mislead, byte-exact download, rail derived from headings) is better than most SaaS ship. The single biggest opportunity is the phone: at 390x844 the first sentence of the Terms lands at y=976, below the whole first screen, behind a 145px stacked header, a 90px meta block and a 559px contents card.

## What's Working

1. Integrity as design. /legal/terms/0.9 renders no body, no meta, no hash, one honest banner. stripDocFrontMatter never touches the hashed text. The rail cannot drift from the document.
2. Typography earns its serif. Georgia 32/22 over Poppins 14/1.7 at a nominal 76ch; BS date beside AD in the meta row.
3. Accessibility fundamentals measured, not assumed: named nav landmarks, a real disclosure button with aria-expanded, visible 2px focus outline on every control class, sticky header (top 0) and rail (top 88) that actually stick, anchors landing 19.7px clear of the header; 0 console errors.

## Priority Issues

[P1] The contract starts below the first phone screen. Measured 390x844: header stacks to three rows (145px, Sign in alone on row three), meta row wraps to three lines, contents card 559px on Terms; first paragraph at y=976 (Terms) / 853 (Privacy). Why: the reader tapped "Terms of Service" and sees a list of eighteen links; an ESL first-timer reads that as "enormous" (it is 2,517 words, about ten minutes). Fix: under 900px collapse the rail into a disclosure ("Contents - 18 sections", closed by default); let the three header actions share one row at 390. Command: /impeccable adapt.

[P1] Not-found page links render in UA blue. .legal-link is styled only under .legal-body, and the /legal/nonsense paragraph sits outside it, so both links fall to #0000EE (roughly 2.0:1 on Dark; blue and visited-purple on Light) at 16px. Why: this is the S678 second-brand-colour-by-omission failure recurring on the branch the S678 note says most needs the chrome; fails AA. Fix: make .legal-link self-sufficient (bare selector), and give the not-found/loading paragraphs the 14px body size. Command: /impeccable polish.

[P1] Light preset amber banner text measures 4.19:1 (#a85200 on a 12% amber tint over #f6f3ef, 13px). Single-source measurement (Assessment A, computed from sampled hex); it is the identical pairing PeriodScope's docs record failing at 4.19. Why: the old-version banner is the page's only message to an auditor following a ledger link. Fix: PeriodScope's answer: tint at most 6% or use the card ground, keep amber as border + bold lead-in; re-measure both presets. Command: /impeccable audit.

[P2] Heading outline is H1 -> H2 "Contents" -> H3 x18, and there is no skip link. The renderer demotes every markdown level by one for a document H1 that is now stripped, so the only level-2 heading is the rail label; 3 focusables precede main and 18 rail links precede the first body link (37 total). Why: a screen-reader user navigating by level-2 headings finds only the table of contents. Fix: map ## to h2 in parseMarkdown now that the document # is stripped (update LegalMarkdown.test.jsx); add a skip link to the article. Command: /impeccable harden.

[P2] The body measure is 76ch nominal but about 95 characters per line in practice. Poppins' zero glyph is wide relative to its average character, so 668px holds ~95 characters; the detector flagged 68 paragraphs on Terms and 28 on Privacy. Why: above the 75-character comfort ceiling on the one surface in the product that is pure reading. Fix: bring .legal-body to ~62ch (about 560px) and re-count real characters per line; this also lets the tables genuinely use the wider column the CSS comment intends (the max-width: none on .legal-table-wrap is inert today because it sits inside the measure). Command: /impeccable typeset.

## Persona Red Flags

Jordan (first-time owner, English 2nd/3rd language): header says Crest Suite, the first sentence says Bloom Hospitality Pvt. Ltd., nothing bridges them before the legalese; "Verify this document" reads as a demand; the reassuring sentence (s7.1) is not surfaced; on a phone, eighteen links and no text.

Sam (screen reader / keyboard): no skip link (23 Tab stops before the first body link); heading levels skip; "Copied" has no live region; "Copy" does not say what it copies; the rail is an ol with list-style: none, which WebKit drops list semantics on without role="list".

Casey (one-handed phone, interrupted): pointer: coarse could not be emulated, so measured targets are the fine-pointer values (rail links 28.2px with 0 gap, verify toggle 28px, footer links 18px); the coarse block in Legal.css does lift these to 44px on a real touch device, but the Print button is btn-sm whose coarse floor is 32px. The header is static below 640px by design, so after an interruption there is no way back to the top or the other document without scrolling ~12,000px; Copy sits at the left edge under a two-line hash.

The auditor / lawyer verifying a version: strong today; the moment v1.1 ships, every ledger deep link to 1.0 answers with the amber apology until SOURCES becomes a list per doc type; the printed page has no page counter, so "page 3 of 7" cannot be cited from a filed copy.

## Minor Observations

- No current-section indicator in the rail; the reserved border-left: 2px transparent on .legal-toc a is waiting for an IntersectionObserver with root set to .legal-page (it is its own scrollport).
- The Privacy purpose table stands 1,175px tall at 390 with 133px rows; table 2 overflows its wrapper by 24px and scrolls internally. Stacked rows under 640px would fix both.
- Legal.css comments cite a "16,000-word contract"; measured 2,517 (Terms) and 1,700 (Privacy). The non-sticky-header rationale was sized against the wrong number.
- Loading... renders outside .legal-body at inherited 16px with UA margins.
- The old-version page keeps the "Terms of Service" header pill lit as current while showing none of it.
- The verify panel's fill equals the page bg on Dark (#0f1117 on #0f1117), so it is delineated by its 1px border alone.
- "Sign in ->" in the header and "Sign in" in the footer are two spellings of one link.
- The PWA install prompt fires on the public legal route (beforeinstallprompt seen in console).
- Run-in clause labels ("7.1 Ownership.") are strong in the same colour as body and do not read as labels.

## Questions to Consider

1. Should the first thing Jordan reads be a contract at all? A 60-word plain-language "what you are agreeing to" box above s1, clearly marked as a summary and not the agreement, might be the only part most customers ever read. Is its absence a legal position or an oversight?
2. Why is the rail on the phone at all? It is the desktop's answer to position sense. A phone needs a sticky "s7 Customer Data" breadcrumb and a jump-to-top, not eighteen links before the first sentence.
3. The verify panel proves the text is authentic; what proves the provider is? A link to the OCR company register entry or PAN lookup may be the more reassuring "verify this" for a buyer in Kathmandu.
