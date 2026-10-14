# Kitchen and bar printers (S837)

A ticket for a station (KOT kitchen, BOT bar) is printed by a **print device** at the restaurant
instead of the till's own print window, whenever one is online for that station. Two kinds of print
device take the same jobs through the same functions:

- **Print station page** (`kind = 'page'`): `/print-station`, a no-login page in Chrome started with
  `--kiosk-printing`. It prints each job through a hidden, sandboxed iframe to Chrome's default
  printer (USB or any printer Windows has installed). One page window per printer.
- **Crest Print Helper** (`kind = 'helper'`): a Windows program (`print-helper/`). It draws each job as
  a 1-bit image and sends ESC/POS raster bytes straight to a network printer (`host:port`, port 9100
  by default), then cuts. One helper can drive several printers.

The till falls back to printing itself: at once when no device for the station is online (or the
till is offline), and on the waiter's **Print here** when a queued job has not printed in 20 s.

This file is the contract between the database (`supabase/migrations/20261014140000_pos_kitchen_printers_s837.sql`),
the till (`src/modules/pos/printing/printQueue.js`), the page and the helper. Change it here first.

## The ticket document (`doc`, version 1)

The till builds every job's content as a `doc`; devices only render it. One builder per slip in
`src/modules/pos/printing/ticketDoc.js` (`kotBotDoc`, `voidSlipDoc`, `moveSlipDoc`, `testDoc`), and
the till's own print window renders the same doc through `renderTicketDocHtml`, so the paper is the
same whoever prints it.

```json
{ "v": 1, "title": "KOT", "lines": [ /* Line */ ] }
```

| Line | Shape | Meaning |
| --- | --- | --- |
| text | `{ "k": "text", "t": "…", "align": "left"\|"center", "size": "xs"\|"sm"\|"md"\|"lg"\|"xl", "bold": bool, "italic": bool, "indent": 0\|1, "strike": bool }` | A paragraph; wraps to the paper width |
| row | `{ "k": "row", "l": "…", "r": "…", "size": …, "bold": bool, "lBold": bool, "rBold": bool, "rSize": …, "strike": bool }` | Left text and right text on one line; the left side wraps, the right side stays on the first line; `strike` strikes the left side (the VOID slip's dishes) |
| hr | `{ "k": "hr" }` | A dashed rule |

- Defaults: `align` left, `size` `sm`, everything else false/0. `bold` on a row applies to both sides;
  `lBold`/`rBold`/`rSize` override one side.
- Sizes in CSS px on the 80 mm page (the helper scales by its own dots-per-px): `xs` 11, `sm` 13,
  `md` 15, `lg` 17, `xl` 20. `lg` and `xl` centred lines carry letter-spacing 1px and 2px.
- Text is **untrusted** (dish names, notes and labels are typed by staff and guests). Renderers escape
  it; the page's iframe is `sandbox="allow-same-origin allow-modals"` (no scripts). Any Unicode can
  appear: Nepali dish names, `×`, `↓`, `↳`, `—`.
- Limits the database enforces: the doc is a JSON object of at most 32 KB with at most 300 `lines`.
- A device adds one line of its own when it prints a job flagged `late` (claimed more than 2 minutes
  after it was queued): a bold centred `PRINTED LATE — sent HH:MM` (Nepal time) under the title.

## Tables (all access through the functions below)

Both tables have RLS on, no policies and no grants for `anon`/`authenticated`, like `pos_devices`.
Neither is exported or restored; Delete Client cascades them; Danger Zone's POS clear deletes jobs.

**`pos_print_devices`**: `id`, `client_id`, `name` (1–60), `kind` (`page`|`helper`), `stations`
(`text[]` ⊆ {KOT, BOT}), `printers` (helper only: `[{ "station": "KOT", "host": "192.168.1.50",
"port": 9100, "width": 80 }]`, one per station, `host` a private IPv4 address, `width` 80 or 58),
`secret_hash` (sha256 hex, NULL until paired), `pair_code_hash`, `pair_code_expires_at`,
`paired_at`, `last_seen_at`, `app_version`, `status` (the device's last report), `last_error`,
`last_error_at`, `created_by`, `created_at`, `revoked_at`, `revoked_by`.

**`pos_print_jobs`**: `id` (minted by the till), `client_id`, `station`, `kind`
(`ticket`|`reprint`|`void`|`move`|`test`), `doc`, `label` (≤ 80, e.g. `Table 4 · #23`, for lists and
the till's banner), `target_device_id` (test jobs), `created_by`, `created_at`, `claimed_by`,
`claimed_at`, `printed_at`, `printed_via` (`device`|`till`), `printed_by_device`, `printed_by_till`,
`fail_count`, `fail_reason`, `failed_at`.

**`storage` bucket `downloads`** (public, zip only, 100 MB): `CrestPrintHelper.zip`, linked from POS
Setup → Printers. No policy names it, so only the service role (the Supabase CLI) uploads.

### Job state (derived, in this order)

| State | When |
| --- | --- |
| `printed` | `printed_at` set (by a device's report or the till's Print here) |
| `printing` | claimed by a device less than 60 s ago |
| `failed` | `fail_count` ≥ 5 (no device will try again) |
| `expired` | queued more than 15 minutes ago and never printed |
| `retrying` | `fail_count` > 0 (the last device to try reported `fail_reason`) |
| `waiting` | otherwise |

A device claims a job only while it is `waiting` or `retrying`, or `printing` with a claim older
than 60 s (a device that died mid-job). A device is **online** when `last_seen_at` is within 20 s.

## Functions

Every function is `SECURITY DEFINER`, `search_path public`, revoked from `PUBLIC`. Errors from the
manager and till functions are raised (`42501` not authorized, `22023` bad input with a `HINT`); the
device functions return `{ "ok": false, "code": "…", "message": "…" }` instead, so a refused pairing
keeps its attempt row.

### Manager (Owner, admin, or a POS manager of the outlet: `pos_device_caller_may_manage`)

| Function | Returns |
| --- | --- |
| `list_pos_print_devices(p_client_id uuid)` | `jsonb` array, live devices only: `{ id, name, kind, stations, printers, paired, pair_code_expires_at, paired_at, last_seen_at, online, app_version, status, last_error, last_error_at, created_at, created_by_name }` |
| `list_pos_print_jobs(p_client_id uuid, p_limit int default 50)` | `jsonb` array, newest first: `{ id, station, kind, label, state, created_at, printed_at, printed_via, device_name, fail_reason, fail_count }` |
| `create_pos_print_device(p_client_id uuid, p_name text, p_kind text, p_stations text[], p_printers jsonb)` | `{ device_id, pair_code, pair_code_expires_at }` |
| `update_pos_print_device(p_device_id uuid, p_name text, p_stations text[], p_printers jsonb)` | `void` |
| `issue_pos_print_pair_code(p_device_id uuid)` | `{ pair_code, pair_code_expires_at }` (the old pairing keeps working until the new code is used) |
| `remove_pos_print_device(p_device_id uuid)` | `void`, idempotent; its claimed jobs go back to waiting |
| `send_pos_print_test(p_device_id uuid, p_station text, p_doc jsonb)` | the new job's `uuid` |

`pair_code` is 8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, shown as `XXXX-XXXX`, good for
15 minutes, single use. Spaces, dashes and case are ignored when typed.

### Till (admin, or a POS login of the outlet with POS access: `pos_caller_has_rank('staff')`)

| Function | Returns |
| --- | --- |
| `get_pos_print_routes(p_client_id uuid)` | `{ "KOT": { device_id, device_name, online } \| null, "BOT": … }`: the device covering each station, an online one first |
| `queue_pos_print_jobs(p_client_id uuid, p_jobs jsonb)` | `{ queued }`. Each job `{ id, station, kind, doc, label }`, kind `ticket`\|`reprint`\|`void`\|`move`, at most 20 per call; an id already queued is skipped, so a retry after a lost answer is safe |
| `get_pos_print_job_status(p_client_id uuid, p_ids uuid[])` | `jsonb` array `{ id, state, device_name, fail_reason, printed_at, printed_via }` (at most 100 ids; an id not queued is absent) |
| `claim_pos_print_job_for_till(p_client_id uuid, p_job jsonb)` | `{ ok, state, device_name }`. `ok: true` means print it on this till now (the job is marked printed by this login, inserted first if it never arrived); `ok: false` with `state` `printed` or `printing` means a device has it |

### Print device (anon; the device's own id and secret)

| Function | Returns |
| --- | --- |
| `pos_print_device_pair(p_code text, p_info jsonb)` | `{ ok: true, device_id, secret, device_name, kind, client_name }`, or `ok: false` with `code` `pair_code_invalid`, `wrong_kind` (the code is for the other kind of device), `too_many_attempts` (10 tries per 15 minutes per address) or `pos_off`. `p_info`: `{ kind, app_version }` |
| `pos_print_device_poll(p_device_id uuid, p_secret text, p_info jsonb)` | `{ ok: true, device: { id, name, kind, stations, printers }, client_name, server_time, jobs: [{ id, station, kind, doc, label, created_at, late }] }` (claims at most 10 jobs, oldest first); `{ ok: true, paused: "pos_off", jobs: [] }` when POS is off or the account is locked; `{ ok: false, code: "device_not_active" }` for a removed device or a stale secret |
| `pos_print_device_report(p_device_id uuid, p_secret text, p_printed uuid[], p_failed jsonb)` | `{ ok: true }`, at most 50 of each. **Printed** marks any unprinted job of this outlet the device could have taken (its station, or a test aimed at it), even after its claim lapsed: it is on paper, and marking it stops a second device printing it. **Failed** (`[{ id, reason }]`, reason ≤ 200 characters) touches only a job this device still holds, and puts it back to waiting with `fail_count + 1` |

`p_info` on a poll: `{ app_version, printers: [{ station, ok, error }] }` (at most 4; `error` ≤ 200
characters; a station the helper prints with no printer configured is sent as `ok: false`); the page
sends `printers: []`. The device row keeps it as `status = { printers: [...] }`. `last_error` is the
newest of a printer's reported error and a failed job's reason, with `last_error_at`. Polls stamp
`last_seen_at` at most every 5 s, or at once when `status` changed.

A device keeps the ids it printed until their report is heard: a job handed back to it that it
already printed is reported printed again, never printed twice. There is no device-side unpair: the
page's "Unpair this computer" only forgets the pairing on that computer; Remove in POS Setup revokes
it. Not covered: a printer's own paper-out state (a printer that takes the bytes with no paper is
reported as printed), and a send that times out part-way through a very long ticket is retried
whole.

Calling from outside the app (the helper): `POST {SUPABASE_URL}/rest/v1/rpc/<function>` with headers
`apikey: <anon key>`, `Authorization: Bearer <anon key>`, `Content-Type: application/json`, and the
parameters as a JSON object (`{ "p_device_id": "…", "p_secret": "…", "p_info": { … } }`).

## Behaviour the till keeps

- Online and the station's device online: queue the job instead of opening the print window, then
  watch it (`get_pos_print_job_status` every 5 s). Not printed after 20 s: the banner offers
  **Print here** (`claim_pos_print_job_for_till`, then the print window from that tap).
- Station device offline, no route, the till offline, or the queue call refused: print on the till
  at once, as before this release. A queue call with **no answer** is watched like a queued job;
  Print here's claim settles whether it ever arrived, so a ticket cannot print twice.
- An offline send prints on the till as before; nothing is queued for it.
- A till on an older release never queues anything and keeps printing itself; no till floor raise.
