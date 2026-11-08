import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { openDb, seed, type DB } from '../db';
import { importSheet, loadSheet } from '../catalog';
import { abandonAttempt, recordAttempt, recordTestRun, startAttempt } from '../attempts';
import { endSession, startSession } from '../sessions';
import { getContext, getStats, nextProblem, renderContextMarkdown } from '../queries';

const cfg = loadConfig();
let db: DB;
const now = new Date(2026, 10, 8, 10);
const perfect = { optimality: 1, approach: 1, codeQuality: 1, communication: 1 };

beforeEach(() => {
  db = openDb(':memory:');
  seed(db, cfg, now);
  importSheet(db, cfg, loadSheet('neetcode150'));
});

describe('catalog', () => {
  it('imports the verified NeetCode 150 with all 18 categories and is idempotent', () => {
    const sheet = loadSheet('neetcode150');
    expect(sheet.verified).toBe(true);
    expect(sheet.problems).toHaveLength(150);
    expect(new Set(sheet.problems.map((p) => p.topic)).size).toBe(18);
    expect(importSheet(db, cfg, sheet)).toEqual({ inserted: 0, updated: 150 });
    const s = getStats(db, cfg, now);
    expect(s.completion.byDifficulty).toEqual({
      easy: { solved: 0, total: 28 },
      medium: { solved: 0, total: 101 },
      hard: { solved: 0, total: 21 },
    });
  });
});

describe('next + sessions', () => {
  it('starts with the first medium, then targets a fresh weakness', () => {
    startSession(db, 'dsa', now);
    expect(nextProblem(db, cfg, { now }).selection!.slug).toBe('group-anagrams');
    startAttempt(db, 'two-sum', { now });
    recordTestRun(db, 'two-sum', 10, 10, now);
    recordAttempt(db, cfg, {
      slug: 'two-sum',
      rubric: perfect,
      weaknesses: [{ description: 'misses duplicates', topic: 'Two Pointers' }],
      now,
    });
    const n = nextProblem(db, cfg, { now });
    expect(n.selection).toMatchObject({ slug: 'two-sum-ii-input-array-is-sorted', kind: 'weakness', topic: 'Two Pointers' });
  });

  it('excludes problems abandoned this session, re-serves them in the next one', () => {
    startSession(db, 'dsa', now);
    startAttempt(db, 'group-anagrams', { now });
    abandonAttempt(db, 'group-anagrams', { now });
    expect(nextProblem(db, cfg, { now }).selection!.slug).not.toBe('group-anagrams');
    endSession(db, { now });
    startSession(db, 'dsa', now);
    const n = nextProblem(db, cfg, { now }).selection!;
    expect(n.slug).toBe('group-anagrams');
    expect(n.reason).toMatch(/abandoned/);
  });

  it('serves at most one due review per session', () => {
    const past = new Date(2026, 9, 1);
    startAttempt(db, 'two-sum', { now: past });
    recordTestRun(db, 'two-sum', 10, 10, past);
    recordAttempt(db, cfg, { slug: 'two-sum', rubric: perfect, now: past }); // due 2026-10-08
    startSession(db, 'dsa', now);
    const first = nextProblem(db, cfg, { now }).selection!;
    expect(first).toMatchObject({ slug: 'two-sum', isReview: true });
    startAttempt(db, 'two-sum', { isReview: true, now });
    abandonAttempt(db, 'two-sum', { now });
    expect(nextProblem(db, cfg, { now }).selection!.isReview).toBe(false);
  });
});

describe('context', () => {
  it('renders markdown with weaknesses, abandoned problems and reviews', () => {
    startSession(db, 'dsa', now);
    startAttempt(db, 'two-sum', { now });
    recordTestRun(db, 'two-sum', 10, 10, now);
    recordAttempt(db, cfg, { slug: 'two-sum', rubric: perfect, weaknesses: [{ description: 'no complexity stated' }], now });
    startAttempt(db, 'valid-anagram', { now });
    abandonAttempt(db, 'valid-anagram', { now });
    const md = renderContextMarkdown(getContext(db, cfg, now));
    expect(md).toContain('no complexity stated');
    expect(md).toContain('Abandoned, still unsolved: valid-anagram');
    expect(md).toContain('Upcoming (7d): two-sum');
    expect(md).toContain('Solved 1/150');
  });
});
