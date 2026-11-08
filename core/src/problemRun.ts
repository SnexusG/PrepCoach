import fs from 'node:fs';
import type { PrepConfig } from './config';
import type { DB } from './db';
import { getProblem, recordTestRun } from './attempts';
import { problemFiles } from './catalog';
import { runJavaTests, type RunResult } from './javaRunner';

export type ProblemRunResult = RunResult & { slug: string };

/**
 * Runs a problem's tests exactly like `prep run-tests`: compiles Solution.java (or a private reference),
 * and — for the user's own solution — saves `.results.json` and updates the open attempt.
 * Shared by the CLI and the web server so both behave identically.
 */
export async function runProblemTests(
  db: DB,
  cfg: PrepConfig,
  slug: string,
  opts: { solutionFile?: string } = {},
): Promise<ProblemRunResult> {
  getProblem(db, slug);
  const files = problemFiles(slug);
  if (!fs.existsSync(files.tests)) throw new Error(`No tests.json for "${slug}" yet — generate the problem files first.`);
  const r = await runJavaTests(files.dir, { solutionFile: opts.solutionFile, timeoutMs: cfg.runner.perTestTimeoutMs });
  const result = { slug, ...r };
  if (!opts.solutionFile) {
    fs.writeFileSync(files.results, JSON.stringify(result, null, 2));
    if (r.compiled) recordTestRun(db, slug, r.passed, r.total);
  }
  return result;
}

/** Last saved test run for a problem (written by the CLI or the web server), or null. */
export function readLastResults(slug: string): ProblemRunResult | null {
  const f = problemFiles(slug).results;
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as ProblemRunResult;
  } catch {
    return null;
  }
}
