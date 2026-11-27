import { DIFFICULTIES, type Difficulty, type PrepConfig, type Track } from './config';
import { getPreference, type DB } from './db';
import { addDays, toDateString } from './spacedRepetition';

const DAY_MS = 864e5;

export interface SolveEvent {
  /** When the problem was first solved (all tests passing on a recorded attempt). */
  at: string;
  difficulty: Difficulty;
}

export interface ForecastInput {
  solves: SolveEvent[];
  /** Start of the first attempt on the track: pace isn't measured from before you began. */
  historyStart: string | null;
  remaining: Record<Difficulty, number>;
  total: number;
  now: Date;
  /** Goal date, YYYY-MM-DD. */
  targetDate: string | null;
}

export type ForecastStatus = 'complete' | 'insufficient' | 'stalled' | 'ok';

export interface ForecastTarget {
  date: string;
  daysLeft: number;
  passed: boolean;
  /** Problems per week needed from today to finish on the target date (null once it has passed). */
  requiredPerWeek: number | null;
  /** Whether the projected date is on or before the target (null when there is no projection). */
  onTrack: boolean | null;
}

export interface Forecast {
  status: ForecastStatus;
  solved: number;
  total: number;
  remaining: number;
  remainingByDifficulty: Record<Difficulty, number>;
  /** Days the pace is measured over (the window, or less when you started more recently). */
  spanDays: number;
  solvesInWindow: number;
  /** Problems per week over the span. */
  perWeek: number;
  /** Projected finish (YYYY-MM-DD) and the early–late range; null when there's no projection. */
  date: string | null;
  early: string | null;
  /** null when the data can't bound it (a single solve in the window). */
  late: string | null;
  daysSinceLastSolve: number | null;
  /** What-if: one problem a day from today. */
  atOnePerDay: string | null;
  target: ForecastTarget | null;
  /** Cumulative solved count after each solving day, for the progress chart. */
  history: { date: string; solved: number }[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const dateAfterDays = (now: Date, days: number) => toDateString(addDays(now, Math.ceil(days)));
const daysBetween = (fromDate: string, toDate: string) =>
  Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / DAY_MS);

/** Projects the sheet completion date from the recent solving pace. Pure: everything comes in through `input`. */
export function computeForecast(input: ForecastInput, cfg: PrepConfig): Forecast {
  const f = cfg.forecast;
  const { now } = input;
  const today = toDateString(now);
  const remaining = DIFFICULTIES.reduce((n, d) => n + input.remaining[d], 0);
  const solves = [...input.solves].sort((a, b) => a.at.localeCompare(b.at));

  const effort = (d: Difficulty) => f.difficultyEffort[d];
  const windowStart = now.getTime() - f.windowDays * DAY_MS;
  const inWindow = solves.filter((s) => Date.parse(s.at) >= windowStart && Date.parse(s.at) <= now.getTime());
  const since = Math.max(windowStart, input.historyStart ? Date.parse(input.historyStart) : windowStart);
  const spanDays = Math.max(f.minSpanDays, (now.getTime() - since) / DAY_MS);
  const n = inWindow.length;
  const effortPerDay = inWindow.reduce((sum, s) => sum + effort(s.difficulty), 0) / spanDays;
  const remainingEffort = DIFFICULTIES.reduce((sum, d) => sum + input.remaining[d] * effort(d), 0);

  const last = solves.length ? solves[solves.length - 1] : null;
  const daysSinceLastSolve = last ? Math.max(0, Math.floor((now.getTime() - Date.parse(last.at)) / DAY_MS)) : null;

  let cumulative = 0;
  const byDay = new Map<string, number>();
  for (const s of solves) byDay.set(toDateString(new Date(s.at)), ++cumulative);
  const history = [...byDay].map(([date, solved]) => ({ date, solved }));

  const status: ForecastStatus =
    remaining === 0 ? 'complete' : solves.length < f.minSolves ? 'insufficient' : n === 0 ? 'stalled' : 'ok';

  let date: string | null = null;
  let early: string | null = null;
  let late: string | null = null;
  if (status === 'ok') {
    date = dateAfterDays(now, remainingEffort / effortPerDay);
    // √n uncertainty on the number of solves in the window scales the pace up and down.
    early = dateAfterDays(now, remainingEffort / ((effortPerDay * (n + Math.sqrt(n))) / n));
    const slow = (n - Math.sqrt(n)) / n;
    late = slow > 0 ? dateAfterDays(now, remainingEffort / (effortPerDay * slow)) : null;
  }

  let target: ForecastTarget | null = null;
  if (input.targetDate) {
    const daysLeft = daysBetween(today, input.targetDate);
    const passed = daysLeft < 0;
    target = {
      date: input.targetDate,
      daysLeft,
      passed,
      requiredPerWeek: passed || remaining === 0 ? null : round1((remaining / Math.max(1, daysLeft)) * 7),
      onTrack: remaining === 0 ? true : date ? date <= input.targetDate : null,
    };
  }

  return {
    status,
    solved: input.total - remaining,
    total: input.total,
    remaining,
    remainingByDifficulty: input.remaining,
    spanDays: round1(spanDays),
    solvesInWindow: n,
    perWeek: round1((n / spanDays) * 7),
    date,
    early,
    late,
    daysSinceLastSolve,
    atOnePerDay: remaining ? dateAfterDays(now, remaining) : null,
    target,
    history,
  };
}

export interface ActiveTimeStat {
  /** Average active minutes over attempts with tracked time; null when there are none yet. */
  avgMinutes: number | null;
  attempts: number;
}

/** Average active time of completed first attempts, per difficulty (attempts from before tracking are skipped). */
export function activeTimeByDifficulty(db: DB, track: Track): Record<Difficulty, ActiveTimeStat> {
  const rows = db
    .prepare(
      `SELECT p.difficulty, AVG(a.active_time_sec) AS avgSec, COUNT(*) AS n
       FROM attempts a JOIN problems p ON p.slug = a.problem_slug
       WHERE p.track = ? AND a.status = 'completed' AND a.is_review = 0 AND a.active_time_sec IS NOT NULL
       GROUP BY p.difficulty`,
    )
    .all(track) as { difficulty: Difficulty; avgSec: number; n: number }[];
  return Object.fromEntries(
    DIFFICULTIES.map((d) => {
      const r = rows.find((x) => x.difficulty === d);
      return [d, { avgMinutes: r ? Math.round(r.avgSec / 60) : null, attempts: r?.n ?? 0 }];
    }),
  ) as Record<Difficulty, ActiveTimeStat>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validates a YYYY-MM-DD goal date (null clears it). */
export function parseTargetDate(v: string | null): string | null {
  if (v == null || v === '' || /^none$/i.test(v)) return null;
  if (!DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
    throw new Error(`Target date must be YYYY-MM-DD (got "${v}")`);
  }
  return v;
}

/** Loads the forecast inputs for the active sheet from the database. */
export function getForecast(db: DB, cfg: PrepConfig, opts: { sheet: string; track: Track; now?: Date }): Forecast {
  const now = opts.now ?? new Date();
  const sheetRows = db
    .prepare(
      `SELECT p.slug, p.difficulty,
         (SELECT MIN(a.finished_at) FROM attempts a
           WHERE a.problem_slug = p.slug AND a.status = 'completed' AND a.tests_total > 0 AND a.tests_passed = a.tests_total
         ) AS solvedAt
       FROM sheet_problems sp JOIN problems p ON p.slug = sp.slug WHERE sp.sheet = ?`,
    )
    .all(opts.sheet) as { slug: string; difficulty: Difficulty; solvedAt: string | null }[];
  const remaining: Record<Difficulty, number> = { easy: 0, medium: 0, hard: 0 };
  const solves: SolveEvent[] = [];
  for (const r of sheetRows) {
    if (r.solvedAt) solves.push({ at: r.solvedAt, difficulty: r.difficulty });
    else remaining[r.difficulty]++;
  }
  const start = db
    .prepare(`SELECT MIN(a.started_at) AS s FROM attempts a JOIN problems p ON p.slug = a.problem_slug WHERE p.track = ?`)
    .get(opts.track) as { s: string | null };
  return computeForecast(
    {
      solves,
      historyStart: start.s,
      remaining,
      total: sheetRows.length,
      now,
      targetDate: getPreference(db, 'target_date') || null,
    },
    cfg,
  );
}
