import { useCallback, useEffect, useRef, useState } from 'react';
import { gameApi, type Rewards } from '../api';
import { confettiFx, reducedMotion, sounds } from '../fx';
import { useTutor } from '../tutor/TutorContext';
import { usePolling } from '../usePolling';
import LevelScale, { levelColor, levelIndex } from './LevelScale';

/** Counts from `from` to `to` (ease-out) once `run` is true; jumps straight there when animations are off. */
function useCountUp(from: number, to: number, run: boolean, animate: boolean, ms = 1200): number {
  const [v, setV] = useState(from);
  useEffect(() => {
    if (!run) return;
    if (!animate) return setV(to);
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      setV(from + (to - from) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [from, to, run, animate, ms]);
  return v;
}

const sign = (d: number) => `${d >= 0 ? '+' : '−'}${Math.abs(Math.round(d))}`;

/**
 * The reward moment: after an attempt is recorded (or a drill finished), a card celebrates what changed — rating,
 * level up, badges, quests, streak, personal bests. Rewards are derived on the server; this only shows them once.
 */
export default function RewardOverlay() {
  const { turns, settings } = useTutor();
  const { data } = usePolling(gameApi.pending, 5000, [turns]);
  const [shown, setShown] = useState<Rewards | null>(null);
  const dismissed = useRef<string | null>(null);

  useEffect(() => {
    if (data && !data.empty && !shown && dismissed.current !== data.until) setShown(data);
  }, [data, shown]);

  const close = useCallback(() => {
    if (!shown) return;
    dismissed.current = shown.until;
    void gameApi.ack(shown.until).catch(() => {});
    setShown(null);
  }, [shown]);

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, close]);

  // Sounds and confetti, scaled to the biggest thing that happened.
  useEffect(() => {
    if (!shown) return;
    const effects = settings.rewardEffects && !reducedMotion();
    const epic = !!shown.levelUp || shown.badges.some((b) => b.rarity === 'epic');
    const rare = shown.badges.length > 0;
    const t = window.setTimeout(() => {
      if (settings.rewardSounds) (epic ? sounds.levelUp : rare ? sounds.badge : sounds.chime)();
      if (effects && epic) confettiFx.big();
      else if (effects && shown.badges.some((b) => b.rarity === 'rare')) confettiFx.burst();
    }, 350);
    return () => window.clearTimeout(t);
    // only when a new reward set opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown?.until]);

  if (!shown) return null;
  return <RewardCard r={shown} animate={settings.rewardEffects && !reducedMotion()} onClose={close} />;
}

function RewardCard({ r, animate, onClose }: { r: Rewards; animate: boolean; onClose: () => void }) {
  const solve = r.solves.at(-1);
  const levels = r.levels;
  const before = r.overall?.before ?? 0;
  const after = r.overall?.after ?? 0;
  const rating = useCountUp(before, after, !!r.overall, animate);
  const primary = solve?.changes.find((c) => c.isPrimary);

  const title = r.levelUp
    ? 'Level up!'
    : solve
      ? solve.solved
        ? r.solves.length > 1
          ? `${r.solves.length} attempts recorded`
          : `Solved ${solve.title}`
        : `${solve.title} recorded`
      : r.drills
        ? `Drill${r.drills > 1 ? 's' : ''} done`
        : 'Nice work';

  let delay = 0;
  const next = () => `${(delay += 0.12)}s`;

  return (
    <div className="rw-backdrop" onClick={onClose} role="presentation">
      <div className={`rw-card ${animate ? 'anim' : ''} ${r.levelUp ? 'levelup' : ''}`} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="rw-kicker">{r.levelUp ? `${r.levelUp.from} → ${r.levelUp.to}` : solve?.isReview ? 'Review' : 'Progress'}</div>
        <h2 className="rw-title">
          {r.levelUp ? (
            <>
              Level up: <span style={{ color: levelColor(levelIndex(after, levels), levels.length) }}>{r.levelUp.to}</span>
            </>
          ) : (
            title
          )}
        </h2>
        {r.levelUp?.meaning && <p className="rw-sub">{r.levelUp.meaning}</p>}

        {r.overall && (
          <div className="rw-rating rw-item" style={{ animationDelay: next() }}>
            <div className="rw-rating-row">
              <span className="rw-rating-num">{Math.round(rating)}</span>
              <span className={`rw-delta ${after >= before ? 'up' : 'down'}`}>{sign(after - before)}</span>
              {primary && (
                <span className="rw-topic">
                  {primary.topic} {Math.round(primary.before)} → {Math.round(primary.after)} <b className={primary.after >= primary.before ? 'up' : 'down'}>{sign(primary.after - primary.before)}</b>
                </span>
              )}
            </div>
            <LevelScale rating={rating} levels={levels} compact />
          </div>
        )}

        {r.streak.current > 0 && (
          <div className="rw-streak rw-item" style={{ animationDelay: next() }}>
            <span className="rw-flame">🔥</span>
            <b>{r.streak.current}-day streak</b>
            {r.streak.extended && <span className="rw-plus">+1 today</span>}
            {r.streak.freezes > 0 && <span className="muted">· ❄ {r.streak.freezes} freeze{r.streak.freezes > 1 ? 's' : ''}</span>}
          </div>
        )}

        {r.badges.length > 0 && (
          <div className="rw-badges">
            {r.badges.map((b) => (
              <div key={b.id} className={`rw-badge rw-item ${b.rarity}`} style={{ animationDelay: next() }}>
                <span className="rw-badge-icon">{b.icon}</span>
                <span>
                  <b>{b.name}</b>
                  <span className="rw-badge-desc">{b.description}</span>
                </span>
                <span className={`rarity ${b.rarity}`}>{b.rarity}</span>
              </div>
            ))}
          </div>
        )}

        {(r.quests.length > 0 || r.bests.length > 0) && (
          <ul className="rw-list">
            {r.quests.map((q) => (
              <li key={q.id} className="rw-item" style={{ animationDelay: next() }}>
                <span className="rw-check">✓</span> Quest complete: {q.title}
              </li>
            ))}
            {r.bests.map((b) => (
              <li key={b.kind} className="rw-item" style={{ animationDelay: next() }}>
                <span className="rw-check">⚡</span> {b.text}
              </li>
            ))}
          </ul>
        )}

        <button className="rw-continue" onClick={onClose} autoFocus>
          Continue
        </button>
      </div>
    </div>
  );
}
