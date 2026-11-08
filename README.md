# PrepCoach

A local-only interview-prep coach for big-tech interviews. **Claude Code is the tutor**: it serves problems,
runs the approach discussion like an interviewer, gives tiered hints and reviews your code. PrepCoach provides
everything a chat is bad at: a Java editor with a test runner, a deterministic rating engine, weakness tracking,
spaced-repetition reviews, a progress dashboard, and a **hands-free voice conversation** with the tutor.

No LLM API key is needed: the tutor runs on your Claude subscription through the `claude` CLI, and nothing in
PrepCoach calls an LLM API directly.

- **Track:** DSA (NeetCode 150 / Blind 75) in Java 17. System Design and Java Fundamentals are reserved for later.
- **State:** SQLite (`data/prep.db`). All ratings and state changes go through the `prep` CLI.

```
 you ──voice/typing──▶ browser (localhost:5173) ──▶ local server (5175) ──▶ headless Claude Code (the tutor)
                        editor · tests · dashboard        │                    runs `npx prep …`
                                                          └──▶ SQLite + problems/ on disk ◀──┘
```

## Requirements

| | Version | Why |
|---|---|---|
| Node.js | 20+ | server, web app, `prep` CLI |
| JDK | 17+ (`javac` and `java` on PATH, or `JAVA_HOME`) | compiles and tests your solutions |
| Claude Code | logged in (run `claude` once) | the tutor |
| Chrome or Edge | recent | voice input (Web Speech API) |

## Setup

```bash
npm install
npx prep doctor      # checks Node, JDK, the claude CLI, the database and the voice model
npm run dev          # runs `prep init`, then starts the API (5175) and the web app (5173)
```

Open **http://localhost:5173**. The first `npm run dev` downloads the Kokoro voice model (~310 MB) into
`data/models/`. That happens once, in the background.

## Practising

### By voice (recommended)
1. On the dashboard, click **🎙 Start talking** and say *"let's start a session"*.
2. The tutor greets you with your status and serves a problem. The problem page opens automatically:
   statement, editor and tests on screen, tutor panel underneath.
3. Talk through your approach and its complexity. The tutor probes edge cases and asks "can you do better?",
   without giving the answer away.
4. Code in the editor (it autosaves to `problems/<slug>/Solution.java`). **Run tests** with Ctrl+Enter.
5. Say *"I'm done"* or press **Submit** to get the interviewer review. Your rating, weaknesses and review queue
   update and the dashboard reflects them right away.

**How the voice works**
- **Hands-free.** The mic stays open, and a short pause sends your turn. Pause length is set in ⚙.
- **Barge-in.** Talking over the tutor interrupts it.
- **Natural replies.** The tutor speaks with a local neural voice (Kokoro). Pick the voice and speed in ⚙.
- **Headphones** work best. A filter drops speech that mostly repeats what the tutor just said, but headphones
  are more reliable.
- **Privacy.** Chrome sends mic audio to Google for speech recognition. Everything else stays on your machine.

The quick-action buttons (Start session, Next problem, Hint, Submit, End) and the text box work too.

### In the terminal
Run `claude` in the repo and use the same slash commands. The web editor and dashboard still work alongside:

| Command | What it does |
|---|---|
| `/prep-start` | start a session: status, confirm sheet + difficulty |
| `/next` | serve the next problem (generates its files on first use, starts the timer) |
| `/hint` | tiered hint (nudge → pattern → approach → full solution). The cost is announced first and every level is logged |
| `/submit` | interviewer review, follow-ups, records the attempt |
| `/abandon` | give up (no rating change, the problem stays unsolved and comes back later) |
| `/status` | progress summary |
| `/end` | wrap up with three takeaways and the next focus |

## Pages

- **Dashboard** `/`: rating, trend and label; topic ratings (weakest first, hatched = low confidence);
  rating over time; weaknesses; reviews due; sheet completion; recent attempts; the voice tutor.
- **Problem** `/problem/<slug>`: statement, Monaco Java editor (picks up edits from your IDE), test runner,
  timer, hint level.
- **History** `/history`: every attempt with filters. Click one for rubric, rating changes, hints,
  weaknesses, notes and code.

## How rating works

- **Outcome.** Each attempt gets an outcome score from 0 to 1. Correctness comes from the tests. The tutor
  scores optimality, approach, code quality and communication. Independence is scaled by hints, and each hint
  level caps the maximum outcome.
- **Elo.** The outcome feeds an Elo update of the topic rating against the problem's difficulty rating.
  Secondary topics move at half weight and reviews at reduced weight.
- **Overall.** The overall DSA rating is a weighted average of topic ratings, weighted by interview frequency
  and by confidence (how many attempts back it up).
- **Reviews.** Solved problems are scheduled for spaced-repetition review, and weaknesses resolve after
  repeated clean demonstrations.

Every constant is in [`prep.config.json`](prep.config.json). See [docs/configuration.md](docs/configuration.md).

## CLI

`npx prep <command>` (add `--json` for machine output). Most-used:

```
prep doctor                 check prerequisites
prep context | stats        status for the tutor / progress summary
prep next | start <slug>    pick / start a problem
prep run-tests <slug>       compile and test Solution.java
prep reviews                spaced-repetition queue
prep weakness list
prep set --sheet neetcode150 --difficulty medium
prep backup                 copy the DB to data/backups/prep-<timestamp>.db
```

Run `npx prep --help` for everything.

## Project layout

```
core/      shared library: DB, rating engine, selection, spaced repetition, Java runner
cli/       the `prep` CLI (single source of truth for state)
server/    Express API + voice-tutor bridge (headless Claude Code) + local TTS
web/       Vite + React app (dashboard, problem page, history, voice)
harness/   Java test harness (per-test timeout, ListNode/TreeNode/design problems)
problems/  one folder per problem: Problem.md, Solution.java, tests.json, notes.md
data/      sheets (catalogs). Generated and ignored by git: prep.db, backups/, models/, tutor/
.claude/   slash commands; CLAUDE.md holds the tutor instructions
```

## Backups and data

- `npm run backup` (or `npx prep backup`) snapshots the database to `data/backups/`.
- `data/prep.db`, backups, the voice model and tutor transcripts are git-ignored.
- `problems/` (your code and notes) is tracked.

## Troubleshooting

- **The tutor never answers.** Run `npx prep doctor`. Claude Code must be installed and logged in.
- **No voice.** Click anywhere on the page once (browsers block audio until you interact). If the neural voice
  fails, it falls back to the browser voice.
- **The mic cuts you off.** Raise "Pause to send" in ⚙.
- **Port in use.** Change `ports` in `prep.config.json`.
