import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { paths } from './config';

const run = promisify(execFile);

export type CaseStatus = 'pass' | 'fail' | 'timeout' | 'error';

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
  /** Sum of per-case solution runtime (ms). */
  runtimeMs: number;
  /** Wall time including compilation (ms). */
  wallMs: number;
  /** Anything the solution printed (truncated). */
  stdout: string;
  usedReference: boolean;
}

export interface RunOptions {
  /** Run this file as Solution.java instead of the problem's own (used to verify tests against a private reference). */
  solutionFile?: string;
  timeoutMs?: number;
  harnessDir?: string;
}

const MAX_STDOUT = 4000;

function javaBin(name: 'java' | 'javac'): string {
  const home = process.env.JAVA_HOME;
  if (home) {
    const p = path.join(home, 'bin', process.platform === 'win32' ? `${name}.exe` : name);
    if (fs.existsSync(p)) return p;
  }
  return name;
}

export async function checkJava(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const { stdout, stderr } = await run(javaBin('javac'), ['-version']);
    return { ok: true, version: (stdout || stderr).trim() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function emptyResult(start: number, usedReference: boolean, compileError: string): RunResult {
  return {
    ranAt: new Date().toISOString(),
    compiled: false,
    compileError,
    passed: 0,
    total: 0,
    allPassed: false,
    cases: [],
    firstFailure: null,
    runtimeMs: 0,
    wallMs: Date.now() - start,
    stdout: '',
    usedReference,
  };
}

/** Compile Solution.java (+ any other .java in the problem dir) with the harness and run tests.json. */
export async function runJavaTests(problemDir: string, opts: RunOptions = {}): Promise<RunResult> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? 2000;
  const harnessDir = opts.harnessDir ?? paths.harness;
  const testsFile = path.join(problemDir, 'tests.json');
  const usedReference = !!opts.solutionFile;
  if (!fs.existsSync(testsFile)) return emptyResult(start, usedReference, `No tests.json in ${problemDir}`);

  const tests = JSON.parse(fs.readFileSync(testsFile, 'utf8')) as { cases: unknown[] };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'prepcoach-'));
  const buildDir = path.join(work, 'build');
  const srcDir = path.join(work, 'src');
  fs.mkdirSync(buildDir);
  fs.mkdirSync(srcDir);

  try {
    // Sources: harness + problem dir (Solution.java swapped for the reference when given).
    const sources = fs
      .readdirSync(harnessDir)
      .filter((f) => f.endsWith('.java'))
      .map((f) => path.join(harnessDir, f));
    for (const f of fs.readdirSync(problemDir).filter((f) => f.endsWith('.java'))) {
      if (usedReference && f === 'Solution.java') continue;
      sources.push(path.join(problemDir, f));
    }
    if (opts.solutionFile) {
      const ref = path.join(srcDir, 'Solution.java');
      fs.copyFileSync(opts.solutionFile, ref);
      sources.push(ref);
    }

    try {
      await run(javaBin('javac'), ['-encoding', 'UTF-8', '-nowarn', '-Xlint:none', '-d', buildDir, ...sources], {
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (e: any) {
      const raw = String(e.stderr || e.message);
      const cleaned = raw
        .split(/\r?\n/)
        .filter((l) => !/^Note: /.test(l))
        .map((l) => l.replaceAll(problemDir + path.sep, '').replaceAll(srcDir + path.sep, '(reference) '))
        .join('\n')
        .trim();
      return emptyResult(start, usedReference, cleaned);
    }

    const resultsFile = path.join(work, 'results.json');
    const processTimeout = tests.cases.length * (timeoutMs + 500) + 15000;
    let stdout = '';
    try {
      const r = await run(javaBin('java'), ['-Dfile.encoding=UTF-8', '-cp', buildDir, 'PrepRunner', testsFile, resultsFile, String(timeoutMs)], {
        timeout: processTimeout,
        maxBuffer: 16 * 1024 * 1024,
      });
      stdout = r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : '');
    } catch (e: any) {
      stdout = String(e.stdout ?? '');
      if (!fs.existsSync(resultsFile)) {
        const why = e.killed ? `Test process killed after ${processTimeout} ms` : String(e.stderr || e.message);
        return { ...emptyResult(start, usedReference, ''), compiled: true, compileError: undefined, stdout: `${why}\n${stdout}`.slice(0, MAX_STDOUT), total: tests.cases.length };
      }
    }

    const parsed = JSON.parse(fs.readFileSync(resultsFile, 'utf8')) as { passed: number; total: number; cases: CaseResult[] };
    const firstFailure = parsed.cases.find((c) => c.status !== 'pass') ?? null;
    return {
      ranAt: new Date().toISOString(),
      compiled: true,
      passed: parsed.passed,
      total: parsed.total,
      allPassed: parsed.total > 0 && parsed.passed === parsed.total,
      cases: parsed.cases,
      firstFailure,
      runtimeMs: Math.round(parsed.cases.reduce((s, c) => s + (c.timeMs ?? 0), 0) * 100) / 100,
      wallMs: Date.now() - start,
      stdout: stdout.length > MAX_STDOUT ? stdout.slice(0, MAX_STDOUT) + '\n…(truncated)' : stdout,
      usedReference,
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const short = (v: unknown, max = 300) => {
  const s = JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > max ? s.slice(0, max) + '…' : s;
};

export function formatRunResult(r: RunResult): string[] {
  if (!r.compiled) return ['COMPILE ERROR', r.compileError ?? ''];
  const L = [`${r.allPassed ? 'PASS' : 'FAIL'} ${r.passed}/${r.total} tests · runtime ${r.runtimeMs} ms (wall ${r.wallMs} ms)${r.usedReference ? ' · reference solution' : ''}`];
  for (const c of r.cases) {
    const mark = c.status === 'pass' ? '✓' : c.status === 'timeout' ? '⏱' : c.status === 'error' ? '!' : '✗';
    L.push(`  ${mark} ${String(c.index + 1).padStart(2)} ${c.name} (${c.timeMs} ms)${c.status === 'pass' ? '' : ` — ${c.status}`}`);
  }
  const f = r.firstFailure;
  if (f) {
    L.push('', `First failing case: #${f.index + 1} ${f.name}`);
    L.push(`  input:    ${short(f.input)}`);
    L.push(`  expected: ${short(f.expected)}`);
    if (f.status === 'fail') L.push(`  actual:   ${short(f.actual)}`);
    if (f.error) L.push(`  ${f.status === 'fail' ? 'note' : 'error'}:    ${f.error}`);
  }
  if (r.stdout.trim()) L.push('', 'stdout:', r.stdout.trim());
  return L;
}
