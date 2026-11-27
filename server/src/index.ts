import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  activeSession,
  attemptDetail,
  confidenceWeight,
  getStats,
  listAttempts,
  listReviews,
  weaknessesWithExamples,
  getOpenAttempt,
  getPreference,
  getProblem,
  liveActiveTime,
  parseTargetDate,
  recordActivity,
  setPreference,
  loadConfig,
  openDb,
  paths,
  problemFiles,
  readLastResults,
  runProblemTests,
  sttConfig,
  drillConfig,
  finishDrillSet,
  getDrillSet,
  gradeLocally,
  publicDrillSet,
  saveDrillAnswer,
  focusWeakness,
  getPrefs,
  tutorConfig,
  type AttemptRow,
} from '@prepcoach/core';
import { TutorBridge, type TutorEvent } from './tutor';
import { buildPrompt, Stt } from './stt';
import { DrillService } from './drills';
import { Tts } from './tts';

// The server only reads state and runs tests through the shared core library — the same code the CLI uses.
const cfg = loadConfig();
const db = openDb();
const app = express();
app.use(express.json({ limit: '2mb' }));

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Validates the slug and that the problem exists in the catalog (throws 404 otherwise). */
function problemFor(slug: string) {
  if (!SLUG.test(slug)) throw httpError(400, 'Invalid slug');
  try {
    return getProblem(db, slug);
  } catch {
    throw httpError(404, `Unknown problem "${slug}"`);
  }
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

const mtimeOf = (file: string) => (fs.existsSync(file) ? fs.statSync(file).mtimeMs : null);
const readIf = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

function lastAttempt(slug: string): (AttemptRow & { lastActivityAt?: string }) | null {
  const open = getOpenAttempt(db, slug);
  if (open) return { ...open, ...liveActiveTime(db, cfg, open.id, open.startedAt) };
  const r = db
    .prepare(
      `SELECT id, status, is_review AS isReview, started_at AS startedAt, finished_at AS finishedAt,
              solve_time_sec AS solveTimeSec, active_time_sec AS activeTimeSec, hints_used AS hintsUsed,
              outcome_score AS outcomeScore
       FROM attempts WHERE problem_slug = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(slug) as any;
  return r ? { ...r, isReview: !!r.isReview } : null;
}

/** Last Solution.java mtime seen per problem: a change made outside the web editor (an IDE) counts as activity. */
const seenMtime = new Map<string, number | null>();

/** Cheap, poll-friendly state: what the editor needs to pick up external edits, hint changes and CLI test runs. */
function problemState(slug: string) {
  const files = problemFiles(slug);
  const mtime = mtimeOf(files.solution);
  if (seenMtime.has(slug) && mtime != null && mtime !== seenMtime.get(slug)) recordActivity(db, slug, 'edit', new Date(mtime));
  seenMtime.set(slug, mtime);
  return {
    solutionMtime: mtime,
    resultsMtime: mtimeOf(files.results),
    attempt: lastAttempt(slug),
    serverTime: new Date().toISOString(),
  };
}

const wrap =
  (fn: (req: Request, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/meta', (_req, res) => {
  res.json({
    hintNames: cfg.rating.hintNames,
    hintCaps: cfg.rating.hintCaps,
    perTestTimeoutMs: cfg.runner.perTestTimeoutMs,
    idleGapMin: cfg.forecast.idleGapMin,
  });
});

/** Problems that have files on disk (for the temporary index page; the dashboard comes in phase 6). */
app.get('/api/problems', (_req, res) => {
  const slugs = fs.existsSync(paths.problems) ? fs.readdirSync(paths.problems) : [];
  const list = slugs
    .filter((s) => SLUG.test(s) && problemFiles(s).generated)
    .flatMap((s) => {
      try {
        const p = getProblem(db, s);
        return [{ slug: s, title: p.title, topic: p.topic, difficulty: p.difficulty, attempt: lastAttempt(s) }];
      } catch {
        return [];
      }
    });
  res.json(list);
});

app.get('/api/problems/:slug', (req, res) => {
  const { slug } = req.params;
  const problem = problemFor(slug);
  const files = problemFiles(slug);
  res.json({
    problem,
    generated: files.generated,
    statement: readIf(files.problemMd),
    solution: readIf(files.solution),
    lastResults: readLastResults(slug),
    ...problemState(slug),
  });
});

app.get('/api/problems/:slug/state', (req, res) => {
  problemFor(req.params.slug);
  res.json(problemState(req.params.slug));
});

app.get('/api/problems/:slug/solution', (req, res) => {
  problemFor(req.params.slug);
  const f = problemFiles(req.params.slug).solution;
  res.json({ code: readIf(f), mtime: mtimeOf(f) });
});

app.get('/api/problems/:slug/results', (req, res) => {
  problemFor(req.params.slug);
  res.json({ results: readLastResults(req.params.slug), resultsMtime: mtimeOf(problemFiles(req.params.slug).results) });
});

/**
 * Save Solution.java. `baseMtime` is the mtime the editor last saw; if the file changed on disk since
 * (edited in the IDE), the save is refused with 409 unless `force` is set, so external edits are never clobbered.
 */
app.put('/api/problems/:slug/solution', (req, res) => {
  const { slug } = req.params;
  problemFor(slug);
  const { code, baseMtime, force } = req.body ?? {};
  if (typeof code !== 'string') throw httpError(400, 'Body must include "code" (string)');
  const files = problemFiles(slug);
  if (!fs.existsSync(files.dir)) throw httpError(404, 'Problem files not generated yet');
  const current = mtimeOf(files.solution);
  if (!force && current !== null && baseMtime != null && current !== baseMtime) {
    return res.status(409).json({ error: 'Solution.java changed on disk', code: readIf(files.solution), mtime: current });
  }
  fs.writeFileSync(files.solution, code);
  recordActivity(db, slug, 'edit');
  const mtime = mtimeOf(files.solution);
  seenMtime.set(slug, mtime);
  res.json({ mtime });
});

/** Heartbeat from the problem page while it is visible and the user is interacting with it. */
app.post('/api/problems/:slug/activity', (req, res) => {
  problemFor(req.params.slug);
  res.json({ recorded: recordActivity(db, req.params.slug, 'focus') });
});

const running = new Set<string>();

app.post(
  '/api/problems/:slug/run',
  wrap(async (req, res) => {
    const { slug } = req.params;
    problemFor(slug);
    if (running.has(slug)) throw httpError(409, 'Tests are already running for this problem');
    running.add(slug);
    try {
      const result = await runProblemTests(db, cfg, slug);
      res.json({ result, ...problemState(slug) });
    } finally {
      running.delete(slug);
    }
  }),
);

// ---------------- dashboard & history ----------------

/** Everything the dashboard shows, in one call (cheap: a handful of indexed SQLite queries). */
app.get('/api/dashboard', (_req, res) => {
  const stats = getStats(db, cfg);
  const tracks = db.prepare('SELECT id, name, enabled FROM tracks ORDER BY rowid').all() as { id: string; name: string; enabled: number }[];
  res.json({
    stats: {
      ...stats,
      topics: stats.topics.map((t) => ({ ...t, confidence: Math.round(confidenceWeight(t.attempts, cfg) * 100) / 100 })),
    },
    initialRating: cfg.rating.initial,
    labels: cfg.rating.labels,
    weaknesses: weaknessesWithExamples(db, stats.track, ['active', 'improving']),
    reviews: listReviews(db, new Date(), { withinDays: 7 }),
    recent: listAttempts(db, { track: stats.track, limit: 8, cfg }),
    session: activeSession(db) ?? null,
    tracks: tracks.map((t) => ({ ...t, enabled: !!t.enabled })),
  });
});

app.get('/api/attempts', (_req, res) => {
  res.json(listAttempts(db, { track: 'dsa', cfg }));
});

/** Goal date for finishing the active sheet: { date: "YYYY-MM-DD" | null }. */
app.put('/api/preferences/target-date', (req, res) => {
  const raw = req.body?.date ?? null;
  if (raw !== null && typeof raw !== 'string') throw httpError(400, '"date" must be a YYYY-MM-DD string or null');
  let date: string | null;
  try {
    date = parseTargetDate(raw);
  } catch (e) {
    throw httpError(400, (e as Error).message);
  }
  setPreference(db, 'target_date', date ?? '');
  res.json({ date: getPreference(db, 'target_date') || null });
});

app.get('/api/attempts/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'Invalid attempt id');
  let detail;
  try {
    detail = attemptDetail(db, id, cfg);
  } catch {
    throw httpError(404, `Attempt #${id} not found`);
  }
  const files = problemFiles(detail.slug);
  res.json({ ...detail, notes: readIf(files.notes), solution: readIf(files.solution) });
});

// ---------------- voice tutor (headless Claude Code) ----------------
const tutor = new TutorBridge(tutorConfig(cfg), paths.root, path.join(paths.root, 'data', 'tutor'), {
  titleOf: (slug) => getProblem(db, slug).title,
});
tutor.adoptScope(
  (db.prepare(`SELECT problem_slug AS slug FROM attempts WHERE status = 'in_progress' ORDER BY id DESC LIMIT 1`).get() as { slug: string } | undefined)?.slug ??
    null,
);

/** Server-sent events: a snapshot on connect, then every tutor event. */
app.get('/api/tutor/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  send({ type: 'snapshot', ...tutor.snapshot() });
  const onEvent = (e: TutorEvent) => send(e);
  tutor.on('event', onEvent);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    tutor.off('event', onEvent);
  });
});

app.post('/api/tutor/message', (req, res) => {
  const { text, clientId } = req.body ?? {};
  if (typeof text !== 'string' || !text.trim()) throw httpError(400, 'Body must include "text"');
  if (text.length > 8000) throw httpError(400, 'Message too long');
  tutor.send(text, typeof clientId === 'string' ? clientId : undefined);
  recordActivity(db, null, 'tutor'); // talking the problem through with the tutor is work on the open attempt
  res.json({ ok: true });
});

app.post('/api/tutor/interrupt', (_req, res) => {
  tutor.interrupt();
  res.json({ ok: true });
});

app.post('/api/tutor/reset', (_req, res) => {
  tutor.reset();
  res.json({ ok: true });
});

/** The problem with an in-progress attempt, if any (the voice UI opens it). */
app.get('/api/current', (_req, res) => {
  const r = db
    .prepare(`SELECT problem_slug AS slug FROM attempts WHERE status = 'in_progress' ORDER BY id DESC LIMIT 1`)
    .get() as { slug: string } | undefined;
  res.json({ slug: r?.slug ?? null });
});

// ---------------- neural text-to-speech (Kokoro, local) ----------------
const tts = new Tts(path.join(paths.root, 'data', 'models'), tutorConfig(cfg).ttsDtype);
// Warm the model in the background so the first reply isn't delayed (first run downloads it).
if (tutorConfig(cfg).tts === 'kokoro') tts.load().catch((e) => console.error('Kokoro TTS failed to load:', e.message));

app.get('/api/tts/status', (_req, res) => res.json(tts.status()));

app.post(
  '/api/tts',
  wrap(async (req, res) => {
    const { text, voice, speed } = req.body ?? {};
    if (typeof text !== 'string' || !text.trim()) throw httpError(400, 'Body must include "text"');
    if (text.length > 1000) throw httpError(400, 'Text too long — send one sentence at a time');
    let gone = false;
    res.on('close', () => (gone = !res.writableFinished));
    const wav = await tts.synthesize(text.trim(), String(voice ?? ''), Number(speed ?? 1), () => gone);
    if (!wav || gone) return void res.end();
    res.set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' }).send(wav);
  }),
);

// ---------------- drill page (generated questions on a weakness) ----------------
const drills = new DrillService(db, drillConfig(cfg), tutorConfig(cfg), () => getPrefs(db).track);
setTimeout(() => drills.prepareNext(), 15_000); // have the suggested drill ready before it's needed

/** Weaknesses you can drill, the suggested one, and whether a drill is ready for each. */
app.get('/api/drills', (_req, res) => {
  const track = getPrefs(db).track;
  const focus = focusWeakness(db, track, 'drill');
  const list = weaknessesWithExamples(db, track, ['active', 'improving']).map((w) => ({
    id: w.id,
    area: w.area,
    description: w.description,
    status: w.status,
    timesObserved: w.timesObserved,
    lastDrill: w.drills[0] ?? null,
    ...drills.status(w.id),
  }));
  res.json({ suggested: focus?.weakness.id ?? null, weaknesses: list });
});

/** Start (or resume) a drill on a weakness; waits for generation if nothing is ready yet. */
app.post(
  '/api/drills/start',
  wrap(async (req, res) => {
    const id = Number(req.body?.weaknessId);
    if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'Body must include "weaknessId"');
    try {
      res.json(publicDrillSet(await drills.ensure(id)));
    } catch (e) {
      throw httpError(502, `Couldn't prepare the drill: ${(e as Error).message}`);
    }
  }),
);

app.get('/api/drills/:id', (req, res) => {
  try {
    res.json(publicDrillSet(getDrillSet(db, Number(req.params.id))));
  } catch {
    throw httpError(404, 'Drill not found');
  }
});

/** Answer one question: multiple choice / spot-the-bug / exact matches are graded here, other typed answers by Claude. */
app.post(
  '/api/drills/:id/answer',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { index, answer } = req.body ?? {};
    const set = getDrillSet(db, id);
    const q = set.questions[Number(index)];
    if (!q) throw httpError(400, 'Unknown question');
    if (answer === undefined || answer === null || String(answer).trim() === '') throw httpError(400, 'Empty answer');
    let graded = gradeLocally(q, answer);
    if (!graded) {
      try {
        graded = await drills.grade(q as Extract<typeof q, { type: 'short' | 'fix' }>, String(answer).slice(0, 2000));
      } catch (e) {
        throw httpError(502, `Couldn't grade that answer: ${(e as Error).message}`);
      }
    }
    try {
      const saved = saveDrillAnswer(db, id, Number(index), graded);
      res.json({ result: graded, question: q, set: publicDrillSet(saved) });
    } catch (e) {
      throw httpError(409, (e as Error).message);
    }
  }),
);

/** Finish: records the score on the weakness (practice only) and prepares the next drill in the background. */
app.post('/api/drills/:id/finish', (req, res) => {
  try {
    const { set, drill } = finishDrillSet(db, Number(req.params.id), { sessionId: activeSession(db)?.id ?? null });
    drills.prepareNext();
    res.json({ drill, set: publicDrillSet(set) });
  } catch (e) {
    throw httpError(400, (e as Error).message);
  }
});

// ---------------- local speech recognition (Whisper helper) ----------------
const sttCfg = sttConfig(cfg);
const stt = new Stt(sttCfg, paths.root);
stt.start();

app.get('/api/stt/status', (_req, res) => {
  res.json({
    ...stt.status(),
    engine: sttCfg.engine,
    vadThreshold: sttCfg.vadThreshold,
    minSpeechMs: sttCfg.minSpeechMs,
    previewMs: sttCfg.previewMs,
  });
});

/** Words to expect: the open problem's title/topic and the identifiers in its Solution.java. */
function sttPrompt(): string {
  const open = db
    .prepare(`SELECT problem_slug AS slug FROM attempts WHERE status = 'in_progress' ORDER BY id DESC LIMIT 1`)
    .get() as { slug: string } | undefined;
  if (!open) return buildPrompt({ extra: sttCfg.extraVocabulary });
  const p = getProblem(db, open.slug);
  return buildPrompt({ title: p.title, topic: p.topic, code: readIf(problemFiles(open.slug).solution), extra: sttCfg.extraVocabulary });
}

/** One utterance as raw 16 kHz mono float32 PCM (little-endian) → { text }. */
app.post(
  '/api/stt',
  express.raw({ type: 'application/octet-stream', limit: '25mb' }),
  wrap(async (req, res) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0 || body.length % 4 !== 0) {
      throw httpError(400, 'Body must be float32 PCM (application/octet-stream)');
    }
    if (stt.state !== 'ready') throw httpError(503, stt.error ?? `speech recognition is ${stt.state}`);
    try {
      res.json(await stt.transcribe(body, sttPrompt()));
    } catch (e) {
      throw httpError(502, (e as Error).message);
    }
  }),
);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    tutor.kill();
    stt.stop();
    process.exit(0);
  });
}
process.on('exit', () => {
  tutor.kill();
  stt.stop();
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Serve a production build of the web app if one exists (`npm run build -w web`); in dev, Vite serves it.
const webDist = path.join(paths.root, 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = typeof err.status === 'number' ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message ?? String(err) });
});

const port = Number(process.env.PREP_API_PORT ?? cfg.ports.api);
app.listen(port, '127.0.0.1', () => {
  console.log(`PrepCoach API on http://localhost:${port} (db: ${paths.db})`);
});
