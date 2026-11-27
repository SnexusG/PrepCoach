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

export interface ProblemListItem {
  slug: string;
  title: string;
  topic: string;
  difficulty: Difficulty;
  attempt: Attempt | null;
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
  problems: () => call<ProblemListItem[]>('/api/problems'),
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

export interface Weakness {
  id: number;
  description: string;
  topic: string | null;
  status: 'active' | 'improving' | 'resolved';
  timesObserved: number;
  cleanDemonstrations: number;
  lastSeen: string;
  examples: { attemptId: number; slug: string; kind: string; date: string; summary: string | null }[];
}

export interface ReviewItem {
  slug: string;
  title: string;
  topic: string;
  difficulty: Difficulty;
  dueDate: string;
  intervalDays: number;
  lastOutcome: number;
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
  labels: { min: number; label: string }[];
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
  weaknesses: { id: number; description: string; topic: string | null; status: string; kind: 'observed' | 'handled_well' }[];
  notes: string | null;
  solution: string | null;
}

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
