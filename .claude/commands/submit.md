---
description: Submit the current solution for an interviewer-style review and record the attempt
argument-hint: "[optional slug]"
allowed-tools: Bash(npx prep:*), Read
---
Review and record the user's solution. Arguments: `$ARGUMENTS`

1. **Gather facts.** Identify the slug (arguments, or the open attempt in `npx prep context`).
   Read `problems/<slug>/Solution.java` and run `npx prep run-tests <slug>` yourself (this stores the fresh
   result on the attempt). Never rely on memory of earlier runs.
2. **Review like an interviewer** — concise, grounded in the actual code and test output:
   - correctness: test result; if failing, show the first failing case and ask them to find the cause
     (don't fix it). Offer to keep working instead of recording, unless they want to submit as is.
   - time and space complexity of *their* code (ask them to state it first if they haven't);
   - edge cases handled / missed; code quality and Java idioms;
   - how it compares to the optimal approach — if theirs is optimal say so now; if not, say the optimal
     complexity exists and (since they're submitting) briefly explain the better idea.
3. **Ask 1–2 follow-up questions** (e.g. "what if the input were streamed?", "what if values were huge?",
   "can you do it in O(1) space?"). Wait for answers before recording; their answers count toward
   communication.
4. **Record.** Pick rubric scores using the calibration table in CLAUDE.md. For each mistake, name the general
   skill gap behind it (CLAUDE.md → Weaknesses) and match it to an active weakness first:
   `--seen "ID: the specific slip"` for an instance of an existing gap, `--handled "ID: what they did right"`
   for one this problem tested that they handled cleanly unprompted, and at most one
   `--weakness "area[/Topic] :: general gap :: the specific slip"` for a gap nobody has logged yet. Then run:
   If you probed a weakness this attempt, add `--probe <id>` with its `--handled` or `--seen` (an unanswered or
   untested probe: leave it out). Then run:
   `npx prep record-attempt <slug> --rubric "optimality=…,approach=…,codeQuality=…,communication=…" [--probe ID] [--seen "ID: …"] [--handled "ID: …"] [--weakness "…"] --summary "<1–2 sentences: approach, outcome, key mistake>"`
   (hints are taken from the log automatically).
5. **Report the rating change in one line** using the CLI's numbers (e.g. "Linked List 1236 → 1251 (+15), review Nov 15
   since you needed the pattern hint"). Only struggles are reviewed: say "no review needed" for a clean solve, and
   "that one's off your review list" when the CLI says it graduated.
   Mention weakness status changes briefly.
6. **Append takeaways** to `problems/<slug>/notes.md`: date, outcome, approach used, complexity, mistakes,
   key insight, follow-up answers — 4–6 bullets.
7. Offer `/next` (or `/end`).
