import type { RatingLevel } from '../api';

/** Index of the level a rating falls in (levels sorted by ascending `min`). */
export function levelIndex(rating: number, levels: RatingLevel[]): number {
  let idx = 0;
  levels.forEach((l, i) => {
    if (rating >= l.min) idx = i;
  });
  return idx;
}

/** Colour token for level i: a sequential ramp, so higher levels read as "more". */
export const levelColor = (i: number, n: number) =>
  `var(--lvl-${n <= 1 ? 4 : Math.round((4 * i) / (n - 1))})`;

/** The rating range each segment draws: open-ended first and last levels get the width of their neighbour. */
function ranges(levels: RatingLevel[]): [number, number][] {
  const n = levels.length;
  const width = (i: number) => (i > 0 && i + 1 < n ? levels[i + 1].min - levels[i].min : 0);
  // Open-ended segments borrow the width of their closed neighbour (200 when there is none).
  const firstW = width(1) || 200;
  const lastW = width(n - 2) || 200;
  return levels.map((l, i) => {
    const lo = i === 0 ? (n > 1 ? levels[1].min - firstW : l.min) : l.min;
    const hi = i + 1 < n ? levels[i + 1].min : l.min + lastW;
    return [lo, hi];
  });
}

const rangeText = (levels: RatingLevel[], i: number) =>
  i === 0 ? `below ${levels[1]?.min ?? '∞'}` : levels[i + 1] ? `${levels[i].min}–${levels[i + 1].min - 1}` : `${levels[i].min}+`;

/**
 * The rating on a ladder of levels: coloured segments, a marker at the rating, the level's meaning and
 * the points to the next level. `compact` drops the meaning and the legend.
 */
export default function LevelScale({ rating, levels, compact = false }: { rating: number; levels: RatingLevel[]; compact?: boolean }) {
  if (levels.length === 0) return null;
  const n = levels.length;
  const cur = levelIndex(rating, levels);
  const [lo, hi] = ranges(levels)[cur];
  const within = Math.min(1, Math.max(0, (rating - lo) / (hi - lo)));
  const pos = ((cur + within) / n) * 100;
  const next = levels[cur + 1];
  const toNext = next ? Math.ceil(next.min - rating) : 0;

  return (
    <div className={`lvl ${compact ? 'compact' : ''}`}>
      <div className="lvl-bar" role="img" aria-label={`Rating ${Math.round(rating)}: ${levels[cur].label}, level ${cur + 1} of ${n}`}>
        {levels.map((l, i) => (
          <span
            key={l.label}
            className={`lvl-seg ${i === cur ? 'on' : i > cur ? 'ahead' : ''}`}
            style={{ background: levelColor(i, n) }}
            title={`${l.label} · ${rangeText(levels, i)}${l.meaning ? ` · ${l.meaning}` : ''}`}
          />
        ))}
        <span className="lvl-marker" style={{ left: `${pos}%` }} />
      </div>
      <div className="lvl-ticks">
        {levels.slice(1).map((l, i) => (
          <span key={l.min} style={{ left: `${((i + 1) / n) * 100}%` }}>
            {l.min}
          </span>
        ))}
      </div>
      <div className="lvl-foot">
        {!compact && levels[cur].meaning && <span className="lvl-meaning">{levels[cur].meaning}</span>}
        {next ? (
          <span className="lvl-next">
            <b>{toNext}</b> to <span style={{ color: levelColor(cur + 1, n) }}>{next.label}</span>
          </span>
        ) : (
          <span className="lvl-next">Top level</span>
        )}
      </div>
      {!compact && (
        <details className="lvl-help">
          <summary>What the levels mean</summary>
          <ul>
            {levels.map((l, i) => (
              <li key={l.label} className={i === cur ? 'on' : ''}>
                <span className="lvl-dot" style={{ background: levelColor(i, n) }} />
                <b>{l.label}</b>
                <span className="muted">{rangeText(levels, i)}</span>
                {l.meaning && <span>{l.meaning}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
