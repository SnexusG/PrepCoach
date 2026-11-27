import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { Command, Option } from 'commander';
import {
  checkJava,
  tutorConfig,
  sttConfig,
  sttArgs,
  sttPython,
  sttVenvDir,
  STT_PACKAGES,
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
  applyAllProblemMeta,
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
  runProblemTests,
  formatRunResult,
  forecastLine,
  getPreference,
  parseTargetDate,
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

const collect = (v: string, prev: string[]) => [...prev, v];

/** Builds weakness observations from --weaknesses JSON plus the shell-safe flags. */
function weaknessObservations(o: { weaknesses?: string; weakness?: string[]; seen?: string[]; handled?: string[] }): WeaknessObservation[] {
  const obs: WeaknessObservation[] = [];
  if (o.weaknesses) {
    const parsed = parseObjectArg(o.weaknesses, '--weaknesses');
    if (!Array.isArray(parsed)) throw new Error('--weaknesses must be a JSON array');
    obs.push(...parsed);
  }
  for (const w of o.weakness ?? []) {
    const idx = w.indexOf('::');
    if (idx < 0) throw new Error(`--weakness "${w}" must look like "Topic :: description" (use "general :: …" for topic-less)`);
    const topic = w.slice(0, idx).trim();
    obs.push({ description: w.slice(idx + 2).trim(), topic: /^general$/i.test(topic) ? null : topic, kind: 'observed' });
  }
  for (const id of o.seen ?? []) obs.push({ id: Number(id), kind: 'observed' });
  for (const id of o.handled ?? []) obs.push({ id: Number(id), kind: 'handled_well' });
  return obs;
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
    const metaApplied = applyAllProblemMeta(d);
    out({ db: paths.db, sheets: results, metaApplied }, () => [
      `Database ready: ${rel(paths.db)}`,
      ...results.map(
        (r) => `Sheet ${r.id} (${r.name}): ${r.count} problems — ${r.inserted} new, ${r.updated} updated${r.verified ? '' : ' — UNVERIFIED'}`,
      ),
      `Applied problem meta (tags/ratings) for ${metaApplied} problem(s).`,
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
  .command('hint <slug> [level]')
  .description('log a hint level (1 nudge, 2 pattern, 3 approach, 4 full solution); without a level, just show the current level and the cost of the next')
  .action((slug, level) => {
    const open = getOpenAttempt(db(), slug);
    if (!open) throw new Error(`No attempt in progress for "${slug}".`);
    const lvl = level === undefined ? open.hintsUsed : recordHint(db(), cfg, slug, Number(level));
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
  .description('compile and run Solution.java against tests.json (saves .results.json and updates the open attempt)')
  .option('--solution <file>', 'run this file as Solution.java instead (verify tests against a private reference; nothing is saved)')
  .action(async (slug, o) => {
    const r = await runProblemTests(db(), cfg, slug, { solutionFile: o.solution });
    out(r, () => formatRunResult(r));
    if (!r.allPassed) process.exitCode = 2;
  });

// ---------------- scaffold ----------------
program
  .command('scaffold <slug>')
  .description('create problems/<slug>/ with notes.md (and Node.java for graph/random-pointer problems)')
  .option('--node <kind>', 'graph | random — copy the matching Node class template')
  .action((slug, o) => {
    const p = getProblem(db(), slug);
    const files = problemFiles(slug);
    fs.mkdirSync(files.dir, { recursive: true });
    if (!fs.existsSync(files.notes)) {
      fs.writeFileSync(files.notes, `# ${p.title} — notes\n\nTopic: ${p.topic} · Difficulty: ${p.difficulty} · ${p.url ?? ''}\n\n`);
    }
    if (o.node) {
      const tpl = { graph: 'GraphNode.java', random: 'RandomNode.java' }[o.node as string];
      if (!tpl) throw new Error('--node must be graph or random');
      fs.copyFileSync(path.join(paths.harness, 'templates', tpl), path.join(files.dir, 'Node.java'));
    }
    const missing = (['problemMd', 'solution', 'tests'] as const).filter((k) => !fs.existsSync(files[k])).map((k) => rel(files[k]));
    out({ dir: files.dir, missing }, () => [
      `Scaffolded ${rel(files.dir)}`,
      missing.length ? `Still to write: ${missing.join(', ')}` : 'All problem files present.',
    ]);
  });

// ---------------- record-attempt ----------------
program
  .command('record-attempt <slug>')
  .description('record a finished attempt: computes outcome + Elo, updates weaknesses and the review queue')
  .requiredOption('--rubric <json>', 'optimality, approach, codeQuality, communication [, independence, correctness] in 0..1 (JSON, @file, or k=v,k=v)')
  .option('--hints <n>', 'hint level used (defaults to the logged level)', Number)
  .option('--weaknesses <json>', 'JSON array of {id?|description, topic?, kind?: observed|handled_well}')
  .option('--weakness <"Topic :: description">', 'new or re-observed weakness by description (repeatable; topic "general" = none)', collect, [])
  .option('--seen <id>', 'existing weakness observed again (repeatable)', collect, [])
  .option('--handled <id>', 'existing weakness handled well this time (repeatable)', collect, [])
  .option('--summary <text>', 'one-paragraph tutor summary')
  .option('--tests-passed <n>', 'override tests passed (defaults to latest run)', Number)
  .option('--tests-total <n>', 'override tests total (defaults to latest run)', Number)
  .action((slug, o) => {
    const rubric = parseObjectArg(o.rubric, '--rubric') as Rubric;
    for (const k of ['optimality', 'approach', 'codeQuality', 'communication'] as const) {
      if (typeof rubric[k] !== 'number') throw new Error(`--rubric is missing numeric "${k}"`);
    }
    const weaknesses = weaknessObservations(o);
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
          ` · tests ${r.testsPassed}/${r.testsTotal} · ${mmss(r.activeTimeSec)} active` +
          (r.solveTimeSec - r.activeTimeSec > 600 ? ` (${mmss(r.solveTimeSec)} since start)` : ''),
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
    const a = abandonAttempt(db(), cfg, slug, { summary: o.summary });
    out(a, () => `Abandoned attempt #${a.id} on ${slug} after ${mmss(a.activeTimeSec)} active. No rating change; it stays unsolved and will be offered again in a later session.`);
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
  .option('--weaknesses <json>', 'JSON array, same format as record-attempt')
  .option('--weakness <"Topic :: description">', 'repeatable', collect, [])
  .option('--seen <id>', 'repeatable', collect, [])
  .option('--handled <id>', 'repeatable', collect, [])
  .action((o) => {
    const obs = weaknessObservations(o);
    if (!obs.length) throw new Error('Nothing to record');
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
  .option('--target-date <YYYY-MM-DD>', 'goal date for finishing the sheet ("none" clears it)')
  .action((o) => {
    const d = db();
    if (o.sheet) {
      const sheet = loadSheet(o.sheet);
      importSheet(d, cfg, sheet);
      setPreference(d, 'active_sheet', o.sheet);
    }
    if (o.difficulty) setPreference(d, 'difficulty', o.difficulty);
    if (o.targetDate !== undefined) setPreference(d, 'target_date', parseTargetDate(o.targetDate) ?? '');
    const p = getPrefs(d);
    const targetDate = getPreference(d, 'target_date') || null;
    out({ ...p, targetDate }, () => `Sheet: ${p.sheetName} (${p.sheet}) · difficulty: ${p.difficulty} · target date: ${targetDate ?? 'none'}`);
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
        `Forecast: ${forecastLine(s.forecast)}`,
        `Average active time: ` +
          DIFFICULTIES.map((d) => `${d} ${s.activeTime[d].avgMinutes == null ? '-' : `${s.activeTime[d].avgMinutes} min`}`).join(', '),
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

// ---------------- doctor ----------------
program
  .command('doctor')
  .description('check prerequisites: Node, JDK (javac/java 17+), the claude CLI, the database and the voice model')
  .action(async () => {
    const checks: { name: string; ok: boolean; detail: string; fix?: string }[] = [];
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    checks.push({ name: 'Node.js', ok: nodeMajor >= 20, detail: `v${process.versions.node}`, fix: 'Install Node.js 20 or newer' });

    const java = await checkJava();
    const javaMajor = Number(/(?:javac\s+)?(\d+)(?:\.\d+)*/.exec(java.version ?? '')?.[1] ?? 0);
    checks.push({
      name: 'JDK (javac)',
      ok: java.ok && javaMajor >= 17,
      detail: java.ok ? java.version! : 'not found',
      fix: 'Install a JDK 17+ and put it on PATH (or set JAVA_HOME)',
    });

    const tc = tutorConfig(cfg);
    const claudeBin = process.env.PREP_CLAUDE_BIN || tc.claudeBin;
    try {
      const v = execFileSync(claudeBin, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();
      checks.push({ name: 'Claude Code CLI', ok: true, detail: v });
    } catch {
      checks.push({ name: 'Claude Code CLI', ok: false, detail: `"${claudeBin}" not found`, fix: 'Install Claude Code and run `claude` once to log in (needed for the voice tutor)' });
    }

    const dbExists = fs.existsSync(paths.db);
    let dbDetail = dbExists ? rel(paths.db) : 'missing';
    if (dbExists) {
      const n = (db().prepare('SELECT COUNT(*) AS n FROM problems').get() as { n: number }).n;
      dbDetail += ` · ${n} problems in catalog`;
    }
    checks.push({ name: 'Database', ok: dbExists, detail: dbDetail, fix: 'Run `npx prep init`' });

    const modelDir = path.join(paths.root, 'data', 'models', 'onnx-community', 'Kokoro-82M-v1.0-ONNX');
    const cached = fs.existsSync(modelDir);
    checks.push({
      name: 'Voice model (Kokoro)',
      ok: true,
      detail: tc.tts === 'browser' ? 'disabled (tutor.tts = "browser")' : cached ? 'cached in data/models/' : 'not downloaded yet — fetched automatically (~310 MB) on first `npm run dev`',
    });

    const sc = sttConfig(cfg);
    if (sc.engine === 'browser') {
      checks.push({ name: 'Speech recognition', ok: true, detail: 'browser built-in (stt.engine = "browser")' });
    } else {
      const py = sttPython(paths.root, sc);
      const probe = spawnSync(py, ['-c', 'import faster_whisper, ctranslate2; print(ctranslate2.get_cuda_device_count())'], {
        encoding: 'utf8',
        timeout: 60000,
        windowsHide: true,
      });
      const gpus = Number(probe.stdout?.trim());
      const whisperDir = path.join(paths.root, 'data', 'models', 'whisper');
      const modelCached = fs.existsSync(whisperDir) && fs.readdirSync(whisperDir).some((d) => d.includes(sc.model));
      checks.push({
        name: 'Speech recognition',
        ok: probe.status === 0,
        detail:
          probe.status === 0
            ? `Whisper ${sc.model} · ${gpus > 0 ? `CUDA GPU found` : `no CUDA GPU → CPU with ${sc.cpuModel}`} · model ${modelCached ? 'cached' : 'not downloaded yet'}`
            : `faster-whisper not installed for ${py} (voice mode falls back to the browser)`,
        fix: 'Run `npx prep stt-setup`',
      });
    }

    out({ ok: checks.every((c) => c.ok), checks }, () => [
      ...checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name.padEnd(22)} ${c.detail}${!c.ok && c.fix ? `\n    → ${c.fix}` : ''}`),
      '',
      checks.every((c) => c.ok) ? 'All good — start with `npm run dev`.' : 'Fix the ✗ items above, then run `npx prep doctor` again.',
    ]);
    if (!checks.every((c) => c.ok)) process.exitCode = 1;
  });

// ---------------- stt-setup ----------------
program
  .command('stt-setup')
  .description('install local Whisper speech recognition: a Python venv in data/stt/, faster-whisper + CUDA libraries, and the model')
  .option('--python <exe>', 'Python 3.9+ used to create the venv', process.platform === 'win32' ? 'python' : 'python3')
  .option('--skip-model', 'install packages only; the model downloads on the next `npm run dev`')
  .action((o) => {
    const sc = sttConfig(cfg);
    const venv = sttVenvDir(paths.root);
    const run = (exe: string, args: string[], what: string) => {
      console.log(`→ ${what}`);
      const r = spawnSync(exe, args, { stdio: 'inherit', windowsHide: true });
      if (r.status !== 0) throw new Error(`${what} failed${r.error ? `: ${r.error.message}` : ` (exit ${r.status})`}`);
    };
    if (sc.python) console.log(`Note: stt.python is set to ${sc.python}; the server will use that interpreter, not this venv.`);
    if (!fs.existsSync(venv)) run(o.python, ['-m', 'venv', venv], `creating ${rel(venv)}`);
    const py = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    run(py, ['-m', 'pip', 'install', '--upgrade', 'pip'], 'upgrading pip');
    const pkgs = process.platform === 'darwin' ? ['faster-whisper'] : STT_PACKAGES;
    run(py, ['-m', 'pip', 'install', ...pkgs], `installing ${pkgs.join(', ')} (CUDA libraries are large)`);
    if (o.skipModel) return console.log('Done. The model downloads the next time the server starts.');
    console.log(`→ downloading and loading ${sc.model} (first time ≈1.6 GB) …`);
    const check = spawnSync(py, sttArgs(paths.root, { ...sc, python: py }, ['--check']), {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, HF_HUB_DISABLE_SYMLINKS_WARNING: '1' },
    });
    const ready = check.stdout
      .split('\n')
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .find((m) => m?.type === 'ready' || m?.type === 'fatal');
    if (ready?.type !== 'ready') throw new Error(`Whisper failed to load: ${ready?.error ?? check.stderr.trim().split('\n').slice(-3).join(' ')}`);
    console.log(`✓ Whisper ready: ${ready.model} on ${ready.device} (${ready.computeType}). Restart \`npm run dev\` to use it.`);
  });

// ---------------- ref-clean ----------------
program
  .command('ref-clean')
  .description('delete private reference solutions (the OS temp dir prepcoach-ref/, used to verify generated tests)')
  .action(() => {
    const dir = path.join(os.tmpdir(), 'prepcoach-ref');
    const existed = fs.existsSync(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    out({ dir, deleted: existed }, () => (existed ? `Deleted ${dir}` : `Nothing to delete (${dir})`));
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
