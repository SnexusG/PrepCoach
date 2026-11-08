import type { PrepConfig, Track } from './config';
import { topicId, type DB } from './db';

export type WeaknessStatus = 'active' | 'improving' | 'resolved';

export interface WeaknessObservation {
  /** Existing weakness id; if omitted, matched by description (case-insensitive) or created. */
  id?: number;
  description?: string;
  /** Topic name; null/omitted = general weakness (e.g. communication). */
  topic?: string | null;
  /** 'observed' (default) = the mistake happened again; 'handled_well' = clean demonstration. */
  kind?: 'observed' | 'handled_well';
}

export interface WeaknessRow {
  id: number;
  track: Track;
  topic: string | null;
  description: string;
  timesObserved: number;
  cleanDemonstrations: number;
  firstSeen: string;
  lastSeen: string;
  status: WeaknessStatus;
}

export interface WeaknessChange {
  id: number;
  description: string;
  action: 'created' | 'observed' | 'handled_well';
  status: WeaknessStatus;
  timesObserved: number;
  cleanDemonstrations: number;
}

const SELECT = `
  SELECT w.id, w.track, t.name AS topic, w.description, w.times_observed AS timesObserved,
         w.clean_demonstrations AS cleanDemonstrations, w.first_seen AS firstSeen,
         w.last_seen AS lastSeen, w.status
  FROM weaknesses w LEFT JOIN topics t ON t.id = w.topic_id`;

export function listWeaknesses(db: DB, track: Track, statuses?: WeaknessStatus[]): WeaknessRow[] {
  const rows = db.prepare(`${SELECT} WHERE w.track = ? ORDER BY w.times_observed DESC, w.last_seen DESC`).all(track) as WeaknessRow[];
  return statuses ? rows.filter((r) => statuses.includes(r.status)) : rows;
}

export function getWeakness(db: DB, id: number): WeaknessRow | undefined {
  return db.prepare(`${SELECT} WHERE w.id = ?`).get(id) as WeaknessRow | undefined;
}

function findWeakness(db: DB, track: Track, obs: WeaknessObservation): WeaknessRow | undefined {
  if (obs.id != null) {
    const w = getWeakness(db, obs.id);
    if (!w) throw new Error(`Weakness #${obs.id} not found`);
    return w;
  }
  if (!obs.description?.trim()) throw new Error('Weakness observation needs an id or a description');
  return db
    .prepare(`${SELECT} WHERE w.track = ? AND lower(trim(w.description)) = lower(trim(?))`)
    .get(track, obs.description) as WeaknessRow | undefined;
}

/**
 * Apply tutor observations from one attempt.
 * - observed: times_observed++, status → active, clean streak resets.
 * - handled_well: clean_demonstrations++, status → improving, → resolved at the configured streak.
 */
export function applyWeaknessObservations(
  db: DB,
  cfg: PrepConfig,
  track: Track,
  attemptId: number | null,
  observations: WeaknessObservation[],
  now = new Date(),
): WeaknessChange[] {
  const ts = now.toISOString();
  const link = db.prepare(
    `INSERT INTO weakness_attempts (weakness_id, attempt_id, kind) VALUES (?, ?, ?)
     ON CONFLICT(weakness_id, attempt_id) DO UPDATE SET kind = excluded.kind`,
  );
  const changes: WeaknessChange[] = [];

  for (const obs of observations) {
    const kind = obs.kind ?? 'observed';
    const existing = findWeakness(db, track, obs);
    let id: number;
    let action: WeaknessChange['action'] = kind;

    if (!existing) {
      if (kind === 'handled_well') {
        throw new Error(`Cannot mark unknown weakness "${obs.description}" as handled well`);
      }
      const tId = obs.topic ? topicId(db, track, obs.topic) : null;
      id = Number(
        db
          .prepare(
            `INSERT INTO weaknesses (track, topic_id, description, times_observed, clean_demonstrations, first_seen, last_seen, status)
             VALUES (?, ?, ?, 1, 0, ?, ?, 'active')`,
          )
          .run(track, tId, obs.description!.trim(), ts, ts).lastInsertRowid,
      );
      action = 'created';
    } else if (kind === 'observed') {
      id = existing.id;
      db.prepare(
        `UPDATE weaknesses SET times_observed = times_observed + 1, clean_demonstrations = 0,
           last_seen = ?, status = 'active' WHERE id = ?`,
      ).run(ts, id);
    } else {
      id = existing.id;
      const clean = existing.cleanDemonstrations + 1;
      const status: WeaknessStatus = clean >= cfg.weaknesses.cleanDemonstrationsToResolve ? 'resolved' : 'improving';
      db.prepare('UPDATE weaknesses SET clean_demonstrations = ?, status = ? WHERE id = ?').run(clean, status, id);
    }

    if (attemptId != null) link.run(id, attemptId, kind);
    const w = getWeakness(db, id)!;
    changes.push({
      id,
      description: w.description,
      action,
      status: w.status,
      timesObserved: w.timesObserved,
      cleanDemonstrations: w.cleanDemonstrations,
    });
  }
  return changes;
}

/** Manual override (prep weakness update). */
export function updateWeakness(
  db: DB,
  id: number,
  patch: { status?: WeaknessStatus; description?: string },
): WeaknessRow {
  const w = getWeakness(db, id);
  if (!w) throw new Error(`Weakness #${id} not found`);
  if (patch.status) db.prepare('UPDATE weaknesses SET status = ? WHERE id = ?').run(patch.status, id);
  if (patch.description) db.prepare('UPDATE weaknesses SET description = ? WHERE id = ?').run(patch.description.trim(), id);
  return getWeakness(db, id)!;
}
