import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { openDb, seed, setPreference, type DB } from '../db';
import { importSheet, loadSheet } from '../catalog';
import { abandonAttempt, getAttempt, recordAttempt, recordHint, recordTestRun, startAttempt } from '../attempts';
import { activeSeconds, recordActivity } from '../activity';
import { computeForecast, parseTargetDate, type ForecastInput } from '../forecast';
import { getStats, listAttempts } from '../queries';

const cfg = loadConfig();
const now = new Date(2026, 10, 27, 12); // Nov 27 2026, local noon
const daysAgo = (d: number, h = 0) => new Date(now.getTime() - d * 864e5 + h * 36e5).toISOString();
const min = (m: number) => m * 60_000;
const perfect = { optimality: 1, approach: 1, codeQuality: 1, communication: 1 };

const input = (o: Partial<ForecastInput>): ForecastInput => ({
  solves: [],
  historyStart: daysAgo(60),
  remaining: { easy: 0, medium: 20, hard: 0 },
  total: 30,
  now,
  targetDate: null,
  ...o,
});
const mediums = (...ago: number[]) => ago.map((d) => ({ at: daysAgo(d), difficulty: 'medium' as const }));

describe('activeSeconds', () => {
  const t0 = '2026-11-01T10:00:00.000Z';
  const at = (m: number) => new Date(Date.parse(t0) + min(m)).toISOString();

  it('sums gaps up to the idle limit and drops longer breaks', () => {
    // start, 10 min, 15 min, (overnight) 900 min, 905 min = end
    expect(activeSeconds(t0, [at(10), at(15), at(900)], at(905), 20 * 60)).toBe((10 + 5 + 5) * 60);
  });

  it('ignores events outside the range and handles an empty range', () => {
    expect(activeSeconds(t0, [at(-5), at(50)], at(10), 20 * 60)).toBe(600);
    expect(activeSeconds(t0, [], t0, 20 * 60)).toBe(0);
  });

  it('counts nothing when start and end are a long break apart with no activity', () => {
    expect(activeSeconds(t0, [], at(60 * 24 * 15), 20 * 60)).toBe(0);
  });
});

describe('computeForecast', () => {
  it('needs a few solves before projecting', () => {
    const f = computeForecast(input({ solves: mediums(3, 1) }), cfg);
    expect(f.status).toBe('insufficient');
    expect(f.date).toBeNull();
    expect(f.solved).toBe(10);
  });

  it('projects from the pace in the window, with a range that brackets the date', () => {
    // 8 mediums in the last 28 days → 2/week; 20 mediums left → 70 days.
    const f = computeForecast(input({ solves: mediums(27, 24, 20, 17, 13, 10, 6, 3) }), cfg);
    expect(f.status).toBe('ok');
    expect(f.perWeek).toBe(2);
    expect(f.date).toBe('2027-02-05');
    expect(f.early! < f.date!).toBe(true);
    expect(f.late! > f.date!).toBe(true);
    expect(f.atOnePerDay).toBe('2026-12-17');
  });

  it('weights hard problems as more work than easy ones', () => {
    const solves = mediums(20, 15, 10, 5);
    const easy = computeForecast(input({ solves, remaining: { easy: 10, medium: 0, hard: 0 } }), cfg);
    const hard = computeForecast(input({ solves, remaining: { easy: 0, medium: 0, hard: 10 } }), cfg);
    expect(easy.date! < hard.date!).toBe(true);
  });

  it('uses at least minSpanDays when you started recently', () => {
    const f = computeForecast(input({ solves: mediums(1, 1, 0), historyStart: daysAgo(2) }), cfg);
    expect(f.spanDays).toBe(cfg.forecast.minSpanDays);
    expect(f.perWeek).toBe(3);
  });

  it('reports a stall when nothing was solved in the window', () => {
    const f = computeForecast(input({ solves: mediums(80, 70, 60) }), cfg);
    expect(f.status).toBe('stalled');
    expect(f.daysSinceLastSolve).toBe(60);
    expect(f.date).toBeNull();
  });

  it('leaves the late end open with a single recent solve', () => {
    const f = computeForecast(input({ solves: mediums(90, 80, 5) }), cfg);
    expect(f.status).toBe('ok');
    expect(f.late).toBeNull();
  });

  it('is complete when nothing remains', () => {
    const f = computeForecast(input({ solves: mediums(5, 4, 3), remaining: { easy: 0, medium: 0, hard: 0 }, total: 3 }), cfg);
    expect(f.status).toBe('complete');
    expect(f.atOnePerDay).toBeNull();
  });

  it('compares against a target date', () => {
    const solves = mediums(27, 24, 20, 17, 13, 10, 6, 3); // projected 2027-02-05
    const behind = computeForecast(input({ solves, targetDate: '2026-12-25' }), cfg).target!;
    expect(behind).toMatchObject({ daysLeft: 28, passed: false, onTrack: false, requiredPerWeek: 5 });
    const ahead = computeForecast(input({ solves, targetDate: '2027-03-01' }), cfg).target!;
    expect(ahead.onTrack).toBe(true);
    const passed = computeForecast(input({ solves, targetDate: '2026-11-01' }), cfg).target!;
    expect(passed).toMatchObject({ passed: true, requiredPerWeek: null });
  });

  it('builds a cumulative history by day', () => {
    const f = computeForecast(input({ solves: [...mediums(3), ...mediums(1), ...mediums(1)] }), cfg);
    expect(f.history.map((h) => h.solved)).toEqual([1, 3]);
  });
});

describe('parseTargetDate', () => {
  it('accepts real dates and clears with none', () => {
    expect(parseTargetDate('2027-02-28')).toBe('2027-02-28');
    expect(parseTargetDate('none')).toBeNull();
    expect(() => parseTargetDate('2027-02-30')).toThrow();
    expect(() => parseTargetDate('next week')).toThrow();
  });
});

describe('active time on attempts', () => {
  let db: DB;
  const t0 = new Date(2026, 10, 20, 9);
  const at = (m: number) => new Date(t0.getTime() + min(m));

  beforeEach(() => {
    db = openDb(':memory:');
    seed(db, cfg, t0);
    importSheet(db, cfg, loadSheet('neetcode150'));
  });

  it('records active time, not wall-clock time, when an attempt spans days', () => {
    startAttempt(db, 'two-sum', { now: at(0) });
    recordActivity(db, 'two-sum', 'edit', at(8));
    recordHint(db, cfg, 'two-sum', 1, at(14));
    recordTestRun(db, 'two-sum', 10, 10, at(25));
    // Left open overnight, then submitted the next morning after a quick re-run.
    recordTestRun(db, 'two-sum', 10, 10, at(60 * 22));
    const r = recordAttempt(db, cfg, { slug: 'two-sum', rubric: perfect, now: at(60 * 22 + 3) });
    expect(r.solveTimeSec).toBe((60 * 22 + 3) * 60);
    expect(r.activeTimeSec).toBe((25 + 3) * 60);
    expect(getAttempt(db, r.attemptId).activeTimeSec).toBe((25 + 3) * 60);
  });

  it('throttles frequent events and ignores activity with no open attempt', () => {
    startAttempt(db, 'two-sum', { now: at(0) });
    for (let s = 5; s < 120; s += 5) recordActivity(db, 'two-sum', 'edit', new Date(t0.getTime() + s * 1000));
    const n = (db.prepare('SELECT COUNT(*) AS n FROM attempt_activity').get() as { n: number }).n;
    expect(n).toBeLessThanOrEqual(5);
    expect(recordActivity(db, 'valid-anagram', 'edit', at(1))).toBe(false);
  });

  it('shows live active time for an open attempt and stores it on abandon', () => {
    startAttempt(db, 'two-sum', { now: at(0) });
    recordActivity(db, 'two-sum', 'focus', at(10));
    const [open] = listAttempts(db, { status: 'in_progress', cfg });
    expect(open).toMatchObject({ activeTimeSec: 600, lastActivityAt: at(10).toISOString() });
    const a = abandonAttempt(db, cfg, 'two-sum', { now: at(12) });
    expect(a.activeTimeSec).toBe(720);
  });

  it('feeds stats: forecast, target date and average active time', () => {
    setPreference(db, 'target_date', '2027-06-30');
    for (const [i, slug] of ['two-sum', 'valid-anagram', 'contains-duplicate'].entries()) {
      startAttempt(db, slug, { now: at(i * 60) });
      recordTestRun(db, slug, 5, 5, at(i * 60 + 10));
      recordAttempt(db, cfg, { slug, rubric: perfect, now: at(i * 60 + 20) });
    }
    const s = getStats(db, cfg, at(60 * 24));
    expect(s.forecast).toMatchObject({ status: 'ok', solved: 3, total: 150, remaining: 147 });
    expect(s.forecast.target?.date).toBe('2027-06-30');
    expect(s.activeTime.easy).toEqual({ avgMinutes: 20, attempts: 3 });
  });
});
