import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';
import {
  DIFFICULTIES,
  abandonAttempt,
  activeSession,
  endSession,
  getContext,
  getOpenAttempt,
  getPrefs,
  getProblem,
  getStats,
  hintCap,
  importSheet,
  isReviewDue,
  listAttempts,
  listReviews,
  listSheetFiles,
  loadConfig,
  loadSheet,
  nextProblem,
  openDb,
  paths,
  problemFiles,
  ratingLabel,
  recordAttempt,
  recordHint,
  renderContextMarkdown,
  seed,
  setPreference,
  startAttempt,
  startSession,
  tagProblem,
  updateWeakness,
  weaknessesWithExamples,
  applyWeaknessObservations,
  type Difficulty,
  type DB,
  type Rubric,
  type WeaknessObservation,
  type WeaknessStatus,
} from '@prepcoach/core';

const cfg = loadConfig();
let dbHandle: DB | null = null;
const db = () => (dbHandle ??= openDb());

const program = new Command();
program
  .name('prep')
  .description('PrepCoach state CLI — the single source of truth for ratings, attempts, weaknesses and reviews.')
  .option('--json', 'machine-readable JSON output')
  .showHelpAfterError();

const json = () => !!program.opts().json;

function out(data: unknown, human: () => string | string[]) {
  if (json()) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const h = human();
    console.log(Array.isArray(h) ? h.join('\n') : h);
  }
}

/** Accepts JSON, @file.json, or "key=value,key=value". */
function parseObjectArg(raw: string, what: string): any {
  let text = raw.trim();
  if (text.startsWith('@')) text = fs.readFileSync(text.slice(1), 'utf8');
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`Invalid JSON for ${what}: ${(e as Error).message}`);
    }
  }
  const obj: Record<string, number | string> = {};
  for (const pair of text.split(',').filter(Boolean)) {
    const [k, v] = pair.split('=').map((s) => s.trim());
    if (!k || v === undefined) throw new Error(`Bad ${what} entry "${pair}" (expected key=value)`);
    obj[k] = Number.isNaN(Number(v)) ? v : Number(v);
  }
  return obj;
}

const parseDifficulty = (v: string): Difficulty => {
  const d = v.toLowerCase() as Difficulty;
  if (!DIFFICULTIES.includes(d)) throw new Error(`Difficulty must be one of ${DIFFICULTIES.join(', ')}`);
  return d;
};
const sign = (n: number) => `${n >= 0 ? '+' : ''}${(Math.round(n * 10) / 10).toFixed(1)}`;
const editorUrl = (slug: string) => `http://localhost:${cfg.ports.web}/problem/${slug}`;
const rel = (p: string) => path.relative(paths.root, p).replace(/\\/g, '/');
const mmss = (s: number | null) => (s == null ? '-' : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`);

// ---------------- init ----------------
program
  .command('init')
  .description('create/migrate the DB, seed tracks/topics and import all sheets in data/sheets')
  .action(() => {
    const d = db();
    seed(d, cfg);
    const results = listSheetFiles().map((id) => {
      const sheet = loadSheet(id);
      return { id, name: sheet.name, verified: sheet.verified, count: sheet.problems.length, ...importSheet(d, cfg, sheet) };
    });
    out({ db: paths.db, sheets: results }, () => [
      `Database ready: ${rel(paths.db)}`,
      ...results.map(
        (r) => `Sheet ${r.id} (${r.name}): ${r.count} problems — ${r.inserted} new, ${r.updated} updated${r.verified ? '' : ' — UNVERIFIED'}`,
      ),
    ]);
  });

// ---------------- session ----------------
const session = program.command('session').description('start/end a tutoring session');
session
  .command('start')
  .description('start (or resume) a session')
  .action(() => {
    const r = startSession(db(), getPrefs(db()).track);
    out(r, () => `${r.resumed ? 'Resumed' : 'Started'} session #${r.session.id}.`);
  });
session
  .command('end')
  .option('--summary <text>', 'session wrap-up')
  .action((o) => {
    const s = endSession(db(), { summary: o.summary });
    out(s ?? null, () => (s ? `Ended session #${s.id}.` : 'No active session.'));
  });

// ---------------- context ----------------
program
  .command('context')
  .description('compact markdown status for the tutor (run at the start of every conversation)')
  .action(() => {
    const c = getContext(db(), cfg);
    out(c, () => renderContextMarkdown(c));
  });

// ---------------- next ----------------
program
  .command('next')
  .description('pick the next problem (does not start the timer; run `prep start <slug>`)')
  .option('--topic <name>', 'restrict to a topic')
  .option('--difficulty <level>', 'easy | medium | hard', parseDifficulty)
  .option('--more-reviews', 'allow more than one review this session')
  .action((o) => {
    const r = nextProblem(db(), cfg, { topic: o.topic, difficulty: o.difficulty, moreReviews: o.moreReviews });
    out(r, () => {
      const L: string[] = [];
      for (const a of r.openAttempts) {
        L.push(`⚠ Open attempt on ${a.slug} — finish it (record-attempt) or \`prep abandon ${a.slug}\`.`);
      }
      if (!r.selection || !r.problem) {
        L.push('Nothing left to serve with these filters. Try another difficulty or topic.');
        return L;
      }
      const s = r.selection;
      L.push(`Next: ${s.title} (${s.slug}) — ${s.topic}, ${s.difficulty}${s.isReview ? ' — REVIEW' : ''}`);
      L.push(`Why: ${s.reason}`);
      L.push(`Files: ${rel(r.problem.files.dir)} (${r.problem.files.generated ? 'generated' : 'NOT generated yet'})`);
      L.push(`Original: ${r.problem.url ?? '-'}`);
      for (const sug of s.suggestions) L.push(`Suggestion: ${sug}`);
      L.push(`Start it with: prep start ${s.slug}${s.isReview ? ' --review' : ''}`);
      return L;
    });
  });

// ---------------- start ----------------
program
  .command('start <slug>')
  .description('open an attempt and start the timer')
  .addOption(new Option('--review', 'force review mode'))
  .addOption(new Option('--no-review', 'force a fresh attempt even if a review is due'))
  .action((slug, o) => {
    const d = db();
    if (!activeSession(d)) startSession(d, getPrefs(d).track);
    const isReview = o.review === undefined ? isReviewDue(d, slug) : o.review;
    const { attempt, resumed } = startAttempt(d, slug, { isReview });
    const problem = getProblem(d, slug);
    const files = problemFiles(slug);
    out({ attempt, resumed, problem, files, editorUrl: editorUrl(slug) }, () => [
      `${resumed ? 'Resumed' : 'Started'} attempt #${attempt.id}: ${problem.title} (${problem.topic}, ${problem.difficulty}, rating ${problem.difficultyRating})${attempt.isReview ? ' — REVIEW' : ''}`,
      `Timer started at ${attempt.startedAt.slice(11, 19)} UTC · hints used ${attempt.hintsUsed}`,
      `Editor: ${editorUrl(slug)}`,
      `Files: ${rel(files.dir)} — ${files.generated ? 'generated' : 'NOT generated yet: write Problem.md, Solution.java, tests.json'}`,
    ]);
  });

// ---------------- hint ----------------
program
  .command('hint <slug> <level>')
  .description('log a hint level (1 nudge, 2 pattern, 3 approach, 4 full solution)')
  .action((slug, level) => {
    const lvl = recordHint(db(), cfg, slug, Number(level));
    const names = cfg.rating.hintNames;
    const next = lvl < names.length - 1 ? lvl + 1 : null;
    const data = {
      slug,
      hintsUsed: lvl,
      name: names[lvl],
      cap: hintCap(lvl, cfg),
      next: next == null ? null : { level: next, name: names[next], cap: hintCap(next, cfg) },
    };
    out(data, () => [
      `Hint level now ${lvl} (${names[lvl]}) — max outcome ${data.cap}.`,
      data.next ? `Next hint would be "${data.next.name}" — max outcome ${data.next.cap}.` : 'No further hints.',
    ]);
  });

// ---------------- run-tests ----------------
program
  .command('run-tests <slug>')
  .description('compile and run Solution.java against tests.json')
  .action(() => {
    throw new Error('run-tests arrives in Phase 3 (Java harness).');
  });

// ---------------- record-attempt ----------------
program
  .command('record-attempt <slug>')
  .description('record a finished attempt: computes outcome + Elo, updates weaknesses and the review queue')
  .requiredOption('--rubric <json>', 'optimality, approach, codeQuality, communication [, independence, correctness] in 0..1 (JSON, @file, or k=v,k=v)')
  .option('--hints <n>', 'hint level used (defaults to the logged level)', Number)
  .option('--weaknesses <json>', 'JSON array of {id?|description, topic?, kind?: observed|handled_well}')
  .option('--summary <text>', 'one-paragraph tutor summary')
  .option('--tests-passed <n>', 'override tests passed (defaults to latest run)', Number)
  .option('--tests-total <n>', 'override tests total (defaults to latest run)', Number)
  .action((slug, o) => {
    const rubric = parseObjectArg(o.rubric, '--rubric') as Rubric;
    for (const k of ['optimality', 'approach', 'codeQuality', 'communication'] as const) {
      if (typeof rubric[k] !== 'number') throw new Error(`--rubric is missing numeric "${k}"`);
    }
    const weaknesses = o.weaknesses ? (parseObjectArg(o.weaknesses, '--weaknesses') as WeaknessObservation[]) : [];
    if (!Array.isArray(weaknesses)) throw new Error('--weaknesses must be a JSON array');
    const r = recordAttempt(db(), cfg, {
      slug,
      rubric,
      hintsUsed: o.hints,
      weaknesses,
      summary: o.summary,
      testsPassed: o.testsPassed,
      testsTotal: o.testsTotal,
    });
    out(r, () => {
      const p = r.changes.find((c) => c.isPrimary);
      const L = [
        `Recorded attempt #${r.attemptId} on ${slug}${r.isReview ? ' (review)' : ''}: outcome ${r.outcome.score.toFixed(2)}` +
          (r.outcome.raw > r.outcome.cap ? ` (capped from ${r.outcome.raw.toFixed(2)} by ${r.hintsUsed} hint level)` : '') +
          ` · tests ${r.testsPassed}/${r.testsTotal} · ${mmss(r.solveTimeSec)}`,
      ];
      if (p) L.push(`${p.topic}: ${Math.round(p.before)} → ${Math.round(p.after)} (${sign(p.delta)})`);
      for (const c of r.changes.filter((c) => !c.isPrimary)) {
        L.push(`  secondary ${c.topic}: ${Math.round(c.before)} → ${Math.round(c.after)} (${sign(c.delta)})`);
      }
      L.push(`Overall DSA: ${Math.round(r.overallBefore)} → ${Math.round(r.overallAfter)} (${ratingLabel(r.overallAfter, cfg)})`);
      L.push(`Next review: ${r.review.dueDate} (in ${r.review.intervalDays}d)`);
      for (const w of r.weaknesses) {
        L.push(`Weakness #${w.id} "${w.description}": ${w.action} → ${w.status} (seen ${w.timesObserved}×, clean ${w.cleanDemonstrations}×)`);
      }
      return L;
    });
  });

// ---------------- abandon ----------------
program
  .command('abandon <slug>')
  .description('abandon the open attempt: no rating change, problem stays unsolved and comes back later')
  .option('--summary <text>', 'why / where you got stuck')
  .action((slug, o) => {
    const a = abandonAttempt(db(), slug, { summary: o.summary });
    out(a, () => `Abandoned attempt #${a.id} on ${slug} after ${mmss(a.solveTimeSec)}. No rating change; it stays unsolved and will be offered again in a later session.`);
  });

// ---------------- weakness ----------------
const weakness = program.command('weakness').description('list / update weaknesses');
weakness
  .command('list')
  .option('--all', 'include resolved')
  .action((o) => {
    const statuses: WeaknessStatus[] | undefined = o.all ? undefined : ['active', 'improving'];
    const rows = weaknessesWithExamples(db(), getPrefs(db()).track, statuses);
    out(rows, () =>
      rows.length
        ? rows.flatMap((w) => [
            `#${w.id} [${w.topic ?? 'general'}] ${w.description} — ${w.status}, seen ${w.timesObserved}×, clean ${w.cleanDemonstrations}×, last ${w.lastSeen.slice(0, 10)}`,
            ...w.examples.map((e) => `    ${e.kind} on ${e.slug} (${e.date.slice(0, 10)})`),
          ])
        : 'No weaknesses logged.',
    );
  });
weakness
  .command('update <id>')
  .option('--status <status>', 'active | improving | resolved')
  .option('--description <text>', 'reword the weakness')
  .action((id, o) => {
    if (o.status && !['active', 'improving', 'resolved'].includes(o.status)) throw new Error('Bad --status');
    const w = updateWeakness(db(), Number(id), { status: o.status, description: o.description });
    out(w, () => `#${w.id} ${w.description} — ${w.status}`);
  });
weakness
  .command('observe')
  .description('log an observation outside of record-attempt (e.g. during a discussion)')
  .requiredOption('--weaknesses <json>', 'JSON array, same format as record-attempt')
  .action((o) => {
    const obs = parseObjectArg(o.weaknesses, '--weaknesses') as WeaknessObservation[];
    const d = db();
    const changes = d.transaction(() => applyWeaknessObservations(d, cfg, getPrefs(d).track, null, obs))();
    out(changes, () => changes.map((w) => `#${w.id} "${w.description}": ${w.action} → ${w.status}`));
  });

// ---------------- reviews ----------------
program
  .command('reviews')
  .description('spaced-repetition queue')
  .option('--all', 'show the whole queue, not just due + next 7 days')
  .action((o) => {
    const rows = listReviews(db(), new Date(), o.all ? {} : { withinDays: 7 });
    out(rows, () =>
      rows.length
        ? rows.map(
            (r) =>
              `${r.due ? 'DUE ' : '    '}${r.dueDate}  ${r.slug} (${r.topic}, ${r.difficulty}) · interval ${r.intervalDays}d · last ${r.lastOutcome.toFixed(2)} · reviews ${r.reviewsCount}`,
          )
        : 'Review queue is empty.',
    );
  });

// ---------------- set ----------------
program
  .command('set')
  .description('set preferences')
  .option('--sheet <id>', `active sheet (${listSheetFiles().join(', ')})`)
  .option('--difficulty <level>', 'preferred difficulty', parseDifficulty)
  .action((o) => {
    const d = db();
    if (o.sheet) {
      const sheet = loadSheet(o.sheet);
      importSheet(d, cfg, sheet);
      setPreference(d, 'active_sheet', o.sheet);
    }
    if (o.difficulty) setPreference(d, 'difficulty', o.difficulty);
    const p = getPrefs(d);
    out(p, () => `Sheet: ${p.sheetName} (${p.sheet}) · difficulty: ${p.difficulty}`);
  });

// ---------------- tag ----------------
program
  .command('tag <slug>')
  .description('set secondary topic tags and/or a custom difficulty rating')
  .option('--secondary <topics>', 'comma-separated topic names ("" to clear)')
  .option('--rating <n>', 'difficulty rating override', Number)
  .action((slug, o) => {
    const secondary = o.secondary === undefined ? undefined : String(o.secondary).split(',').map((s: string) => s.trim()).filter(Boolean);
    tagProblem(db(), slug, { secondaryTopics: secondary, difficultyRating: o.rating });
    const p = getProblem(db(), slug);
    out(p, () => `${p.slug}: ${p.topic} + [${p.secondaryTopics.join(', ')}] · rating ${p.difficultyRating}`);
  });

// ---------------- problem ----------------
program
  .command('problem <slug>')
  .description('show a problem, its files and attempt history')
  .action((slug) => {
    const d = db();
    const p = getProblem(d, slug);
    const files = problemFiles(slug);
    const attempts = listAttempts(d, { slug });
    const open = getOpenAttempt(d, slug);
    out({ problem: p, files, attempts, open: open ?? null, editorUrl: editorUrl(slug) }, () => [
      `${p.title} (${p.slug}) — ${p.topic}${p.secondaryTopics.length ? ` + ${p.secondaryTopics.join(', ')}` : ''}, ${p.difficulty} (${p.difficultyRating})`,
      `Original: ${p.url ?? '-'} · Editor: ${editorUrl(slug)}`,
      `Files: ${rel(files.dir)} — ${files.generated ? 'generated' : 'not generated'}`,
      open ? `Open attempt #${open.id} since ${open.startedAt.slice(0, 16)} UTC, hints ${open.hintsUsed}, tests ${open.testsPassed ?? '-'}/${open.testsTotal ?? '-'}` : 'No open attempt.',
      ...attempts.map(
        (a) =>
          `  #${a.id} ${a.startedAt.slice(0, 10)} ${a.status}${a.isReview ? ' (review)' : ''}` +
          (a.status === 'completed' ? ` outcome ${a.outcomeScore?.toFixed(2)} Δ ${sign(a.ratingDelta ?? 0)}` : ''),
      ),
    ]);
  });

// ---------------- stats ----------------
program
  .command('stats')
  .description('progress summary (ratings, completion, weaknesses, reviews)')
  .action(() => {
    const s = getStats(db(), cfg);
    const { ratingHistory, ...rest } = s;
    out(json() ? s : rest, () => {
      const pc = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);
      const L = [
        `DSA rating ${Math.round(s.overall.rating)} — ${s.overall.label} (7d ${sign(s.overall.trend7d)}, 30d ${sign(s.overall.trend30d)})`,
        `${s.prefs.sheetName}: ${s.completion.solved}/${s.completion.total} solved (${pc(s.completion.solved, s.completion.total)}%) — ` +
          DIFFICULTIES.map((d) => `${d} ${s.completion.byDifficulty[d].solved}/${s.completion.byDifficulty[d].total}`).join(', '),
        `Attempts: ${s.attempts.completed} completed, ${s.attempts.abandoned} abandoned, ${s.attempts.inProgress} open · ` +
          `Weaknesses: ${s.weaknesses.active} active, ${s.weaknesses.improving} improving, ${s.weaknesses.resolved} resolved · ` +
          `Reviews: ${s.reviews.due} due, ${s.reviews.upcoming7d} in next 7d`,
        '',
        'Topic                        Rating  Att  Solved (E/M/H)   Label',
      ];
      for (const t of [...s.topics].sort((a, b) => a.rating - b.rating)) {
        const solved = DIFFICULTIES.map((d) => `${t.solved[d]}/${t.total[d]}`).join(' ');
        L.push(
          `${t.topic.padEnd(28)} ${String(Math.round(t.rating)).padStart(6)}${t.lowConfidence ? '*' : ' '} ${String(t.attempts).padStart(3)}  ${solved.padEnd(15)}  ${t.label}`,
        );
      }
      L.push('* low confidence (< 3 attempts)');
      return L;
    });
  });

// ---------------- sheets ----------------
program
  .command('sheets')
  .description('list available sheets')
  .action(() => {
    const active = getPrefs(db()).sheet;
    const rows = listSheetFiles().map((id) => {
      const s = loadSheet(id);
      return { id, name: s.name, count: s.problems.length, verified: s.verified, active: id === active };
    });
    out(rows, () => rows.map((r) => `${r.active ? '*' : ' '} ${r.id} — ${r.name} (${r.count})${r.verified ? '' : ' UNVERIFIED'}`));
  });

// ---------------- backup ----------------
program
  .command('backup')
  .description('copy the DB to data/backups/prep-<timestamp>.db')
  .action(async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(paths.backups, `prep-${stamp}.db`);
    fs.mkdirSync(paths.backups, { recursive: true });
    await db().backup(file);
    out({ file }, () => `Backed up to ${rel(file)}`);
  });

try {
  await program.parseAsync(process.argv);
} catch (e) {
  const msg = (e as Error).message;
  if (json()) console.log(JSON.stringify({ error: msg }));
  else console.error(`Error: ${msg}`);
  process.exitCode = 1;
} finally {
  (dbHandle as DB | null)?.close();
}
