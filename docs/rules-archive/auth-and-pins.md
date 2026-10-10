# auth-and-pins.md: archived sections

Moved word for word out of .claude/rules/auth-and-pins.md. This is history and is not auto-loaded: no rules glob matches docs/. The live rule stays in the rules file, with a `History:` pointer here. Line numbers refer to the rules file before the move.

---

## Shared key retirement

Moved in S809 3h (2026-10-10), when the shared key's app code and Edge Function branch were removed.

_Original lines 120–143:_

**The shared key is retired explicitly, never automatically when the first tablet registers.** An
outlet with three tills that re-activates one would otherwise lose the other two mid-service.
`pos-staff-login` stamps `pos_legacy_key_last_used_at` on every legacy sign-in, and Till Devices shows
that stamp. A manager presses Switch off once the tablets have moved.
`retire_pos_legacy_device_key` then **rotates** `client_secrets.pos_device_secret` to a value no
tablet holds, so every path still comparing against it stops matching at once. That includes
`get_pos_staff` and a stale `pos-staff-login`, so neither had to be redefined. **S809 1j
(`20261009160000`, owner decision Q7 a) switched it off at every client and made a new
`client_secrets` row born switched off (`pos_legacy_key_retired_at DEFAULT now()`);
`get_pos_device_secret` is dropped.** Deactivating a tablet that has its own key revokes that key,
not just the localStorage copy.

**`pos-staff-login` falls back to the pre-S754 check only on `PGRST202`** (the verify function is
not in the schema cache, i.e. the function deployed ahead of the migration), so a deploy-order slip
does not lock out every tablet already on a floor. Any other error refuses. **Every client has now
switched the shared key off (S809 1j), so the follow-up is due**: delete `pos-staff-login`'s legacy
branch and its PGRST202 fallback, PosLogin's `get_pos_staff` path, Pos.js's legacy notice and the
Till Devices shared-key panel, then drop `get_pos_staff`, `verify_pos_legacy_device`,
`retire_pos_legacy_device_key` and `pos_legacy_device_key_status`, in that order, after the deploys
(`POS_TODO.md` A2). A stale bundle on a legacy tablet calls `get_pos_staff`, so the drop goes last. **Archive, Clear Client Data, Delete Client and the trial purge revoke every
tablet key and rotate/retire the shared key (S755)**. `revokeClientTablets` runs first inside
`deleteClientDataFor`, with the service role, because `revoke_pos_device` and
`retire_pos_legacy_device_key` refuse a caller with no session. The caller is recorded as
`revoked_by`. A restore brings neither back, so each tablet is re-activated from Till Devices.
