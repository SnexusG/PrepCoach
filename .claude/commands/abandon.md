---
description: Give up on the current problem (no rating change; it stays unsolved and comes back later)
argument-hint: "[optional reason]"
allowed-tools: Bash(npx prep:*), Read
---
The user wants to stop working on the current problem. Arguments: `$ARGUMENTS`

1. Identify the open attempt (`npx prep context`). If there is none, say so and stop.
2. Confirm once, briefly, unless the arguments already make it clear: abandoning means no rating change,
   no review scheduled, and the problem stays unsolved and will be offered again in a later session.
   Offer the alternative: a hint (`/hint`) or submitting as is (`/submit`).
3. Run `npx prep abandon <slug> --summary "<where they got stuck, in one sentence>"`.
4. If the stuck point reflects a specific weakness, log it: `npx prep weakness observe --seen <id>` or
   `--weakness "Topic :: description"`.
5. Add a short entry to `problems/<slug>/notes.md` (date, abandoned, where they got stuck) — no solution.
6. Do **not** reveal the solution unless the user explicitly asks. Offer `/next`.
