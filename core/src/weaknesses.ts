import type { PrepConfig, Track } from './config';
import { topicId, type DB } from './db';

export type WeaknessStatus = 'active' | 'improving' | 'resolved';

/**
 * Areas a weakness belongs to. They give the tutor a fixed shelf for new observations, so it reuses a general
 * weakness instead of creating a near-duplicate for every slip.
 */
export const WEAKNESS_AREAS = {
  complexity: 'Complexity analysis',
  java: 'Java language & collections',
  understanding: 'Problem understanding',
  'edge-cases': 'Edge cases',
  algorithm: 'Algorithm & pattern choice',
  implementation: 'Implementation discipline',
  testing: 'Testing & verification',
  communication: 'Communication',
} as const;
export type WeaknessArea = keyof typeof WEAKNESS_AREAS;

export function parseArea(v: string): WeaknessArea | null {
  const k = v.trim().toLowerCase() as WeaknessArea;
  return k in WEAKNESS_AREAS ? k : null;
}

export interface WeaknessObservation {
  /** Existing weakness id; if omitted, matched by description (case-insensitive) or created. */
  id?: number;
  description?: string;
  /** Topic name; null/omitted = general weakness (e.g. communication). */
  topic?: string | null;
  /** 'observed' (default) = the mistake happened again; 'handled_well' = clean demonstration. */
  kind?: 'observed' | 'handled_well';
  /** Area for a new weakness (see WEAKNESS_AREAS). */
  area?: WeaknessArea | null;
  /** The specific slip (or clean demonstration) in this attempt, e.g. "priced a HashMap insert at O(log n)". */
  note?: string | null;
}

export interface WeaknessRow {
  id: number;
  track: Track;
  topic: string | null;
  area: WeaknessArea | null;
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
  SELECT w.id, w.track, t.name AS topic, w.area, w.description, w.times_observed AS timesObserved,
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
    `INSERT INTO weakness_attempts (weakness_id, attempt_id, kind, note) VALUES (?, ?, ?, ?)
     ON CONFLICT(weakness_id, attempt_id) DO UPDATE SET kind = excluded.kind, note = COALESCE(excluded.note, note)`,
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
            `INSERT INTO weaknesses (track, topic_id, area, description, times_observed, clean_demonstrations, first_seen, last_seen, status)
             VALUES (?, ?, ?, ?, 1, 0, ?, ?, 'active')`,
          )
          .run(track, tId, obs.area ?? null, obs.description!.trim(), ts, ts).lastInsertRowid,
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

    if (attemptId != null) link.run(id, attemptId, kind, obs.note?.trim() || null);
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

/** Past slips without a note get the weakness's old (specific) wording, so generalizing loses nothing. */
function keepOldWordingAsNotes(db: DB, id: number, oldDescription: string) {
  db.prepare("UPDATE weakness_attempts SET note = ? WHERE weakness_id = ? AND note IS NULL AND kind = 'observed'").run(oldDescription, id);
}

/**
 * Manual override (prep weakness update). With `generalize`, a reworded description keeps the old wording as the
 * note of past observations.
 */
export function updateWeakness(
  db: DB,
  id: number,
  patch: { status?: WeaknessStatus; description?: string; area?: WeaknessArea | null; topic?: string | null; generalize?: boolean },
): WeaknessRow {
  const w = getWeakness(db, id);
  if (!w) throw new Error(`Weakness #${id} not found`);
  db.transaction(() => {
    if (patch.status) db.prepare('UPDATE weaknesses SET status = ? WHERE id = ?').run(patch.status, id);
    if (patch.area !== undefined) db.prepare('UPDATE weaknesses SET area = ? WHERE id = ?').run(patch.area, id);
    if (patch.topic !== undefined) {
      db.prepare('UPDATE weaknesses SET topic_id = ? WHERE id = ?').run(patch.topic ? topicId(db, w.track, patch.topic) : null, id);
    }
    if (patch.description && patch.description.trim() !== w.description) {
      if (patch.generalize) keepOldWordingAsNotes(db, id, w.description);
      db.prepare('UPDATE weaknesses SET description = ? WHERE id = ?').run(patch.description.trim(), id);
    }
  })();
  return getWeakness(db, id)!;
}

const SEVERITY: Record<WeaknessStatus, number> = { active: 2, improving: 1, resolved: 0 };

/**
 * Merges weaknesses into `targetId`: their observations (with their old wording kept as notes), counts and dates
 * move to the target, and they are deleted. The merged status is the most severe one; a clean streak only survives
 * if nothing merged is still active. Optionally rewords the target (its own old wording is kept as notes too).
 */
export function mergeWeaknesses(
  db: DB,
  sourceIds: number[],
  targetId: number,
  opts: { description?: string; area?: WeaknessArea | null } = {},
): WeaknessRow {
  const target = getWeakness(db, targetId);
  if (!target) throw new Error(`Weakness #${targetId} not found`);
  const sources = [...new Set(sourceIds)].filter((id) => id !== targetId).map((id) => {
    const w = getWeakness(db, id);
    if (!w) throw new Error(`Weakness #${id} not found`);
    if (w.track !== target.track) throw new Error(`Weakness #${id} is on a different track`);
    return w;
  });
  if (!sources.length) throw new Error('Nothing to merge: give at least one weakness other than the target');

  db.transaction(() => {
    if (opts.description && opts.description.trim() !== target.description) keepOldWordingAsNotes(db, targetId, target.description);
    for (const src of sources) {
      keepOldWordingAsNotes(db, src.id, src.description);
      const links = db.prepare('SELECT attempt_id AS attemptId, kind, note FROM weakness_attempts WHERE weakness_id = ?').all(src.id) as {
        attemptId: number;
        kind: string;
        note: string | null;
      }[];
      for (const l of links) {
        const existing = db
          .prepare('SELECT kind, note FROM weakness_attempts WHERE weakness_id = ? AND attempt_id = ?')
          .get(targetId, l.attemptId) as { kind: string; note: string | null } | undefined;
        if (!existing) {
          db.prepare('INSERT INTO weakness_attempts (weakness_id, attempt_id, kind, note) VALUES (?, ?, ?, ?)').run(targetId, l.attemptId, l.kind, l.note);
        } else {
          // Same attempt on both: an observed slip outweighs a clean demonstration; keep both notes.
          const kind = existing.kind === 'observed' || l.kind === 'observed' ? 'observed' : 'handled_well';
          const note = [existing.note, l.note].filter(Boolean).join('; ') || null;
          db.prepare('UPDATE weakness_attempts SET kind = ?, note = ? WHERE weakness_id = ? AND attempt_id = ?').run(kind, note, targetId, l.attemptId);
        }
      }
      db.prepare('DELETE FROM weakness_attempts WHERE weakness_id = ?').run(src.id);
      db.prepare('DELETE FROM weaknesses WHERE id = ?').run(src.id);
    }
    const all = [target, ...sources];
    const status = all.reduce((a, w) => (SEVERITY[w.status] > SEVERITY[a] ? w.status : a), 'resolved' as WeaknessStatus);
    const clean = status === 'active' ? 0 : Math.min(...all.filter((w) => w.status === status).map((w) => w.cleanDemonstrations));
    db.prepare(
      `UPDATE weaknesses SET times_observed = ?, clean_demonstrations = ?, status = ?, first_seen = ?, last_seen = ?,
         description = ?, area = ? WHERE id = ?`,
    ).run(
      all.reduce((n, w) => n + w.timesObserved, 0),
      clean,
      status,
      all.map((w) => w.firstSeen).sort()[0],
      all.map((w) => w.lastSeen).sort().reverse()[0],
      opts.description?.trim() || target.description,
      opts.area !== undefined ? opts.area : (target.area ?? sources.find((w) => w.area)?.area ?? null),
      targetId,
    );
  })();
  return getWeakness(db, targetId)!;
}
