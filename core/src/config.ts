import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Track = 'dsa' | 'system_design' | 'java';
export type Difficulty = 'easy' | 'medium' | 'hard';
export const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

export interface TopicConfig {
  name: string;
  frequencyWeight: number;
}

export interface PrepConfig {
  rating: {
    initial: number;
    difficultyRatings: Record<Difficulty, number>;
    kFactor: { provisional: number; provisionalAttempts: number; standard: number };
    secondaryTopicWeight: number;
    reviewWeight: number;
    rubricWeights: {
      correctness: number;
      optimality: number;
      approach: number;
      codeQuality: number;
      communication: number;
      independence: number;
    };
    partialCorrectnessFactor: number;
    hintCaps: number[];
    hintNames: string[];
    confidence: { lowAttempts: number; fullAttempts: number; minWeight: number };
    labels: { min: number; label: string }[];
  };
  topics: Record<Track, TopicConfig[]>;
  spacedRepetition: {
    initialIntervals: { low: number; mid: number; high: number };
    lowThreshold: number;
    highThreshold: number;
    reviewPassThreshold: number;
    initialEase: number;
    minEase: number;
    maxEase: number;
    maxIntervalDays: number;
  };
  selection: {
    maxReviewsPerSession: number;
    weakTopicMargin: number;
    hardPromotionThreshold: number;
    failOutcomeThreshold: number;
    consecutiveFailsToDrop: number;
  };
  weaknesses: { cleanDemonstrationsToResolve: number };
  runner: { perTestTimeoutMs: number };
  ports: { web: number; api: number };
  /** Voice tutor: the web server drives a headless Claude Code session (`claude -p`). Optional; defaults below. */
  tutor?: Partial<TutorConfig>;
}

export interface TutorConfig {
  /** Path to the claude executable (default: `claude` on PATH, or the PREP_CLAUDE_BIN env var). */
  claudeBin: string;
  /** Model alias passed as --model; null = your Claude Code default. */
  model: string | null;
  /** Headless sessions can't show permission prompts: auto = classifier decides, dontAsk = allowlist only. */
  permissionMode: 'auto' | 'dontAsk' | 'acceptEdits';
  /** Always-allowed tools (permission rule syntax). */
  allowedTools: string[];
  /** Spoken replies: 'kokoro' = local neural voice (default), 'browser' = the browser's built-in voices only. */
  tts: 'kokoro' | 'browser';
  /** Kokoro model precision; fp32 is fastest on desktop CPUs. */
  ttsDtype: 'fp32' | 'q8' | 'q4';
}

export const DEFAULT_TUTOR_CONFIG: TutorConfig = {
  claudeBin: 'claude',
  model: null,
  permissionMode: 'auto',
  allowedTools: ['Bash(npx prep:*)', 'Read', 'Glob', 'Grep', 'Edit(problems/**)', 'Write(problems/**)'],
  tts: 'kokoro',
  ttsDtype: 'fp32',
};

export function tutorConfig(cfg: PrepConfig): TutorConfig {
  return { ...DEFAULT_TUTOR_CONFIG, ...(cfg.tutor ?? {}) };
}

/** Repo root: PREP_ROOT env var, else two levels up from core/src. */
export const REPO_ROOT = process.env.PREP_ROOT
  ? path.resolve(process.env.PREP_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const paths = {
  root: REPO_ROOT,
  config: path.join(REPO_ROOT, 'prep.config.json'),
  db: process.env.PREP_DB ? path.resolve(process.env.PREP_DB) : path.join(REPO_ROOT, 'data', 'prep.db'),
  sheets: path.join(REPO_ROOT, 'data', 'sheets'),
  backups: path.join(REPO_ROOT, 'data', 'backups'),
  problems: path.join(REPO_ROOT, 'problems'),
  harness: path.join(REPO_ROOT, 'harness'),
};

export function validateConfig(cfg: PrepConfig): void {
  const errors: string[] = [];
  const w = cfg.rating.rubricWeights;
  const sum = w.correctness + w.optimality + w.approach + w.codeQuality + w.communication + w.independence;
  if (Math.abs(sum - 1) > 1e-6) errors.push(`rating.rubricWeights must sum to 1 (got ${sum})`);
  if (cfg.rating.hintCaps.length !== 5) errors.push('rating.hintCaps must have 5 entries (hint levels 0-4)');
  if (cfg.rating.hintNames.length !== cfg.rating.hintCaps.length) errors.push('rating.hintNames must match hintCaps length');
  for (let i = 1; i < cfg.rating.hintCaps.length; i++) {
    if (cfg.rating.hintCaps[i] > cfg.rating.hintCaps[i - 1]) errors.push('rating.hintCaps must be non-increasing');
  }
  const labels = cfg.rating.labels;
  for (let i = 1; i < labels.length; i++) {
    if (labels[i].min <= labels[i - 1].min) errors.push('rating.labels must be sorted by ascending min');
  }
  if (cfg.spacedRepetition.lowThreshold > cfg.spacedRepetition.highThreshold) {
    errors.push('spacedRepetition.lowThreshold must be <= highThreshold');
  }
  if (errors.length) throw new Error(`Invalid prep.config.json:\n  - ${errors.join('\n  - ')}`);
}

let cached: PrepConfig | null = null;

export function loadConfig(file = paths.config): PrepConfig {
  if (cached && file === paths.config) return cached;
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as PrepConfig;
  validateConfig(cfg);
  if (file === paths.config) cached = cfg;
  return cfg;
}
