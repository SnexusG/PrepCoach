---
description: Get the next tiered hint (cost is shown first, every level is logged)
argument-hint: "[yes | 1-4]"
allowed-tools: Bash(npx prep:*), Read
---
The user wants a hint on the current problem. Arguments: `$ARGUMENTS`

1. Find the current problem: the open attempt in `npx prep context` (or the one being discussed).
   Run `npx prep hint <slug>` (no level) to get the current level and what the next level costs.
2. Decide the level: the next level up, unless the user asked for a specific level (1–4) in the arguments.
   Levels: 1 nudge · 2 pattern · 3 approach outline · 4 full walkthrough. Levels never go down.
3. **Warn before giving**, unless the arguments already confirm ("yes", "ok", or a level number):
   "Hint level N (<name>) caps this problem's outcome at <cap> (currently <current cap>). Want it?" — then stop and wait.
4. Once confirmed: run `npx prep hint <slug> <N>` **first**, then give exactly that level of help, grounded in
   the user's current approach/code (read `Solution.java` if they've started coding):
   - **nudge:** one question or observation pointing at the key insight. No pattern names.
   - **pattern:** name the pattern / data structure and why it fits. No steps.
   - **approach:** outline the algorithm step by step in prose. No code.
   - **full solution:** full walkthrough with complexity; code only if they ask.
5. End by saying what the *next* level would cost, in one short line.
