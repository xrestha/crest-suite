---
paths:
  - "src/modules/pos/printing/**"
  - "print-helper/**"
  - "docs/kitchen-printers.md"
  - "supabase/migrations/*kitchen_printers*"
  - "public/print-station-tick.js"
---

# Kitchen and bar printers (S837)

A station slip (KOT, BOT, VOID, MOVE, Reprint) prints on a **print device** at the restaurant when
one is online for that station, and on the till otherwise. The contract — the ticket document, the
three groups of functions, the job states — is `docs/kitchen-printers.md`; change it there first,
then every renderer.

## The paper is a document, built once

- **A slip is a `doc` from `src/modules/pos/printing/ticketDoc.js`** (`kotBotDoc`, `voidSlipDoc`,
  `moveSlipDoc`, `testDoc`), rendered by `renderTicketDocHtml` on the till and the print station
  page and by the helper's raster renderer. `posOrderPrintHtml.js`' three builders are one-line
  renders of these. Never build station-slip HTML in a caller: the device would print something
  else.
- **A new line kind or style touches four places**: the contract, `renderTicketDocHtml`, the
  helper's `render.js`, and `pos_print_doc_ok`'s size limits if it grows the doc. The doc is
  untrusted text everywhere (dish names, notes, labels): every renderer escapes, and the page's
  iframe is `sandbox="allow-same-origin allow-modals"`.
- **The helper always prints a raster image**, never ESC/POS text: a receipt printer's built-in font
  has no Devanagari and no `×`, `↓`, `↳`, and code pages differ by model. Shaping is harfbuzzjs
  (WASM) with Noto fonts bundled into the single executable.

## The till (`useStationPrinting`)

- **`deliver()` answers synchronously**, so the send paths keep their order (the save lands → the
  slip goes → it is logged) and their `printed` messages. `local: saved.keptOnTill` keeps a send held
  on the till printing there; an offline till, a station with no online device or a doc over the
  limits prints on the till too.
- **Every queued slip is watched until it is on paper.** Not printed in `PRINT_FALLBACK_MS` (20 s),
  refused by the queue call, or given up by its device (5 failures, or 15 minutes old) → the banner
  with **Print here**. Print here opens the window BEFORE its await (the tap's permission to open a
  window is fresh only then) and prints only on the claim's `ok`; a claim with no answer prints
  anyway and says the station may get a second copy — a missing ticket is worse than a duplicate.
- **The banner is in all three of PosOrders' returns** (`printAlertsEl`, S578). A new till view that
  can send or void renders it too.
- **No till floor raise was needed**: a till on an older release never queues and prints itself.
  Raise one only if a future release changes what a till must send.

## The database (`20261014140000`)

- **`pos_print_devices` and `pos_print_jobs` have RLS on, no policies and no client grants**, like
  `pos_devices`: everything goes through the functions, each with its own caller test (manager:
  `pos_device_caller_may_manage`; till: `pos_print_caller_is_till`; device: its id + secret).
  Neither is exported; Danger Zone's POS clear deletes the jobs; Archive revokes the devices
  (`revokeClientTablets`); the nightly `crest-purge-print-jobs` deletes jobs older than 7 days.
- **Device functions answer `{ ok: false, code }` instead of raising**, so a refused pairing keeps
  its attempt row (10 per 15 minutes per address, the S822 trusted hop).
- **Who printed is settled by the row**: claims are `FOR UPDATE SKIP LOCKED`, a claim lapses after
  60 s, Print here marks the job printed in one statement or is told a device has it, a device's
  "printed" report is honoured even after its claim lapsed (it IS on paper).
- **`pos_print_jobs.created_by` / `printed_by_till` hold a login's id with no foreign key** on
  purpose: a key would make every waiter "a login with records" (`pos_login_reference_columns`) for
  the week the queue lives. `pos_print_devices`' keys are real and worded in `POS_RECORD_WORDS`.

## The two devices

- **Print station page** (`/print-station`, no login): needs Chrome started with `--kiosk-printing`
  (proved on Chromium, S837: `contentWindow.print()` from a timer prints with no tap). Its tick runs
  in a worker so a hidden window is not throttled to once a minute; it holds a screen wake lock and
  takes releases through `useReleaseReload`. A report that failed is resent before anything new is
  printed (a claim lapses in 60 s and would print again).
- **Crest Print Helper** (`print-helper/`): a Node 22 single executable for Windows, built on Linux
  with `node --env-file=../.env.local build/build.mjs` (never open the env file; the anon key it
  bakes in is public anyway). It is unsigned: Windows shows "Windows protected your PC" once. The zip
  is served from the public `downloads` storage bucket at `HELPER_DOWNLOAD_URL`; uploading a new one
  is an outward step to confirm with the owner.
