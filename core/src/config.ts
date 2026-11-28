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
    /** Rating levels, ascending `min`; `meaning` is a one-line description shown in the UI. */
    labels: { min: number; label: string; meaning?: string }[];
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
    /** An attempt is a struggle (and the problem gets reviewed) if any of these holds, or not all tests passed. */
    struggle: { outcomeBelow: number; hintLevelAtLeast: number; approachBelow: number; independenceBelow: number };
    /** Clean reviews in a row that take a problem out of the review queue. */
    graduateAfterCleanReviews: number;
  };
  selection: {
    maxReviewsPerSession: number;
    weakTopicMargin: number;
    hardPromotionThreshold: number;
    failOutcomeThreshold: number;
    consecutiveFailsToDrop: number;
  };
  weaknesses: { cleanDemonstrationsToResolve: number };
  forecast: ForecastConfig;
  runner: { perTestTimeoutMs: number };
  ports: { web: number; api: number };
  /** Voice tutor: the web server drives a headless Claude Code session (`claude -p`). Optional; defaults below. */
  tutor?: Partial<TutorConfig>;
  /** Speech recognition for voice mode. Optional; defaults below. */
  stt?: Partial<SttConfig>;
  /** Drill page (generated questions on a weakness). Optional; defaults below. */
  drill?: Partial<DrillConfig>;
  /** Streaks, quests and badges. Optional; defaults below. */
  gamification?: Partial<GamificationConfig>;
}

export interface DrillConfig {
  /** Questions per drill on one weakness. */
  questions: number;
  /** Questions in a mixed drill across all open weaknesses (spread over them, least recently drilled first). */
  mixedQuestions: number;
  /** Model that writes drill questions (null = your Claude Code default). */
  generationModel: string | null;
  /** Model that grades typed answers (small and fast is fine). */
  gradingModel: string | null;
}

export interface GamificationConfig {
  /** A streak freeze is earned every `freezeEvery` active days in a row (at most `maxFreezes` banked); one is spent per missed day. */
  streak: { freezeEvery: number; maxFreezes: number };
  /** How many daily and weekly quests to offer. */
  quests: { daily: number; weekly: number };
  /** "Par" active minutes per difficulty, for the under-par quest; Speedrunner is a medium in half of par. */
  parMinutes: Record<Difficulty, number>;
  /** Topic rating for the Topic Master badge (with 5 solves in the topic). */
  topicMasterRating: number;
}

export const DEFAULT_GAMIFICATION_CONFIG: GamificationConfig = {
  streak: { freezeEvery: 7, maxFreezes: 2 },
  quests: { daily: 3, weekly: 2 },
  parMinutes: { easy: 15, medium: 30, hard: 50 },
  topicMasterRating: 1400,
};

export function gamificationConfig(cfg: PrepConfig): GamificationConfig {
  const g = cfg.gamification ?? {};
  const d = DEFAULT_GAMIFICATION_CONFIG;
  return {
    streak: { ...d.streak, ...(g.streak ?? {}) },
    quests: { ...d.quests, ...(g.quests ?? {}) },
    parMinutes: { ...d.parMinutes, ...(g.parMinutes ?? {}) },
    topicMasterRating: g.topicMasterRating ?? d.topicMasterRating,
  };
}

export const DEFAULT_DRILL_CONFIG: DrillConfig = { questions: 5, mixedQuestions: 8, generationModel: null, gradingModel: 'haiku' };

export function drillConfig(cfg: PrepConfig): DrillConfig {
  return { ...DEFAULT_DRILL_CONFIG, ...(cfg.drill ?? {}) };
}

export interface SttConfig {
  /** 'whisper' = local faster-whisper helper (falls back to the browser if unavailable); 'browser' = Chrome's recognition. */
  engine: 'whisper' | 'browser';
  /** Python interpreter for the helper; null = data/stt/venv (created by `prep stt-setup`), else `python`. */
  python: string | null;
  /** Whisper model on the GPU (any faster-whisper name, e.g. large-v3-turbo, distil-large-v3, small.en). */
  model: string;
  device: 'auto' | 'cuda' | 'cpu';
  /** CTranslate2 compute type; auto = int8_float16 on CUDA, int8 on CPU. */
  computeType: string;
  /** Smaller model used when device is auto and no GPU is usable. */
  cpuModel: string;
  /** Beam search width: 5 is more accurate, 1 is faster. */
  beamSize: number;
  /** Extra words to bias recognition toward (added to the built-in programming glossary). */
  extraVocabulary: string[];
  /** Speech detection: Silero VAD probability that counts as speech (0–1). */
  vadThreshold: number;
  /** Sounds shorter than this are ignored (coughs, clicks). */
  minSpeechMs: number;
  /** While you talk, re-transcribe the audio so far this often for the live caption (0 = off). */
  previewMs: number;
}

export const DEFAULT_STT_CONFIG: SttConfig = {
  engine: 'whisper',
  python: null,
  model: 'large-v3-turbo',
  device: 'auto',
  computeType: 'auto',
  cpuModel: 'small.en',
  beamSize: 5,
  extraVocabulary: [],
  vadThreshold: 0.5,
  minSpeechMs: 250,
  previewMs: 1200,
};

export function sttConfig(cfg: PrepConfig): SttConfig {
  return { ...DEFAULT_STT_CONFIG, ...(cfg.stt ?? {}) };
}

export interface ForecastConfig {
  /** Pace is measured over the last N days of solving. */
  windowDays: number;
  /** A short history is still treated as at least this many days, so one good day doesn't predict a sprint. */
  minSpanDays: number;
  /** Fewer solves than this in the window → no forecast yet. */
  minSolves: number;
  /** Relative effort per difficulty (medium = 1): pace and remaining work are measured in these units. */
  difficultyEffort: Record<Difficulty, number>;
  /** Gaps between activity events longer than this count as a break, not as solving time. */
  idleGapMin: number;
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
  /** Start a fresh tutor conversation (old transcript archived) after this many idle hours; /prep-start always does. */
  freshConversationAfterHours: number;
}

export const DEFAULT_TUTOR_CONFIG: TutorConfig = {
  claudeBin: 'claude',
  model: null,
  permissionMode: 'auto',
  allowedTools: ['Bash(npx prep:*)', 'Read', 'Glob', 'Grep', 'Edit(problems/**)', 'Write(problems/**)'],
  tts: 'kokoro',
  ttsDtype: 'fp32',
  freshConversationAfterHours: 4,
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
  const st = cfg.spacedRepetition.struggle;
  if (!st) errors.push('spacedRepetition.struggle is missing');
  else {
    for (const k of ['outcomeBelow', 'approachBelow', 'independenceBelow'] as const) {
      if (!(st[k] >= 0 && st[k] <= 1)) errors.push(`spacedRepetition.struggle.${k} must be between 0 and 1`);
    }
    if (!(Number.isInteger(st.hintLevelAtLeast) && st.hintLevelAtLeast >= 1 && st.hintLevelAtLeast <= 5)) {
      errors.push('spacedRepetition.struggle.hintLevelAtLeast must be an integer 1–5 (5 = hints never count)');
    }
  }
  const g = cfg.spacedRepetition.graduateAfterCleanReviews;
  if (!(Number.isInteger(g) && g >= 1)) errors.push('spacedRepetition.graduateAfterCleanReviews must be an integer >= 1');
  const f = cfg.forecast;
  if (!f) errors.push('forecast section is missing');
  else {
    if (!(f.windowDays >= 7)) errors.push('forecast.windowDays must be >= 7');
    if (!(f.minSpanDays >= 1 && f.minSpanDays <= f.windowDays)) errors.push('forecast.minSpanDays must be between 1 and windowDays');
    if (!(Number.isInteger(f.minSolves) && f.minSolves >= 1)) errors.push('forecast.minSolves must be an integer >= 1');
    for (const d of DIFFICULTIES) {
      if (!(f.difficultyEffort?.[d] > 0)) errors.push(`forecast.difficultyEffort.${d} must be > 0`);
    }
    if (!(f.idleGapMin > 0)) errors.push('forecast.idleGapMin must be > 0');
  }
  const t = cfg.tutor ?? {};
  if (t.permissionMode && !['auto', 'dontAsk', 'acceptEdits'].includes(t.permissionMode)) {
    errors.push('tutor.permissionMode must be "auto", "dontAsk" or "acceptEdits"');
  }
  if (t.tts && !['kokoro', 'browser'].includes(t.tts)) errors.push('tutor.tts must be "kokoro" or "browser"');
  if (t.ttsDtype && !['fp32', 'q8', 'q4'].includes(t.ttsDtype)) errors.push('tutor.ttsDtype must be "fp32", "q8" or "q4"');
  if (t.allowedTools && !Array.isArray(t.allowedTools)) errors.push('tutor.allowedTools must be an array of permission rules');
  if (t.freshConversationAfterHours !== undefined && !(t.freshConversationAfterHours > 0)) {
    errors.push('tutor.freshConversationAfterHours must be > 0');
  }
  const dr = cfg.drill ?? {};
  if (dr.questions !== undefined && !(Number.isInteger(dr.questions) && dr.questions >= 3 && dr.questions <= 10)) {
    errors.push('drill.questions must be an integer 3–10');
  }
  if (dr.mixedQuestions !== undefined && !(Number.isInteger(dr.mixedQuestions) && dr.mixedQuestions >= 3 && dr.mixedQuestions <= 15)) {
    errors.push('drill.mixedQuestions must be an integer 3–15');
  }
  const gm = gamificationConfig(cfg);
  if (!(Number.isInteger(gm.streak.freezeEvery) && gm.streak.freezeEvery >= 1)) errors.push('gamification.streak.freezeEvery must be an integer >= 1');
  if (!(Number.isInteger(gm.streak.maxFreezes) && gm.streak.maxFreezes >= 0)) errors.push('gamification.streak.maxFreezes must be an integer >= 0');
  if (!(Number.isInteger(gm.quests.daily) && gm.quests.daily >= 1 && gm.quests.daily <= 6)) errors.push('gamification.quests.daily must be an integer 1–6');
  if (!(Number.isInteger(gm.quests.weekly) && gm.quests.weekly >= 1 && gm.quests.weekly <= 4)) errors.push('gamification.quests.weekly must be an integer 1–4');
  for (const d of DIFFICULTIES) if (!(gm.parMinutes[d] > 0)) errors.push(`gamification.parMinutes.${d} must be > 0`);
  const s = cfg.stt ?? {};
  if (s.engine && !['whisper', 'browser'].includes(s.engine)) errors.push('stt.engine must be "whisper" or "browser"');
  if (s.device && !['auto', 'cuda', 'cpu'].includes(s.device)) errors.push('stt.device must be "auto", "cuda" or "cpu"');
  if (s.beamSize !== undefined && !(Number.isInteger(s.beamSize) && s.beamSize >= 1)) errors.push('stt.beamSize must be an integer >= 1');
  if (s.vadThreshold !== undefined && !(s.vadThreshold > 0 && s.vadThreshold < 1)) errors.push('stt.vadThreshold must be between 0 and 1');
  if (s.minSpeechMs !== undefined && !(s.minSpeechMs >= 0)) errors.push('stt.minSpeechMs must be >= 0');
  if (s.previewMs !== undefined && !(s.previewMs === 0 || s.previewMs >= 300)) errors.push('stt.previewMs must be 0 (off) or >= 300');
  if (s.extraVocabulary !== undefined && !Array.isArray(s.extraVocabulary)) errors.push('stt.extraVocabulary must be an array of strings');
  if (cfg.ports.web === cfg.ports.api) errors.push('ports.web and ports.api must differ');
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
