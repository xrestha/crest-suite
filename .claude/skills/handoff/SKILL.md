---
name: handoff
description: Write HANDOFF.md at the repo root so a fresh session can continue this work after /clear. Run by the user as /handoff.
disable-model-invocation: true
---

# /handoff

Write `HANDOFF.md` at the repo root, replacing any existing copy, so the next session can pick up this work after `/clear` without this conversation.

Use exactly these sections, in this order:

1. **Goal**: what the work is for, in one or two sentences.
2. **Done**: what is finished, and how each item was verified (test, `build:verify`, `check:docs`, a live query). Unverified work is not done; put it under Left.
3. **Left**: what remains, in the order it should happen.
4. **Key decisions**: choices already made and why, including anything the user approved or ruled out, so the next session does not re-open them.
5. **Files involved**: repo-relative paths only, one per line. No excerpts.
6. **Next step**: the single action to take first, specific enough to start without re-reading anything else (the exact command, or the file and the change).

Rules:

- Under 40 lines in total.
- No code blocks copied from files. Point at `path:line` instead.
- If work is uncommitted, say so, and list the modified files from `git status --short` under Files involved.
- Write it with the Write tool, and do not commit it: `HANDOFF.md` is gitignored.
- Then tell the user it is written and that they can run `/clear`.
