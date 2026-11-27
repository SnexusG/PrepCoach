import type { PrepConfig } from './config';

/**
 * Rubric scores supplied by the tutor, each in [0, 1].
 * - correctness: only used when there are no test results (e.g. a verbal review);
 *   otherwise correctness is derived from tests passed.
 * - independence: optional tutor judgement (e.g. needed heavy steering without formal hints);
 *   it is always further scaled down by hints used. Defaults to 1.
 */
export interface Rubric {
  correctness?: number;
  optimality: number;
  approach: number;
  codeQuality: number;
  communication: number;
  independence?: number;
}

export interface OutcomeInput {
  rubric: Rubric;
  testsPassed: number;
  testsTotal: number;
  hintsUsed: number;
}

export interface OutcomeResult {
  /** Final outcome in [0, 1] after the hint cap. */
  score: number;
  /** Weighted score before the hint cap. */
  raw: number;
  /** Max achievable outcome at this hint level. */
  cap: number;
  components: Required<Rubric>;
}

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const clamp01 = (x: number) => clamp(Number.isFinite(x) ? x : 0, 0, 1);
const round = (x: number, digits = 4) => Math.round(x * 10 ** digits) / 10 ** digits;

export function maxHintLevel(cfg: PrepConfig): number {
  return cfg.rating.hintCaps.length - 1;
}

export function normalizeHints(hints: number, cfg: PrepConfig): number {
  return clamp(Math.round(hints), 0, maxHintLevel(cfg));
}

export function hintCap(hints: number, cfg: PrepConfig): number {
  return cfg.rating.hintCaps[normalizeHints(hints, cfg)];
}

/** All tests must pass for full credit; partial passes are scaled by partialCorrectnessFactor. */
export function computeCorrectness(
  testsPassed: number,
  testsTotal: number,
  cfg: PrepConfig,
  fallback?: number,
): number {
  if (testsTotal <= 0) return clamp01(fallback ?? 0);
  const ratio = clamp01(testsPassed / testsTotal);
  return ratio === 1 ? 1 : ratio * cfg.rating.partialCorrectnessFactor;
}

export function computeIndependence(hints: number, cfg: PrepConfig, tutorScore = 1): number {
  const h = normalizeHints(hints, cfg);
  return clamp01(tutorScore) * (1 - h / maxHintLevel(cfg));
}

export function computeOutcome(input: OutcomeInput, cfg: PrepConfig): OutcomeResult {
  const w = cfg.rating.rubricWeights;
  const components: Required<Rubric> = {
    correctness: computeCorrectness(input.testsPassed, input.testsTotal, cfg, input.rubric.correctness),
    optimality: clamp01(input.rubric.optimality),
    approach: clamp01(input.rubric.approach),
    codeQuality: clamp01(input.rubric.codeQuality),
    communication: clamp01(input.rubric.communication),
    independence: computeIndependence(input.hintsUsed, cfg, input.rubric.independence ?? 1),
  };
  const raw =
    w.correctness * components.correctness +
    w.optimality * components.optimality +
    w.approach * components.approach +
    w.codeQuality * components.codeQuality +
    w.communication * components.communication +
    w.independence * components.independence;
  const cap = hintCap(input.hintsUsed, cfg);
  return { score: round(Math.min(raw, cap)), raw: round(raw), cap, components };
}

/** Probability the learner "beats" the problem: 1/(1+10^((P−T)/400)). */
export function expectedScore(problemRating: number, topicRating: number): number {
  return 1 / (1 + 10 ** ((problemRating - topicRating) / 400));
}

export function kFactor(attemptsCount: number, cfg: PrepConfig): number {
  const k = cfg.rating.kFactor;
  return attemptsCount < k.provisionalAttempts ? k.provisional : k.standard;
}

export interface EloInput {
  topicRating: number;
  problemRating: number;
  outcome: number;
  /** Prior attempts in this topic (drives provisional K). */
  attemptsCount: number;
  /** 1 for primary topic, secondaryTopicWeight for secondary; multiplied by reviewWeight for reviews. */
  weight: number;
}

export interface EloResult {
  newRating: number;
  delta: number;
  expected: number;
  k: number;
}

export function eloUpdate(input: EloInput, cfg: PrepConfig): EloResult {
  const expected = expectedScore(input.problemRating, input.topicRating);
  const k = kFactor(input.attemptsCount, cfg);
  const delta = k * input.weight * (clamp01(input.outcome) - expected);
  const newRating = round(input.topicRating + delta, 2);
  return { newRating, delta: round(newRating - input.topicRating, 2), expected: round(expected), k };
}

/** Effective Elo weight for a topic update. */
export function updateWeight(isPrimary: boolean, isReview: boolean, cfg: PrepConfig): number {
  const base = isPrimary ? 1 : cfg.rating.secondaryTopicWeight;
  return isReview ? base * cfg.rating.reviewWeight : base;
}

/** Confidence weight in [minWeight, 1] growing linearly with attempts. */
export function confidenceWeight(attempts: number, cfg: PrepConfig): number {
  const c = cfg.rating.confidence;
  return Math.max(c.minWeight, Math.min(1, attempts / c.fullAttempts));
}

export function isLowConfidence(attempts: number, cfg: PrepConfig): boolean {
  return attempts < cfg.rating.confidence.lowAttempts;
}

export interface TopicRatingInfo {
  topic: string;
  rating: number;
  attempts: number;
}

/**
 * Overall rating = weighted average of topic ratings, weight = frequencyWeight × confidence.
 * Untouched topics still contribute at minimum confidence, pulling the overall toward the
 * initial rating until there is evidence.
 */
export function overallRating(topics: TopicRatingInfo[], frequencyWeights: Record<string, number>, cfg: PrepConfig): number {
  let num = 0;
  let den = 0;
  for (const t of topics) {
    const w = (frequencyWeights[t.topic] ?? 0.5) * confidenceWeight(t.attempts, cfg);
    num += w * t.rating;
    den += w;
  }
  return den === 0 ? cfg.rating.initial : round(num / den, 2);
}

export function ratingLabel(rating: number, cfg: PrepConfig): string {
  let label = cfg.rating.labels[0]?.label ?? '';
  for (const l of cfg.rating.labels) if (rating >= l.min) label = l.label;
  return label;
}

