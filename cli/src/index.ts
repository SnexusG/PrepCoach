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
  pruneReviewQueue,
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
  getAttempt,
  loadGame,
  gameSummary,
  rewardsSince,
  rewardLine,
  mergeWeaknesses,
  focusWeakness,
  recordDrill,
  parseArea,
  WEAKNESS_AREAS,
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

/**
 * Builds weakness observations from --weaknesses JSON plus the shell-safe flags:
 *   --weakness "area[/Topic] :: general description [:: the specific slip]"   (old style "Topic :: description" still works)
 *   --seen "ID[: the specific slip]"   --handled "ID[: what they did right]"
 */
function weaknessObservations(o: { weaknesses?: string; weakness?: string[]; seen?: string[]; handled?: string[]; probe?: string[] }): WeaknessObservation[] {
  const obs: WeaknessObservation[] = [];
  if (o.weaknesses) {
    const parsed = parseObjectArg(o.weaknesses, '--weaknesses');
    if (!Array.isArray(parsed)) throw new Error('--weaknesses must be a JSON array');
    obs.push(...parsed);
  }
  for (const w of o.weakness ?? []) {
    const parts = w.split('::').map((x) => x.trim());
    if (parts.length < 2 || !parts[1]) {
      throw new Error(`--weakness "${w}" must look like "area[/Topic] :: general description [:: specific slip]" (areas: ${Object.keys(WEAKNESS_AREAS).join(', ')})`);
    }
    const [head, description, note] = parts;
    const [first, topicPart] = head.split('/').map((x) => x.trim());
    const area = parseArea(first);
    const topic = area ? topicPart || null : /^general$/i.test(first) ? null : first; // old style: head is the topic
    obs.push({ description, topic, area, note: note || null, kind: 'observed' });
  }
  const idNote = (v: string, flag: string) => {
    const m = /^\s*#?(\d+)\s*(?::\s*([\s\S]*))?$/.exec(v);
    if (!m) throw new Error(`${flag} "${v}" must look like "ID" or "ID: what happened"`);
    return { id: Number(m[1]), note: m[2]?.trim() || null };
  };
  for (const v of o.seen ?? []) obs.push({ ...idNote(v, '--seen'), kind: 'observed' });
  for (const v of o.handled ?? []) obs.push({ ...idNote(v, '--handled'), kind: 'handled_well' });
  for (const v of o.probe ?? []) {
    const id = Number(String(v).replace(/^#/, ''));
    const hit = obs.find((x) => x.id === id);
    if (!hit) throw new Error(`--probe ${v} needs the outcome too: --handled "${id}: …" or --seen "${id}: …"`);
    hit.probed = true;
  }
  return obs;
}

const requireArea = (v: string) => {
  if (/^(none|null)$/i.test(v)) return null;
  const a = parseArea(v);
  if (!a) throw new Error(`Unknown area "${v}". Areas: ${Object.keys(WEAKNESS_AREAS).join(', ')}`);
  return a;
};

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
    const probe = focusWeakness(d, problem.track, 'probe');
    out({ attempt, resumed, problem, files, editorUrl: editorUrl(slug), probe }, () => [
      `${resumed ? 'Resumed' : 'Started'} attempt #${attempt.id}: ${problem.title} (${problem.topic}, ${problem.difficulty}, rating ${problem.difficultyRating})${attempt.isReview ? ' — REVIEW' : ''}`,
      `Timer started at ${attempt.startedAt.slice(11, 19)} UTC · hints used ${attempt.hintsUsed}`,
      `Editor: ${editorUrl(slug)}`,
      `Files: ${rel(files.dir)} — ${files.generated ? 'generated' : 'NOT generated yet: write Problem.md, Solution.java, tests.json'}`,
      probe
        ? `Probe this attempt: #${probe.weakness.id} [${probe.weakness.area ?? 'no area'}] ${probe.weakness.description} (${probe.reason}) — ` +
          'if this problem can\'t test it, pick another active weakness it can, or skip'
        : 'Probe this attempt: no active weaknesses',
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
  .option('--weakness <"area[/Topic] :: general description :: specific slip">', 'new general weakness, with this attempt\'s slip as the note (repeatable)', collect, [])
  .option('--seen <"ID: slip">', 'existing weakness observed again, with what happened (repeatable)', collect, [])
  .option('--handled <"ID: what went right">', 'existing weakness handled well this time (repeatable)', collect, [])
  .option('--probe <id>', 'the weakness you tested on purpose this attempt (also pass its --handled or --seen)', collect, [])
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
    // What this attempt unlocked (streak, badges, quests, level-up, personal bests): celebrated by the tutor.
    const finishedAt = getAttempt(db(), r.attemptId).finishedAt!;
    const game = loadGame(db(), cfg);
    const rewards = rewardsSince(db(), game.history, game.state, cfg, new Date(Date.parse(finishedAt) - 1).toISOString(), new Date());
    out({ ...r, rewards }, () => {
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
      if (r.review.action === 'scheduled' && r.review.state) {
        L.push(
          `Review on ${r.review.state.dueDate} (in ${r.review.state.intervalDays}d)` +
            (r.review.reasons.length ? ` — struggled: ${r.review.reasons.join(', ')}` : ` — clean review ${r.review.cleanStreak}, more needed to graduate`),
        );
      } else if (r.review.action === 'graduated') {
        L.push('Solved cleanly — taken out of the review queue.');
      } else {
        L.push('Clean solve — no review scheduled.');
      }
      for (const w of r.weaknesses) {
        L.push(`Weakness #${w.id} "${w.description}": ${w.action} → ${w.status} (seen ${w.timesObserved}×, clean ${w.cleanDemonstrations}×)`);
      }
      const line = rewardLine(rewards);
      if (line) L.push(`Rewards: ${line}`);
      return L;
    });
  });

// ---------------- game ----------------
program
  .command('game')
  .description('streak, quests, badges and personal bests (derived from history; Elo is unaffected)')
  .action(() => {
    const g = loadGame(db(), cfg);
    const s = g.state;
    const sum = gameSummary(g);
    out({ summary: sum, ...s, heatmap: undefined }, () => {
      const L = [
        `Streak ${sum.streak} (longest ${sum.longestStreak})${sum.freezes ? ` · ${sum.freezes} freeze(s) banked` : ''}${sum.activeToday ? ' · active today' : ' · nothing yet today'}`,
        'Quests:',
        ...[...s.quests.daily, ...s.quests.weekly].map((q) => `  ${q.done ? '✓' : '·'} ${q.title} (${q.progress}/${q.goal})`),
        `Badges ${sum.badges}/${sum.badgesTotal}:`,
        ...s.achievements.map(
          (a) => `  ${a.unlockedAt ? a.icon : '🔒'} ${a.name} — ${a.description}${a.unlockedAt ? ` (${a.unlockedAt.slice(0, 10)})` : a.progress ? ` [${a.progress[0]}/${a.progress[1]}]` : ''}`,
        ),
        'Personal bests:',
        ...DIFFICULTIES.map((d) => {
          const b = s.bests.fastest[d];
          return `  fastest ${d}: ${b ? `${Math.round(b.activeSec / 60)} min (${b.title})` : '—'}`;
        }),
        `  best score: ${s.bests.bestOutcome ? `${s.bests.bestOutcome.outcome.toFixed(2)} (${s.bests.bestOutcome.title})` : '—'}`,
        `Levels: ${s.levels.map((l) => `${l.label}${l.reachedAt ? ` ✓ ${l.reachedAt.slice(0, 10)}` : ''}`).join(' → ')}`,
      ];
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
            `#${w.id} [${w.area ?? 'no area'}${w.topic ? ` · ${w.topic}` : ''}] ${w.description} — ${w.status}, seen ${w.timesObserved}×, clean ${w.cleanDemonstrations}×, last ${w.lastSeen.slice(0, 10)}`,
            ...w.examples.map((e) => `    ${e.kind === 'observed' ? 'seen' : 'handled well'} on ${e.slug} (${e.date.slice(0, 10)})${e.note ? `: ${e.note}` : ''}`),
          ])
        : 'No weaknesses logged.',
    );
  });
weakness
  .command('update <id>')
  .option('--status <status>', 'active | improving | resolved')
  .option('--description <text>', 'reword the weakness')
  .option('--generalize', 'with --description: keep the old (specific) wording as the note on past observations')
  .option('--area <area>', `set the area (${Object.keys(WEAKNESS_AREAS).join(', ')})`)
  .option('--topic <topic>', 'tie it to a DSA topic ("none" = not topic-bound)')
  .action((id, o) => {
    if (o.status && !['active', 'improving', 'resolved'].includes(o.status)) throw new Error('Bad --status');
    const area = o.area === undefined ? undefined : requireArea(o.area);
    const topic = o.topic === undefined ? undefined : /^(none|general)$/i.test(o.topic) ? null : o.topic;
    const w = updateWeakness(db(), Number(id), { status: o.status, description: o.description, area, topic, generalize: o.generalize });
    out(w, () => `#${w.id} [${w.area ?? 'no area'}] ${w.description} — ${w.status}`);
  });
weakness
  .command('merge <ids...>')
  .description('merge weaknesses into one general weakness (observations, counts and old wording as notes move over)')
  .requiredOption('--into <id>', 'the weakness to keep')
  .option('--description <text>', 'reword the kept weakness')
  .option('--area <area>', `set its area (${Object.keys(WEAKNESS_AREAS).join(', ')})`)
  .action((ids: string[], o) => {
    const w = mergeWeaknesses(db(), ids.map(Number), Number(o.into), {
      description: o.description,
      area: o.area === undefined ? undefined : requireArea(o.area),
    });
    out(w, () => `Merged into #${w.id} [${w.area ?? 'no area'}] ${w.description} — ${w.status}, seen ${w.timesObserved}×`);
  });
weakness
  .command('focus')
  .description('which weakness to work on next (rotates so each gets attention)')
  .option('--drill', 'for a drill instead of probing on a problem')
  .option('--area <area>', 'only weaknesses in this area')
  .option('--exclude <id>', 'skip this weakness (repeatable)', collect, [])
  .action((o) => {
    const f = focusWeakness(db(), getPrefs(db()).track, o.drill ? 'drill' : 'probe', {
      area: o.area ? requireArea(o.area) ?? undefined : undefined,
      exclude: (o.exclude as string[]).map(Number),
    });
    out(f, () =>
      f
        ? `#${f.weakness.id} [${f.weakness.area ?? 'no area'}] ${f.weakness.description} — ${f.weakness.status}, seen ${f.weakness.timesObserved}× (${f.reason})`
        : 'No active or improving weaknesses.',
    );
  });
weakness
  .command('areas')
  .description('the areas a weakness can belong to')
  .action(() => out(WEAKNESS_AREAS, () => Object.entries(WEAKNESS_AREAS).map(([k, v]) => `${k.padEnd(15)} ${v}`)));
weakness
  .command('observe')
  .description('log an observation outside of record-attempt (e.g. during a discussion)')
  .option('--weaknesses <json>', 'JSON array, same format as record-attempt')
  .option('--weakness <"area[/Topic] :: general description :: specific slip">', 'repeatable', collect, [])
  .option('--seen <"ID: slip">', 'repeatable', collect, [])
  .option('--handled <"ID: what went right">', 'repeatable', collect, [])
  .action((o) => {
    const obs = weaknessObservations(o);
    if (!obs.length) throw new Error('Nothing to record');
    const d = db();
    const changes = d.transaction(() => applyWeaknessObservations(d, cfg, getPrefs(d).track, null, obs))();
    out(changes, () => changes.map((w) => `#${w.id} "${w.description}": ${w.action} → ${w.status}`));
  });

// ---------------- drill ----------------
const drill = program.command('drill').description('short practice drills on a weakness');
drill
  .command('record <weaknessId>')
  .description('record a drill result (practice only: it does not change the weakness status)')
  .requiredOption('--score <correct/total>', 'e.g. 4/5')
  .option('--note <text>', 'what they missed (or "all correct")')
  .action((id, o) => {
    const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(o.score));
    if (!m) throw new Error('--score must look like 4/5');
    const d = db();
    const r = recordDrill(d, Number(String(id).replace(/^#/, '')), {
      correct: Number(m[1]),
      total: Number(m[2]),
      note: o.note,
      sessionId: activeSession(d)?.id ?? null,
    });
    out(r, () => `Drill on #${r.weaknessId}: ${r.correct}/${r.total}${r.note ? ` — ${r.note}` : ''}`);
  });

// ---------------- reviews ----------------
program
  .command('reviews')
  .description('spaced-repetition queue')
  .option('--all', 'show the whole queue, not just due + next 7 days')
  .option('--prune', 'remove problems you solved cleanly (judged by their latest attempt); only struggles stay queued')
  .option('--dry-run', 'with --prune: show what would be removed without changing anything')
  .action((o) => {
    if (o.prune) {
      const r = pruneReviewQueue(db(), cfg, { dryRun: o.dryRun });
      return out(r, () => [
        `${o.dryRun ? 'Would remove' : 'Removed'} ${r.removed.length} clean solve(s)${r.removed.length ? `: ${r.removed.map((x) => x.slug).join(', ')}` : ''}.`,
        r.kept.length ? `Kept ${r.kept.length}:` : 'Nothing you struggled with is queued.',
        ...r.kept.map((k) => `  ${k.slug} — ${k.reasons.join(', ')}`),
      ]);
    }
    const rows = listReviews(db(), new Date(), o.all ? {} : { withinDays: 7 });
    out(rows, () =>
      rows.length
        ? rows.map(
            (r) =>
              `${r.due ? 'DUE ' : '    '}${r.dueDate}  ${r.slug} (${r.topic}, ${r.difficulty}) · interval ${r.intervalDays}d · last ${r.lastOutcome.toFixed(2)} · reviews ${r.reviewsCount}` +
                (r.reason ? ` · why: ${r.reason}` : ''),
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
