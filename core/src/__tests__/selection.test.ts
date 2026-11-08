import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { progressionSuggestions, selectNext, type ProblemInfo, type SelectionInput, type TopicStat } from '../selection';

const cfg = loadConfig();

const P = (slug: string, topic: string, difficulty: ProblemInfo['difficulty'], sheetOrder: number, status: ProblemInfo['status'] = 'unsolved'): ProblemInfo => ({
  slug,
  title: slug,
  topic,
  difficulty,
  sheetOrder,
  status,
});

const problems: ProblemInfo[] = [
  P('contains-duplicate', 'Arrays & Hashing', 'easy', 1),
  P('group-anagrams', 'Arrays & Hashing', 'medium', 2),
  P('top-k-frequent', 'Arrays & Hashing', 'medium', 3),
  P('3sum', 'Two Pointers', 'medium', 4),
  P('container-water', 'Two Pointers', 'medium', 5),
  P('min-window', 'Sliding Window', 'hard', 6),
  P('number-of-islands', 'Graphs', 'medium', 7),
  P('clone-graph', 'Graphs', 'medium', 8),
];

const stat = (topic: string, rating = 1200, attempts = 0, recentOutcomes: TopicStat['recentOutcomes'] = []): TopicStat => ({
  topic,
  rating,
  attempts,
  recentOutcomes,
});

const base = (over: Partial<SelectionInput> = {}): SelectionInput => ({
  problems,
  topicStats: ['Arrays & Hashing', 'Two Pointers', 'Sliding Window', 'Graphs'].map((t) => stat(t)),
  activeWeaknesses: [],
  dueReviews: [],
  reviewsServedThisSession: 0,
  excludeSlugs: [],
  preferredDifficulty: 'medium',
  ...over,
});

describe('selectNext', () => {
  it('falls back to the next unsolved problem in sheet order at the chosen difficulty', () => {
    const s = selectNext(base(), cfg)!;
    expect(s.slug).toBe('group-anagrams');
    expect(s.kind).toBe('sheet');
  });

  it('serves a due review first, at most once per session', () => {
    const due = { dueReviews: [{ slug: '3sum', dueDate: '2026-11-07' }] };
    const first = selectNext(base(due), cfg)!;
    expect(first).toMatchObject({ slug: '3sum', kind: 'review', isReview: true });
    const second = selectNext(base({ ...due, reviewsServedThisSession: 1 }), cfg)!;
    expect(second.kind).not.toBe('review');
    const more = selectNext(base({ ...due, reviewsServedThisSession: 1, extraReviews: true }), cfg)!;
    expect(more.kind).toBe('review');
  });

  it('targets a topic-specific active weakness, most observed first', () => {
    const s = selectNext(
      base({
        activeWeaknesses: [
          { id: 1, topic: 'Two Pointers', description: 'skips duplicates wrong', timesObserved: 1, lastSeen: '2026-11-01' },
          { id: 2, topic: 'Graphs', description: 'forgets visited set in BFS', timesObserved: 3, lastSeen: '2026-10-01' },
          { id: 3, topic: null, description: "doesn't state complexity", timesObserved: 9, lastSeen: '2026-11-07' },
        ],
      }),
      cfg,
    )!;
    expect(s).toMatchObject({ slug: 'number-of-islands', kind: 'weakness' });
    expect(s.reason).toContain('forgets visited set');
  });

  it('targets the lowest-rated attempted topic when it is clearly weak', () => {
    const s = selectNext(
      base({ topicStats: [stat('Arrays & Hashing', 1300, 4), stat('Two Pointers', 1150, 2), stat('Graphs', 1200, 0)] }),
      cfg,
    )!;
    expect(s).toMatchObject({ slug: '3sum', kind: 'weak_topic' });
  });

  it('does not treat a topic as weak when ratings are close and above initial', () => {
    const s = selectNext(base({ topicStats: [stat('Arrays & Hashing', 1320, 4), stat('Two Pointers', 1300, 2)] }), cfg)!;
    expect(s.kind).toBe('sheet');
  });

  it('skips solved, failed and in-progress problems but re-serves abandoned ones', () => {
    const ps = problems.map((p) =>
      p.slug === 'group-anagrams'
        ? { ...p, status: 'solved' as const }
        : p.slug === 'top-k-frequent'
          ? { ...p, status: 'failed' as const }
          : p.slug === '3sum'
            ? { ...p, status: 'abandoned' as const, lastAbandonedAt: '2026-11-05T10:00:00Z' }
            : p,
    );
    const s = selectNext(base({ problems: ps }), cfg)!;
    expect(s.slug).toBe('3sum');
    expect(s.reason).toContain('abandoned');
    expect(s.reason).toContain('2026-11-05');
  });

  it('does not re-serve a problem excluded this session (e.g. just abandoned)', () => {
    const s = selectNext(base({ excludeSlugs: ['group-anagrams'] }), cfg)!;
    expect(s.slug).toBe('top-k-frequent');
  });

  it('honours explicit topic and difficulty filters (and skips reviews)', () => {
    const s = selectNext(
      base({ dueReviews: [{ slug: '3sum', dueDate: '2026-11-01' }], filter: { topic: 'Graphs' } }),
      cfg,
    )!;
    expect(s.slug).toBe('number-of-islands');
    const hard = selectNext(base({ filter: { difficulty: 'hard' } }), cfg)!;
    expect(hard.slug).toBe('min-window');
  });

  it('returns null when nothing is left', () => {
    expect(selectNext(base({ problems: problems.map((p) => ({ ...p, status: 'solved' as const })) }), cfg)).toBeNull();
  });
});

describe('progression suggestions', () => {
  it('suggests hards above the threshold', () => {
    const s = progressionSuggestions([stat('Trees', 1560, 8)], 'medium', cfg);
    expect(s.get('Trees')).toMatch(/move up to hards/);
  });

  it('suggests easies after two failed mediums in a row', () => {
    const s = progressionSuggestions(
      [stat('Graphs', 1150, 3, [{ difficulty: 'medium', outcome: 0.3 }, { difficulty: 'medium', outcome: 0.4 }])],
      'medium',
      cfg,
    );
    expect(s.get('Graphs')).toMatch(/easies/);
  });

  it('does not suggest easies if one of the last two mediums went well', () => {
    const s = progressionSuggestions(
      [stat('Graphs', 1150, 3, [{ difficulty: 'medium', outcome: 0.3 }, { difficulty: 'medium', outcome: 0.8 }])],
      'medium',
      cfg,
    );
    expect(s.has('Graphs')).toBe(false);
  });
});
