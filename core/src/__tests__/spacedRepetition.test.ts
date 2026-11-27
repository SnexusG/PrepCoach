import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { addDays, initialInterval, scheduleReview, struggleReasons, toDateString, type ReviewState } from '../spacedRepetition';

const cfg = loadConfig();
const today = new Date(2026, 10, 8); // 2026-11-08 local

describe('spaced repetition', () => {
  it('picks the initial interval from the outcome band', () => {
    expect(initialInterval(0.3, cfg)).toBe(1);
    expect(initialInterval(0.5, cfg)).toBe(3);
    expect(initialInterval(0.75, cfg)).toBe(3);
    expect(initialInterval(0.76, cfg)).toBe(7);
  });

  it('schedules a fresh attempt with a due date', () => {
    const s = scheduleReview(null, 0.6, false, today, cfg);
    expect(s).toMatchObject({ intervalDays: 3, ease: 2, dueDate: '2026-11-11', reviewsCount: 0 });
  });

  it('a fresh (non-review) attempt resets an existing schedule', () => {
    const prev: ReviewState = { intervalDays: 30, ease: 2.4, dueDate: '2026-12-01', lastOutcome: 0.9, reviewsCount: 3 };
    const s = scheduleReview(prev, 0.4, false, today, cfg);
    expect(s.intervalDays).toBe(1);
    expect(s.reviewsCount).toBe(0);
  });

  it('a passed review roughly doubles the interval', () => {
    const prev: ReviewState = { intervalDays: 7, ease: 2, dueDate: '2026-11-08', lastOutcome: 0.8, reviewsCount: 0 };
    expect(scheduleReview(prev, 0.8, true, today, cfg)).toMatchObject({ intervalDays: 14, ease: 2, reviewsCount: 1 });
    expect(scheduleReview(prev, 0.9, true, today, cfg)).toMatchObject({ intervalDays: 15, ease: 2.1 });
    expect(scheduleReview(prev, 0.65, true, today, cfg)).toMatchObject({ intervalDays: 13, ease: 1.85 }); // 7 × 1.85 = 12.95
  });

  it('caps the interval at 60 days', () => {
    const prev: ReviewState = { intervalDays: 40, ease: 2.5, dueDate: '2026-11-08', lastOutcome: 0.9, reviewsCount: 4 };
    expect(scheduleReview(prev, 0.95, true, today, cfg).intervalDays).toBe(60);
  });

  it('a failed review resets to 1 day and lowers ease', () => {
    const prev: ReviewState = { intervalDays: 14, ease: 2, dueDate: '2026-11-08', lastOutcome: 0.8, reviewsCount: 1 };
    expect(scheduleReview(prev, 0.4, true, today, cfg)).toMatchObject({ intervalDays: 1, ease: 1.8, dueDate: '2026-11-09' });
  });

  it('never drops ease below the minimum', () => {
    const prev: ReviewState = { intervalDays: 1, ease: 1.35, dueDate: '2026-11-08', lastOutcome: 0.2, reviewsCount: 5 };
    expect(scheduleReview(prev, 0.1, true, today, cfg).ease).toBe(1.3);
  });

  it('counts only real struggles', () => {
    const clean = { outcome: 0.85, hintsUsed: 1, testsPassed: 14, testsTotal: 14, approach: 0.5, independence: 0.6 };
    expect(struggleReasons(clean, cfg)).toEqual([]); // a nudge, a bit of probing: still a clean solve
    expect(struggleReasons({ ...clean, testsPassed: 12 }, cfg)).toEqual(['tests 12/14']);
    expect(struggleReasons({ ...clean, hintsUsed: 2 }, cfg)).toEqual(['hint level 2 (pattern)']);
    expect(struggleReasons({ ...clean, approach: 0.4 }, cfg)).toEqual(['approach needed heavy steering (0.4)']);
    expect(struggleReasons({ ...clean, independence: 0.3 }, cfg)).toEqual(['low independence (0.3)']);
    expect(struggleReasons({ ...clean, outcome: 0.6 }, cfg)).toEqual(['outcome 0.60']);
    expect(struggleReasons({ ...clean, independence: undefined, approach: undefined }, cfg)).toEqual([]);
  });

  it('handles month/year boundaries', () => {
    expect(toDateString(addDays(new Date(2026, 10, 29), 7))).toBe('2026-12-06');
    expect(toDateString(addDays(new Date(2026, 11, 30), 3))).toBe('2027-01-02');
  });
});
