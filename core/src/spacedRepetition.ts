import type { PrepConfig } from './config';
import { clamp } from './rating';

export interface ReviewState {
  intervalDays: number;
  ease: number;
  /** Local date, YYYY-MM-DD. */
  dueDate: string;
  lastOutcome: number;
  reviewsCount: number;
}

/** Local calendar date as YYYY-MM-DD. */
export function toDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(d: Date, days: number): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  r.setDate(r.getDate() + days);
  return r;
}

export function initialInterval(outcome: number, cfg: PrepConfig): number {
  const sr = cfg.spacedRepetition;
  if (outcome < sr.lowThreshold) return sr.initialIntervals.low;
  if (outcome <= sr.highThreshold) return sr.initialIntervals.mid;
  return sr.initialIntervals.high;
}

/**
 * Compute the next review state after an attempt.
 * - Fresh (non-review) attempt: interval from the outcome band, ease reset.
 * - Review passed: interval × ease (≈ doubling), capped; ease nudged by quality.
 * - Review failed: interval resets to 1 day, ease drops.
 */
export function scheduleReview(
  prev: ReviewState | null,
  outcome: number,
  isReview: boolean,
  today: Date,
  cfg: PrepConfig,
): ReviewState {
  const sr = cfg.spacedRepetition;
  let intervalDays: number;
  let ease: number;
  let reviewsCount: number;

  if (!isReview || !prev) {
    intervalDays = initialInterval(outcome, cfg);
    ease = sr.initialEase;
    reviewsCount = 0;
  } else if (outcome >= sr.reviewPassThreshold) {
    const easeAdj = outcome >= 0.85 ? 0.1 : outcome < 0.7 ? -0.15 : 0;
    ease = clamp(prev.ease + easeAdj, sr.minEase, sr.maxEase);
    intervalDays = Math.min(sr.maxIntervalDays, Math.max(prev.intervalDays + 1, Math.round(prev.intervalDays * ease)));
    reviewsCount = prev.reviewsCount + 1;
  } else {
    ease = clamp(prev.ease - 0.2, sr.minEase, sr.maxEase);
    intervalDays = 1;
    reviewsCount = prev.reviewsCount + 1;
  }

  return {
    intervalDays,
    ease: Math.round(ease * 100) / 100,
    dueDate: toDateString(addDays(today, intervalDays)),
    lastOutcome: outcome,
    reviewsCount,
  };
}

export function isDue(state: Pick<ReviewState, 'dueDate'>, today: Date): boolean {
  return state.dueDate <= toDateString(today);
}
