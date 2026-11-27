import type { DB } from './db';
import { getWeakness, recordDrill, type DrillRow } from './weaknesses';

/**
 * Drill sets for the drill page: questions generated for one weakness (by a one-off Claude call in the server),
 * answered one at a time. Multiple choice and spot-the-bug are graded here; typed answers are graded by Claude.
 */

export type DrillQuestion =
  | { type: 'mcq'; prompt: string; code?: string; options: string[]; answer: number; explanation: string }
  | { type: 'short'; prompt: string; code?: string; expected: string; explanation: string }
  | { type: 'bug'; prompt: string; code: string; answer: number; explanation: string }
  | { type: 'fix'; prompt: string; code: string; expected: string; explanation: string };

export interface DrillAnswer {
  /** Option index (mcq), 1-based line (bug) or the typed text (short/fix). */
  answer: number | string;
  correct: boolean;
  feedback: string;
  gradedBy: 'auto' | 'claude';
}

export interface DrillSet {
  id: number;
  weaknessId: number;
  createdAt: string;
  status: 'ready' | 'in_progress' | 'done';
  questions: DrillQuestion[];
  answers: Record<number, DrillAnswer>;
  drillId: number | null;
  finishedAt: string | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Keeps only well-formed questions (generated JSON is checked, never trusted). */
export function validateQuestions(raw: unknown): DrillQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: DrillQuestion[] = [];
  for (const q of raw as any[]) {
    const prompt = str(q?.prompt);
    const explanation = str(q?.explanation);
    const code = str(q?.code) || undefined;
    if (!prompt || !explanation) continue;
    if (q.type === 'mcq') {
      const options = Array.isArray(q.options) ? q.options.map(str).filter(Boolean) : [];
      if (options.length >= 2 && options.length <= 6 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < options.length) {
        out.push({ type: 'mcq', prompt, code, options, answer: q.answer, explanation });
      }
    } else if (q.type === 'bug') {
      const lines = code?.split('\n').length ?? 0;
      if (code && Number.isInteger(q.answer) && q.answer >= 1 && q.answer <= lines) out.push({ type: 'bug', prompt, code, answer: q.answer, explanation });
    } else if (q.type === 'short' || q.type === 'fix') {
      const expected = str(q.expected);
      if (!expected) continue;
      if (q.type === 'fix' && !code) continue;
      out.push(q.type === 'fix' ? { type: 'fix', prompt, code: code!, expected, explanation } : { type: 'short', prompt, code, expected, explanation });
    }
  }
  return out;
}

type Row = { id: number; weaknessId: number; createdAt: string; status: DrillSet['status']; questions: string; answers: string; drillId: number | null; finishedAt: string | null };
const COLS = `id, weakness_id AS weaknessId, created_at AS createdAt, status, questions, answers, drill_id AS drillId, finished_at AS finishedAt`;
const parse = (r: Row): DrillSet => ({ ...r, questions: JSON.parse(r.questions), answers: JSON.parse(r.answers) });

export function createDrillSet(db: DB, weaknessId: number, questions: DrillQuestion[], now = new Date()): DrillSet {
  if (!getWeakness(db, weaknessId)) throw new Error(`Weakness #${weaknessId} not found`);
  if (!questions.length) throw new Error('A drill needs at least one question');
  const id = Number(
    db.prepare('INSERT INTO drill_sets (weakness_id, created_at, questions) VALUES (?, ?, ?)').run(weaknessId, now.toISOString(), JSON.stringify(questions))
      .lastInsertRowid,
  );
  return getDrillSet(db, id);
}

export function getDrillSet(db: DB, id: number): DrillSet {
  const r = db.prepare(`SELECT ${COLS} FROM drill_sets WHERE id = ?`).get(id) as Row | undefined;
  if (!r) throw new Error(`Drill #${id} not found`);
  return parse(r);
}

/** An unstarted (ready) or unfinished set for this weakness, if one exists — newest first. */
export function openDrillSet(db: DB, weaknessId: number): DrillSet | null {
  const r = db
    .prepare(`SELECT ${COLS} FROM drill_sets WHERE weakness_id = ? AND status IN ('in_progress', 'ready') ORDER BY status = 'in_progress' DESC, id DESC LIMIT 1`)
    .get(weaknessId) as Row | undefined;
  return r ? parse(r) : null;
}

/** Prompts of recent questions on a weakness, so new drills don't repeat them. */
export function recentDrillPrompts(db: DB, weaknessId: number, limit = 20): string[] {
  const rows = db.prepare('SELECT questions FROM drill_sets WHERE weakness_id = ? ORDER BY id DESC LIMIT 6').all(weaknessId) as { questions: string }[];
  return rows.flatMap((r) => (JSON.parse(r.questions) as DrillQuestion[]).map((q) => q.prompt)).slice(0, limit);
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

/** Finishes a set: records the drill result on the weakness (practice — status unchanged) and returns it. */
export function finishDrillSet(db: DB, id: number, opts: { sessionId?: number | null; now?: Date } = {}): { set: DrillSet; drill: DrillRow } {
  const set = getDrillSet(db, id);
  if (set.status === 'done' && set.drillId) {
    const drill = db.prepare('SELECT id, weakness_id AS weaknessId, at, correct, total, note FROM weakness_drills WHERE id = ?').get(set.drillId) as DrillRow;
    return { set, drill };
  }
  const answered = Object.entries(set.answers);
  if (!answered.length) throw new Error('Answer at least one question first');
  const correct = answered.filter(([, a]) => a.correct).length;
  const missed = answered.filter(([, a]) => !a.correct).map(([i]) => set.questions[Number(i)].prompt.replace(/\s+/g, ' ').slice(0, 70));
  const note = missed.length ? `missed: ${missed.join(' | ')}` : 'all correct';
  const now = opts.now ?? new Date();
  return db.transaction(() => {
    const drill = recordDrill(db, set.weaknessId, { correct, total: answered.length, note, sessionId: opts.sessionId ?? null }, now);
    db.prepare(`UPDATE drill_sets SET status = 'done', drill_id = ?, finished_at = ? WHERE id = ?`).run(drill.id, now.toISOString(), id);
    return { set: getDrillSet(db, id), drill };
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
