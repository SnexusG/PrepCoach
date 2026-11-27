import type { DB } from './db';
import { getWeakness, recordDrill, type DrillRow } from './weaknesses';

/**
 * Drill sets for the drill page: questions generated (by a one-off Claude call in the server) for one weakness, or
 * a **mixed** drill across several. Answered one at a time; multiple choice and spot-the-bug are graded here, typed
 * answers by Claude. Finishing records one practice result per weakness the questions covered.
 */

interface Base {
  prompt: string;
  explanation: string;
  /** Weakness this question targets (set on every question of a mixed drill). */
  weaknessId?: number;
}
export type DrillQuestion =
  | (Base & { type: 'mcq'; code?: string; options: string[]; answer: number })
  | (Base & { type: 'short'; code?: string; expected: string })
  | (Base & { type: 'bug'; code: string; answer: number })
  | (Base & { type: 'fix'; code: string; expected: string });

export interface DrillAnswer {
  /** Option index (mcq), 1-based line (bug) or the typed text (short/fix). */
  answer: number | string;
  correct: boolean;
  feedback: string;
  gradedBy: 'auto' | 'claude';
}

/** What a drill is about: one weakness, or a mix of all open ones. */
export type DrillTargetKey = number | 'mixed';

export interface DrillSet {
  id: number;
  /** null for a mixed drill. */
  weaknessId: number | null;
  mixed: boolean;
  createdAt: string;
  status: 'ready' | 'in_progress' | 'done';
  questions: DrillQuestion[];
  answers: Record<number, DrillAnswer>;
  drillIds: number[];
  finishedAt: string | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/**
 * Keeps only well-formed questions (generated JSON is checked, never trusted). With `weaknessIds`, each question
 * must name one of them (mixed drills); otherwise any weakness id on a question is dropped.
 */
export function validateQuestions(raw: unknown, weaknessIds?: number[]): DrillQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: DrillQuestion[] = [];
  for (const q of raw as any[]) {
    const prompt = str(q?.prompt);
    const explanation = str(q?.explanation);
    const code = str(q?.code) || undefined;
    if (!prompt || !explanation) continue;
    let weaknessId: number | undefined;
    if (weaknessIds) {
      if (!weaknessIds.includes(Number(q.weaknessId))) continue;
      weaknessId = Number(q.weaknessId);
    }
    const base = { prompt, explanation, ...(weaknessId ? { weaknessId } : {}) };
    if (q.type === 'mcq') {
      const options = Array.isArray(q.options) ? q.options.map(str).filter(Boolean) : [];
      if (options.length >= 2 && options.length <= 6 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < options.length) {
        out.push({ ...base, type: 'mcq', code, options, answer: q.answer });
      }
    } else if (q.type === 'bug') {
      const lines = code?.split('\n').length ?? 0;
      if (code && Number.isInteger(q.answer) && q.answer >= 1 && q.answer <= lines) out.push({ ...base, type: 'bug', code, answer: q.answer });
    } else if (q.type === 'short' || q.type === 'fix') {
      const expected = str(q.expected);
      if (!expected) continue;
      if (q.type === 'fix') {
        if (code) out.push({ ...base, type: 'fix', code, expected });
      } else out.push({ ...base, type: 'short', code, expected });
    }
  }
  return out;
}

type Row = {
  id: number;
  weaknessId: number | null;
  mixed: number;
  createdAt: string;
  status: DrillSet['status'];
  questions: string;
  answers: string;
  drillIds: string;
  finishedAt: string | null;
};
const COLS = `id, weakness_id AS weaknessId, mixed, created_at AS createdAt, status, questions, answers, drill_ids AS drillIds,
  finished_at AS finishedAt`;
const parse = (r: Row): DrillSet => ({
  ...r,
  mixed: !!r.mixed,
  questions: JSON.parse(r.questions),
  answers: JSON.parse(r.answers),
  drillIds: JSON.parse(r.drillIds),
});

export function createDrillSet(db: DB, target: DrillTargetKey, questions: DrillQuestion[], now = new Date()): DrillSet {
  if (!questions.length) throw new Error('A drill needs at least one question');
  const mixed = target === 'mixed';
  if (!mixed && !getWeakness(db, target)) throw new Error(`Weakness #${target} not found`);
  if (mixed && questions.some((q) => !q.weaknessId)) throw new Error('Every question of a mixed drill needs a weaknessId');
  const id = Number(
    db
      .prepare('INSERT INTO drill_sets (weakness_id, mixed, created_at, questions) VALUES (?, ?, ?, ?)')
      .run(mixed ? null : target, mixed ? 1 : 0, now.toISOString(), JSON.stringify(questions)).lastInsertRowid,
  );
  return getDrillSet(db, id);
}

export function getDrillSet(db: DB, id: number): DrillSet {
  const r = db.prepare(`SELECT ${COLS} FROM drill_sets WHERE id = ?`).get(id) as Row | undefined;
  if (!r) throw new Error(`Drill #${id} not found`);
  return parse(r);
}

/** An unfinished (preferred) or ready set for this target, if one exists. */
export function openDrillSet(db: DB, target: DrillTargetKey): DrillSet | null {
  const where = target === 'mixed' ? 'mixed = 1' : 'mixed = 0 AND weakness_id = ?';
  const args = target === 'mixed' ? [] : [target];
  const r = db
    .prepare(`SELECT ${COLS} FROM drill_sets WHERE ${where} AND status IN ('in_progress', 'ready') ORDER BY status = 'in_progress' DESC, id DESC LIMIT 1`)
    .get(...args) as Row | undefined;
  return r ? parse(r) : null;
}

/** Prompts of recent questions on a weakness (from single and mixed drills), so new drills don't repeat them. */
export function recentDrillPrompts(db: DB, weaknessId: number, limit = 20): string[] {
  const rows = db
    .prepare('SELECT weakness_id AS weaknessId, mixed, questions FROM drill_sets WHERE weakness_id = ? OR mixed = 1 ORDER BY id DESC LIMIT 10')
    .all(weaknessId) as { weaknessId: number | null; mixed: number; questions: string }[];
  return rows
    .flatMap((r) => (JSON.parse(r.questions) as DrillQuestion[]).filter((q) => !r.mixed || q.weaknessId === weaknessId).map((q) => q.prompt))
    .slice(0, limit);
}

/** Grades what can be graded without Claude: multiple choice, spot-the-bug, and typed answers that match exactly. */
export function gradeLocally(q: DrillQuestion, answer: number | string): DrillAnswer | null {
  if (q.type === 'mcq' || q.type === 'bug') {
    const a = Number(answer);
    const correct = a === q.answer;
    const right = q.type === 'mcq' ? `the answer is "${q.options[q.answer]}"` : `the bug is on line ${q.answer}`;
    return { answer: a, correct, feedback: correct ? 'Correct.' : `Not quite — ${right}.`, gradedBy: 'auto' };
  }
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '').replace(/[;.]+$/, '');
  if (norm(String(answer)) === norm(q.expected)) return { answer: String(answer), correct: true, feedback: 'Correct.', gradedBy: 'auto' };
  return null; // needs judgement
}

/** Saves an answer (a question is answered once) and marks the set as started. */
export function saveDrillAnswer(db: DB, id: number, index: number, a: DrillAnswer): DrillSet {
  const set = getDrillSet(db, id);
  if (set.status === 'done') throw new Error('This drill is already finished');
  if (!Number.isInteger(index) || index < 0 || index >= set.questions.length) throw new Error(`No question ${index}`);
  if (set.answers[index]) throw new Error('That question is already answered');
  const answers = { ...set.answers, [index]: a };
  db.prepare(`UPDATE drill_sets SET answers = ?, status = 'in_progress' WHERE id = ?`).run(JSON.stringify(answers), id);
  return getDrillSet(db, id);
}

const getDrill = (db: DB, id: number) =>
  db.prepare('SELECT id, weakness_id AS weaknessId, at, correct, total, note FROM weakness_drills WHERE id = ?').get(id) as DrillRow;

/**
 * Finishes a set: records one practice result per weakness covered by the answered questions (weakness status is
 * unchanged), and returns them. Questions on a weakness that no longer exists are left out.
 */
export function finishDrillSet(db: DB, id: number, opts: { sessionId?: number | null; now?: Date } = {}): { set: DrillSet; drills: DrillRow[] } {
  const set = getDrillSet(db, id);
  if (set.status === 'done') return { set, drills: set.drillIds.map((d) => getDrill(db, d)).filter(Boolean) };
  const answered = Object.entries(set.answers).map(([i, a]) => ({ q: set.questions[Number(i)], a }));
  if (!answered.length) throw new Error('Answer at least one question first');
  const byWeakness = new Map<number, typeof answered>();
  for (const x of answered) {
    const wid = x.q.weaknessId ?? set.weaknessId;
    if (wid == null || !getWeakness(db, wid)) continue;
    byWeakness.set(wid, [...(byWeakness.get(wid) ?? []), x]);
  }
  const now = opts.now ?? new Date();
  return db.transaction(() => {
    const drills = [...byWeakness].map(([wid, xs]) => {
      const missed = xs.filter((x) => !x.a.correct).map((x) => x.q.prompt.replace(/\s+/g, ' ').slice(0, 70));
      return recordDrill(
        db,
        wid,
        {
          correct: xs.filter((x) => x.a.correct).length,
          total: xs.length,
          note: (set.mixed ? 'mixed drill; ' : '') + (missed.length ? `missed: ${missed.join(' | ')}` : 'all correct'),
          sessionId: opts.sessionId ?? null,
        },
        now,
      );
    });
    db.prepare(`UPDATE drill_sets SET status = 'done', drill_ids = ?, finished_at = ? WHERE id = ?`).run(
      JSON.stringify(drills.map((d) => d.id)),
      now.toISOString(),
      id,
    );
    return { set: getDrillSet(db, id), drills };
  })();
}

/** What the browser may see: answers and explanations only for questions already answered. */
export function publicDrillSet(set: DrillSet) {
  return {
    ...set,
    questions: set.questions.map((q, i) => {
      if (set.answers[i]) return q;
      const { explanation: _e, ...rest } = q as any;
      delete rest.answer;
      delete rest.expected;
      return rest;
    }),
  };
}
