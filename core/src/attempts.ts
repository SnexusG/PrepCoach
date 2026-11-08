import type { Difficulty, PrepConfig, Track } from './config';
import { getPreference, type DB } from './db';
import {
  computeOutcome,
  eloUpdate,
  normalizeHints,
  overallRating,
  updateWeight,
  type OutcomeResult,
  type Rubric,
} from './rating';
import { scheduleReview, type ReviewState } from './spacedRepetition';
import { applyWeaknessObservations, type WeaknessChange, type WeaknessObservation } from './weaknesses';

export interface ProblemRow {
  slug: string;
  track: Track;
  title: string;
  topicId: number;
  topic: string;
  secondaryTopics: string[];
  difficulty: Difficulty;
  difficultyRating: number;
  url: string | null;
  generated: boolean;
}

export interface AttemptRow {
  id: number;
  sessionId: number | null;
  problemSlug: string;
  status: 'in_progress' | 'completed' | 'abandoned';
  isReview: boolean;
  startedAt: string;
  finishedAt: string | null;
  solveTimeSec: number | null;
  hintsUsed: number;
  testsPassed: number | null;
  testsTotal: number | null;
  lastRunAt: string | null;
  outcomeScore: number | null;
  tutorSummary: string | null;
}

export function getProblem(db: DB, slug: string): ProblemRow {
  const row = db
    .prepare(
      `SELECT p.slug, p.track, p.title, p.topic_id AS topicId, t.name AS topic, p.secondary_topics AS secondaryTopics,
              p.difficulty, p.difficulty_rating AS difficultyRating, p.url, p.generated
       FROM problems p JOIN topics t ON t.id = p.topic_id WHERE p.slug = ?`,
    )
    .get(slug) as (Omit<ProblemRow, 'secondaryTopics' | 'generated'> & { secondaryTopics: string; generated: number }) | undefined;
  if (!row) throw new Error(`Unknown problem: "${slug}"`);
  return { ...row, secondaryTopics: JSON.parse(row.secondaryTopics), generated: !!row.generated };
}

const ATTEMPT_COLS = `id, session_id AS sessionId, problem_slug AS problemSlug, status, is_review AS isReview,
  started_at AS startedAt, finished_at AS finishedAt, solve_time_sec AS solveTimeSec, hints_used AS hintsUsed,
  tests_passed AS testsPassed, tests_total AS testsTotal, last_run_at AS lastRunAt,
  outcome_score AS outcomeScore, tutor_summary AS tutorSummary`;

function mapAttempt(r: any): AttemptRow {
  return { ...r, isReview: !!r.isReview };
}

export function getOpenAttempt(db: DB, slug: string): AttemptRow | undefined {
  const r = db
    .prepare(`SELECT ${ATTEMPT_COLS} FROM attempts WHERE problem_slug = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1`)
    .get(slug);
  return r ? mapAttempt(r) : undefined;
}

export function getAttempt(db: DB, id: number): AttemptRow {
  const r = db.prepare(`SELECT ${ATTEMPT_COLS} FROM attempts WHERE id = ?`).get(id);
  if (!r) throw new Error(`Attempt #${id} not found`);
  return mapAttempt(r);
}

function requireOpenAttempt(db: DB, slug: string): AttemptRow {
  const a = getOpenAttempt(db, slug);
  if (!a) throw new Error(`No attempt in progress for "${slug}". Run \`prep start ${slug}\` first.`);
  return a;
}

function activeSessionId(db: DB): number | null {
  const v = getPreference(db, 'active_session_id');
  return v ? Number(v) : null;
}

/** Opens an attempt (timer starts). Returns the existing open attempt if there is one. */
export function startAttempt(
  db: DB,
  slug: string,
  opts: { isReview?: boolean; now?: Date } = {},
): { attempt: AttemptRow; resumed: boolean } {
  getProblem(db, slug);
  const open = getOpenAttempt(db, slug);
  if (open) return { attempt: open, resumed: true };
  const now = opts.now ?? new Date();
  const isReview = opts.isReview ?? false;
  const sessionId = activeSessionId(db);
  const id = db.transaction(() => {
    const id = Number(
      db
        .prepare('INSERT INTO attempts (session_id, problem_slug, is_review, started_at) VALUES (?, ?, ?, ?)')
        .run(sessionId, slug, isReview ? 1 : 0, now.toISOString()).lastInsertRowid,
    );
    if (isReview && sessionId) db.prepare('UPDATE sessions SET reviews_served = reviews_served + 1 WHERE id = ?').run(sessionId);
    return id;
  })();
  return { attempt: getAttempt(db, id), resumed: false };
}

/** Logs a hint. Levels only go up; returns the new level. */
export function recordHint(db: DB, cfg: PrepConfig, slug: string, level: number, now = new Date()): number {
  const a = requireOpenAttempt(db, slug);
  const lvl = normalizeHints(level, cfg);
  if (lvl <= a.hintsUsed) return a.hintsUsed;
  db.transaction(() => {
    db.prepare('INSERT INTO hint_log (attempt_id, level, given_at) VALUES (?, ?, ?)').run(a.id, lvl, now.toISOString());
    db.prepare('UPDATE attempts SET hints_used = ? WHERE id = ?').run(lvl, a.id);
  })();
  return lvl;
}

/** Stores the latest test run on the open attempt (if any). */
export function recordTestRun(db: DB, slug: string, passed: number, total: number, now = new Date()): void {
  const a = getOpenAttempt(db, slug);
  if (!a) return;
  db.prepare('UPDATE attempts SET tests_passed = ?, tests_total = ?, last_run_at = ? WHERE id = ?').run(
    passed,
    total,
    now.toISOString(),
    a.id,
  );
}

function elapsedSec(startedAt: string, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - new Date(startedAt).getTime()) / 1000));
}

/** Abandon: marked unsolved, no rating change, no review scheduled. */
export function abandonAttempt(db: DB, slug: string, opts: { summary?: string; now?: Date } = {}): AttemptRow {
  const a = requireOpenAttempt(db, slug);
  const now = opts.now ?? new Date();
  db.prepare(
    `UPDATE attempts SET status = 'abandoned', finished_at = ?, solve_time_sec = ?, tutor_summary = ? WHERE id = ?`,
  ).run(now.toISOString(), elapsedSec(a.startedAt, now), opts.summary ?? null, a.id);
  return getAttempt(db, a.id);
}

export interface TopicRating {
  topicId: number;
  topic: string;
  rating: number;
  attempts: number;
  lastUpdated: string | null;
}

export function topicRatings(db: DB, track: Track): TopicRating[] {
  return db
    .prepare(
      `SELECT t.id AS topicId, t.name AS topic, r.rating, r.attempts_count AS attempts, r.last_updated AS lastUpdated
       FROM topics t JOIN ratings r ON r.topic_id = t.id WHERE t.track = ? ORDER BY t.sort_order`,
    )
    .all(track) as TopicRating[];
}

export function computeOverallRating(db: DB, cfg: PrepConfig, track: Track): number {
  const freq = Object.fromEntries(cfg.topics[track].map((t) => [t.name, t.frequencyWeight]));
  return overallRating(topicRatings(db, track), freq, cfg);
}

export interface RecordAttemptParams {
  slug: string;
  rubric: Rubric;
  /** Defaults to the hint level logged on the attempt. */
  hintsUsed?: number;
  /** Default to the attempt's latest test run. */
  testsPassed?: number;
  testsTotal?: number;
  weaknesses?: WeaknessObservation[];
  summary?: string;
  now?: Date;
}

export interface RatingChange {
  topic: string;
  isPrimary: boolean;
  before: number;
  after: number;
  delta: number;
  expected: number;
  k: number;
  weight: number;
}

export interface RecordAttemptResult {
  attemptId: number;
  slug: string;
  isReview: boolean;
  outcome: OutcomeResult;
  hintsUsed: number;
  testsPassed: number;
  testsTotal: number;
  solveTimeSec: number;
  changes: RatingChange[];
  overallBefore: number;
  overallAfter: number;
  review: ReviewState;
  weaknesses: WeaknessChange[];
}

/** The single write path for a finished attempt: outcome, Elo, history, weaknesses, review queue. */
export function recordAttempt(db: DB, cfg: PrepConfig, params: RecordAttemptParams): RecordAttemptResult {
  const now = params.now ?? new Date();
  const ts = now.toISOString();
  const problem = getProblem(db, params.slug);
  const attempt = requireOpenAttempt(db, params.slug);
  const track = problem.track;

  const hintsUsed = normalizeHints(Math.max(params.hintsUsed ?? 0, attempt.hintsUsed), cfg);
  const testsPassed = params.testsPassed ?? attempt.testsPassed ?? 0;
  const testsTotal = params.testsTotal ?? attempt.testsTotal ?? 0;
  const outcome = computeOutcome({ rubric: params.rubric, testsPassed, testsTotal, hintsUsed }, cfg);
  const solveTimeSec = elapsedSec(attempt.startedAt, now);

  return db.transaction((): RecordAttemptResult => {
    const overallBefore = computeOverallRating(db, cfg, track);

    // Elo updates: primary topic at full weight, secondary topics at reduced weight.
    const targets: { name: string; isPrimary: boolean }[] = [
      { name: problem.topic, isPrimary: true },
      ...problem.secondaryTopics
        .filter((t) => t.toLowerCase() !== problem.topic.toLowerCase())
        .map((name) => ({ name, isPrimary: false })),
    ];
    const getRating = db.prepare(
      `SELECT r.topic_id AS topicId, t.name, r.rating, r.attempts_count AS attempts
       FROM ratings r JOIN topics t ON t.id = r.topic_id WHERE t.track = ? AND lower(t.name) = lower(?)`,
    );
    const setRating = db.prepare(
      'UPDATE ratings SET rating = ?, attempts_count = attempts_count + ?, last_updated = ? WHERE topic_id = ?',
    );
    const insChange = db.prepare(
      `INSERT INTO attempt_rating_changes (attempt_id, topic_id, is_primary, weight, expected, k, rating_before, rating_after)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insHistory = db.prepare(
      'INSERT INTO rating_history (track, topic_id, rating, recorded_at, attempt_id) VALUES (?, ?, ?, ?, ?)',
    );

    const changes: RatingChange[] = [];
    for (const target of targets) {
      const r = getRating.get(track, target.name) as
        | { topicId: number; name: string; rating: number; attempts: number }
        | undefined;
      if (!r) continue; // unknown secondary tag: ignore rather than fail the whole record
      const weight = updateWeight(target.isPrimary, attempt.isReview, cfg);
      const elo = eloUpdate(
        { topicRating: r.rating, problemRating: problem.difficultyRating, outcome: outcome.score, attemptsCount: r.attempts, weight },
        cfg,
      );
      setRating.run(elo.newRating, target.isPrimary ? 1 : 0, ts, r.topicId);
      insChange.run(attempt.id, r.topicId, target.isPrimary ? 1 : 0, weight, elo.expected, elo.k, r.rating, elo.newRating);
      insHistory.run(track, r.topicId, elo.newRating, ts, attempt.id);
      changes.push({
        topic: r.name,
        isPrimary: target.isPrimary,
        before: r.rating,
        after: elo.newRating,
        delta: elo.delta,
        expected: elo.expected,
        k: elo.k,
        weight,
      });
    }

    const overallAfter = computeOverallRating(db, cfg, track);
    insHistory.run(track, null, overallAfter, ts, attempt.id);

    db.prepare(
      `UPDATE attempts SET status = 'completed', finished_at = ?, solve_time_sec = ?, hints_used = ?,
         tests_passed = ?, tests_total = ?, rubric = ?, outcome_score = ?, tutor_summary = ? WHERE id = ?`,
    ).run(
      ts,
      solveTimeSec,
      hintsUsed,
      testsPassed,
      testsTotal,
      JSON.stringify({ input: params.rubric, components: outcome.components, raw: outcome.raw, cap: outcome.cap }),
      outcome.score,
      params.summary ?? null,
      attempt.id,
    );

    // Spaced repetition.
    const prevRow = db
      .prepare(
        `SELECT interval_days AS intervalDays, ease, due_date AS dueDate, last_outcome AS lastOutcome,
                reviews_count AS reviewsCount FROM review_queue WHERE problem_slug = ?`,
      )
      .get(problem.slug) as ReviewState | undefined;
    const review = scheduleReview(prevRow ?? null, outcome.score, attempt.isReview, now, cfg);
    db.prepare(
      `INSERT INTO review_queue (problem_slug, due_date, interval_days, ease, last_outcome, reviews_count)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(problem_slug) DO UPDATE SET due_date = excluded.due_date, interval_days = excluded.interval_days,
         ease = excluded.ease, last_outcome = excluded.last_outcome, reviews_count = excluded.reviews_count`,
    ).run(problem.slug, review.dueDate, review.intervalDays, review.ease, review.lastOutcome, review.reviewsCount);

    const weaknesses = applyWeaknessObservations(db, cfg, track, attempt.id, params.weaknesses ?? [], now);

    return {
      attemptId: attempt.id,
      slug: problem.slug,
      isReview: attempt.isReview,
      outcome,
      hintsUsed,
      testsPassed,
      testsTotal,
      solveTimeSec,
      changes,
      overallBefore,
      overallAfter,
      review,
      weaknesses,
    };
  })();
}

/** Per-problem status for selection and dashboards. */
export function problemStatuses(
  db: DB,
  sheet: string,
): { slug: string; status: 'unsolved' | 'in_progress' | 'abandoned' | 'failed' | 'solved'; lastAbandonedAt: string | null }[] {
  const rows = db
    .prepare(
      `SELECT sp.slug,
         MAX(CASE WHEN a.status = 'completed' AND a.tests_total > 0 AND a.tests_passed = a.tests_total THEN 1 ELSE 0 END) AS solved,
         MAX(CASE WHEN a.status = 'in_progress' THEN 1 ELSE 0 END) AS inProgress,
         MAX(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) AS completed,
         MAX(CASE WHEN a.status = 'abandoned' THEN a.finished_at END) AS lastAbandonedAt
       FROM sheet_problems sp LEFT JOIN attempts a ON a.problem_slug = sp.slug
       WHERE sp.sheet = ? GROUP BY sp.slug`,
    )
    .all(sheet) as { slug: string; solved: number; inProgress: number; completed: number; lastAbandonedAt: string | null }[];
  return rows.map((r) => ({
    slug: r.slug,
    status: r.solved
      ? 'solved'
      : r.inProgress
        ? 'in_progress'
        : r.completed
          ? 'failed'
          : r.lastAbandonedAt
            ? 'abandoned'
            : 'unsolved',
    lastAbandonedAt: r.lastAbandonedAt,
  }));
}
