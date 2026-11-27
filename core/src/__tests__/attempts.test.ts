import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { openDb, seed, topicId, type DB } from '../db';
import {
  abandonAttempt,
  computeOverallRating,
  getAttempt,
  problemStatuses,
  recordAttempt,
  recordHint,
  recordTestRun,
  startAttempt,
  topicRatings,
} from '../attempts';
import { listWeaknesses } from '../weaknesses';

const cfg = loadConfig();
const t0 = new Date(2026, 10, 8, 10, 0, 0);
const t1 = new Date(2026, 10, 8, 10, 25, 0);
const perfect = { optimality: 1, approach: 1, codeQuality: 1, communication: 1 };

let db: DB;

function addProblem(slug: string, topic: string, difficulty: 'easy' | 'medium' | 'hard', order: number, secondary: string[] = []) {
  db.prepare(
    `INSERT INTO problems (slug, track, title, topic_id, secondary_topics, difficulty, difficulty_rating, url)
     VALUES (?, 'dsa', ?, ?, ?, ?, ?, ?)`,
  ).run(slug, slug, topicId(db, 'dsa', topic), JSON.stringify(secondary), difficulty, cfg.rating.difficultyRatings[difficulty], null);
  db.prepare(`INSERT INTO sheet_problems (sheet, slug, sheet_order) VALUES ('neetcode150', ?, ?)`).run(slug, order);
}

const rating = (topic: string) => topicRatings(db, 'dsa').find((t) => t.topic === topic)!;

beforeEach(() => {
  db = openDb(':memory:');
  seed(db, cfg, t0);
  addProblem('two-sum', 'Arrays & Hashing', 'easy', 1);
  addProblem('3sum', 'Two Pointers', 'medium', 2, ['Arrays & Hashing']);
  addProblem('number-of-islands', 'Graphs', 'medium', 3);
});

describe('seed', () => {
  it('creates tracks, 18 DSA topics at 1200, and is idempotent', () => {
    seed(db, cfg, t0);
    expect(topicRatings(db, 'dsa')).toHaveLength(18);
    expect(topicRatings(db, 'dsa').every((t) => t.rating === 1200 && t.attempts === 0)).toBe(true);
    const tracks = db.prepare('SELECT id, enabled FROM tracks ORDER BY id').all();
    expect(tracks).toEqual([
      { id: 'dsa', enabled: 1 },
      { id: 'java', enabled: 0 },
      { id: 'system_design', enabled: 0 },
    ]);
  });
});

describe('recordAttempt', () => {
  it('updates primary and secondary ratings, history, attempt row and review queue', () => {
    startAttempt(db, '3sum', { now: t0 });
    recordTestRun(db, '3sum', 15, 15, t1);
    const r = recordAttempt(db, cfg, { slug: '3sum', rubric: perfect, summary: 'clean two-pointer', now: t1 });

    expect(r.outcome.score).toBe(1);
    expect(r.solveTimeSec).toBe(25 * 60);
    expect(r.changes).toHaveLength(2);
    const [primary, secondary] = r.changes;
    expect(primary).toMatchObject({ topic: 'Two Pointers', isPrimary: true, before: 1200, k: 48 });
    expect(primary.delta).toBeCloseTo(36.47, 1);
    expect(secondary).toMatchObject({ topic: 'Arrays & Hashing', isPrimary: false, weight: 0.5 });
    expect(secondary.delta).toBeCloseTo(18.23, 1);

    expect(rating('Two Pointers')).toMatchObject({ rating: primary.after, attempts: 1 });
    expect(rating('Arrays & Hashing')).toMatchObject({ rating: secondary.after, attempts: 0 });
    expect(r.overallAfter).toBeGreaterThan(r.overallBefore);
    expect(r.overallAfter).toBe(computeOverallRating(db, cfg, 'dsa'));

    const history = db.prepare('SELECT topic_id FROM rating_history WHERE attempt_id = ?').all(r.attemptId);
    expect(history).toHaveLength(3); // two topics + overall

    const a = getAttempt(db, r.attemptId);
    expect(a).toMatchObject({ status: 'completed', outcomeScore: 1, testsPassed: 15, testsTotal: 15, tutorSummary: 'clean two-pointer' });

    const q = db.prepare('SELECT * FROM review_queue WHERE problem_slug = ?').get('3sum');
    expect(q).toMatchObject({ interval_days: 7, due_date: '2026-11-15' });
  });

  it('applies logged hints as a cap even if the tutor passes fewer', () => {
    startAttempt(db, 'two-sum', { now: t0 });
    expect(recordHint(db, cfg, 'two-sum', 2, t0)).toBe(2);
    expect(recordHint(db, cfg, 'two-sum', 1, t0)).toBe(2); // hints never go down
    recordTestRun(db, 'two-sum', 10, 10, t1);
    const r = recordAttempt(db, cfg, { slug: 'two-sum', rubric: perfect, hintsUsed: 0, now: t1 });
    expect(r.hintsUsed).toBe(2);
    expect(r.outcome.score).toBe(0.7);
  });

  it('a review counts at half weight and passing doubles the interval', () => {
    startAttempt(db, 'two-sum', { now: t0 });
    recordTestRun(db, 'two-sum', 10, 10, t0);
    recordAttempt(db, cfg, { slug: 'two-sum', rubric: perfect, now: t0 }); // interval 7
    startAttempt(db, 'two-sum', { isReview: true, now: t1 });
    recordTestRun(db, 'two-sum', 10, 10, t1);
    const r = recordAttempt(db, cfg, { slug: 'two-sum', rubric: perfect, now: t1 });
    expect(r.isReview).toBe(true);
    expect(r.changes[0].weight).toBe(0.5);
    expect(r.review).toMatchObject({ intervalDays: 15, reviewsCount: 1 });
  });

  it('fails cleanly without an open attempt', () => {
    expect(() => recordAttempt(db, cfg, { slug: '3sum', rubric: perfect })).toThrow(/No attempt in progress/);
  });
});

describe('abandonAttempt', () => {
  it('records the attempt as abandoned with no rating change or review, and the problem stays unsolved', () => {
    startAttempt(db, 'number-of-islands', { now: t0 });
    const a = abandonAttempt(db, cfg, 'number-of-islands', { summary: 'stuck on approach', now: t1 });
    expect(a).toMatchObject({ status: 'abandoned', solveTimeSec: 1500, tutorSummary: 'stuck on approach' });
    expect(rating('Graphs')).toMatchObject({ rating: 1200, attempts: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM rating_history').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM review_queue').get()).toEqual({ n: 0 });
    const st = problemStatuses(db, 'neetcode150').find((p) => p.slug === 'number-of-islands')!;
    expect(st.status).toBe('abandoned');
    expect(st.lastAbandonedAt).toBe(t1.toISOString());
  });
});

describe('problemStatuses', () => {
  it('distinguishes unsolved, in_progress, failed and solved', () => {
    startAttempt(db, 'two-sum', { now: t0 });
    recordTestRun(db, 'two-sum', 10, 10, t1);
    recordAttempt(db, cfg, { slug: 'two-sum', rubric: perfect, now: t1 });
    startAttempt(db, '3sum', { now: t0 });
    recordTestRun(db, '3sum', 5, 15, t1);
    recordAttempt(db, cfg, { slug: '3sum', rubric: perfect, now: t1 });
    startAttempt(db, 'number-of-islands', { now: t1 });
    const map = Object.fromEntries(problemStatuses(db, 'neetcode150').map((s) => [s.slug, s.status]));
    expect(map).toEqual({ 'two-sum': 'solved', '3sum': 'failed', 'number-of-islands': 'in_progress' });
  });
});

describe('weaknesses via recordAttempt', () => {
  const solve = (slug: string, weaknesses: any[]) => {
    startAttempt(db, slug, { now: t0 });
    recordTestRun(db, slug, 10, 10, t1);
    return recordAttempt(db, cfg, { slug, rubric: perfect, weaknesses, now: t1 });
  };

  it('creates, re-observes by description, improves and resolves after 3 clean demonstrations', () => {
    const r1 = solve('number-of-islands', [{ description: 'Forgets visited set in BFS', topic: 'Graphs' }]);
    expect(r1.weaknesses[0]).toMatchObject({ action: 'created', status: 'active', timesObserved: 1 });
    const id = r1.weaknesses[0].id;

    const r2 = solve('number-of-islands', [{ description: 'forgets visited set in bfs' }]);
    expect(r2.weaknesses[0]).toMatchObject({ id, action: 'observed', timesObserved: 2 });

    expect(solve('number-of-islands', [{ id, kind: 'handled_well' }]).weaknesses[0].status).toBe('improving');
    expect(solve('number-of-islands', [{ id, kind: 'handled_well' }]).weaknesses[0].status).toBe('improving');
    expect(solve('number-of-islands', [{ id, kind: 'handled_well' }]).weaknesses[0].status).toBe('resolved');

    // Relapse reactivates and resets the clean streak.
    const relapse = solve('number-of-islands', [{ id }]);
    expect(relapse.weaknesses[0]).toMatchObject({ status: 'active', cleanDemonstrations: 0, timesObserved: 3 });
    expect(listWeaknesses(db, 'dsa', ['active'])).toHaveLength(1);
  });

  it('supports general (topic-less) weaknesses and rejects unknown topics', () => {
    const r = solve('two-sum', [{ description: "doesn't state complexity unprompted", topic: null }]);
    expect(listWeaknesses(db, 'dsa')[0].topic).toBeNull();
    expect(r.weaknesses).toHaveLength(1);
    startAttempt(db, '3sum', { now: t0 });
    expect(() =>
      recordAttempt(db, cfg, { slug: '3sum', rubric: perfect, weaknesses: [{ description: 'x', topic: 'Nope' }], now: t1 }),
    ).toThrow(/Unknown dsa topic/);
    // the failed record rolled back: attempt still open, rating untouched
    expect(rating('Two Pointers').attempts).toBe(0);
  });
});
