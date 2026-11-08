import type { Difficulty, PrepConfig } from './config';

/**
 * solved     – a completed attempt passed all tests
 * failed     – completed but never passed all tests (comes back via the review queue)
 * abandoned  – only abandoned attempts; still unsolved and eligible again
 * in_progress – currently open attempt
 * unsolved   – never attempted
 */
export type ProblemStatus = 'unsolved' | 'in_progress' | 'abandoned' | 'failed' | 'solved';

export interface ProblemInfo {
  slug: string;
  title: string;
  topic: string;
  difficulty: Difficulty;
  sheetOrder: number;
  status: ProblemStatus;
  /** ISO timestamp of the most recent abandonment, if any. */
  lastAbandonedAt?: string | null;
}

export interface TopicStat {
  topic: string;
  rating: number;
  attempts: number;
  /** Most recent first; completed non-review attempts in this topic. */
  recentOutcomes: { difficulty: Difficulty; outcome: number }[];
}

export interface ActiveWeakness {
  id: number;
  topic: string | null;
  description: string;
  timesObserved: number;
  lastSeen: string;
}

export interface DueReview {
  slug: string;
  dueDate: string;
}

export interface SelectionInput {
  problems: ProblemInfo[];
  topicStats: TopicStat[];
  activeWeaknesses: ActiveWeakness[];
  /** Sorted by due date, oldest first. */
  dueReviews: DueReview[];
  reviewsServedThisSession: number;
  /** Problems not to serve now (e.g. abandoned earlier this session). */
  excludeSlugs: string[];
  preferredDifficulty: Difficulty;
  filter?: { topic?: string; difficulty?: Difficulty };
  /** Allow reviews beyond the per-session cap ("give me more reviews"). */
  extraReviews?: boolean;
}

export type SelectionKind = 'review' | 'weakness' | 'weak_topic' | 'sheet';

export interface Selection {
  slug: string;
  title: string;
  topic: string;
  difficulty: Difficulty;
  kind: SelectionKind;
  isReview: boolean;
  reason: string;
  suggestions: string[];
}

const ELIGIBLE: ProblemStatus[] = ['unsolved', 'abandoned'];

function bySheetOrder(a: ProblemInfo, b: ProblemInfo) {
  return a.sheetOrder - b.sheetOrder;
}

function abandonedNote(p: ProblemInfo): string {
  if (p.status !== 'abandoned') return '';
  const when = p.lastAbandonedAt ? ` on ${p.lastAbandonedAt.slice(0, 10)}` : '';
  return ` You abandoned this one${when}, so it's still unsolved.`;
}

/** Topic-level progression suggestions (move up to hards / drop to easies). */
export function progressionSuggestions(
  stats: TopicStat[],
  preferred: Difficulty,
  cfg: PrepConfig,
): Map<string, string> {
  const out = new Map<string, string>();
  const s = cfg.selection;
  for (const t of stats) {
    const recentMediums = t.recentOutcomes.filter((o) => o.difficulty === 'medium').slice(0, s.consecutiveFailsToDrop);
    if (
      recentMediums.length === s.consecutiveFailsToDrop &&
      recentMediums.every((o) => o.outcome < s.failOutcomeThreshold)
    ) {
      out.set(
        t.topic,
        `${t.topic}: ${s.consecutiveFailsToDrop} mediums in a row went badly — consider a few easies (prep next --topic "${t.topic}" --difficulty easy).`,
      );
    } else if (t.rating >= s.hardPromotionThreshold && preferred !== 'hard') {
      out.set(
        t.topic,
        `${t.topic}: rating ${Math.round(t.rating)} ≥ ${s.hardPromotionThreshold} — ready to move up to hards (prep next --topic "${t.topic}" --difficulty hard).`,
      );
    }
  }
  return out;
}

export function selectNext(input: SelectionInput, cfg: PrepConfig): Selection | null {
  const exclude = new Set(input.excludeSlugs);
  const difficulty = input.filter?.difficulty ?? input.preferredDifficulty;
  const bySlug = new Map(input.problems.map((p) => [p.slug, p]));
  const progression = progressionSuggestions(input.topicStats, input.preferredDifficulty, cfg);

  const finish = (p: ProblemInfo, kind: SelectionKind, reason: string): Selection => {
    const suggestions: string[] = [];
    const own = progression.get(p.topic);
    if (own) suggestions.push(own);
    for (const [topic, s] of progression) if (topic !== p.topic) suggestions.push(s);
    return {
      slug: p.slug,
      title: p.title,
      topic: p.topic,
      difficulty: p.difficulty,
      kind,
      isReview: kind === 'review',
      reason,
      suggestions,
    };
  };

  const eligible = (p: ProblemInfo) => ELIGIBLE.includes(p.status) && !exclude.has(p.slug);
  const firstInTopic = (topic: string) =>
    input.problems.filter((p) => p.topic === topic && p.difficulty === difficulty && eligible(p)).sort(bySheetOrder)[0];

  // 1. Due spaced-repetition reviews (capped per session, skipped when a topic is requested).
  const reviewCapOk = input.extraReviews || input.reviewsServedThisSession < cfg.selection.maxReviewsPerSession;
  if (!input.filter?.topic && reviewCapOk) {
    for (const r of input.dueReviews) {
      const p = bySlug.get(r.slug);
      if (!p || exclude.has(p.slug)) continue;
      return finish(p, 'review', `Spaced-repetition review due since ${r.dueDate}.`);
    }
  }

  // Explicit topic request: next eligible problem in that topic.
  if (input.filter?.topic) {
    const p = firstInTopic(input.filter.topic);
    if (!p) return null;
    return finish(p, 'sheet', `Next ${difficulty} in ${p.topic} (requested).${abandonedNote(p)}`);
  }

  // 2a. Active weaknesses tied to a topic, most-observed first.
  const weaknesses = input.activeWeaknesses
    .filter((w) => w.topic)
    .sort((a, b) => b.timesObserved - a.timesObserved || b.lastSeen.localeCompare(a.lastSeen));
  for (const w of weaknesses) {
    const p = firstInTopic(w.topic!);
    if (p) {
      return finish(
        p,
        'weakness',
        `Targets your active weakness "${w.description}" (${w.topic}, seen ${w.timesObserved}×).${abandonedNote(p)}`,
      );
    }
  }

  // 2b. Lowest-rated attempted topic, if it is clearly weak.
  const attempted = input.topicStats.filter((t) => t.attempts > 0);
  if (attempted.length) {
    const avg = attempted.reduce((s, t) => s + t.rating, 0) / attempted.length;
    const weak = [...attempted]
      .sort((a, b) => a.rating - b.rating)
      .filter((t) => t.rating < cfg.rating.initial || t.rating < avg - cfg.selection.weakTopicMargin);
    for (const t of weak) {
      const p = firstInTopic(t.topic);
      if (p) {
        return finish(p, 'weak_topic', `${t.topic} is your lowest-rated topic (${Math.round(t.rating)}).${abandonedNote(p)}`);
      }
    }
  }

  // 3. Next unsolved in sheet order at the chosen difficulty.
  const next = input.problems.filter((p) => p.difficulty === difficulty && eligible(p)).sort(bySheetOrder)[0];
  if (next) return finish(next, 'sheet', `Next unsolved ${difficulty} in sheet order.${abandonedNote(next)}`);

  return null;
}
