import type { Difficulty, PrepConfig, Track } from './config';
import { DIFFICULTIES } from './config';
import { getPreference, type DB } from './db';
import { computeOverallRating, problemStatuses, topicRatings, type ProblemRow, getProblem } from './attempts';
import { isLowConfidence, ratingLabel } from './rating';
import { selectNext, type ProblemInfo, type Selection, type TopicStat } from './selection';
import { activeSession, type SessionRow } from './sessions';
import { toDateString, addDays } from './spacedRepetition';
import { listWeaknesses, type WeaknessRow } from './weaknesses';
import { problemFiles, sheetName } from './catalog';
import { liveActiveTime } from './activity';
import { activeTimeByDifficulty, getForecast, type ActiveTimeStat, type Forecast } from './forecast';

export interface Prefs {
  sheet: string;
  sheetName: string;
  difficulty: Difficulty;
  track: Track;
}

export function getPrefs(db: DB): Prefs {
  const sheet = getPreference(db, 'active_sheet')!;
  return {
    sheet,
    sheetName: sheetName(sheet),
    difficulty: getPreference(db, 'difficulty') as Difficulty,
    track: getPreference(db, 'mode') as Track,
  };
}

// ---------- problems on the active sheet ----------

export interface SheetProblemStatus extends ProblemInfo {
  url: string | null;
  difficultyRating: number;
}

export function sheetProblems(db: DB, sheet: string): SheetProblemStatus[] {
  const statuses = new Map(problemStatuses(db, sheet).map((s) => [s.slug, s]));
  const rows = db
    .prepare(
      `SELECT p.slug, p.title, t.name AS topic, p.difficulty, sp.sheet_order AS sheetOrder, p.url,
              p.difficulty_rating AS difficultyRating
       FROM sheet_problems sp JOIN problems p ON p.slug = sp.slug JOIN topics t ON t.id = p.topic_id
       WHERE sp.sheet = ? ORDER BY sp.sheet_order`,
    )
    .all(sheet) as Omit<SheetProblemStatus, 'status' | 'lastAbandonedAt'>[];
  return rows.map((r) => {
    const s = statuses.get(r.slug);
    return { ...r, status: s?.status ?? 'unsolved', lastAbandonedAt: s?.lastAbandonedAt ?? null };
  });
}

// ---------- attempts ----------

export interface AttemptSummary {
  id: number;
  slug: string;
  title: string;
  topic: string;
  difficulty: Difficulty;
  status: 'in_progress' | 'completed' | 'abandoned';
  isReview: boolean;
  startedAt: string;
  finishedAt: string | null;
  solveTimeSec: number | null;
  /** Active (working) time; for an open attempt, up to `lastActivityAt`. null = recorded before tracking existed. */
  activeTimeSec: number | null;
  /** Open attempts only: the latest activity (the live timer runs on from here). */
  lastActivityAt?: string;
  hintsUsed: number;
  testsPassed: number | null;
  testsTotal: number | null;
  outcomeScore: number | null;
  ratingDelta: number | null;
  tutorSummary: string | null;
  sessionId: number | null;
}

/** Fills in the live active time of open attempts (finished ones have it stored). */
function withLiveTime<T extends { id: number; status: string; startedAt: string; activeTimeSec: number | null }>(
  db: DB,
  cfg: PrepConfig | undefined,
  row: T,
): T & { lastActivityAt?: string } {
  if (row.status !== 'in_progress' || !cfg) return row;
  return { ...row, ...liveActiveTime(db, cfg, row.id, row.startedAt) };
}

export function listAttempts(
  db: DB,
  opts: { track?: Track; limit?: number; status?: string; topic?: string; slug?: string; sessionId?: number; cfg?: PrepConfig } = {},
): AttemptSummary[] {
  const where: string[] = ['p.track = ?'];
  const args: unknown[] = [opts.track ?? 'dsa'];
  if (opts.status) (where.push('a.status = ?'), args.push(opts.status));
  if (opts.topic) (where.push('lower(t.name) = lower(?)'), args.push(opts.topic));
  if (opts.slug) (where.push('a.problem_slug = ?'), args.push(opts.slug));
  if (opts.sessionId) (where.push('a.session_id = ?'), args.push(opts.sessionId));
  const rows = db
    .prepare(
      `SELECT a.id, a.problem_slug AS slug, p.title, t.name AS topic, p.difficulty, a.status, a.is_review AS isReview,
              a.started_at AS startedAt, a.finished_at AS finishedAt, a.solve_time_sec AS solveTimeSec,
              a.active_time_sec AS activeTimeSec,
              a.hints_used AS hintsUsed, a.tests_passed AS testsPassed, a.tests_total AS testsTotal,
              a.outcome_score AS outcomeScore, a.tutor_summary AS tutorSummary, a.session_id AS sessionId,
              (SELECT c.rating_after - c.rating_before FROM attempt_rating_changes c
                 WHERE c.attempt_id = a.id AND c.is_primary = 1) AS ratingDelta
       FROM attempts a JOIN problems p ON p.slug = a.problem_slug JOIN topics t ON t.id = p.topic_id
       WHERE ${where.join(' AND ')}
       ORDER BY a.id DESC LIMIT ?`,
    )
    .all(...args, opts.limit ?? 1000) as any[];
  return rows.map((r) => withLiveTime(db, opts.cfg, { ...r, isReview: !!r.isReview }));
}

// ---------- reviews ----------

export interface ReviewItem {
  slug: string;
  title: string;
  topic: string;
  difficulty: Difficulty;
  dueDate: string;
  intervalDays: number;
  lastOutcome: number;
  reviewsCount: number;
  /** Why it's being reviewed (what you struggled with); null for entries from before reasons were stored. */
  reason: string | null;
  due: boolean;
}

export function listReviews(db: DB, now = new Date(), opts: { withinDays?: number } = {}): ReviewItem[] {
  const today = toDateString(now);
  const horizon = opts.withinDays != null ? toDateString(addDays(now, opts.withinDays)) : '9999-12-31';
  const rows = db
    .prepare(
      `SELECT q.problem_slug AS slug, p.title, t.name AS topic, p.difficulty, q.due_date AS dueDate,
              q.interval_days AS intervalDays, q.last_outcome AS lastOutcome, q.reviews_count AS reviewsCount, q.reason
       FROM review_queue q JOIN problems p ON p.slug = q.problem_slug JOIN topics t ON t.id = p.topic_id
       WHERE q.due_date <= ? ORDER BY q.due_date, q.last_outcome`,
    )
    .all(horizon) as Omit<ReviewItem, 'due'>[];
  return rows.map((r) => ({ ...r, due: r.dueDate <= today }));
}

export function isReviewDue(db: DB, slug: string, now = new Date()): boolean {
  const r = db.prepare('SELECT due_date AS d FROM review_queue WHERE problem_slug = ?').get(slug) as { d: string } | undefined;
  return !!r && r.d <= toDateString(now);
}

// ---------- next ----------

export interface NextOptions {
  topic?: string;
  difficulty?: Difficulty;
  moreReviews?: boolean;
  now?: Date;
}

export interface NextResult {
  selection: Selection | null;
  problem: (ProblemRow & { files: ReturnType<typeof problemFiles> }) | null;
  openAttempts: AttemptSummary[];
  prefs: Prefs;
}

function recentOutcomesByTopic(db: DB, track: Track): Map<string, TopicStat['recentOutcomes']> {
  const rows = db
    .prepare(
      `SELECT t.name AS topic, p.difficulty, a.outcome_score AS outcome
       FROM attempts a JOIN problems p ON p.slug = a.problem_slug JOIN topics t ON t.id = p.topic_id
       WHERE p.track = ? AND a.status = 'completed' AND a.is_review = 0 ORDER BY a.id DESC`,
    )
    .all(track) as { topic: string; difficulty: Difficulty; outcome: number }[];
  const m = new Map<string, TopicStat['recentOutcomes']>();
  for (const r of rows) {
    const list = m.get(r.topic) ?? [];
    if (list.length < 5) list.push({ difficulty: r.difficulty, outcome: r.outcome });
    m.set(r.topic, list);
  }
  return m;
}

export function nextProblem(db: DB, cfg: PrepConfig, opts: NextOptions = {}): NextResult {
  const now = opts.now ?? new Date();
  const prefs = getPrefs(db);
  const session = activeSession(db);
  const problems = sheetProblems(db, prefs.sheet);
  const recent = recentOutcomesByTopic(db, prefs.track);
  const topicStats: TopicStat[] = topicRatings(db, prefs.track).map((t) => ({
    topic: t.topic,
    rating: t.rating,
    attempts: t.attempts,
    recentOutcomes: recent.get(t.topic) ?? [],
  }));
  const sheetSlugs = new Set(problems.map((p) => p.slug));
  const dueReviews = listReviews(db, now)
    .filter((r) => r.due && sheetSlugs.has(r.slug))
    .map((r) => ({ slug: r.slug, dueDate: r.dueDate }));
  const excludeSlugs = session
    ? listAttempts(db, { sessionId: session.id, status: 'abandoned' }).map((a) => a.slug)
    : [];
  const activeWeaknesses = listWeaknesses(db, prefs.track, ['active']).map((w) => ({
    id: w.id,
    topic: w.topic,
    description: w.description,
    timesObserved: w.timesObserved,
    lastSeen: w.lastSeen,
  }));

  if (opts.topic) {
    const known = topicStats.find((t) => t.topic.toLowerCase() === opts.topic!.toLowerCase());
    if (!known) throw new Error(`Unknown topic "${opts.topic}". Topics: ${topicStats.map((t) => t.topic).join(', ')}`);
    opts = { ...opts, topic: known.topic };
  }

  const selection = selectNext(
    {
      problems,
      topicStats,
      activeWeaknesses,
      dueReviews,
      reviewsServedThisSession: session?.reviewsServed ?? 0,
      excludeSlugs,
      preferredDifficulty: prefs.difficulty,
      filter: { topic: opts.topic, difficulty: opts.difficulty },
      extraReviews: opts.moreReviews,
    },
    cfg,
  );
  const problem = selection ? { ...getProblem(db, selection.slug), files: problemFiles(selection.slug) } : null;
  return { selection, problem, openAttempts: listAttempts(db, { status: 'in_progress', track: prefs.track }), prefs };
}

// ---------- stats ----------

export interface TopicStatRow {
  topic: string;
  rating: number;
  attempts: number;
  label: string;
  lowConfidence: boolean;
  solved: Record<Difficulty, number>;
  total: Record<Difficulty, number>;
}

export interface Stats {
  track: Track;
  prefs: Prefs;
  overall: { rating: number; label: string; trend7d: number; trend30d: number };
  topics: TopicStatRow[];
  completion: { solved: number; total: number; byDifficulty: Record<Difficulty, { solved: number; total: number }> };
  weaknesses: { active: number; improving: number; resolved: number };
  reviews: { due: number; upcoming7d: number };
  attempts: { completed: number; abandoned: number; inProgress: number };
  ratingHistory: { recordedAt: string; topic: string | null; rating: number }[];
  forecast: Forecast;
  /** Average active time per difficulty (attempts tracked since active-time tracking was added). */
  activeTime: Record<Difficulty, ActiveTimeStat>;
}

function overallAt(db: DB, cfg: PrepConfig, track: Track, iso: string): number {
  const row = db
    .prepare(
      `SELECT rating FROM rating_history WHERE track = ? AND topic_id IS NULL AND recorded_at <= ?
       ORDER BY recorded_at DESC, id DESC LIMIT 1`,
    )
    .get(track, iso) as { rating: number } | undefined;
  return row?.rating ?? cfg.rating.initial;
}

const zeroByDiff = (): Record<Difficulty, number> => ({ easy: 0, medium: 0, hard: 0 });

export function getStats(db: DB, cfg: PrepConfig, now = new Date()): Stats {
  const prefs = getPrefs(db);
  const track = prefs.track;
  const overall = computeOverallRating(db, cfg, track);
  const problems = sheetProblems(db, prefs.sheet);

  const topics: TopicStatRow[] = topicRatings(db, track).map((t) => {
    const mine = problems.filter((p) => p.topic === t.topic);
    const solved = zeroByDiff();
    const total = zeroByDiff();
    for (const p of mine) {
      total[p.difficulty]++;
      if (p.status === 'solved') solved[p.difficulty]++;
    }
    return {
      topic: t.topic,
      rating: Math.round(t.rating * 10) / 10,
      attempts: t.attempts,
      label: ratingLabel(t.rating, cfg),
      lowConfidence: isLowConfidence(t.attempts, cfg),
      solved,
      total,
    };
  });

  const byDifficulty = Object.fromEntries(
    DIFFICULTIES.map((d) => [
      d,
      {
        solved: problems.filter((p) => p.difficulty === d && p.status === 'solved').length,
        total: problems.filter((p) => p.difficulty === d).length,
      },
    ]),
  ) as Stats['completion']['byDifficulty'];

  const weak = listWeaknesses(db, track);
  const reviews = listReviews(db, now, { withinDays: 7 });
  const counts = db
    .prepare(
      `SELECT a.status, COUNT(*) AS n FROM attempts a JOIN problems p ON p.slug = a.problem_slug
       WHERE p.track = ? GROUP BY a.status`,
    )
    .all(track) as { status: string; n: number }[];
  const count = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;

  const ratingHistory = db
    .prepare(
      `SELECT h.recorded_at AS recordedAt, t.name AS topic, h.rating FROM rating_history h
       LEFT JOIN topics t ON t.id = h.topic_id WHERE h.track = ? ORDER BY h.recorded_at, h.id`,
    )
    .all(track) as Stats['ratingHistory'];

  const daysAgo = (n: number) => new Date(now.getTime() - n * 864e5).toISOString();
  return {
    track,
    prefs,
    overall: {
      rating: overall,
      label: ratingLabel(overall, cfg),
      trend7d: Math.round((overall - overallAt(db, cfg, track, daysAgo(7))) * 10) / 10,
      trend30d: Math.round((overall - overallAt(db, cfg, track, daysAgo(30))) * 10) / 10,
    },
    topics,
    completion: {
      solved: problems.filter((p) => p.status === 'solved').length,
      total: problems.length,
      byDifficulty,
    },
    weaknesses: {
      active: weak.filter((w) => w.status === 'active').length,
      improving: weak.filter((w) => w.status === 'improving').length,
      resolved: weak.filter((w) => w.status === 'resolved').length,
    },
    reviews: { due: reviews.filter((r) => r.due).length, upcoming7d: reviews.filter((r) => !r.due).length },
    attempts: { completed: count('completed'), abandoned: count('abandoned'), inProgress: count('in_progress') },
    ratingHistory,
    forecast: getForecast(db, cfg, { sheet: prefs.sheet, track, now }),
    activeTime: activeTimeByDifficulty(db, track),
  };
}

// ---------- weakness examples ----------

export interface WeaknessWithExamples extends WeaknessRow {
  examples: { attemptId: number; slug: string; kind: string; date: string; summary: string | null; note: string | null }[];
}

export function weaknessesWithExamples(db: DB, track: Track, statuses?: WeaknessRow['status'][]): WeaknessWithExamples[] {
  const ex = db.prepare(
    `SELECT wa.attempt_id AS attemptId, a.problem_slug AS slug, wa.kind, COALESCE(a.finished_at, a.started_at) AS date,
            a.tutor_summary AS summary, wa.note
     FROM weakness_attempts wa JOIN attempts a ON a.id = wa.attempt_id
     WHERE wa.weakness_id = ? ORDER BY a.id DESC LIMIT 3`,
  );
  return listWeaknesses(db, track, statuses).map((w) => ({ ...w, examples: ex.all(w.id) as WeaknessWithExamples['examples'] }));
}

// ---------- context ----------

export interface ContextData {
  date: string;
  prefs: Prefs;
  session: SessionRow | undefined;
  stats: Stats;
  weaknesses: WeaknessWithExamples[];
  recent: AttemptSummary[];
  open: AttemptSummary[];
  abandoned: (SheetProblemStatus & { lastAbandonedAt: string })[];
  reviewsDue: ReviewItem[];
  reviewsUpcoming: ReviewItem[];
  suggestions: string[];
}

export function getContext(db: DB, cfg: PrepConfig, now = new Date()): ContextData {
  const prefs = getPrefs(db);
  const stats = getStats(db, cfg, now);
  const reviews = listReviews(db, now, { withinDays: 7 });
  const next = nextProblem(db, cfg, { now });
  return {
    date: toDateString(now),
    prefs,
    session: activeSession(db),
    stats,
    weaknesses: weaknessesWithExamples(db, prefs.track, ['active', 'improving']),
    recent: listAttempts(db, { track: prefs.track, limit: 6 }).filter((a) => a.status !== 'in_progress').slice(0, 5),
    open: listAttempts(db, { track: prefs.track, status: 'in_progress', cfg }),
    abandoned: sheetProblems(db, prefs.sheet).filter((p) => p.status === 'abandoned') as ContextData['abandoned'],
    reviewsDue: reviews.filter((r) => r.due),
    reviewsUpcoming: reviews.filter((r) => !r.due),
    suggestions: next.selection?.suggestions ?? [],
  };
}

const fmtDelta = (d: number) => `${d >= 0 ? '+' : ''}${Math.round(d * 10) / 10}`;
const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '?');
const mins = (sec: number | null) => (sec == null ? 'unknown time' : `${Math.round(sec / 60)} min`);

/** One-line forecast, shared by `prep context` and `prep stats`. */
export function forecastLine(f: Forecast): string {
  const target = f.target
    ? f.target.passed
      ? ` · target ${f.target.date} has passed`
      : ` · target ${f.target.date}: needs ${f.target.requiredPerWeek ?? 0}/week` +
        (f.target.onTrack == null ? '' : f.target.onTrack ? ' (on track)' : ' (behind)')
    : '';
  switch (f.status) {
    case 'complete':
      return `sheet complete (${f.total}/${f.total})${target}`;
    case 'insufficient':
      return `not enough data yet (${f.solved} solved; needs a few more for a pace)${target}`;
    case 'stalled':
      return `no new problems solved in ${f.daysSinceLastSolve} days, so no current pace · ${f.remaining} left${target}`;
    default:
      return (
        `finish ${f.remaining} remaining around ${f.date} (range ${f.early} – ${f.late ?? 'open-ended'}) at ` +
        `${f.perWeek} problems/week over ${Math.round(f.spanDays)} days · at 1/day: ${f.atOnePerDay}${target}`
      );
  }
}

export function renderContextMarkdown(c: ContextData): string {
  const s = c.stats;
  const L: string[] = [];
  L.push(`# PrepCoach context — ${c.date}`);
  L.push(
    `Track: DSA · Sheet: ${c.prefs.sheetName} · Preferred difficulty: ${c.prefs.difficulty} · ` +
      (c.session ? `Session #${c.session.id} (started ${c.session.startedAt.slice(11, 16)} UTC, reviews served ${c.session.reviewsServed})` : 'No active session'),
  );
  L.push('');
  L.push('## Overall');
  L.push(
    `DSA rating **${Math.round(s.overall.rating)}** — ${s.overall.label} (7d ${fmtDelta(s.overall.trend7d)}, 30d ${fmtDelta(s.overall.trend30d)}) · ` +
      `Solved ${s.completion.solved}/${s.completion.total} (${pct(s.completion.solved, s.completion.total)}%) — ` +
      DIFFICULTIES.map((d) => `${d} ${s.completion.byDifficulty[d].solved}/${s.completion.byDifficulty[d].total}`).join(', ') +
      ` · Attempts: ${s.attempts.completed} completed, ${s.attempts.abandoned} abandoned`,
  );
  L.push(`Forecast: ${forecastLine(s.forecast)}`);
  const times = DIFFICULTIES.filter((d) => s.activeTime[d].avgMinutes != null).map(
    (d) => `${d} ${s.activeTime[d].avgMinutes} min (${s.activeTime[d].attempts})`,
  );
  if (times.length) L.push(`Average active time per solve: ${times.join(', ')}`);
  L.push('');

  const attempted = s.topics.filter((t) => t.attempts > 0).sort((a, b) => a.rating - b.rating);
  const untouched = s.topics.filter((t) => t.attempts === 0);
  L.push('## Topic ratings (weakest first)');
  if (attempted.length) {
    for (const t of attempted) {
      const solved = DIFFICULTIES.reduce((n, d) => n + t.solved[d], 0);
      const total = DIFFICULTIES.reduce((n, d) => n + t.total[d], 0);
      L.push(
        `- ${t.topic}: ${Math.round(t.rating)} (${t.label}) · ${t.attempts} attempt${t.attempts === 1 ? '' : 's'}` +
          `${t.lowConfidence ? ' · low confidence' : ''} · solved ${solved}/${total}`,
      );
    }
  } else L.push('- No topic attempted yet.');
  if (untouched.length) {
    const moved = untouched.filter((t) => t.rating !== 1200);
    L.push(
      `- Not yet attempted (1200): ${untouched.filter((t) => t.rating === 1200).map((t) => t.topic).join(', ')}` +
        (moved.length ? ` · moved via secondary tags: ${moved.map((t) => `${t.topic} ${Math.round(t.rating)}`).join(', ')}` : ''),
    );
  }
  L.push('');

  L.push('## Weaknesses to watch');
  if (!c.weaknesses.length) L.push('- None logged yet.');
  for (const w of c.weaknesses) {
    L.push(
      `- #${w.id} [${w.area ?? 'no area'}${w.topic ? ` · ${w.topic}` : ''}] **${w.description}** — ${w.status}, seen ${w.timesObserved}×, last ${day(w.lastSeen)}` +
        (w.status === 'improving' ? `, clean ${w.cleanDemonstrations}×` : ''),
    );
    for (const e of w.examples.slice(0, 2)) {
      L.push(`  - ${e.kind === 'observed' ? 'seen on' : 'handled well on'} ${e.slug} (${day(e.date)}): ${e.note ?? e.summary ?? ''}`);
    }
  }
  L.push('');

  if (c.open.length || c.abandoned.length) {
    L.push('## Unfinished');
    for (const a of c.open) {
      L.push(
        `- In progress: ${a.slug} (${a.topic}, ${a.difficulty}) since ${a.startedAt.slice(0, 16).replace('T', ' ')} UTC, ` +
          `${mins(a.activeTimeSec)} active so far, hints ${a.hintsUsed}`,
      );
    }
    for (const p of c.abandoned) L.push(`- Abandoned, still unsolved: ${p.slug} (${p.topic}, ${p.difficulty}) on ${day(p.lastAbandonedAt)}`);
    L.push('');
  }

  L.push('## Recent attempts');
  if (!c.recent.length) L.push('- None yet.');
  for (const a of c.recent) {
    const parts = [
      `${day(a.finishedAt ?? a.startedAt)} ${a.slug} (${a.topic}, ${a.difficulty}${a.isReview ? ', review' : ''})`,
      a.status === 'abandoned'
        ? 'ABANDONED'
        : `outcome ${a.outcomeScore?.toFixed(2)}, tests ${a.testsPassed ?? 0}/${a.testsTotal ?? 0}, hints ${a.hintsUsed}, Δ ${fmtDelta(a.ratingDelta ?? 0)}` +
          (a.activeTimeSec != null ? `, ${mins(a.activeTimeSec)} active` : ''),
    ];
    L.push(`- ${parts.join(' — ')}${a.tutorSummary ? ` — ${a.tutorSummary}` : ''}`);
  }
  L.push('');

  L.push('## Reviews');
  if (!c.reviewsDue.length) L.push('- None due today.');
  for (const r of c.reviewsDue) {
    L.push(`- DUE: ${r.slug} (${r.topic}) since ${r.dueDate}, last outcome ${r.lastOutcome.toFixed(2)}${r.reason ? ` — struggled: ${r.reason}` : ''}`);
  }
  if (c.reviewsUpcoming.length) L.push(`- Upcoming (7d): ${c.reviewsUpcoming.map((r) => `${r.slug} ${r.dueDate}`).join(', ')}`);

  if (c.suggestions.length) {
    L.push('');
    L.push('## Progression suggestions');
    for (const sug of c.suggestions) L.push(`- ${sug}`);
  }
  return L.join('\n');
}

// ---------- attempt detail (history page) ----------

export interface AttemptDetail extends AttemptSummary {
  rubric: {
    input?: Record<string, number>;
    components?: Record<string, number>;
    raw?: number;
    cap?: number;
  } | null;
  ratingChanges: { topic: string; isPrimary: boolean; ratingBefore: number; ratingAfter: number; expected: number; k: number; weight: number }[];
  hints: { level: number; givenAt: string }[];
  weaknesses: { id: number; description: string; topic: string | null; area: string | null; status: string; kind: 'observed' | 'handled_well'; note: string | null }[];
}

export function attemptDetail(db: DB, id: number, cfg?: PrepConfig): AttemptDetail {
  const summary = db
    .prepare(
      `SELECT a.id, a.problem_slug AS slug, p.title, t.name AS topic, p.difficulty, a.status, a.is_review AS isReview,
              a.started_at AS startedAt, a.finished_at AS finishedAt, a.solve_time_sec AS solveTimeSec,
              a.active_time_sec AS activeTimeSec,
              a.hints_used AS hintsUsed, a.tests_passed AS testsPassed, a.tests_total AS testsTotal,
              a.outcome_score AS outcomeScore, a.tutor_summary AS tutorSummary, a.session_id AS sessionId, a.rubric,
              (SELECT c.rating_after - c.rating_before FROM attempt_rating_changes c
                 WHERE c.attempt_id = a.id AND c.is_primary = 1) AS ratingDelta
       FROM attempts a JOIN problems p ON p.slug = a.problem_slug JOIN topics t ON t.id = p.topic_id WHERE a.id = ?`,
    )
    .get(id) as any;
  if (!summary) throw new Error(`Attempt #${id} not found`);
  const ratingChanges = (
    db
      .prepare(
        `SELECT t.name AS topic, c.is_primary AS isPrimary, c.rating_before AS ratingBefore, c.rating_after AS ratingAfter,
                c.expected, c.k, c.weight
         FROM attempt_rating_changes c JOIN topics t ON t.id = c.topic_id WHERE c.attempt_id = ? ORDER BY c.is_primary DESC`,
      )
      .all(id) as any[]
  ).map((r) => ({ ...r, isPrimary: !!r.isPrimary }));
  const hints = db.prepare('SELECT level, given_at AS givenAt FROM hint_log WHERE attempt_id = ? ORDER BY level').all(id) as AttemptDetail['hints'];
  const weaknesses = db
    .prepare(
      `SELECT w.id, w.description, t.name AS topic, w.area, w.status, wa.kind, wa.note
       FROM weakness_attempts wa JOIN weaknesses w ON w.id = wa.weakness_id LEFT JOIN topics t ON t.id = w.topic_id
       WHERE wa.attempt_id = ? ORDER BY wa.kind, w.id`,
    )
    .all(id) as AttemptDetail['weaknesses'];
  let rubric: AttemptDetail['rubric'] = null;
  try {
    rubric = summary.rubric ? JSON.parse(summary.rubric) : null;
  } catch {
    rubric = null;
  }
  return withLiveTime(db, cfg, { ...summary, isReview: !!summary.isReview, rubric, ratingChanges, hints, weaknesses });
}
