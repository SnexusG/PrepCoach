import { fmtDate, fmtMins, gameApi, type Achievement, type GameState, type Quest } from '../api';
import { levelColor } from '../components/LevelScale';
import NavBar from '../components/NavBar';
import TutorPanel from '../components/TutorPanel';
import { useTutor } from '../tutor/TutorContext';
import { usePolling } from '../usePolling';

// ---------------------------------------------------------------- quests

export function QuestList({ quests, compact = false }: { quests: Quest[]; compact?: boolean }) {
  return (
    <ul className={`quests ${compact ? 'compact' : ''}`}>
      {quests.map((q) => (
        <li key={q.id} className={q.done ? 'done' : ''}>
          <span className="q-check" aria-hidden>
            {q.done ? '✓' : ''}
          </span>
          <span className="q-title">{q.title}</span>
          {q.goal > 1 && (
            <span className="q-meter" title={`${q.progress} of ${q.goal}`}>
              <span style={{ width: `${(100 * q.progress) / q.goal}%` }} />
            </span>
          )}
          <span className="q-count">
            {q.progress}/{q.goal}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- heatmap

function Heatmap({ days }: { days: GameState['heatmap'] }) {
  const cell = 11;
  const gap = 3;
  // Columns are weeks (Monday on top); pad the first column so weekdays line up.
  const firstDow = (new Date(`${days[0].date}T12:00:00`).getDay() + 6) % 7;
  const cells = days.map((d, i) => ({ ...d, col: Math.floor((i + firstDow) / 7), row: (i + firstDow) % 7 }));
  const cols = cells[cells.length - 1].col + 1;
  const level = (n: number) => (n === 0 ? -1 : Math.min(4, n));
  const months = cells.filter((c) => c.date.endsWith('-01')).map((c) => ({ col: c.col, label: new Date(`${c.date}T12:00:00`).toLocaleDateString(undefined, { month: 'short' }) }));
  return (
    <svg className="heatmap" viewBox={`0 0 ${cols * (cell + gap)} ${7 * (cell + gap) + 14}`} role="img" aria-label="Practice activity over the last year">
      {months.map((m) => (
        <text key={m.col} x={m.col * (cell + gap)} y={9} className="hm-month">
          {m.label}
        </text>
      ))}
      {cells.map((c) => {
        const n = c.attempts + c.drills;
        const lv = level(n);
        return (
          <rect
            key={c.date}
            x={c.col * (cell + gap)}
            y={14 + c.row * (cell + gap)}
            width={cell}
            height={cell}
            rx={2}
            fill={lv < 0 ? 'var(--track)' : `var(--lvl-${lv})`}
          >
            <title>{`${c.date}: ${c.solves} solved${c.attempts > c.solves ? `, ${c.attempts - c.solves} unsolved` : ''}${c.drills ? `, ${c.drills} drill${c.drills > 1 ? 's' : ''}` : ''}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------- badges

function Badge({ a }: { a: Achievement }) {
  const locked = !a.unlockedAt;
  return (
    <div className={`badge-card ${a.rarity} ${locked ? 'locked' : ''}`} title={a.description}>
      <span className="badge-icon">{locked ? '🔒' : a.icon}</span>
      <b className="badge-name">{a.name}</b>
      <span className="badge-desc">{a.description}</span>
      {locked ? (
        a.progress && a.progress[1] > 1 ? (
          <span className="badge-progress">
            <span className="q-meter">
              <span style={{ width: `${(100 * a.progress[0]) / a.progress[1]}%` }} />
            </span>
            <span>
              {a.progress[0]}/{a.progress[1]}
            </span>
          </span>
        ) : null
      ) : (
        <span className="badge-date">{fmtDate(a.unlockedAt)}</span>
      )}
      <span className={`rarity ${a.rarity}`}>{a.rarity}</span>
    </div>
  );
}

// ---------------------------------------------------------------- page

export default function Trophies() {
  const { turns } = useTutor();
  const { data, error } = usePolling(gameApi.state, 10000, [turns]);

  return (
    <div className="dash-page">
      <NavBar />
      <div className="dash-layout">
        <main className="dash trophies">
          {error && <div className="banner error">Couldn’t load your trophies: {error}</div>}
          {!data && !error && <div className="page-msg">Loading…</div>}
          {data && <TrophiesBody g={data} />}
        </main>
        <aside className="dash-tutor">
          <TutorPanel />
        </aside>
      </div>
    </div>
  );
}

function TrophiesBody({ g }: { g: GameState }) {
  const unlocked = g.achievements.filter((a) => a.unlockedAt).sort((a, b) => b.unlockedAt!.localeCompare(a.unlockedAt!));
  const locked = g.achievements.filter((a) => !a.unlockedAt);
  const s = g.streak;
  return (
    <>
      <section className="card streak-card">
        <div className="streak-hero">
          <span className={`streak-flame ${s.activeToday ? 'lit' : ''}`}>🔥</span>
          <div>
            <div className="streak-num">
              {s.current} <span>day{s.current === 1 ? '' : 's'}</span>
            </div>
            <div className="muted small">
              {s.activeToday ? 'Practised today' : s.current ? 'Practise today to keep it going' : 'Solve or drill today to start a streak'}
            </div>
            <div className="streak-meta">
              <span>Longest {s.longest}</span>
              <span title="Earned every 7 days in a row; spent automatically on a missed day">❄ {s.freezes} freeze{s.freezes === 1 ? '' : 's'}</span>
            </div>
          </div>
        </div>
        <div className="streak-heat">
          <Heatmap days={g.heatmap} />
        </div>
      </section>

      <div className="grid2">
        <section className="card">
          <div className="card-head">
            <h2>Today’s quests</h2>
            <span className="muted small">new ones every day</span>
          </div>
          <QuestList quests={g.quests.daily} />
        </section>
        <section className="card">
          <div className="card-head">
            <h2>This week</h2>
            <span className="muted small">resets Monday</span>
          </div>
          <QuestList quests={g.quests.weekly} />
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Badges</h2>
          <span className="muted small">
            {unlocked.length} of {g.achievements.length} earned
          </span>
        </div>
        <div className="badge-grid">
          {[...unlocked, ...locked].map((a) => (
            <Badge key={a.id} a={a} />
          ))}
        </div>
      </section>

      <div className="grid2">
        <section className="card">
          <div className="card-head">
            <h2>Level journey</h2>
            <span className="muted small">overall DSA rating</span>
          </div>
          <ol className="journey">
            {g.levels.map((l, i) => (
              <li key={l.label} className={l.reachedAt ? 'reached' : ''}>
                <span className="journey-dot" style={{ background: l.reachedAt ? levelColor(i, g.levels.length) : undefined }} />
                <span className="journey-name">
                  <b>{l.label}</b> <span className="muted small">{i === 0 ? '' : `${l.min}+`}</span>
                  {l.meaning && <span className="muted small journey-meaning">{l.meaning}</span>}
                </span>
                <span className="muted small">{l.reachedAt ? fmtDate(l.reachedAt) : '—'}</span>
              </li>
            ))}
          </ol>
        </section>
        <section className="card">
          <div className="card-head">
            <h2>Personal bests</h2>
          </div>
          <dl className="bests">
            {(['easy', 'medium', 'hard'] as const).map((d) => {
              const b = g.bests.fastest[d];
              return (
                <div key={d}>
                  <dt>Fastest {d}</dt>
                  <dd>{b ? <>{fmtMins(b.activeSec)} <span className="muted small">{b.title}</span></> : '—'}</dd>
                </div>
              );
            })}
            <div>
              <dt>Best score</dt>
              <dd>
                {g.bests.bestOutcome ? (
                  <>
                    {g.bests.bestOutcome.outcome.toFixed(2)} <span className="muted small">{g.bests.bestOutcome.title}</span>
                  </>
                ) : (
                  '—'
                )}
              </dd>
            </div>
            <div>
              <dt>Longest streak</dt>
              <dd>
                {g.bests.longestStreak} day{g.bests.longestStreak === 1 ? '' : 's'}
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </>
  );
}
