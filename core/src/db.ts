import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, type PrepConfig, type Track } from './config';

export type DB = Database.Database;

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export function openDb(file: string = paths.db): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 3000');
  migrate(db);
  return db;
}

/** Applies migrations/NNN_*.sql in order, tracked via PRAGMA user_version. */
export function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  for (const f of files) {
    const version = parseInt(f, 10);
    if (version <= current) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    })();
  }
}

const TRACKS: { id: Track; name: string; enabled: number }[] = [
  { id: 'dsa', name: 'DSA', enabled: 1 },
  { id: 'system_design', name: 'System Design', enabled: 0 },
  { id: 'java', name: 'Java Fundamentals', enabled: 0 },
];

export const DEFAULT_PREFERENCES: Record<string, string> = {
  active_sheet: 'neetcode150',
  difficulty: 'medium',
  mode: 'dsa',
};

/** Idempotent seed: tracks, topics from config, a rating row per topic, default preferences. */
export function seed(db: DB, cfg: PrepConfig, now = new Date()): void {
  const insTrack = db.prepare('INSERT OR IGNORE INTO tracks (id, name, enabled) VALUES (?, ?, ?)');
  const insTopic = db.prepare('INSERT OR IGNORE INTO topics (track, name, sort_order) VALUES (?, ?, ?)');
  const insRating = db.prepare(
    `INSERT OR IGNORE INTO ratings (topic_id, track, rating, attempts_count, last_updated)
     SELECT id, track, ?, 0, ? FROM topics WHERE track = ? AND name = ?`,
  );
  const insPref = db.prepare('INSERT OR IGNORE INTO preferences (key, value) VALUES (?, ?)');
  db.transaction(() => {
    for (const t of TRACKS) insTrack.run(t.id, t.name, t.enabled);
    for (const track of Object.keys(cfg.topics) as Track[]) {
      cfg.topics[track].forEach((topic, i) => {
        insTopic.run(track, topic.name, i);
        insRating.run(cfg.rating.initial, now.toISOString(), track, topic.name);
      });
    }
    for (const [k, v] of Object.entries(DEFAULT_PREFERENCES)) insPref.run(k, v);
  })();
}

export function getPreference(db: DB, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM preferences WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? DEFAULT_PREFERENCES[key];
}

export function setPreference(db: DB, key: string, value: string): void {
  db.prepare(
    'INSERT INTO preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function topicId(db: DB, track: Track, name: string): number {
  const row = db.prepare('SELECT id FROM topics WHERE track = ? AND lower(name) = lower(?)').get(track, name) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`Unknown ${track} topic: "${name}"`);
  return row.id;
}
