---
description: Wrap up the session with takeaways and next focus
allowed-tools: Bash(npx prep:*)
---
Wrap up the session.

1. If an attempt is still open, ask whether to `/submit` it or `/abandon` it before ending (don't end with it dangling
   unless the user insists — it's fine to leave it open to resume next time).
2. Run `npx prep context` to see this session's attempts and rating changes.
3. Give **exactly 3 bullet takeaways** from this session (what went well, the main mistake pattern, one insight).
4. Give **what to focus on next time** in 1–2 lines (weakest topic / weakness to target, reviews coming due).
   **Weakness check:** if two weaknesses in the context are the same underlying gap, or one only describes a
   single incident, propose the merge or rewording (CLAUDE.md → Weaknesses → Consolidate) in one line and run it
   only if the user agrees.
5. Run `npx prep session end --summary "<one line: problems done, key takeaway, next focus>"`.
