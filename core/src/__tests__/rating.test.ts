import { describe, expect, it } from 'vitest';
import { loadConfig, validateConfig, type PrepConfig } from '../config';
import {
  computeCorrectness,
  computeIndependence,
  computeOutcome,
  confidenceWeight,
  eloUpdate,
  expectedScore,
  hintCap,
  isLowConfidence,
  kFactor,
  overallRating,
  ratingLabel,
  updateWeight,
} from '../rating';

const cfg = loadConfig();
const perfect = { optimality: 1, approach: 1, codeQuality: 1, communication: 1 };

describe('config', () => {
  it('ships a valid config', () => expect(() => validateConfig(cfg)).not.toThrow());
  it('rejects rubric weights that do not sum to 1', () => {
    const bad: PrepConfig = structuredClone(cfg);
    bad.rating.rubricWeights.correctness = 0.5;
    expect(() => validateConfig(bad)).toThrow(/sum to 1/);
  });
});

describe('outcome score', () => {
  it('perfect solve with no hints scores 1.0', () => {
    const r = computeOutcome({ rubric: perfect, testsPassed: 12, testsTotal: 12, hintsUsed: 0 }, cfg);
    expect(r.score).toBe(1);
    expect(r.cap).toBe(1);
  });

  it('requires all tests for full correctness credit', () => {
    expect(computeCorrectness(12, 12, cfg)).toBe(1);
    expect(computeCorrectness(8, 10, cfg)).toBeCloseTo(0.56); // 0.8 × 0.7
    expect(computeCorrectness(0, 10, cfg)).toBe(0);
  });

  it('weights partial correctness into the outcome', () => {
    const r = computeOutcome({ rubric: perfect, testsPassed: 8, testsTotal: 10, hintsUsed: 0 }, cfg);
    expect(r.score).toBeCloseTo(0.35 * 0.56 + 0.65, 4); // 0.846
  });

  it('uses tutor correctness only when there are no tests', () => {
    const r = computeOutcome({ rubric: { ...perfect, correctness: 0.5 }, testsPassed: 0, testsTotal: 0, hintsUsed: 0 }, cfg);
    expect(r.components.correctness).toBe(0.5);
  });

  it('scales independence down by hints used', () => {
    expect(computeIndependence(0, cfg)).toBe(1);
    expect(computeIndependence(2, cfg)).toBe(0.5);
    expect(computeIndependence(4, cfg)).toBe(0);
    expect(computeIndependence(1, cfg, 0.8)).toBeCloseTo(0.6);
  });

  it('caps the outcome by hint level', () => {
    expect([0, 1, 2, 3, 4].map((h) => hintCap(h, cfg))).toEqual([1, 0.85, 0.7, 0.5, 0.25]);
    const nudge = computeOutcome({ rubric: perfect, testsPassed: 10, testsTotal: 10, hintsUsed: 1 }, cfg);
    expect(nudge.raw).toBeCloseTo(0.975);
    expect(nudge.score).toBe(0.85);
    const full = computeOutcome({ rubric: perfect, testsPassed: 10, testsTotal: 10, hintsUsed: 4 }, cfg);
    expect(full.score).toBe(0.25);
  });

  it('cap does not raise a weak raw score', () => {
    const r = computeOutcome(
      { rubric: { optimality: 0, approach: 0, codeQuality: 0, communication: 0 }, testsPassed: 0, testsTotal: 10, hintsUsed: 1 },
      cfg,
    );
    expect(r.score).toBeCloseTo(0.075); // independence only: 0.1 × 0.75
  });

  it('clamps out-of-range rubric values', () => {
    const r = computeOutcome(
      { rubric: { optimality: 5, approach: -1, codeQuality: 1, communication: 1 }, testsPassed: 1, testsTotal: 1, hintsUsed: 0 },
      cfg,
    );
    expect(r.components.optimality).toBe(1);
    expect(r.components.approach).toBe(0);
  });
});

describe('Elo', () => {
  it('expected score follows the logistic formula', () => {
    expect(expectedScore(1200, 1200)).toBe(0.5);
    expect(expectedScore(1400, 1200)).toBeCloseTo(0.24025, 4);
    expect(expectedScore(1100, 1200)).toBeCloseTo(0.64007, 4);
  });

  it('uses provisional K for the first attempts in a topic', () => {
    expect(kFactor(0, cfg)).toBe(48);
    expect(kFactor(4, cfg)).toBe(48);
    expect(kFactor(5, cfg)).toBe(24);
  });

  it('a perfect medium solve at 1200 gains ~36 points (provisional)', () => {
    const r = eloUpdate({ topicRating: 1200, problemRating: 1400, outcome: 1, attemptsCount: 0, weight: 1 }, cfg);
    expect(r.k).toBe(48);
    expect(r.delta).toBeCloseTo(36.47, 1);
    expect(r.newRating).toBeCloseTo(1236.47, 1);
  });

  it('a failed easy loses points', () => {
    const r = eloUpdate({ topicRating: 1200, problemRating: 1100, outcome: 0.1, attemptsCount: 10, weight: 1 }, cfg);
    expect(r.delta).toBeCloseTo(24 * (0.1 - 0.64007), 1);
    expect(r.newRating).toBeLessThan(1200);
  });

  it('matching expectation leaves rating unchanged', () => {
    const r = eloUpdate({ topicRating: 1400, problemRating: 1400, outcome: 0.5, attemptsCount: 10, weight: 1 }, cfg);
    expect(r.delta).toBe(0);
  });

  it('secondary topics and reviews update at reduced weight', () => {
    expect(updateWeight(true, false, cfg)).toBe(1);
    expect(updateWeight(false, false, cfg)).toBe(0.5);
    expect(updateWeight(true, true, cfg)).toBe(0.5);
    expect(updateWeight(false, true, cfg)).toBe(0.25);
    const primary = eloUpdate({ topicRating: 1200, problemRating: 1400, outcome: 1, attemptsCount: 0, weight: 1 }, cfg);
    const secondary = eloUpdate({ topicRating: 1200, problemRating: 1400, outcome: 1, attemptsCount: 0, weight: 0.5 }, cfg);
    expect(secondary.delta).toBeCloseTo(primary.delta / 2, 1);
  });
});

describe('overall rating, confidence, labels', () => {
  const freq = Object.fromEntries(cfg.topics.dsa.map((t) => [t.name, t.frequencyWeight]));

  it('is the initial rating with no attempts', () => {
    const topics = cfg.topics.dsa.map((t) => ({ topic: t.name, rating: 1200, attempts: 0 }));
    expect(overallRating(topics, freq, cfg)).toBe(1200);
  });

  it('weights by frequency × confidence', () => {
    const topics = [
      { topic: 'Trees', rating: 1500, attempts: 10 }, // weight 1.0 × 1.0
      { topic: 'Bit Manipulation', rating: 1000, attempts: 0 }, // weight 0.3 × 0.1
    ];
    const expected = (1500 * 1 + 1000 * 0.03) / 1.03;
    expect(overallRating(topics, freq, cfg)).toBeCloseTo(expected, 1);
  });

  it('confidence grows with attempts and flags low-confidence topics', () => {
    expect(confidenceWeight(0, cfg)).toBe(0.1);
    expect(confidenceWeight(5, cfg)).toBe(0.5);
    expect(confidenceWeight(20, cfg)).toBe(1);
    expect(isLowConfidence(2, cfg)).toBe(true);
    expect(isLowConfidence(3, cfg)).toBe(false);
  });

  it('maps ratings to labels', () => {
    expect(ratingLabel(1150, cfg)).toBe('Beginner');
    expect(ratingLabel(1200, cfg)).toBe('Developing');
    expect(ratingLabel(1399, cfg)).toBe('Developing');
    expect(ratingLabel(1400, cfg)).toBe('Interview-ready (mediums)');
    expect(ratingLabel(1650, cfg)).toBe('Strong');
  });
});
