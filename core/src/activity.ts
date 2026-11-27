import type { PrepConfig } from './config';
import type { DB } from './db';

export type ActivityKind = 'start' | 'edit' | 'run' | 'hint' | 'tutor' | 'focus' | 'finish';

/**
 * Events closer together than this are not stored separately (editor autosave and focus heartbeats fire often).
 * It only limits storage; active time is at most this much less precise.
 */
const THROTTLE_MS = 30_000;

/**
 * Active seconds in [start, end]: the sum of the gaps between consecutive events (start and end included) that are
 * no longer than `idleGapSec`. A longer gap is a break and counts as nothing. Events outside the range are ignored.
 */
export function activeSeconds(startIso: string, eventIsos: string[], endIso: string, idleGapSec: number): number {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!(end > start)) return 0;
  const points = [start, ...eventIsos.map(Date.parse).filter((t) => t > start && t < end), end].sort((a, b) => a - b);
  let ms = 0;
  for (let i = 1; i < points.length; i++) {
    const gap = points[i] - points[i - 1];
    if (gap <= idleGapSec * 1000) ms += gap;
  }
  return Math.round(ms / 1000);
}

const idleGapSec = (cfg: PrepConfig) => cfg.forecast.idleGapMin * 60;

interface OpenRef {
  id: number;
  startedAt: string;
}

function openAttemptFor(db: DB, slug: string | null): OpenRef | undefined {
  const sql = slug
    ? `SELECT id, started_at AS startedAt FROM attempts WHERE status = 'in_progress' AND problem_slug = ? ORDER BY id DESC LIMIT 1`
    : `SELECT id, started_at AS startedAt FROM attempts WHERE status = 'in_progress' ORDER BY id DESC LIMIT 1`;
  return (slug ? db.prepare(sql).get(slug) : db.prepare(sql).get()) as OpenRef | undefined;
}

/** Inserts an event for an attempt, skipping it if the attempt already has one within the throttle window. */
export function logActivity(db: DB, attemptId: number, kind: ActivityKind, at: Date = new Date()): void {
  const last = db
    .prepare('SELECT at FROM attempt_activity WHERE attempt_id = ? ORDER BY at DESC LIMIT 1')
    .get(attemptId) as { at: string } | undefined;
  const always = kind === 'start' || kind === 'finish';
  if (!always && last && Math.abs(at.getTime() - Date.parse(last.at)) < THROTTLE_MS) return;
  db.prepare('INSERT INTO attempt_activity (attempt_id, kind, at) VALUES (?, ?, ?)').run(attemptId, kind, at.toISOString());
}

/**
 * Records that the user is working on `slug` (or, with null, on whichever attempt is open). No-op when there is no
 * open attempt or the event predates it. Returns whether an attempt was found.
 */
export function recordActivity(db: DB, slug: string | null, kind: ActivityKind, at: Date = new Date()): boolean {
  const a = openAttemptFor(db, slug);
  if (!a || at.getTime() < Date.parse(a.startedAt)) return false;
  logActivity(db, a.id, kind, at);
  return true;
}

function eventTimes(db: DB, attemptId: number): string[] {
  return (db.prepare('SELECT at FROM attempt_activity WHERE attempt_id = ? ORDER BY at').all(attemptId) as { at: string }[]).map(
    (r) => r.at,
  );
}

/** Active time of an attempt up to `until` (a finished attempt's end, or the last activity of an open one). */
export function attemptActiveSeconds(db: DB, cfg: PrepConfig, attemptId: number, startedAt: string, until: string): number {
  return activeSeconds(startedAt, eventTimes(db, attemptId), until, idleGapSec(cfg));
}

export interface LiveActiveTime {
  /** Active seconds up to the last activity event. */
  activeTimeSec: number;
  lastActivityAt: string;
}

/** For an open attempt: active time so far, and when the user was last active (the web timer ticks on from it). */
export function liveActiveTime(db: DB, cfg: PrepConfig, attemptId: number, startedAt: string): LiveActiveTime {
  const events = eventTimes(db, attemptId);
  const last = events.length ? events[events.length - 1] : startedAt;
  return { activeTimeSec: activeSeconds(startedAt, events, last, idleGapSec(cfg)), lastActivityAt: last };
}
