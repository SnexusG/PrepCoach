/** Badge definitions. Each one finds when (if ever) it was earned by walking history, so they unlock retroactively. */
import type { PrepConfig } from './config';
import { gamificationConfig } from './config';
import type { AchievementContext, HistAttempt } from './gamification';
import { addDays, toDateString } from './spacedRepetition';

export type Rarity = 'common' | 'rare' | 'epic';

export interface Unlock {
  at: string | null;
  /** [current, goal] for badges with a count to show while locked. */
  progress?: [number, number];
}

export interface AchievementDef {
  id: string;
  name: string;
  description: string;
  icon: string;
  rarity: Rarity;
  unlock: (ctx: AchievementContext) => Unlock;
}

/** The n-th item's timestamp, with progress toward n. */
function nth(times: string[], n: number): Unlock {
  return { at: times[n - 1] ?? null, progress: [Math.min(times.length, n), n] };
}

const solved = (ctx: AchievementContext) => ctx.h.attempts.filter((a) => a.solved);
const at = (a: HistAttempt | undefined) => a?.finishedAt ?? null;

/** First time `run` consecutive items satisfy `ok` (best run so far as progress). */
function firstRun(items: HistAttempt[], ok: (a: HistAttempt) => boolean, run: number): Unlock {
  let cur = 0;
  let best = 0;
  for (const a of items) {
    cur = ok(a) ? cur + 1 : 0;
    best = Math.max(best, cur);
    if (cur >= run) return { at: a.finishedAt, progress: [run, run] };
  }
  return { at: null, progress: [best, run] };
}

export function ACHIEVEMENTS(cfg: PrepConfig): AchievementDef[] {
  const g = gamificationConfig(cfg);
  const levelBadges: AchievementDef[] = cfg.rating.labels
    .filter((l) => l.min > cfg.rating.initial)
    .map((l, i) => ({
      id: `level-${l.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name: l.label,
      description: `Reach ${l.label} (${l.min}+ overall)`,
      icon: ['🎯', '💪', '👑', '🌟'][i] ?? '🌟',
      rarity: i === 0 ? 'rare' : 'epic',
      unlock: (ctx) => {
        const best = Math.max(cfg.rating.initial, ...ctx.h.overall.map((r) => r.rating));
        return { at: ctx.h.overall.find((r) => r.rating >= l.min)?.at ?? null, progress: [Math.round(best), l.min] };
      },
    }));

  return [
    { id: 'first-blood', name: 'First Blood', description: 'Solve your first problem', icon: '🩸', rarity: 'common', unlock: (c) => nth(solved(c).map((a) => a.finishedAt), 1) },
    { id: 'hardened', name: 'Hardened', description: 'Solve a hard problem', icon: '🪨', rarity: 'rare', unlock: (c) => ({ at: at(solved(c).find((a) => a.difficulty === 'hard')) }) },
    {
      id: 'clean-sheet',
      name: 'Clean Sheet',
      description: 'Solve 5 problems in a row without hints',
      icon: '🧼',
      rarity: 'rare',
      unlock: (c) => firstRun(c.h.attempts.filter((a) => a.status === 'completed'), (a) => a.solved && a.hints === 0, 5),
    },
    {
      id: 'speedrunner',
      name: 'Speedrunner',
      description: `Solve a medium in under ${Math.round(g.parMinutes.medium / 2)} active minutes`,
      icon: '⚡',
      rarity: 'rare',
      unlock: (c) => ({ at: at(solved(c).find((a) => a.difficulty !== 'easy' && a.activeSec != null && a.activeSec > 0 && a.activeSec <= (g.parMinutes.medium / 2) * 60)) }),
    },
    { id: 'flawless', name: 'Flawless', description: 'Score 0.95+ with no hints', icon: '💎', rarity: 'rare', unlock: (c) => ({ at: at(solved(c).find((a) => a.hints === 0 && (a.outcome ?? 0) >= 0.95)) }) },
    {
      id: 'comeback',
      name: 'Comeback',
      description: 'Solve a problem you once abandoned',
      icon: '🔁',
      rarity: 'common',
      unlock: (c) => {
        const abandoned = new Map<string, string>();
        for (const a of c.h.attempts) {
          if (a.status === 'abandoned') abandoned.set(a.slug, abandoned.get(a.slug) ?? a.finishedAt);
          else if (a.solved && abandoned.has(a.slug)) return { at: a.finishedAt };
        }
        return { at: null };
      },
    },
    { id: 'perfect-review', name: 'Perfect Review', description: 'Ace a review (0.9+)', icon: '📚', rarity: 'rare', unlock: (c) => ({ at: at(solved(c).find((a) => a.isReview && (a.outcome ?? 0) >= 0.9)) }) },
    { id: 'habit-breaker', name: 'Habit Breaker', description: 'Resolve a weakness', icon: '🔓', rarity: 'rare', unlock: (c) => nth(c.h.resolvedWeaknesses.map((w) => w.at), 1) },
    { id: 'probe-proof', name: 'Probe Proof', description: 'Handle 5 deliberate weakness probes cleanly', icon: '🛡️', rarity: 'rare', unlock: (c) => nth(c.h.handled.filter((x) => x.probed).map((x) => x.at), 5) },
    { id: 'driller', name: 'Driller', description: 'Finish 10 drills', icon: '🛠️', rarity: 'common', unlock: (c) => nth(c.h.drills.map((d) => d.at), 10) },
    {
      id: 'well-rounded',
      name: 'Well-Rounded',
      description: 'Solve problems in 5 different topics',
      icon: '🧭',
      rarity: 'common',
      unlock: (c) => {
        const seen = new Set<string>();
        const firsts: string[] = [];
        for (const a of solved(c)) if (!seen.has(a.topic)) seen.add(a.topic) && firsts.push(a.finishedAt);
        return nth(firsts, 5);
      },
    },
    {
      id: 'topic-master',
      name: 'Topic Master',
      description: `Get a topic to ${g.topicMasterRating}+ with 5 solves in it`,
      icon: '🏆',
      rarity: 'epic',
      unlock: (c) => {
        for (const r of c.h.topicRatings) {
          if (r.rating < g.topicMasterRating) continue;
          if (solved(c).filter((a) => a.topic === r.topic && a.finishedAt <= r.at).length >= 5) return { at: r.at };
        }
        return { at: null };
      },
    },
    {
      id: 'on-fire',
      name: 'On Fire',
      description: 'Keep a 7-day streak',
      icon: '🔥',
      rarity: 'rare',
      unlock: (c) => ({ at: c.streak.reachedOn[7] ?? null, progress: [Math.min(c.streak.longest, 7), 7] }),
    },
    {
      id: 'unstoppable',
      name: 'Unstoppable',
      description: 'Keep a 30-day streak',
      icon: '🚀',
      rarity: 'epic',
      unlock: (c) => ({ at: c.streak.reachedOn[30] ?? null, progress: [Math.min(c.streak.longest, 30), 30] }),
    },
    {
      id: 'questing',
      name: 'Questing',
      description: 'Finish all daily quests 7 days in a row',
      icon: '🗺️',
      rarity: 'epic',
      unlock: (c) => {
        let run = 0;
        let best = 0;
        let prev: string | null = null;
        for (const d of c.questDays) {
          const consecutive = prev !== null && toDateString(addDays(new Date(`${prev}T12:00:00`), 1)) === d.date;
          run = consecutive ? run + 1 : 1;
          prev = d.date;
          best = Math.max(best, run);
          if (run >= 7) return { at: d.at, progress: [7, 7] };
        }
        return { at: null, progress: [best, 7] };
      },
    },
    {
      id: 'centurion',
      name: 'Centurion',
      description: 'Solve 100 different problems',
      icon: '💯',
      rarity: 'epic',
      unlock: (c) => {
        const seen = new Set<string>();
        const firsts: string[] = [];
        for (const a of solved(c)) if (!seen.has(a.slug)) seen.add(a.slug) && firsts.push(a.finishedAt);
        return nth(firsts, 100);
      },
    },
    ...levelBadges,
  ];
}
