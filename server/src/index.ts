import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  getOpenAttempt,
  getProblem,
  loadConfig,
  openDb,
  paths,
  problemFiles,
  readLastResults,
  runProblemTests,
  tutorConfig,
  type AttemptRow,
} from '@prepcoach/core';
import { TutorBridge, type TutorEvent } from './tutor';

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

function lastAttempt(slug: string): AttemptRow | null {
  const open = getOpenAttempt(db, slug);
  if (open) return open;
  const r = db
    .prepare(
      `SELECT id, status, is_review AS isReview, started_at AS startedAt, finished_at AS finishedAt,
              solve_time_sec AS solveTimeSec, hints_used AS hintsUsed, outcome_score AS outcomeScore
       FROM attempts WHERE problem_slug = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(slug) as any;
  return r ? { ...r, isReview: !!r.isReview } : null;
}

/** Cheap, poll-friendly state: what the editor needs to pick up external edits, hint changes and CLI test runs. */
function problemState(slug: string) {
  const files = problemFiles(slug);
  return {
    solutionMtime: mtimeOf(files.solution),
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
  res.json({ hintNames: cfg.rating.hintNames, hintCaps: cfg.rating.hintCaps, perTestTimeoutMs: cfg.runner.perTestTimeoutMs });
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
  res.json({ mtime: mtimeOf(files.solution) });
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

// ---------------- voice tutor (headless Claude Code) ----------------
const tutor = new TutorBridge(tutorConfig(cfg), paths.root, path.join(paths.root, 'data', 'tutor'));

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

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    tutor.kill();
    process.exit(0);
  });
}
process.on('exit', () => tutor.kill());

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
