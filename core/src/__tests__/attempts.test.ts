import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { openDb, seed, topicId, type DB } from '../db';
import {
  abandonAttempt,
  computeOverallRating,
  getAttempt,
  problemStatuses,
  pruneReviewQueue,
  recordAttempt,
  recordHint,
  recordTestRun,
  startAttempt,
  topicRatings,
} from '../attempts';
import { getWeakness, listWeaknesses, mergeWeaknesses, updateWeakness } from '../weaknesses';
import { weaknessesWithExamples } from '../queries';

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

    // A clean solve is not scheduled for review.
    expect(r.review).toMatchObject({ action: 'none', reasons: [] });
    expect(db.prepare('SELECT * FROM review_queue WHERE problem_slug = ?').get('3sum')).toBeUndefined();
  });

  it('schedules a review only for a struggle, and says why', () => {
    startAttempt(db, '3sum', { now: t0 });
    recordTestRun(db, '3sum', 15, 15, t1);
    const r = recordAttempt(db, cfg, { slug: '3sum', rubric: { ...perfect, approach: 0.3 }, now: t1 });
    expect(r.review.action).toBe('scheduled');
    expect(r.review.reasons).toEqual(['approach needed heavy steering (0.3)']);
    const q = db.prepare('SELECT * FROM review_queue WHERE problem_slug = ?').get('3sum');
    expect(q).toMatchObject({ interval_days: 7, due_date: '2026-11-15', reason: 'approach needed heavy steering (0.3)' });
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

  it('a review counts at half weight, and a clean review graduates the problem', () => {
    startAttempt(db, 'two-sum', { now: t0 });
    recordTestRun(db, 'two-sum', 10, 10, t0);
    recordAttempt(db, cfg, { slug: 'two-sum', rubric: { ...perfect, independence: 0.3 }, now: t0 }); // struggled → queued
    startAttempt(db, 'two-sum', { isReview: true, now: t1 });
    recordTestRun(db, 'two-sum', 10, 10, t1);
    const r = recordAttempt(db, cfg, { slug: 'two-sum', rubric: perfect, now: t1 });
    expect(r.isReview).toBe(true);
    expect(r.changes[0].weight).toBe(0.5);
    expect(r.review).toMatchObject({ action: 'graduated', cleanStreak: 1 });
    expect(db.prepare('SELECT * FROM review_queue WHERE problem_slug = ?').get('two-sum')).toBeUndefined();
  });

  it('a review that still needs a pattern hint stays queued with a longer interval', () => {
    startAttempt(db, 'two-sum', { now: t0 });
    recordTestRun(db, 'two-sum', 6, 10, t0);
    const first = recordAttempt(db, cfg, { slug: 'two-sum', rubric: perfect, now: t0 });
    expect(first.review.reasons).toEqual(['tests 6/10']);
    startAttempt(db, 'two-sum', { isReview: true, now: t1 });
    recordHint(db, cfg, 'two-sum', 2, t1);
    recordTestRun(db, 'two-sum', 10, 10, t1);
    const r = recordAttempt(db, cfg, { slug: 'two-sum', rubric: perfect, now: t1 });
    expect(r.review.action).toBe('scheduled');
    expect(r.review.reasons).toEqual(['hint level 2 (pattern)']);
    expect(r.review.state!.reviewsCount).toBe(1);
    expect(r.review.state!.intervalDays).toBeGreaterThan(first.review.state!.intervalDays);
  });

  it('needs several clean reviews when graduateAfterCleanReviews > 1', () => {
    const strict = { ...cfg, spacedRepetition: { ...cfg.spacedRepetition, graduateAfterCleanReviews: 2 } };
    startAttempt(db, 'two-sum', { now: t0 });
    recordTestRun(db, 'two-sum', 6, 10, t0);
    recordAttempt(db, strict, { slug: 'two-sum', rubric: perfect, now: t0 });
    for (const [i, expected] of (['scheduled', 'graduated'] as const).entries()) {
      const at = new Date(t1.getTime() + i * 864e5);
      startAttempt(db, 'two-sum', { isReview: true, now: at });
      recordTestRun(db, 'two-sum', 10, 10, at);
      expect(recordAttempt(db, strict, { slug: 'two-sum', rubric: perfect, now: at }).review.action).toBe(expected);
    }
  });

  it('prunes clean solves already in the queue', () => {
    startAttempt(db, 'two-sum', { now: t0 });
    recordTestRun(db, 'two-sum', 10, 10, t0);
    recordAttempt(db, cfg, { slug: 'two-sum', rubric: perfect, now: t0 });
    startAttempt(db, '3sum', { now: t0 });
    recordTestRun(db, '3sum', 15, 15, t0);
    recordAttempt(db, cfg, { slug: '3sum', rubric: { ...perfect, approach: 0.2 }, now: t0 });
    // Simulate a queue from before the struggle rule: a clean solve queued anyway.
    db.prepare(
      `INSERT INTO review_queue (problem_slug, due_date, interval_days, ease, last_outcome, reviews_count) VALUES ('two-sum', '2026-11-15', 7, 2, 1, 0)`,
    ).run();
    expect(pruneReviewQueue(db, cfg, { dryRun: true }).removed).toEqual([{ slug: 'two-sum' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM review_queue').get()).toEqual({ n: 2 });
    const r = pruneReviewQueue(db, cfg);
    expect(r.kept).toEqual([{ slug: '3sum', reasons: ['approach needed heavy steering (0.2)'] }]);
    expect((db.prepare('SELECT problem_slug AS s FROM review_queue').all() as { s: string }[]).map((x) => x.s)).toEqual(['3sum']);
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

describe('general weaknesses with specific notes', () => {
  const solve = (slug: string, weaknesses: any[], at = t1) => {
    startAttempt(db, slug, { now: t0 });
    recordTestRun(db, slug, 10, 10, at);
    return recordAttempt(db, cfg, { slug, rubric: perfect, weaknesses, now: at });
  };
  const notes = (id: number) =>
    (db.prepare('SELECT note FROM weakness_attempts WHERE weakness_id = ? ORDER BY attempt_id').all(id) as { note: string | null }[]).map((r) => r.note);

  it('keeps the general gap on the weakness and each slip as a note', () => {
    const r1 = solve('two-sum', [
      { description: 'not comfortable with the cost of Java collection operations', area: 'complexity', note: 'priced HashMap insert at O(log n)' },
    ]);
    const id = r1.weaknesses[0].id;
    solve('3sum', [{ id, note: 'thought sorting a list is O(n)' }]);
    expect(getWeakness(db, id)).toMatchObject({ area: 'complexity', timesObserved: 2 });
    expect(notes(id)).toEqual(['priced HashMap insert at O(log n)', 'thought sorting a list is O(n)']);
    const [w] = weaknessesWithExamples(db, 'dsa');
    expect(w.examples.map((e) => e.note)).toEqual(['thought sorting a list is O(n)', 'priced HashMap insert at O(log n)']);
  });

  it('merges weaknesses: history, counts and old wording move to the target', () => {
    const a = solve('two-sum', [{ description: 'rusty collections syntax', area: 'java', note: 'nums.size() on an array' }]).weaknesses[0].id;
    const b = solve('3sum', [{ description: 'TreeSet comparator collapses equal counts' }]).weaknesses[0].id;
    solve('number-of-islands', [{ id: a, kind: 'handled_well' }]); // a is improving, b is active
    const merged = mergeWeaknesses(db, [b], a, { description: 'not yet fluent with the Java collections API and its semantics' });
    expect(merged).toMatchObject({ id: a, area: 'java', timesObserved: 2, status: 'active', cleanDemonstrations: 0 });
    expect(getWeakness(db, b)).toBeUndefined();
    // a's own slip keeps its note; b's slip had none, so its old wording becomes the note; a clean demonstration gets none
    expect(notes(a)).toEqual(['nums.size() on an array', 'TreeSet comparator collapses equal counts', null]);
    expect(() => mergeWeaknesses(db, [a], a)).toThrow(/Nothing to merge/);
  });

  it('generalizing a description keeps the old wording as notes', () => {
    const id = solve('two-sum', [{ description: 'believes HashMap insertion is O(log n)' }]).weaknesses[0].id;
    const w = updateWeakness(db, id, { description: 'not comfortable with Java operation costs', area: 'complexity', generalize: true });
    expect(w).toMatchObject({ description: 'not comfortable with Java operation costs', area: 'complexity' });
    expect(notes(id)).toEqual(['believes HashMap insertion is O(log n)']);
  });
});
