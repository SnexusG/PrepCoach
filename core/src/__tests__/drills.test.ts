import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { openDb, seed, type DB } from '../db';
import { importSheet, loadSheet } from '../catalog';
import { recordAttempt, recordTestRun, startAttempt } from '../attempts';
import {
  createDrillSet,
  finishDrillSet,
  gradeLocally,
  openDrillSet,
  publicDrillSet,
  recentDrillPrompts,
  saveDrillAnswer,
  validateQuestions,
} from '../drills';
import { getWeakness, listDrills } from '../weaknesses';

const cfg = loadConfig();
const t0 = new Date(2026, 10, 20, 9);
const perfect = { optimality: 1, approach: 1, codeQuality: 1, communication: 1 };
let db: DB;
let a: number;
let b: number;

beforeEach(() => {
  db = openDb(':memory:');
  seed(db, cfg, t0);
  importSheet(db, cfg, loadSheet('neetcode150'));
  startAttempt(db, 'two-sum', { now: t0 });
  recordTestRun(db, 'two-sum', 5, 5, t0);
  const r = recordAttempt(db, cfg, {
    slug: 'two-sum',
    rubric: perfect,
    weaknesses: [{ description: 'gap A', area: 'complexity' }, { description: 'gap B', area: 'java' }],
    now: t0,
  });
  [a, b] = r.weaknesses.map((w) => w.id);
});

const mcq = (weaknessId?: number, prompt = 'Cost of HashMap.get?') => ({
  type: 'mcq', prompt, options: ['O(1)', 'O(n)'], answer: 0, explanation: 'hashing', weaknessId,
});

describe('drill questions', () => {
  it('keeps only well-formed questions, and in a mixed drill only ones tagged with a requested weakness', () => {
    const raw = [
      mcq(a),
      { type: 'bug', prompt: 'Find it', code: 'a\nb\nc', answer: 4, explanation: 'x' }, // line out of range
      { type: 'short', prompt: 'Cost?', expected: 'O(n)', explanation: 'x', weaknessId: 999 },
      { type: 'fix', prompt: 'Fix', expected: 'x', explanation: 'x' }, // fix needs code
    ];
    expect(validateQuestions(raw).map((q) => q.type)).toEqual(['mcq', 'short']);
    expect(validateQuestions(raw, [a, b]).map((q) => q.weaknessId)).toEqual([a]);
  });

  it('grades multiple choice and exact typed answers locally, and leaves the rest to judgement', () => {
    const [q] = validateQuestions([mcq()]);
    expect(gradeLocally(q, 0)).toMatchObject({ correct: true, gradedBy: 'auto' });
    expect(gradeLocally(q, 1)!.feedback).toContain('O(1)');
    const [s] = validateQuestions([{ type: 'short', prompt: 'p', expected: 'O(n log n)', explanation: 'x' }]);
    expect(gradeLocally(s, ' o(n LOG n) ')).toMatchObject({ correct: true });
    expect(gradeLocally(s, 'linearithmic')).toBeNull();
  });

  it('hides answers and explanations until a question is answered', () => {
    const set = createDrillSet(db, a, validateQuestions([mcq(), mcq(undefined, 'second')]), t0);
    const answered = saveDrillAnswer(db, set.id, 0, gradeLocally(set.questions[0], 0)!);
    const pub = publicDrillSet(answered).questions as any[];
    expect(pub[0]).toHaveProperty('answer', 0);
    expect(pub[1]).not.toHaveProperty('answer');
    expect(pub[1]).not.toHaveProperty('explanation');
  });
});

describe('mixed drills', () => {
  it('records one practice result per weakness and leaves weakness status alone', () => {
    const qs = validateQuestions([mcq(a, 'a1'), mcq(b, 'b1'), mcq(a, 'a2'), mcq(b, 'b2')], [a, b]);
    const set = createDrillSet(db, 'mixed', qs, t0);
    expect(set).toMatchObject({ mixed: true, weaknessId: null });
    expect(openDrillSet(db, 'mixed')!.id).toBe(set.id);
    expect(openDrillSet(db, a)).toBeNull(); // a mixed set isn't a single-weakness set
    const answers = [0, 1, 0, 0]; // a1 right, b1 wrong, a2 right, b2 right
    answers.forEach((ans, i) => saveDrillAnswer(db, set.id, i, gradeLocally(qs[i], ans)!));
    const { drills, set: done } = finishDrillSet(db, set.id, { now: t0 });
    expect(drills.map((d) => [d.weaknessId, d.correct, d.total])).toEqual([
      [a, 2, 2],
      [b, 1, 2],
    ]);
    expect(drills[1].note).toBe('mixed drill; missed: b1');
    expect(done.status).toBe('done');
    expect(listDrills(db, b)).toHaveLength(1);
    expect(getWeakness(db, a)!.status).toBe('active');
    // finishing again returns the same results instead of recording twice
    expect(finishDrillSet(db, set.id).drills.map((d) => d.id)).toEqual(drills.map((d) => d.id));
    expect(recentDrillPrompts(db, b)).toEqual(['b1', 'b2']);
  });

  it('rejects a mixed set with untagged questions and finishing with nothing answered', () => {
    expect(() => createDrillSet(db, 'mixed', validateQuestions([mcq()]), t0)).toThrow(/weaknessId/);
    const set = createDrillSet(db, a, validateQuestions([mcq()]), t0);
    expect(() => finishDrillSet(db, set.id)).toThrow(/at least one/);
  });
});
