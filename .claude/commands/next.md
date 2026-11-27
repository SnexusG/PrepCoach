---
description: Serve the next problem (generates files if needed, starts the timer)
argument-hint: "[optional: topic / difficulty / 'more reviews' / a specific slug]"
allowed-tools: Bash(npx prep:*)
---
Serve the next problem. User arguments: `$ARGUMENTS`

1. **Pick.**
   - If the user named a specific problem slug, use it.
   - Otherwise run `npx prep next` with flags from the arguments: `--topic "<Topic>"`, `--difficulty <level>`,
     `--more-reviews` (exact topic names are in `npx prep context`).
   - If it warns about an open attempt, ask the user to finish it or `/abandon` it first, and stop.
2. **Generate if needed.** If the files are "NOT generated yet", follow `docs/problem-generation.md` exactly
   (scaffold → tag secondary topics → own-words `Problem.md` → stub `Solution.java` → `tests.json` with edge
   cases → verify against a private reference outside the repo → delete the reference). Do this quietly; don't
   show tests, reference code or hints.
3. **Start.** Run `npx prep start <slug>` (it auto-detects reviews; it starts the timer). Note the
   "Probe this attempt" weakness silently — you'll test it during the problem (CLAUDE.md → Deliberate probing).
4. **Present** concisely in the chat:
   - title, topic, difficulty, and the reason it was chosen (from `prep next`), plus "REVIEW" if it is one;
   - the statement from `Problem.md` (constraints and examples included);
   - "Open in the editor: http://localhost:5173/problem/<slug>" (or edit `problems/<slug>/Solution.java` in the IDE);
   - **if another active weakness is relevant** (not the one you're probing), a one-line heads-up using a past
     slip as the example — without hinting at the approach. E.g. "Last time you priced a HashMap insert at log n —
     keep operation costs in mind."
5. Ask for the approach: "Walk me through your approach and its time/space complexity before you code."
   For reviews: "Explain the approach and complexity, then code it quickly."
Then follow the interviewer rules in CLAUDE.md (probe, don't confirm optimality, don't give hints).
