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
};

// ---------------- formatting ----------------

export const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';
export const fmtDateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
export const fmtMins = (sec: number | null) => (sec == null ? '—' : sec < 60 ? `${sec}s` : `${Math.round(sec / 60)} min`);
export const fmtDelta = (d: number | null) => (d == null ? '—' : `${d >= 0 ? '+' : '−'}${Math.abs(Math.round(d * 10) / 10)}`);
