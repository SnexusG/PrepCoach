import { spawn } from 'node:child_process';
import os from 'node:os';
import {
  createDrillSet,
  focusWeakness,
  getWeakness,
  listWeaknesses,
  openDrillSet,
  recentDrillPrompts,
  validateQuestions,
  weaknessesWithExamples,
  type DB,
  type DrillAnswer,
  type DrillConfig,
  type DrillQuestion,
  type DrillSet,
  type DrillTargetKey,
  type Track,
  type WeaknessRow,
  type TutorConfig,
} from '@prepcoach/core';

/**
 * Drill questions are written and typed answers judged by one-off `claude -p` calls with structured output.
 * They run outside the repo with no tools and no project settings, so they never act as the tutor (no CLAUDE.md,
 * no `npx prep`) and never touch the tutor's conversation.
 */

const AREA_GUIDE: Record<string, string> = {
  complexity: 'time/space cost of Java operations and short snippets (HashMap/TreeMap/PriorityQueue/ArrayList/sorting/String building), worst vs average case',
  java: 'Java 17 collections API and semantics: method names, generics with primitives, equals/hashCode, comparators, iteration and mutation, String vs StringBuilder',
  understanding: 'reading a short problem statement precisely: restating rules, spotting constraints and ambiguities worth clarifying',
  'edge-cases': 'inputs that break naive code: empty, single element, duplicates, negatives, overflow, extremes of the constraints',
  algorithm: 'recognising the right pattern (two pointers, sliding window, BFS/DFS, heap, DP, binary search…) from a one-line problem description, and why',
  implementation: 'spotting bugs in short Java snippets: off-by-one, wrong bounds, duplicated blocks with an index slip, wrong update order',
  testing: 'choosing the smallest input that exposes a bug, and what a good set of test cases covers',
  communication: 'explaining an approach crisply: which explanation is better structured, what to state up front (complexity, approach, trade-offs)',
};

const GEN_SYSTEM = `You write short practice drills for a software engineer preparing for big-tech coding interviews in Java 17.
A drill targets one weakness (a general skill gap). Questions must be answerable in under a minute each, unambiguous,
technically correct, and aimed at the gap — especially at the specific slips listed. Never use or describe a
complete interview problem (no spoilers); use small snippets and focused questions.
Question types:
- "mcq": prompt, optional code, 3–4 options, answer = index of the single correct option (0-based). Make the wrong
  options plausible (common misconceptions), not silly.
- "short": a typed answer of a few words or a complexity like "O(n log n)"; expected = the canonical answer.
- "bug": code of 4–10 lines with exactly one buggy line; answer = that 1-based line number; prompt asks to find it.
- "fix": code of 1–6 lines that's wrong; expected = the corrected code (just the changed line(s)).
Every question has an explanation: 1–2 sentences on why the answer is right (shown after answering).
Code is plain Java with no markdown fences. Mix the types (at least two different ones) to fit the gap.
In a mixed drill (several weaknesses, each with an id), set weaknessId on every question to the weakness it targets,
write the requested number for each, and order the questions so the weaknesses alternate.`;

const GEN_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['mcq', 'short', 'bug', 'fix'] },
          prompt: { type: 'string' },
          code: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          answer: { type: 'integer' },
          expected: { type: 'string' },
          explanation: { type: 'string' },
          weaknessId: { type: 'integer' },
        },
        required: ['type', 'prompt', 'explanation'],
      },
    },
  },
  required: ['questions'],
};

const GRADE_SYSTEM = `You grade one answer in a short coding-interview drill. Judge the substance, not the wording:
"constant time" equals "O(1)"; a fix is correct if it behaves like the expected fix (different but valid code counts).
Be strict about technical correctness and lenient about formatting and typos. Reply with correct (true/false) and
one or two sentences of feedback addressed to the student ("you"): if wrong, say what's wrong and give the right answer.`;

const GRADE_SCHEMA = {
  type: 'object',
  properties: { correct: { type: 'boolean' }, feedback: { type: 'string' } },
  required: ['correct', 'feedback'],
};

/** One `claude -p` call returning structured output. The prompt goes through stdin (no quoting trouble). */
function claudeJson<T>(bin: string, opts: { system: string; prompt: string; schema: object; model: string | null; timeoutMs: number }): Promise<T> {
  const args = [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(opts.schema),
    '--system-prompt', opts.system,
    '--tools', '',
    '--no-session-persistence',
    '--setting-sources', '',
    '--strict-mcp-config',
  ];
  if (opts.model) args.push('--model', opts.model);
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { cwd: os.tmpdir(), env: process.env, windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Claude took too long'));
    }, opts.timeoutMs);
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err = (err + d).slice(-1000)));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`could not run ${bin}: ${e.message}`));
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        if (j.is_error || !j.structured_output) throw new Error(j.result || `no structured output (exit ${code})`);
        resolve(j.structured_output as T);
      } catch (e) {
        reject(new Error(`${(e as Error).message}${err ? ` — ${err.trim().split('\n').pop()}` : ''}`));
      }
    });
    proc.stdin.end(opts.prompt);
  });
}

export class DrillService {
  private generating = new Map<DrillTargetKey, Promise<DrillSet>>();
  private errors = new Map<DrillTargetKey, string>();
  private prepChain: Promise<unknown> = Promise.resolve();

  constructor(
    private db: DB,
    private cfg: DrillConfig,
    private tutor: TutorConfig,
    private track: () => Track,
  ) {}

  private get bin() {
    return process.env.PREP_CLAUDE_BIN || this.tutor.claudeBin;
  }

  status(target: DrillTargetKey) {
    return {
      ready: !!openDrillSet(this.db, target),
      generating: this.generating.has(target),
      error: this.errors.get(target) ?? null,
    };
  }

  /** A ready or unfinished set for the target, generating one if needed (deduplicated). */
  ensure(target: DrillTargetKey): Promise<DrillSet> {
    const open = openDrillSet(this.db, target);
    if (open) return Promise.resolve(open);
    const running = this.generating.get(target);
    if (running) return running;
    const job = (target === 'mixed' ? this.generateMixed() : this.generate(target))
      .then((qs) => {
        this.errors.delete(target);
        return createDrillSet(this.db, target, qs);
      })
      .catch((e) => {
        this.errors.set(target, (e as Error).message);
        throw e;
      })
      .finally(() => this.generating.delete(target));
    this.generating.set(target, job);
    return job;
  }

  /** Prepare the mixed drill and the suggested single one in the background (one after the other). */
  prepareNext(): void {
    const prep = (t: DrillTargetKey) => () =>
      this.ensure(t).catch((e) => console.error(`Drill preparation failed: ${(e as Error).message}`));
    const open = listWeaknesses(this.db, this.track(), ['active', 'improving']);
    if (!open.length) return;
    this.prepChain = this.prepChain.then(prep('mixed'));
    const f = focusWeakness(this.db, this.track(), 'drill');
    if (f) this.prepChain = this.prepChain.then(prep(f.weakness.id));
  }

  /** The prompt block describing one weakness: its gap, area, actual slips, last drill and questions to avoid. */
  private describe(w: WeaknessRow, opts: { withId: boolean }): string {
    const full = weaknessesWithExamples(this.db, w.track).find((x) => x.id === w.id);
    const slips = (full?.examples ?? []).filter((e) => e.kind === 'observed').map((e) => e.note ?? e.summary).filter(Boolean);
    const avoid = recentDrillPrompts(this.db, w.id, opts.withId ? 8 : 20);
    return [
      `${opts.withId ? `Weakness id ${w.id}` : 'Weakness'}: ${w.description}`,
      `Area: ${w.area ?? 'unspecified'}${w.area && AREA_GUIDE[w.area] ? ` — ${AREA_GUIDE[w.area]}` : ''}`,
      slips.length ? `Their actual slips (aim at these):\n${slips.map((s) => `- ${s}`).join('\n')}` : '',
      full?.drills[0]?.note ? `Last drill result: ${full.drills[0].correct}/${full.drills[0].total}, ${full.drills[0].note}` : '',
      avoid.length ? `Don't repeat these earlier questions:\n${avoid.map((s) => `- ${s}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async ask(prompt: string, weaknessIds?: number[]): Promise<DrillQuestion[]> {
    const out = await claudeJson<{ questions: unknown }>(this.bin, {
      system: GEN_SYSTEM,
      prompt,
      schema: GEN_SCHEMA,
      model: this.cfg.generationModel ?? this.tutor.model,
      timeoutMs: 240_000,
    });
    return validateQuestions(out.questions, weaknessIds);
  }

  private async generate(weaknessId: number): Promise<DrillQuestion[]> {
    const w = getWeakness(this.db, weaknessId);
    if (!w) throw new Error(`Weakness #${weaknessId} not found`);
    const qs = (await this.ask(`${this.describe(w, { withId: false })}\n\nWrite exactly ${this.cfg.questions} questions.`)).slice(0, this.cfg.questions);
    if (qs.length < Math.min(3, this.cfg.questions)) throw new Error(`only ${qs.length} usable questions were generated`);
    return qs;
  }

  /**
   * A drill across all open weaknesses: mixedQuestions spread over them, least recently drilled first (at most 3 on
   * any one), each question tagged with the weakness it targets.
   */
  private async generateMixed(): Promise<DrillQuestion[]> {
    const open = listWeaknesses(this.db, this.track(), ['active', 'improving']).sort(
      (a, b) => (a.lastDrillAt ?? '').localeCompare(b.lastDrillAt ?? '') || b.timesObserved - a.timesObserved,
    );
    if (!open.length) throw new Error('No open weaknesses to drill');
    const total = this.cfg.mixedQuestions;
    const counts = new Map<number, number>();
    for (let i = 0, given = 0; given < total && i < open.length * 3; i++) {
      const w = open[i % open.length];
      if ((counts.get(w.id) ?? 0) >= 3) continue;
      counts.set(w.id, (counts.get(w.id) ?? 0) + 1);
      given++;
    }
    const picked = open.filter((w) => counts.has(w.id));
    const prompt = [
      'Mixed drill across these weaknesses:',
      ...picked.map((w) => `${this.describe(w, { withId: true })}\nQuestions for this weakness: ${counts.get(w.id)}`),
      `Write ${total} questions in total, each with weaknessId set to the weakness it targets.`,
    ].join('\n\n');
    const qs = await this.ask(prompt, picked.map((w) => w.id));
    if (qs.length < Math.min(4, total)) throw new Error(`only ${qs.length} usable questions were generated`);
    return qs.slice(0, total);
  }

  /** Judge a typed answer that didn't match the expected one exactly. */
  async grade(q: Extract<DrillQuestion, { type: 'short' | 'fix' }>, answer: string): Promise<DrillAnswer> {
    const prompt = [
      `Question: ${q.prompt}`,
      q.code ? `Code:\n${q.code}` : '',
      `Expected answer: ${q.expected}`,
      `Why: ${q.explanation}`,
      `Student's answer: ${answer}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const r = await claudeJson<{ correct: boolean; feedback: string }>(this.bin, {
      system: GRADE_SYSTEM,
      prompt,
      schema: GRADE_SCHEMA,
      model: this.cfg.gradingModel,
      timeoutMs: 60_000,
    });
    return { answer, correct: !!r.correct, feedback: String(r.feedback ?? ''), gradedBy: 'claude' };
  }
}
