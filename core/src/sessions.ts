import type { Track } from './config';
import { getPreference, setPreference, type DB } from './db';

export interface SessionRow {
  id: number;
  track: Track;
  startedAt: string;
  endedAt: string | null;
  reviewsServed: number;
  summary: string | null;
}

/** Sessions idle longer than this are auto-closed when a new one starts. */
const STALE_HOURS = 12;

const COLS = `id, track, started_at AS startedAt, ended_at AS endedAt, reviews_served AS reviewsServed, summary`;

export function getSession(db: DB, id: number): SessionRow | undefined {
  return db.prepare(`SELECT ${COLS} FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
}

export function activeSession(db: DB): SessionRow | undefined {
  const id = getPreference(db, 'active_session_id');
  if (!id) return undefined;
  const s = getSession(db, Number(id));
  return s && !s.endedAt ? s : undefined;
}

/** Starts a session, or resumes the active one if it is recent. */
export function startSession(db: DB, track: Track = 'dsa', now = new Date()): { session: SessionRow; resumed: boolean } {
  const current = activeSession(db);
  if (current) {
    const ageH = (now.getTime() - new Date(current.startedAt).getTime()) / 3.6e6;
    if (ageH < STALE_HOURS) return { session: current, resumed: true };
    endSession(db, { summary: current.summary ?? '(auto-closed)', now });
  }
  const id = Number(
    db.prepare('INSERT INTO sessions (track, started_at) VALUES (?, ?)').run(track, now.toISOString()).lastInsertRowid,
  );
  setPreference(db, 'active_session_id', String(id));
  return { session: getSession(db, id)!, resumed: false };
}

export function endSession(db: DB, opts: { summary?: string; now?: Date } = {}): SessionRow | undefined {
  const s = activeSession(db);
  if (!s) return undefined;
  db.prepare('UPDATE sessions SET ended_at = ?, summary = COALESCE(?, summary) WHERE id = ?').run(
    (opts.now ?? new Date()).toISOString(),
    opts.summary ?? null,
    s.id,
  );
  db.prepare("DELETE FROM preferences WHERE key = 'active_session_id'").run();
  return getSession(db, s.id);
}
