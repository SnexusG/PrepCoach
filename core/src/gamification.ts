/**
 * The fun layer: streaks, quests, achievements, personal bests and the post-submit reward moment.
 * Everything is derived from history (attempts, drills, weakness evidence, rating history), so past work counts
 * and the DB stays rebuildable. Elo is untouched; the only stored state is how far rewards have been celebrated.
 */
import type { Difficulty, PrepConfig, Track } from './config';
import { DIFFICULTIES, gamificationConfig } from './config';
import { getPreference, setPreference, type DB } from './db';
import { ratingLabel } from './rating';
import { addDays, toDateString } from './spacedRepetition';
import { ACHIEVEMENTS, type AchievementDef } from './achievements';

// ---------------------------------------------------------------- history

export interface HistAttempt {
  id: number;
  slug: string;
  title: string;
  topic: string;
  difficulty: Difficulty;
  status: 'completed' | 'abandoned';
  isReview: boolean;
  finishedAt: string;
  hints: number;
  solved: boolean;
  outcome: number | null;
  activeSec: number | null;
}

export interface History {
  attempts: HistAttempt[]; // completed + abandoned, by finish time
  drills: { at: string; correct: number; total: number }[];
  handled: { at: string; weaknessId: number; probed: boolean }[];
  resolvedWeaknesses: { id: number; at: string }[];
  overall: { at: string; rating: number; attemptId: number | null }[];
  topicRatings: { at: string; topic: string; rating: number }[];
  initialRating: number;
}

export function loadHistory(db: DB, cfg: PrepConfig, track: Track): History {
  const attempts = (
    db
      .prepare(
        `SELECT a.id, a.problem_slug AS slug, p.title, t.name AS topic, p.difficulty, a.status, a.is_review AS isReview,
                a.finished_at AS finishedAt, a.hints_used AS hints, a.tests_passed AS passed, a.tests_total AS total,
                a.outcome_score AS outcome, a.active_time_sec AS activeSec
         FROM attempts a JOIN problems p ON p.slug = a.problem_slug JOIN topics t ON t.id = p.topic_id
         WHERE p.track = ? AND a.status IN ('completed','abandoned') AND a.finished_at IS NOT NULL
         ORDER BY a.finished_at, a.id`,
      )
      .all(track) as (Omit<HistAttempt, 'solved' | 'isReview'> & { isReview: number; passed: number | null; total: number | null })[]
  ).map(({ passed, total, isReview, ...a }) => ({
    ...a,
    isReview: !!isReview,
    solved: a.status === 'completed' && !!total && passed === total,
  }));

  const drills = db
    .prepare(
      `SELECT d.at, d.correct, d.total FROM weakness_drills d JOIN weaknesses w ON w.id = d.weakness_id
       WHERE w.track = ? ORDER BY d.at`,
    )
    .all(track) as History['drills'];

  const handledRows = db
    .prepare(
      `SELECT a.finished_at AS at, wa.weakness_id AS weaknessId, wa.probed FROM weakness_attempts wa
       JOIN attempts a ON a.id = wa.attempt_id JOIN weaknesses w ON w.id = wa.weakness_id
       WHERE w.track = ? AND wa.kind = 'handled_well' AND a.finished_at IS NOT NULL ORDER BY a.finished_at`,
    )
    .all(track) as { at: string; weaknessId: number; probed: number }[];
  const handled = handledRows.map((h) => ({ ...h, probed: !!h.probed }));

  // No resolved_at column: a weakness resolves on the clean demonstration that reaches the threshold.
  const need = cfg.weaknesses.cleanDemonstrationsToResolve;
  const resolved = db.prepare(`SELECT id, last_seen AS lastSeen FROM weaknesses WHERE track = ? AND status = 'resolved'`).all(track) as {
    id: number;
    lastSeen: string;
  }[];
  const resolvedWeaknesses = resolved
    .map((w) => {
      const mine = handled.filter((h) => h.weaknessId === w.id);
      return { id: w.id, at: mine[need - 1]?.at ?? mine[mine.length - 1]?.at ?? w.lastSeen };
    })
    .sort((a, b) => a.at.localeCompare(b.at));

  const overall = db
    .prepare(
      `SELECT recorded_at AS at, rating, attempt_id AS attemptId FROM rating_history
       WHERE track = ? AND topic_id IS NULL ORDER BY recorded_at, id`,
    )
    .all(track) as History['overall'];
  const topicRatings = db
    .prepare(
      `SELECT h.recorded_at AS at, t.name AS topic, h.rating FROM rating_history h JOIN topics t ON t.id = h.topic_id
       WHERE h.track = ? ORDER BY h.recorded_at, h.id`,
    )
    .all(track) as History['topicRatings'];

  return { attempts, drills, handled, resolvedWeaknesses, overall, topicRatings, initialRating: cfg.rating.initial };
}

const day = (iso: string) => toDateString(new Date(iso));
const solves = (h: History) => h.attempts.filter((a) => a.solved);

// ---------------------------------------------------------------- streaks + heatmap

export interface StreakState {
  current: number;
  longest: number;
  freezes: number;
  activeToday: boolean;
  /** Days a freeze was spent on. */
  frozenDays: string[];
  /** When the streak first reached each length: the first activity of that day (ISO), for streak badges. */
  reachedOn: Record<number, string>;
}

/** Per local day: the events that make it an active day. */
function activityByDay(h: History): Map<string, { solves: number; attempts: number; drills: number; first: string }> {
  const m = new Map<string, { solves: number; attempts: number; drills: number; first: string }>();
  const touch = (iso: string) => {
    const d = day(iso);
    let e = m.get(d);
    if (!e) m.set(d, (e = { solves: 0, attempts: 0, drills: 0, first: iso }));
    if (iso < e.first) e.first = iso;
    return e;
  };
  for (const a of h.attempts) {
    if (a.status !== 'completed') continue;
    const e = touch(a.finishedAt);
    e.attempts++;
    if (a.solved) e.solves++;
  }
  for (const d of h.drills) touch(d.at).drills++;
  return m;
}

export function computeStreak(h: History, cfg: PrepConfig, now = new Date()): StreakState {
  const g = gamificationConfig(cfg);
  const days = activityByDay(h);
  const today = toDateString(now);
  const s: StreakState = { current: 0, longest: 0, freezes: 0, activeToday: days.has(today), frozenDays: [], reachedOn: {} };
  const first = [...days.keys()].sort()[0];
  if (!first) return s;
  let run = 0; // real active days in a row, for earning freezes
  for (let d = new Date(`${first}T12:00:00`); toDateString(d) <= today; d = addDays(d, 1)) {
    const key = toDateString(d);
    if (days.has(key)) {
      s.current++;
      run++;
      if (run % g.streak.freezeEvery === 0 && s.freezes < g.streak.maxFreezes) s.freezes++;
      s.reachedOn[s.current] ??= days.get(key)!.first;
    } else if (key === today) {
      // today isn't over: the streak is still alive
    } else if (s.current > 0 && s.freezes > 0) {
      s.freezes--;
      s.frozenDays.push(key);
      run = 0;
    } else {
      s.current = 0;
      run = 0;
    }
    s.longest = Math.max(s.longest, s.current);
  }
  return s;
}

export interface HeatDay {
  date: string;
  solves: number;
  attempts: number;
  drills: number;
}

export function heatmap(h: History, now = new Date(), days = 365): HeatDay[] {
  const m = activityByDay(h);
  const out: HeatDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = toDateString(addDays(now, -i));
    const e = m.get(date);
    out.push({ date, solves: e?.solves ?? 0, attempts: e?.attempts ?? 0, drills: e?.drills ?? 0 });
  }
  return out;
}

// ---------------------------------------------------------------- quests

export interface Quest {
  id: string;
  title: string;
  progress: number;
  goal: number;
  done: boolean;
  /** When the goal was reached (ISO), if done. */
  doneAt: string | null;
}

interface QuestTemplate {
  id: string;
  title: (goal: number) => string;
  goal: number;
  /** Timestamps of the events that count toward it, in order. */
  events: (h: History, cfg: PrepConfig, from: string, to: string) => string[];
}

const inRange = (iso: string, from: string, to: string) => day(iso) >= from && day(iso) <= to;
const solvedIn = (h: History, from: string, to: string) => solves(h).filter((a) => inRange(a.finishedAt, from, to));

const DAILY: QuestTemplate[] = [
  { id: 'medium', title: () => 'Solve a medium', goal: 1, events: (h, _c, f, t) => solvedIn(h, f, t).filter((a) => a.difficulty !== 'easy').map((a) => a.finishedAt) },
  { id: 'no-hint', title: () => 'Solve one without hints', goal: 1, events: (h, _c, f, t) => solvedIn(h, f, t).filter((a) => a.hints === 0).map((a) => a.finishedAt) },
  { id: 'drill', title: () => 'Finish a drill', goal: 1, events: (h, _c, f, t) => h.drills.filter((d) => inRange(d.at, f, t)).map((d) => d.at) },
  { id: 'double', title: (n) => `Solve ${n} problems`, goal: 2, events: (h, _c, f, t) => solvedIn(h, f, t).map((a) => a.finishedAt) },
  {
    id: 'par',
    title: () => 'Solve one under par time',
    goal: 1,
    events: (h, c, f, t) =>
      solvedIn(h, f, t)
        .filter((a) => a.activeSec != null && a.activeSec <= gamificationConfig(c).parMinutes[a.difficulty] * 60)
        .map((a) => a.finishedAt),
  },
  { id: 'clean', title: () => 'Score 0.9+ on a solve', goal: 1, events: (h, _c, f, t) => solvedIn(h, f, t).filter((a) => (a.outcome ?? 0) >= 0.9).map((a) => a.finishedAt) },
];
const SOLVE_ANY: QuestTemplate = { id: 'solve', title: () => 'Solve a problem', goal: 1, events: (h, _c, f, t) => solvedIn(h, f, t).map((a) => a.finishedAt) };

const WEEKLY_EXTRA: QuestTemplate[] = [
  { id: 'w-hard', title: () => 'Solve a hard', goal: 1, events: (h, _c, f, t) => solvedIn(h, f, t).filter((a) => a.difficulty === 'hard').map((a) => a.finishedAt) },
  {
    id: 'w-days',
    title: (n) => `Practise on ${n} different days`,
    goal: 5,
    events: (h, _c, f, t) => {
      const firsts = new Map<string, string>();
      for (const a of h.attempts) if (a.status === 'completed' && inRange(a.finishedAt, f, t)) firsts.set(day(a.finishedAt), firsts.get(day(a.finishedAt)) ?? a.finishedAt);
      for (const d of h.drills) if (inRange(d.at, f, t) && !firsts.has(day(d.at))) firsts.set(day(d.at), d.at);
      return [...firsts.values()].sort();
    },
  },
  {
    id: 'w-topics',
    title: (n) => `Solve in ${n} different topics`,
    goal: 3,
    events: (h, _c, f, t) => {
      const seen = new Set<string>();
      return solvedIn(h, f, t).filter((a) => !seen.has(a.topic) && !!seen.add(a.topic)).map((a) => a.finishedAt);
    },
  },
];

/** Small deterministic PRNG seeded by a string (the date), so a day's quests never change. */
function seeded(key: string): () => number {
  let x = 2166136261;
  for (const ch of key) x = Math.imul(x ^ ch.charCodeAt(0), 16777619);
  return () => {
    x = Math.imul(x ^ (x >>> 15), 2246822507);
    x = Math.imul(x ^ (x >>> 13), 3266489909);
    return ((x ^= x >>> 16) >>> 0) / 4294967296;
  };
}

function pick<T>(pool: T[], n: number, key: string): T[] {
  const rnd = seeded(key);
  const a = [...pool];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

function evalQuest(t: QuestTemplate, h: History, cfg: PrepConfig, from: string, to: string, goal = t.goal): Quest {
  const ev = t.events(h, cfg, from, to);
  return { id: t.id, title: t.title(goal), goal, progress: Math.min(goal, ev.length), done: ev.length >= goal, doneAt: ev[goal - 1] ?? null };
}

/** The day's quests: always "solve a problem", plus a seeded pick from the pool. */
export function dailyQuests(h: History, cfg: PrepConfig, date: string): Quest[] {
  const n = gamificationConfig(cfg).quests.daily;
  return [SOLVE_ANY, ...pick(DAILY, Math.max(0, n - 1), `d:${date}`)].map((t) => evalQuest(t, h, cfg, date, date));
}

/** Monday of the local week containing `date`. */
export function weekStart(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return toDateString(addDays(d, -((d.getDay() + 6) % 7)));
}

/** The week's quests: "solve N" sized from your pace (or the goal date's need), plus a seeded extra. */
export function weeklyQuests(h: History, cfg: PrepConfig, date: string, solveTarget: number): Quest[] {
  const from = weekStart(date);
  const to = toDateString(addDays(new Date(`${from}T12:00:00`), 6));
  const n = gamificationConfig(cfg).quests.weekly;
  const solveN: QuestTemplate = { id: 'w-solve', title: (g) => `Solve ${g} problems this week`, goal: solveTarget, events: (hh, _c, f, t) => solvedIn(hh, f, t).map((a) => a.finishedAt) };
  return [solveN, ...pick(WEEKLY_EXTRA, Math.max(0, n - 1), `w:${from}`)].map((t) => evalQuest(t, h, cfg, from, to));
}

// ---------------------------------------------------------------- achievements, bests, levels

export interface Achievement extends Omit<AchievementDef, 'unlock'> {
  unlockedAt: string | null;
  progress: [number, number] | null;
}

export interface AchievementContext {
  h: History;
  cfg: PrepConfig;
  streak: StreakState;
  /** Days on which every daily quest was done, with when the last one was. */
  questDays: { date: string; at: string }[];
}

export function achievements(ctx: AchievementContext): Achievement[] {
  return ACHIEVEMENTS(ctx.cfg).map(({ unlock, ...def }) => {
    const r = unlock(ctx);
    return { ...def, unlockedAt: r.at, progress: r.progress ?? null };
  });
}

export interface PersonalBests {
  fastest: Record<Difficulty, { slug: string; title: string; activeSec: number; at: string } | null>;
  bestOutcome: { slug: string; title: string; outcome: number; at: string } | null;
  longestStreak: number;
}

export function personalBests(h: History, streak: StreakState, until?: string): PersonalBests {
  const s = solves(h).filter((a) => !until || a.finishedAt <= until);
  const fastest = Object.fromEntries(
    DIFFICULTIES.map((d) => {
      const best = s.filter((a) => a.difficulty === d && a.activeSec != null && a.activeSec > 0).sort((a, b) => a.activeSec! - b.activeSec!)[0];
      return [d, best ? { slug: best.slug, title: best.title, activeSec: best.activeSec!, at: best.finishedAt } : null];
    }),
  ) as PersonalBests['fastest'];
  const bo = [...s].filter((a) => a.outcome != null).sort((a, b) => b.outcome! - a.outcome! || a.finishedAt.localeCompare(b.finishedAt))[0];
  return {
    fastest,
    bestOutcome: bo ? { slug: bo.slug, title: bo.title, outcome: bo.outcome!, at: bo.finishedAt } : null,
    longestStreak: streak.longest,
  };
}

export interface LevelStep {
  label: string;
  min: number;
  meaning?: string;
  /** When the overall rating first reached it (null = not yet; the starting level has the first record's time). */
  reachedAt: string | null;
}

export function levelJourney(h: History, cfg: PrepConfig): LevelStep[] {
  return cfg.rating.labels.map((l) => ({
    label: l.label,
    min: l.min,
    meaning: l.meaning,
    // Levels at or below the starting rating count as reached from the first recorded attempt.
    reachedAt: l.min <= h.initialRating ? (h.overall[0]?.at ?? null) : (h.overall.find((r) => r.rating >= l.min)?.at ?? null),
  }));
}

// ---------------------------------------------------------------- full state

export interface GameState {
  streak: StreakState;
  heatmap: HeatDay[];
  quests: { daily: Quest[]; weekly: Quest[] };
  achievements: Achievement[];
  bests: PersonalBests;
  levels: LevelStep[];
}

/**
 * Weekly solve target: what the goal date needs, else one above your pace, but always reachable: at least 3 and
 * at most 3 above your current pace (a quest you can't finish isn't fun).
 */
export function weeklySolveTarget(perWeek: number | null, requiredPerWeek: number | null): number {
  const pace = Math.ceil(perWeek ?? 0);
  const want = requiredPerWeek != null && requiredPerWeek > 0 ? Math.ceil(requiredPerWeek) : pace + 1;
  return Math.max(3, Math.min(want, pace + 3));
}

function questDays(h: History, cfg: PrepConfig, now: Date): AchievementContext['questDays'] {
  const days = [...activityByDay(h).keys()].sort().filter((d) => d <= toDateString(now));
  const out: AchievementContext['questDays'] = [];
  for (const date of days) {
    const q = dailyQuests(h, cfg, date);
    if (q.every((x) => x.done)) out.push({ date, at: q.map((x) => x.doneAt!).sort().at(-1)! });
  }
  return out;
}

export function computeGameState(h: History, cfg: PrepConfig, now: Date, weeklyTarget: number): GameState {
  const streak = computeStreak(h, cfg, now);
  const today = toDateString(now);
  return {
    streak,
    heatmap: heatmap(h, now),
    quests: { daily: dailyQuests(h, cfg, today), weekly: weeklyQuests(h, cfg, today, weeklyTarget) },
    achievements: achievements({ h, cfg, streak, questDays: questDays(h, cfg, now) }),
    bests: personalBests(h, streak),
    levels: levelJourney(h, cfg),
  };
}

// ---------------------------------------------------------------- rewards since a moment

export const REWARDS_SEEN_KEY = 'rewards.seenThrough';

export interface RewardSolve {
  attemptId: number;
  slug: string;
  title: string;
  difficulty: Difficulty;
  solved: boolean;
  isReview: boolean;
  outcome: number | null;
  changes: { topic: string; before: number; after: number; isPrimary: boolean }[];
}

export interface Rewards {
  since: string;
  until: string;
  solves: RewardSolve[];
  overall: { before: number; after: number } | null;
  levelUp: { from: string; to: string; meaning?: string } | null;
  badges: Achievement[];
  quests: Quest[];
  streak: { current: number; extended: boolean; freezes: number };
  bests: { kind: string; text: string }[];
  drills: number;
  empty: boolean;
}

const overallAt = (h: History, iso: string) => {
  let r = h.initialRating;
  for (const x of h.overall) if (x.at <= iso) r = x.rating;
  return r;
};

/** Everything worth celebrating that happened after `since` (exclusive), as of `now`. */
export function rewardsSince(db: DB, h: History, state: GameState, cfg: PrepConfig, since: string, now: Date): Rewards {
  const until = now.toISOString();
  const after = (iso: string | null) => !!iso && iso > since && iso <= until;
  const newAttempts = h.attempts.filter((a) => a.status === 'completed' && after(a.finishedAt));
  const changeStmt = db.prepare(
    `SELECT t.name AS topic, c.rating_before AS before, c.rating_after AS after, c.is_primary AS isPrimary
     FROM attempt_rating_changes c JOIN topics t ON t.id = c.topic_id WHERE c.attempt_id = ? ORDER BY c.is_primary DESC`,
  );
  const solvesOut: RewardSolve[] = newAttempts.map((a) => ({
    attemptId: a.id,
    slug: a.slug,
    title: a.title,
    difficulty: a.difficulty,
    solved: a.solved,
    isReview: a.isReview,
    outcome: a.outcome,
    changes: (changeStmt.all(a.id) as { topic: string; before: number; after: number; isPrimary: number }[]).map((c) => ({ ...c, isPrimary: !!c.isPrimary })),
  }));

  const before = overallAt(h, since);
  const afterR = overallAt(h, until);
  const idx = (r: number) => cfg.rating.labels.filter((l) => r >= l.min).length - 1;
  const levelUp =
    idx(afterR) > idx(before)
      ? {
          from: ratingLabel(before, cfg),
          to: ratingLabel(afterR, cfg),
          meaning: cfg.rating.labels[idx(afterR)]?.meaning,
        }
      : null;

  const badges = state.achievements.filter((a) => after(a.unlockedAt));
  const quests = [...state.quests.daily, ...state.quests.weekly].filter((q) => q.done && after(q.doneAt));
  const activeBefore = h.attempts.some((a) => a.status === 'completed' && a.finishedAt <= since && day(a.finishedAt) === toDateString(now)) || h.drills.some((d) => d.at <= since && day(d.at) === toDateString(now));
  const drills = h.drills.filter((d) => after(d.at)).length;

  // Personal bests set after `since` that beat a record which already existed then.
  const old = personalBests(h, state.streak, since);
  const bests: Rewards['bests'] = [];
  for (const d of DIFFICULTIES) {
    const nowBest = state.bests.fastest[d];
    const was = old.fastest[d];
    if (nowBest && was && after(nowBest.at) && nowBest.activeSec < was.activeSec) {
      bests.push({ kind: `fastest-${d}`, text: `Fastest ${d}: ${Math.round(nowBest.activeSec / 60)} min (was ${Math.round(was.activeSec / 60)})` });
    }
  }
  if (state.bests.bestOutcome && old.bestOutcome && after(state.bests.bestOutcome.at) && state.bests.bestOutcome.outcome > old.bestOutcome.outcome) {
    bests.push({ kind: 'outcome', text: `Best score yet: ${state.bests.bestOutcome.outcome.toFixed(2)}` });
  }

  const extended = state.streak.activeToday && !activeBefore && (newAttempts.length > 0 || drills > 0);
  const r: Rewards = {
    since,
    until,
    solves: solvesOut,
    overall: solvesOut.length ? { before, after: afterR } : null,
    levelUp,
    badges,
    quests,
    streak: { current: state.streak.current, extended, freezes: state.streak.freezes },
    bests,
    drills,
    empty: false,
  };
  r.empty = !solvesOut.length && !levelUp && !badges.length && !quests.length && !drills && !bests.length;
  return r;
}

// ---------------------------------------------------------------- DB-facing entry points

export interface GameContext {
  history: History;
  state: GameState;
}

/** Loads history and computes the full state. `weeklyTarget` comes from the forecast (see `weeklySolveTarget`). */
export function getGame(db: DB, cfg: PrepConfig, track: Track, weeklyTarget: number, now = new Date()): GameContext {
  const history = loadHistory(db, cfg, track);
  return { history, state: computeGameState(history, cfg, now, weeklyTarget) };
}

/** Rewards not yet celebrated. The first call only sets the marker, so old history doesn't all pop at once. */
export function pendingRewards(db: DB, cfg: PrepConfig, game: GameContext, now = new Date()): Rewards {
  let since = getPreference(db, REWARDS_SEEN_KEY);
  if (!since) {
    since = now.toISOString();
    setPreference(db, REWARDS_SEEN_KEY, since);
  }
  return rewardsSince(db, game.history, game.state, cfg, since, now);
}

/** Marks rewards up to `through` (the `until` of the pending rewards shown) as celebrated. */
export function ackRewards(db: DB, through: string): void {
  const cur = getPreference(db, REWARDS_SEEN_KEY);
  if (!cur || through > cur) setPreference(db, REWARDS_SEEN_KEY, through);
}

/** One line for the CLI after record-attempt and for `prep context`. */
export function rewardLine(r: Rewards): string {
  const parts: string[] = [];
  if (r.streak.current > 0) parts.push(`🔥 streak ${r.streak.current}${r.streak.extended ? ' (+1)' : ''}`);
  if (r.levelUp) parts.push(`⬆ level up: ${r.levelUp.to}!`);
  for (const b of r.badges) parts.push(`🏅 ${b.name}`);
  for (const q of r.quests) parts.push(`✅ quest "${q.title}"`);
  for (const b of r.bests) parts.push(`⚡ ${b.text}`);
  return parts.join(' · ');
}
