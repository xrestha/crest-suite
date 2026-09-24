# legal-documents.md: archived sections

History behind rules in `.claude/rules/legal-documents.md`. This file is not auto-loaded: no rules
glob matches `docs/`. The live rule stays in the rules file, with a `History:` pointer here.

---

## S789: grouped Owner held at the gate

Reported 2026-09-24 with a screenshot from 2026-09-22. The operator created BLOOM CAFE - PKR as a
second outlet of BLOOM CAFE and grouped the two. The Owner switched to PKR and got the
re-acceptance gate. After Accept, the screen said *"Your acceptance was recorded, but this screen
did not refresh"*, and Reload brought the gate straight back.

The two halves disagreed about which client was accepting:

- **Write:** `record_legal_acceptance` inserted with `client_id: profile.client_id`, the HOME
  outlet. S750 had moved every other `admin-user-ops` action to `callerClientId`
  (`active_client_id || client_id`) and left this one on the home client, with a one-line comment
  calling the account's own company the contracting party.
- **Read:** `AuthContext` decides the gate from `legal_acceptances` filtered by
  `effectiveClientId`, the switched outlet. The SELECT policy is `client_id = my_client_id()`, so
  the Owner could not have seen the home rows from PKR even if the read had asked for them.

The live ledger showed PKR with 0 rows and BLOOM CAFE with 22 duplicate `clickwrap_reaccept` rows:
11 presses over two days. The gate replaces the whole app, outlet switcher included, so the only way
out was the operator taking BLOOM CAFE out of the group. The `clients.group_id` trigger then cleared
the Owner's `active_client_id`. That happened twice, which left the group with PKR as a member and
its HQ outside it.

**Why the write side changed, not the read side.** Each outlet is its own `clients` row with its own
`legal_name` and `pan_no` (the "contracting business", `20260903140000`) and its own Subscription
Agreement. Help → Legal and the admin drawer's Legal tab both read per outlet. Pointing the gate at
the home client would have needed an RLS change, and Help → Legal on PKR would still have said the
business had accepted nothing. The 22 duplicate rows on BLOOM CAFE were deleted on the owner's
instruction. They carried the same document hashes, the same login and the same versions as BLOOM
CAFE's 4 September Terms and Privacy pair, which was kept, so the business's record did not change.
The delete asserted both conditions and would have rolled back otherwise. That is an operator's
one-off correction by service role: nothing in the product can delete from this table.

**The general shape:** when one side of a check moves to the switched outlet, every writer that
check reads must move too. S750 moved the staff actions and made an exception for one writer
without asking which reader depended on it.
