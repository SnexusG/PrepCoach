// Types mirror the server JSON (which mirrors @prepcoach/core).
export type Difficulty = 'easy' | 'medium' | 'hard';
export type CaseStatus = 'pass' | 'fail' | 'timeout' | 'error';

export interface Problem {
  slug: string;
  title: string;
  topic: string;
  secondaryTopics: string[];
  difficulty: Difficulty;
  url: string | null;
}

export interface Attempt {
  id: number;
  status: 'in_progress' | 'completed' | 'abandoned';
  isReview: boolean;
  startedAt: string;
  finishedAt: string | null;
  solveTimeSec: number | null;
  /** Working time (breaks excluded); null for attempts from before tracking. Open attempts: up to lastActivityAt. */
  activeTimeSec: number | null;
  lastActivityAt?: string;
  hintsUsed: number;
  outcomeScore: number | null;
}

export interface CaseResult {
  index: number;
  name: string;
  status: CaseStatus;
  timeMs: number;
  input: unknown;
  expected: unknown;
  actual?: unknown;
  error?: string;
}

export interface RunResult {
  ranAt: string;
  compiled: boolean;
  compileError?: string;
  passed: number;
  total: number;
  allPassed: boolean;
  cases: CaseResult[];
  firstFailure: CaseResult | null;
  runtimeMs: number;
  wallMs: number;
  stdout: string;
}

export interface ProblemState {
  solutionMtime: number | null;
  resultsMtime: number | null;
  attempt: Attempt | null;
  serverTime: string;
}

export interface ProblemData extends ProblemState {
  problem: Problem;
  generated: boolean;
  statement: string | null;
  solution: string | null;
  lastResults: RunResult | null;
}

export interface Meta {
  hintNames: string[];
  hintCaps: number[];
  perTestTimeoutMs: number;
  /** Gaps longer than this are breaks (the live timer pauses). */
  idleGapMin: number;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: any) {
    super(message);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText, body);
  return body as T;
}

const p = (slug: string) => `/api/problems/${encodeURIComponent(slug)}`;

export const api = {
  meta: () => call<Meta>('/api/meta'),
  problem: (slug: string) => call<ProblemData>(p(slug)),
  state: (slug: string) => call<ProblemState>(`${p(slug)}/state`),
  solution: (slug: string) => call<{ code: string | null; mtime: number | null }>(`${p(slug)}/solution`),
  results: (slug: string) => call<{ results: RunResult | null; resultsMtime: number | null }>(`${p(slug)}/results`),
  save: (slug: string, code: string, baseMtime: number | null, force = false) =>
    call<{ mtime: number }>(`${p(slug)}/solution`, { method: 'PUT', body: JSON.stringify({ code, baseMtime, force }) }),
  run: (slug: string) => call<ProblemState & { result: RunResult }>(`${p(slug)}/run`, { method: 'POST' }),
  activity: (slug: string) => call<{ recorded: boolean }>(`${p(slug)}/activity`, { method: 'POST', body: '{}' }),
};

// ---------------- dashboard & history ----------------

export interface TopicStat {
  topic: string;
  rating: number;
  attempts: number;
  label: string;
  lowConfidence: boolean;
  confidence: number;
  solved: Record<Difficulty, number>;
  total: Record<Difficulty, number>;
}

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
  activeTimeSec: number | null;
  lastActivityAt?: string;
  hintsUsed: number;
  testsPassed: number | null;
  testsTotal: number | null;
  outcomeScore: number | null;
  ratingDelta: number | null;
  tutorSummary: string | null;
  sessionId: number | null;
}

/** Display names of weakness areas (mirrors WEAKNESS_AREAS in core). */
export const WEAKNESS_AREA_LABELS: Record<string, string> = {
  complexity: 'Complexity analysis',
  java: 'Java language & collections',
  understanding: 'Problem understanding',
  'edge-cases': 'Edge cases',
  algorithm: 'Algorithm & pattern choice',
  implementation: 'Implementation discipline',
  testing: 'Testing & verification',
  communication: 'Communication',
};

export interface Weakness {
  id: number;
  description: string;
  topic: string | null;
  area: string | null;
  status: 'active' | 'improving' | 'resolved';
  timesObserved: number;
  cleanDemonstrations: number;
  lastSeen: string;
  examples: { attemptId: number; slug: string; kind: string; date: string; summary: string | null; note: string | null; probed: boolean }[];
  /** Latest drills first. */
  drills: { id: number; at: string; correct: number; total: number; note: string | null }[];
  lastProbedAt: string | null;
  lastDrillAt: string | null;
}

export interface ReviewItem {
  slug: string;
  title: string;
  topic: string;
  difficulty: Difficulty;
  dueDate: string;
  intervalDays: number;
  lastOutcome: number;
  /** What you struggled with (why it's queued); null for older entries. */
  reason: string | null;
  due: boolean;
}

export interface Forecast {
  status: 'complete' | 'insufficient' | 'stalled' | 'ok';
  solved: number;
  total: number;
  remaining: number;
  remainingByDifficulty: Record<Difficulty, number>;
  spanDays: number;
  solvesInWindow: number;
  perWeek: number;
  date: string | null;
  early: string | null;
  late: string | null;
  daysSinceLastSolve: number | null;
  atOnePerDay: string | null;
  target: { date: string; daysLeft: number; passed: boolean; requiredPerWeek: number | null; onTrack: boolean | null } | null;
  history: { date: string; solved: number }[];
}

export interface RatingLevel {
  min: number;
  label: string;
  meaning?: string;
}

export interface Dashboard {
  stats: {
    prefs: { sheet: string; sheetName: string; difficulty: Difficulty };
    overall: { rating: number; label: string; trend7d: number; trend30d: number };
    topics: TopicStat[];
    completion: { solved: number; total: number; byDifficulty: Record<Difficulty, { solved: number; total: number }> };
    weaknesses: { active: number; improving: number; resolved: number };
    reviews: { due: number; upcoming7d: number };
    attempts: { completed: number; abandoned: number; inProgress: number };
    ratingHistory: { recordedAt: string; topic: string | null; rating: number }[];
    forecast: Forecast;
    activeTime: Record<Difficulty, { avgMinutes: number | null; attempts: number }>;
  };
  initialRating: number;
  labels: RatingLevel[];
  game: (GameSummary & { quests: Quest[]; weeklyCount: number }) | null;
  weaknesses: Weakness[];
  reviews: ReviewItem[];
  recent: AttemptSummary[];
  session: { id: number; startedAt: string } | null;
  tracks: { id: string; name: string; enabled: boolean }[];
}

export interface AttemptDetail extends AttemptSummary {
  rubric: { input?: Record<string, number>; components?: Record<string, number>; raw?: number; cap?: number } | null;
  ratingChanges: { topic: string; isPrimary: boolean; ratingBefore: number; ratingAfter: number; expected: number; k: number; weight: number }[];
  hints: { level: number; givenAt: string }[];
  weaknesses: { id: number; description: string; topic: string | null; area: string | null; status: string; kind: 'observed' | 'handled_well'; note: string | null }[];
  notes: string | null;
  solution: string | null;
}

// ---------------- game (streaks, quests, badges) ----------------

export interface Quest {
  id: string;
  title: string;
  progress: number;
  goal: number;
  done: boolean;
  doneAt: string | null;
}

export interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
  rarity: 'common' | 'rare' | 'epic';
  unlockedAt: string | null;
  progress: [number, number] | null;
}

export interface GameSummary {
  streak: number;
  longestStreak: number;
  freezes: number;
  activeToday: boolean;
  questsDone: number;
  questsTotal: number;
  badges: number;
  badgesTotal: number;
  latestBadge: { name: string; icon: string; at: string } | null;
}

export interface GameState {
  summary: GameSummary;
  streak: { current: number; longest: number; freezes: number; activeToday: boolean; frozenDays: string[] };
  heatmap: { date: string; solves: number; attempts: number; drills: number }[];
  quests: { daily: Quest[]; weekly: Quest[] };
  achievements: Achievement[];
  bests: {
    fastest: Record<Difficulty, { slug: string; title: string; activeSec: number; at: string } | null>;
    bestOutcome: { slug: string; title: string; outcome: number; at: string } | null;
    longestStreak: number;
  };
  levels: { label: string; min: number; meaning?: string; reachedAt: string | null }[];
}

export interface Rewards {
  since: string;
  until: string;
  solves: {
    attemptId: number;
    slug: string;
    title: string;
    difficulty: Difficulty;
    solved: boolean;
    isReview: boolean;
    outcome: number | null;
    changes: { topic: string; before: number; after: number; isPrimary: boolean }[];
  }[];
  overall: { before: number; after: number } | null;
  levelUp: { from: string; to: string; meaning?: string } | null;
  badges: Achievement[];
  quests: Quest[];
  streak: { current: number; extended: boolean; freezes: number };
  bests: { kind: string; text: string }[];
  drills: number;
  empty: boolean;
  levels: RatingLevel[];
}

export const gameApi = {
  state: () => call<GameState>('/api/game'),
  summary: () => call<GameSummary & { rating: number; label: string; levels: RatingLevel[] }>('/api/game/summary'),
  pending: () => call<Rewards>('/api/rewards/pending'),
  ack: (through: string) => call<{ ok: true }>('/api/rewards/ack', { method: 'POST', body: JSON.stringify({ through }) }),
};

export const dashApi = {
  dashboard: () => call<Dashboard>('/api/dashboard'),
  attempts: () => call<AttemptSummary[]>('/api/attempts'),
  attempt: (id: number) => call<AttemptDetail>(`/api/attempts/${id}`),
  setTargetDate: (date: string | null) =>
    call<{ date: string | null }>('/api/preferences/target-date', { method: 'PUT', body: JSON.stringify({ date }) }),
};

// ---------------- formatting ----------------

export const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';
export const fmtDateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
export const fmtMins = (sec: number | null) => (sec == null ? '—' : sec < 60 ? `${sec}s` : `${Math.round(sec / 60)} min`);

/** A YYYY-MM-DD calendar day, e.g. "Mar 14, 2027". */
export const fmtDay = (day: string | null) => {
  if (!day) return '—';
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

/** The headline sentence for the completion forecast (home page and dashboard). */
export function forecastHeadline(f: Forecast, sheetName: string): string {
  switch (f.status) {
    case 'complete':
      return `${sheetName} complete — all ${f.total} solved.`;
    case 'insufficient':
      return `Solve a few more problems to see when you'll finish ${sheetName}.`;
    case 'stalled':
      return `No new problems solved in ${f.daysSinceLastSolve} days, so there's no current pace for ${sheetName}.`;
    default:
      return `On pace to finish ${sheetName} around ${fmtDay(f.date)}.`;
  }
}
export const fmtDelta = (d: number | null) => (d == null ? '—' : `${d >= 0 ? '+' : '−'}${Math.abs(Math.round(d * 10) / 10)}`);

// ---------------- drills ----------------

interface DrillQBase {
  prompt: string;
  explanation?: string;
  /** The weakness a mixed-drill question targets. */
  weaknessId?: number;
}
export type DrillQuestion =
  | (DrillQBase & { type: 'mcq'; code?: string; options: string[]; answer?: number })
  | (DrillQBase & { type: 'short'; code?: string; expected?: string })
  | (DrillQBase & { type: 'bug'; code: string; answer?: number })
  | (DrillQBase & { type: 'fix'; code: string; expected?: string });

export interface DrillAnswer {
  answer: number | string;
  correct: boolean;
  feedback: string;
  gradedBy: 'auto' | 'claude';
}

export interface DrillSet {
  id: number;
  /** null for a mixed drill. */
  weaknessId: number | null;
  mixed: boolean;
  status: 'ready' | 'in_progress' | 'done';
  /** Unanswered questions come without their answer and explanation. */
  questions: DrillQuestion[];
  answers: Record<number, DrillAnswer>;
}

export interface DrillTarget {
  id: number;
  area: string | null;
  description: string;
  status: 'active' | 'improving' | 'resolved';
  timesObserved: number;
  lastDrill: { correct: number; total: number; at: string; note: string | null } | null;
  ready: boolean;
  generating: boolean;
  error: string | null;
}

export const drillApi = {
  list: () =>
    call<{
      suggested: number | null;
      weaknesses: DrillTarget[];
      mixed: { ready: boolean; generating: boolean; error: string | null; weaknessCount: number; questions: number };
    }>('/api/drills'),
  /** A weakness id, or 'mixed' for a drill across all open weaknesses. */
  start: (target: number | 'mixed') =>
    call<DrillSet>('/api/drills/start', { method: 'POST', body: JSON.stringify(target === 'mixed' ? { mixed: true } : { weaknessId: target }) }),
  answer: (id: number, index: number, answer: number | string) =>
    call<{ result: DrillAnswer; question: DrillQuestion; set: DrillSet }>(`/api/drills/${id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ index, answer }),
    }),
  finish: (id: number) =>
    call<{ drills: { weaknessId: number; correct: number; total: number; note: string | null }[] }>(`/api/drills/${id}/finish`, { method: 'POST' }),
};
