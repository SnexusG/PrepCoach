import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { openDb, seed, type DB } from '../db';
import { importSheet, loadSheet } from '../catalog';
import { abandonAttempt, recordAttempt, recordTestRun, startAttempt } from '../attempts';
import {
  ackRewards,
  achievements,
  computeStreak,
  dailyQuests,
  levelJourney,
  pendingRewards,
  rewardLine,
  weekStart,
  weeklyQuests,
  weeklySolveTarget,
  type HistAttempt,
  type History,
} from '../gamification';
import { loadGame } from '../queries';

const cfg = loadConfig();
const now = new Date(2026, 10, 27, 18); // Fri Nov 27 2026, local evening
/** Local noon `d` days before `now`, plus `h` hours. */
const ago = (d: number, h = 0) => new Date(2026, 10, 27 - d, 12 + h).toISOString();

let nextId = 1;
const solve = (d: number, o: Partial<HistAttempt> = {}): HistAttempt => ({
  id: nextId++,
  slug: `p${nextId}`,
  title: `P${nextId}`,
  topic: 'Arrays & Hashing',
  difficulty: 'medium',
  status: 'completed',
  isReview: false,
  finishedAt: ago(d),
  hints: 0,
  solved: true,
  outcome: 0.8,
  activeSec: 25 * 60,
  ...o,
});
const hist = (o: Partial<History> = {}): History => ({
  attempts: [],
  drills: [],
  handled: [],
  resolvedWeaknesses: [],
  overall: [],
  topicRatings: [],
  initialRating: cfg.rating.initial,
  ...o,
});

describe('streaks', () => {
  it('counts consecutive active days and keeps the streak alive before today has any activity', () => {
    const s = computeStreak(hist({ attempts: [solve(3), solve(2), solve(1)] }), cfg, now);
    expect(s).toMatchObject({ current: 3, longest: 3, activeToday: false });
  });

  it('drills count as activity; a missed day without a freeze resets the streak', () => {
    const h = hist({ attempts: [solve(5), solve(4), solve(1)], drills: [{ at: ago(0), correct: 3, total: 5 }] });
    expect(computeStreak(h, cfg, now)).toMatchObject({ current: 2, longest: 2, activeToday: true });
  });

  it('earns a freeze after 7 days and spends it on a missed day', () => {
    const days = [12, 11, 10, 9, 8, 7, 6, /* 5 missed */ 4, 3, 2, 1, 0];
    const s = computeStreak(hist({ attempts: days.map((d) => solve(d)) }), cfg, now);
    expect(s.frozenDays).toEqual(['2026-11-22']);
    expect(s.current).toBe(12);
    expect(s.freezes).toBe(0);
    expect(s.reachedOn[7]).toBe(ago(6));
  });
});

describe('quests', () => {
  it('always includes "solve a problem", is deterministic per day and tracks progress', () => {
    const h = hist({ attempts: [solve(0, { hints: 2, outcome: 0.5 })] });
    const date = '2026-11-27';
    const q = dailyQuests(h, cfg, date);
    expect(q).toHaveLength(cfg.gamification!.quests!.daily!);
    expect(q[0]).toMatchObject({ id: 'solve', done: true, progress: 1, doneAt: ago(0) });
    expect(dailyQuests(h, cfg, date).map((x) => x.id)).toEqual(q.map((x) => x.id));
    expect(new Set(q.map((x) => x.id)).size).toBe(q.length);
  });

  it('weeks start on Monday and the solve target stays reachable', () => {
    expect(weekStart('2026-11-27')).toBe('2026-11-23');
    expect(weekStart('2026-11-23')).toBe('2026-11-23');
    expect(weeklySolveTarget(2.5, 15.6)).toBe(6);
    expect(weeklySolveTarget(4, null)).toBe(5);
    expect(weeklySolveTarget(null, null)).toBe(3);
    const w = weeklyQuests(hist({ attempts: [solve(0), solve(1), solve(6)] }), cfg, '2026-11-27', 3);
    expect(w[0]).toMatchObject({ id: 'w-solve', progress: 2, goal: 3, done: false }); // Nov 21 is the previous week
  });
});

describe('achievements and levels', () => {
  const ctxFor = (h: History) => ({ h, cfg, streak: computeStreak(h, cfg, now), questDays: [] });
  const get = (h: History, id: string) => achievements(ctxFor(h)).find((a) => a.id === id)!;

  it('unlocks retroactively at the attempt that earned them', () => {
    const atts = [solve(9, { hints: 1 }), ...[8, 7, 6, 5, 4].map((d) => solve(d)), solve(3, { difficulty: 'hard' })];
    const h = hist({ attempts: atts });
    expect(get(h, 'first-blood').unlockedAt).toBe(ago(9));
    expect(get(h, 'clean-sheet').unlockedAt).toBe(ago(4));
    expect(get(h, 'hardened').unlockedAt).toBe(ago(3));
    expect(get(h, 'on-fire').unlockedAt).toBe(ago(3));
    expect(get(h, 'centurion')).toMatchObject({ unlockedAt: null, progress: [7, 100] });
  });

  it('Comeback needs an earlier abandon of the same problem', () => {
    const a = solve(2, { slug: 'x', status: 'abandoned', solved: false });
    expect(get(hist({ attempts: [a, solve(1, { slug: 'x' })] }), 'comeback').unlockedAt).toBe(ago(1));
    expect(get(hist({ attempts: [solve(1, { slug: 'x' })] }), 'comeback').unlockedAt).toBeNull();
  });

  it('Elo level badges and the journey use the overall rating history', () => {
    const overall = [
      { at: ago(5), rating: 1250, attemptId: 1 },
      { at: ago(2), rating: 1410, attemptId: 2 },
    ];
    const h = hist({ overall });
    expect(get(h, 'level-interview-ready').unlockedAt).toBe(ago(2));
    expect(get(h, 'level-strong')).toMatchObject({ unlockedAt: null, progress: [1410, 1600] });
    const j = levelJourney(h, cfg);
    expect(j.find((l) => l.label === 'Developing')!.reachedAt).toBe(ago(5));
    expect(j.find((l) => l.label === 'Interview-ready')!.reachedAt).toBe(ago(2));
    expect(j.find((l) => l.label === 'Expert')!.reachedAt).toBeNull();
  });
});

describe('pending rewards', () => {
  let db: DB;
  const t0 = new Date(2026, 10, 20, 9);
  const at = (m: number) => new Date(t0.getTime() + m * 60_000);
  const perfect = { optimality: 1, approach: 1, codeQuality: 1, communication: 1 };

  beforeEach(() => {
    db = openDb(':memory:');
    seed(db, cfg, t0);
    importSheet(db, cfg, loadSheet('neetcode150'));
  });

  const solveAt = (slug: string, m: number) => {
    startAttempt(db, slug, { now: at(m) });
    recordTestRun(db, slug, 5, 5, at(m + 10));
    return recordAttempt(db, cfg, { slug, rubric: perfect, now: at(m + 12) });
  };

  it('the first call only sets the marker; later solves show up until acknowledged', () => {
    solveAt('two-sum', 0);
    const first = pendingRewards(db, cfg, loadGame(db, cfg, at(30)), at(30));
    expect(first.empty).toBe(true);

    solveAt('valid-anagram', 60);
    const r = pendingRewards(db, cfg, loadGame(db, cfg, at(90)), at(90));
    expect(r.empty).toBe(false);
    expect(r.solves.map((s) => s.slug)).toEqual(['valid-anagram']);
    expect(r.solves[0].changes[0]).toMatchObject({ topic: 'Arrays & Hashing', isPrimary: true });
    expect(r.overall!.after).toBeGreaterThan(r.overall!.before);
    expect(rewardLine(r)).toContain('🔥 streak 1');

    ackRewards(db, r.until);
    expect(pendingRewards(db, cfg, loadGame(db, cfg, at(95)), at(95)).empty).toBe(true);
  });

  it('abandons are not celebrated, and a later solve of the same problem earns Comeback', () => {
    pendingRewards(db, cfg, loadGame(db, cfg, at(0)), at(0));
    startAttempt(db, 'two-sum', { now: at(1) });
    abandonAttempt(db, cfg, 'two-sum', { now: at(5) });
    expect(pendingRewards(db, cfg, loadGame(db, cfg, at(6)), at(6)).empty).toBe(true);
    solveAt('two-sum', 10);
    const r = pendingRewards(db, cfg, loadGame(db, cfg, at(30)), at(30));
    expect(r.badges.map((b) => b.id)).toEqual(expect.arrayContaining(['first-blood', 'comeback']));
  });
});
