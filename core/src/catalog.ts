import fs from 'node:fs';
import path from 'node:path';
import { DIFFICULTIES, paths, type Difficulty, type PrepConfig, type Track } from './config';
import { topicId, type DB } from './db';

export interface SheetProblem {
  order: number;
  slug: string;
  title: string;
  topic: string;
  secondaryTopics?: string[];
  difficulty: Difficulty;
  /** Optional per-problem override of the difficulty rating. */
  difficultyRating?: number;
  url?: string;
}

export interface Sheet {
  id: string;
  name: string;
  track?: Track;
  source?: string;
  fetchedAt?: string;
  verified: boolean;
  problems: SheetProblem[];
}

export function listSheetFiles(dir = paths.sheets): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

export function loadSheet(id: string, dir = paths.sheets): Sheet {
  const file = path.join(dir, `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`Sheet "${id}" not found (expected ${file})`);
  const sheet = JSON.parse(fs.readFileSync(file, 'utf8')) as Sheet;
  for (const p of sheet.problems) {
    if (!p.slug || !p.title || !p.topic) throw new Error(`Sheet ${id}: problem missing slug/title/topic: ${JSON.stringify(p)}`);
    if (!DIFFICULTIES.includes(p.difficulty)) throw new Error(`Sheet ${id}: bad difficulty "${p.difficulty}" for ${p.slug}`);
  }
  return sheet;
}

/**
 * Upserts a sheet into the DB. Title/topic/difficulty/url follow the sheet;
 * difficulty_rating and secondary topics are only set on first insert (or if the sheet
 * specifies them), so per-problem tuning made later is preserved.
 */
export function importSheet(db: DB, cfg: PrepConfig, sheet: Sheet): { inserted: number; updated: number } {
  const track = sheet.track ?? 'dsa';
  const exists = db.prepare('SELECT 1 FROM problems WHERE slug = ?');
  const insert = db.prepare(
    `INSERT INTO problems (slug, track, title, topic_id, secondary_topics, difficulty, difficulty_rating, url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE problems SET title = ?, topic_id = ?, difficulty = ?, url = COALESCE(?, url) WHERE slug = ?`,
  );
  const setSecondary = db.prepare('UPDATE problems SET secondary_topics = ? WHERE slug = ?');
  const setRating = db.prepare('UPDATE problems SET difficulty_rating = ? WHERE slug = ?');
  const link = db.prepare(
    `INSERT INTO sheet_problems (sheet, slug, sheet_order, verified) VALUES (?, ?, ?, ?)
     ON CONFLICT(sheet, slug) DO UPDATE SET sheet_order = excluded.sheet_order, verified = excluded.verified`,
  );
  let inserted = 0;
  let updated = 0;
  db.transaction(() => {
    for (const p of sheet.problems) {
      const tId = topicId(db, track, p.topic);
      const secondary = (p.secondaryTopics ?? []).filter((t) => {
        topicId(db, track, t); // validate
        return true;
      });
      if (exists.get(p.slug)) {
        update.run(p.title, tId, p.difficulty, p.url ?? null, p.slug);
        if (secondary.length) setSecondary.run(JSON.stringify(secondary), p.slug);
        if (p.difficultyRating) setRating.run(p.difficultyRating, p.slug);
        updated++;
      } else {
        insert.run(
          p.slug,
          track,
          p.title,
          tId,
          JSON.stringify(secondary),
          p.difficulty,
          p.difficultyRating ?? cfg.rating.difficultyRatings[p.difficulty],
          p.url ?? null,
        );
        inserted++;
      }
      link.run(sheet.id, p.slug, p.order, sheet.verified ? 1 : 0);
    }
  })();
  return { inserted, updated };
}

export function sheetName(id: string): string {
  try {
    return loadSheet(id).name;
  } catch {
    return id;
  }
}

/** Problem folder paths and whether lazy generation has happened. */
export function problemFiles(slug: string) {
  const dir = path.join(paths.problems, slug);
  const files = {
    dir,
    problemMd: path.join(dir, 'Problem.md'),
    solution: path.join(dir, 'Solution.java'),
    tests: path.join(dir, 'tests.json'),
    notes: path.join(dir, 'notes.md'),
    results: path.join(dir, '.results.json'),
  };
  const generated = [files.problemMd, files.solution, files.tests].every((f) => fs.existsSync(f));
  return { ...files, generated };
}

export interface ProblemMeta {
  secondaryTopics?: string[];
  difficultyRating?: number;
}

/** problems/<slug>/meta.json: repo-persisted tags so a DB rebuild keeps them. */
export function readProblemMeta(slug: string): ProblemMeta | null {
  const file = path.join(paths.problems, slug, 'meta.json');
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as ProblemMeta) : null;
}

/** Re-applies every problems/<slug>/meta.json to the DB (run by `prep init`). Returns how many were applied. */
export function applyAllProblemMeta(db: DB, dir = paths.problems): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const slug of fs.readdirSync(dir)) {
    const meta = readProblemMeta(slug);
    if (!meta || !db.prepare('SELECT 1 FROM problems WHERE slug = ?').get(slug)) continue;
    tagProblem(db, slug, meta, { persist: false });
    n++;
  }
  return n;
}

/** Set secondary topic tags and/or a custom difficulty rating for a problem (also saved to meta.json). */
export function tagProblem(
  db: DB,
  slug: string,
  opts: ProblemMeta,
  { persist = true }: { persist?: boolean } = {},
): void {
  const row = db.prepare('SELECT track FROM problems WHERE slug = ?').get(slug) as { track: Track } | undefined;
  if (!row) throw new Error(`Unknown problem: "${slug}"`);
  if (persist) {
    const meta = { ...(readProblemMeta(slug) ?? {}), ...opts };
    const dir = path.join(paths.problems, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  }
  if (opts.secondaryTopics) {
    const names = opts.secondaryTopics.map((t) => {
      const id = topicId(db, row.track, t);
      return (db.prepare('SELECT name FROM topics WHERE id = ?').get(id) as { name: string }).name;
    });
    db.prepare('UPDATE problems SET secondary_topics = ? WHERE slug = ?').run(JSON.stringify(names), slug);
  }
  if (opts.difficultyRating != null) {
    db.prepare('UPDATE problems SET difficulty_rating = ? WHERE slug = ?').run(opts.difficultyRating, slug);
  }
}
