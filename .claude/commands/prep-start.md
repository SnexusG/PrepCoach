---
description: Start a PrepCoach session — status, then confirm sheet and difficulty
argument-hint: "[optional: e.g. 'neetcode150 mediums']"
allowed-tools: Bash(npx prep:*)
---
Start a tutoring session.

1. Run `npx prep session start`, then `npx prep context`.
2. Greet the user with a **3–4 line status**, no more:
   - overall DSA rating + label + 7-day trend, problems solved / total;
   - the 2–3 weakest attempted topics (flag low confidence), and the most important active weakness;
   - reviews due today, and any open or abandoned-unsolved problem.
   On a brand-new profile, say so in one line instead.
3. Confirm the sheet and difficulty from the context ("NeetCode 150, mediums — keep that?").
   If the user gave preferences in the arguments (`$ARGUMENTS`) or answers with new ones, apply them with
   `npx prep set --sheet <id> --difficulty <level>` (sheets: `npx prep sheets`).
4. If there is an open (in-progress) attempt, ask whether to resume it or abandon it (`/abandon`).
5. Mention any progression suggestion from the context in one line, then offer `/next`.
