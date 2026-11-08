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
