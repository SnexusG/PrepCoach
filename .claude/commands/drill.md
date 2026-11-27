---
description: Short drill (2–4 minutes) on one of your weaknesses
argument-hint: "[optional: 'all', a weakness id or an area, e.g. '2' or 'complexity']"
allowed-tools: Bash(npx prep:*)
---
Run a short drill on one weakness. User arguments: `$ARGUMENTS`

In the web app there is a **Drill page** (http://localhost:5173/drill) with a dedicated interface — multiple
choice, typed answers, spot-the-bug — that records results by itself. If the user is in the web app and isn't
asking for a spoken drill, suggest the Drill page in one line instead. Otherwise (terminal, or voice), run it here:

Drills are quick practice on the **skill gap**, not on a problem: they never use a problem from the sheet that
the user hasn't solved (no spoilers), and they don't count as hints.

1. **Pick the weakness.**
   - `all` (or "everything", "mixed") → a **mixed drill**: 7–8 questions spread over all active and improving
     weaknesses (least recently drilled first, at most 3 each), alternating between them; announce which weakness
     each question is about, and at the end record one result per weakness with `npx prep drill record`.
   - A number in the arguments → that weakness id. An area name (complexity, java, …) →
     `npx prep weakness focus --drill --area <area>`.
   - Otherwise `npx prep weakness focus --drill` (it rotates: least recently drilled first).
   - If there are no active weaknesses, say so and offer `/next` instead.
2. **Announce it in one line**: "Quick drill on <the weakness, in plain words> — 5 questions, about 3 minutes."
3. **Ask 4–5 short questions, one at a time.** Build them from the weakness and its noted slips in
   `npx prep context` (aim at what actually went wrong), and vary them — never repeat the last drill's
   questions (its note is in the context). Formats by area:
   - **complexity**: "What does `TreeMap.put` cost?", "Complexity of this 4-line snippet?", "Sorting a
     `List<String>` of n strings of length k — total cost?"
   - **java**: "Which method checks a key in a `HashMap`?", "Why won't `List<int>` compile?", "What does this
     line print?", "Fix this line".
   - **edge-cases**: give a signature and constraints; "Which inputs would break a naive solution?"
   - **understanding**: give a 3–4 line problem statement; "What would you ask, and what are the rules and
     constraints in your own words?"
   - **algorithm**: one-line problem descriptions; "Which pattern, and why?"
   - **implementation**: a 4–8 line snippet with a bug (off-by-one, wrong bound, duplicated block); "Find it."
   - **testing**: a short buggy function; "Smallest input that exposes the bug?"
   - **communication**: "Explain this approach in 30 seconds with its complexity" — judge structure and whether
     complexity comes up unprompted.
   Show code in fenced blocks (on screen, not read aloud in voice mode); keep spoken questions to one sentence.
4. **After each answer**: right or wrong in one line, plus the correct answer briefly. It's practice, so give
   the answer — unlike interview problems.
5. **Record** the result: `npx prep drill record <id> --score <correct>/<total> --note "<what they missed, or 'all correct'>"`.
   Drills are practice and don't change the weakness status — real problems do (see probing in CLAUDE.md).
6. **Wrap up in one line** ("4/5 — operation costs are solid, sorting cost still shaky") and offer `/next`.
