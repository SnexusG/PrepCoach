# Configuration — `prep.config.json`

Every tuning constant lives in `prep.config.json` at the repo root. It is validated on load (the CLI and server
refuse to start with a clear message if something is inconsistent). Restart `npm run dev` after editing.

Changing rating constants affects **future** attempts only; past rating changes are stored per attempt.

## `rating`
| Key | Default | Meaning |
|---|---|---|
| `initial` | 1200 | starting rating for every topic |
| `difficultyRatings` | easy 1100 · medium 1400 · hard 1700 | the "opponent" rating of a problem in the Elo update (a problem can override it via `prep tag --rating`) |
| `kFactor.provisional` / `provisionalAttempts` / `standard` | 48 / 5 / 24 | Elo K: bigger moves for a topic's first 5 attempts, then steadier |
| `secondaryTopicWeight` | 0.5 | how much secondary topics move relative to the primary topic |
| `reviewWeight` | 0.5 | rating weight of a review attempt |
| `rubricWeights` | correctness 0.35, optimality 0.2, approach 0.15, codeQuality 0.1, communication 0.1, independence 0.1 | outcome = weighted rubric; **must sum to 1** |
| `partialCorrectnessFactor` | 0.7 | correctness credit when some (not all) tests pass is `passed/total × 0.7` |
| `hintCaps` | 1, 0.85, 0.7, 0.5, 0.25 | max outcome after hint level 0–4 (non-increasing, 5 entries) |
| `hintNames` | none, nudge, pattern, approach, full solution | display names of hint levels |
| `confidence.lowAttempts` / `fullAttempts` / `minWeight` | 3 / 10 / 0.1 | topics with < 3 attempts are flagged low-confidence; confidence weight ramps to 1 at 10 attempts (used for the overall rating) |
| `labels` | Beginner 0 · Developing 1200 · Interview-ready (mediums) 1400 · Strong 1600 | rating labels (ascending `min`) |

## `topics`
Per track, the topics and their `frequencyWeight` (how often they show up in interviews). The overall rating is a
weighted average of topic ratings by `frequencyWeight × confidence`.

## `spacedRepetition`
| Key | Default | Meaning |
|---|---|---|
| `initialIntervals` | low 1 · mid 3 · high 7 days | first review interval by outcome band |
| `lowThreshold` / `highThreshold` | 0.5 / 0.75 | outcome bands |
| `reviewPassThreshold` | 0.6 | a review at or above this grows the interval (× ease); below resets it to 1 day and lowers ease |
| `initialEase` / `minEase` / `maxEase` | 2.0 / 1.3 / 2.5 | SM-2-style interval multiplier |
| `maxIntervalDays` | 60 | cap |

## `selection`
| Key | Default | Meaning |
|---|---|---|
| `maxReviewsPerSession` | 1 | due reviews served per session before new problems (`prep next --more-reviews` overrides) |
| `weakTopicMargin` | 50 | a topic is targeted when it is below the starting rating or this far below your average |
| `hardPromotionThreshold` | 1550 | suggest hards once a topic reaches this |
| `failOutcomeThreshold` / `consecutiveFailsToDrop` | 0.5 / 2 | suggest a few easies in a topic after 2 mediums in a row scored below 0.5 |

## `weaknesses`
`cleanDemonstrationsToResolve` (3): clean, unprompted demonstrations needed to resolve a weakness.

## `runner`
`perTestTimeoutMs` (2000): per-test-case timeout for Java solutions (catches infinite loops).

## `ports`
`web` (5173) and `api` (5175). The web dev server proxies `/api` to the API port. `PREP_API_PORT` overrides `api`.

## `tutor` (voice tutor)
| Key | Default | Meaning |
|---|---|---|
| `model` | `null` | Claude model alias for the headless tutor (`null` = your Claude Code default) |
| `permissionMode` | `auto` | headless sessions can't show permission prompts: `auto` lets Claude Code's classifier decide, `dontAsk` allows only `allowedTools` |
| `allowedTools` | `npx prep`, Read, Glob, Grep, edits under `problems/` | always-allowed tools (Claude Code permission-rule syntax) |
| `tts` | `kokoro` | `kokoro` = local neural voice; `browser` = the browser's built-in voices only |
| `ttsDtype` | `fp32` | Kokoro precision. fp32 is fastest on desktop CPUs (~3× realtime); `q8` is smaller but slower |
| `claudeBin` | `claude` | path to the Claude Code executable (or set `PREP_CLAUDE_BIN`) |

Voice, speed and pause length are per-browser settings in the tutor panel (⚙), not in this file.

## Environment variables
| Variable | Effect |
|---|---|
| `PREP_DB` | use a different database file (handy for experiments) |
| `PREP_ROOT` | repo root override |
| `PREP_API_PORT` | API port override |
| `PREP_CLAUDE_BIN` | path to the `claude` executable |
| `JAVA_HOME` | JDK used for `javac`/`java` |
