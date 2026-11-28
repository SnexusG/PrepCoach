import { Link, useNavigate } from 'react-router-dom';
import { dashApi, fmtDate, fmtDay, forecastHeadline, type Dashboard } from '../api';
import LevelScale, { levelColor, levelIndex } from '../components/LevelScale';
import NavBar from '../components/NavBar';
import TutorPanel from '../components/TutorPanel';
import { QuestList } from './Trophies';
import { useTutor } from '../tutor/TutorContext';
import { usePolling } from '../usePolling';

const SOON: Record<string, string> = {
  system_design: 'Design a URL shortener, a rate limiter… in a 45-minute mock interview.',
  java: 'Collections, concurrency, JVM, generics — concept questions and small exercises.',
};

/** The one obvious next step: start a session, resume the open problem, or get the next one. */
function DsaCard({ data }: { data: Dashboard | null }) {
  const t = useTutor();
  const navigate = useNavigate();
  const busy = t.state === 'thinking' || t.state === 'starting';
  const open = data?.recent.find((a) => a.status === 'in_progress') ?? null;
  const session = data?.session ?? null;

  const go = (cmd: string, voice: boolean) => {
    if (voice && t.recognitionSupported && !t.listening) t.startMic();
    t.send(cmd);
  };

  let title: string;
  let lead: string;
  let primary: { label: string; run: () => void };
  let secondary: { label: string; run: () => void } | null;

  if (open) {
    title = 'Pick up where you left off';
    lead = `${open.title} · ${open.topic} · started ${fmtDate(open.startedAt)}`;
    primary = { label: `Resume ${open.title}`, run: () => navigate(`/problem/${open.slug}`) };
    secondary = null;
  } else if (session) {
    title = 'Session in progress';
    lead = `Session #${session.id} is active. Ready for another problem?`;
    primary = { label: '🎙 Next problem', run: () => go('/next', true) };
    secondary = { label: 'Next problem (type)', run: () => go('/next', false) };
  } else {
    title = 'Start a DSA session';
    lead = 'Your tutor checks your ratings, weaknesses and due reviews, then picks the right problem for you.';
    primary = { label: '🎙 Start with voice', run: () => go('/prep-start', true) };
    secondary = { label: 'Start (type instead)', run: () => go('/prep-start', false) };
  }

  return (
    <>
      <section className="home-hero">
        <div className="home-track">
          DSA · Java 17
          {data && (
            <span className="home-sheet">
              {data.stats.prefs.sheetName} · {data.stats.prefs.difficulty}
            </span>
          )}
        </div>
        <h1>{title}</h1>
        <p className="home-lead">{lead}</p>
        <div className="home-cta">
          <button className="cta" onClick={primary.run} disabled={busy || !t.connected}>
            {primary.label}
          </button>
          {secondary && (
            <button onClick={secondary.run} disabled={busy || !t.connected}>
              {secondary.label}
            </button>
          )}
          {!open && (data?.stats.weaknesses.active ?? 0) + (data?.stats.weaknesses.improving ?? 0) > 0 && (
            <button
              className="ghost"
              onClick={() => navigate('/drill?mixed=1')}
              disabled={busy || !t.connected}
              title="Mixed practice: quick questions across your focus areas"
            >
              ⚡ Quick drill
            </button>
          )}
        </div>
        {!t.connected && <p className="home-status">Connecting to the tutor…</p>}
        {busy && <p className="home-status">The tutor is working — follow along on the right.</p>}
      </section>
      {data && <ProgressCard data={data} />}
    </>
  );
}

/** Where you stand: rating and level, the three numbers that matter, and the finish forecast. */
function ProgressCard({ data }: { data: Dashboard }) {
  const { overall, completion, reviews, weaknesses } = data.stats;
  const game = data.game;
  const levels = data.labels;
  const idx = levelIndex(overall.rating, levels);
  const color = levelColor(idx, levels.length);
  const pct = completion.total ? (100 * completion.solved) / completion.total : 0;

  return (
    <section className="home-progress">
      <div className="home-rating">
        <div className="home-rating-num">
          <span className="home-rating-value">{Math.round(overall.rating)}</span>
          <span className="home-rating-level" style={{ color }}>
            {overall.label}
          </span>
          {levels[idx]?.meaning && <span className="home-rating-meaning">{levels[idx].meaning}</span>}
        </div>
        <LevelScale rating={overall.rating} levels={levels} compact />
      </div>

      <div className="home-stats">
        {game && (
          <Link to="/trophies" className={`home-stat streak ${game.activeToday ? 'lit' : ''}`}>
            <span className="home-stat-label">Streak</span>
            <span className="home-stat-value">
              <span className="home-flame">🔥</span>
              {game.streak}
              <span className="home-stat-of"> day{game.streak === 1 ? '' : 's'}</span>
            </span>
            <span className="home-stat-sub">{game.activeToday ? 'done for today ✓' : game.streak ? 'practise today to keep it' : 'solve one to start'}</span>
          </Link>
        )}
        <Link to="/dashboard" className="home-stat">
          <span className="home-stat-label">Solved</span>
          <span className="home-stat-value">
            {completion.solved}
            <span className="home-stat-of"> / {completion.total}</span>
          </span>
          <span className="meter">
            <span className="meter-fill" style={{ width: `${pct}%`, display: 'block' }} />
          </span>
        </Link>
        <Link to="/dashboard" className="home-stat">
          <span className="home-stat-label">Reviews due</span>
          <span className="home-stat-value">{reviews.due}</span>
          <span className="home-stat-sub">{reviews.upcoming7d} more this week</span>
        </Link>
        <Link to="/dashboard" className="home-stat">
          <span className="home-stat-label">Weaknesses</span>
          <span className="home-stat-value">{weaknesses.active}</span>
          <span className="home-stat-sub">
            active · {weaknesses.improving} improving
          </span>
        </Link>
      </div>

      {game && game.quests.length > 0 && (
        <div className="home-quests">
          <div className="home-quests-head">
            <span className="home-stat-label">Today’s quests</span>
            <Link to="/trophies" className="small">
              {game.badges}/{game.badgesTotal} badges →
            </Link>
          </div>
          <QuestList quests={game.quests.slice(0, game.quests.length - game.weeklyCount)} compact />
          <div className="home-stat-label home-week-label">This week</div>
          <QuestList quests={game.quests.slice(game.quests.length - game.weeklyCount)} compact />
        </div>
      )}

      <ForecastLine data={data} />
    </section>
  );
}

/** One line on when the sheet will be done, linking to the full forecast. */
function ForecastLine({ data }: { data: Dashboard }) {
  const f = data.stats.forecast;
  const t = f.target;
  const showGoal = t && !t.passed && f.status !== 'complete';
  return (
    <div className="home-forecast">
      <span className="home-forecast-text">
        {forecastHeadline(f, data.stats.prefs.sheetName)}
        {f.status === 'ok' && <span className="muted"> · {f.perWeek}/week</span>}
      </span>
      {showGoal && (
        <span className={`goal-pill ${t.onTrack ? 'ok' : t.onTrack === false ? 'behind' : ''}`}>
          Goal {fmtDay(t.date)}: {t.onTrack ? 'on track' : `needs ${t.requiredPerWeek}/week`}
        </span>
      )}
      <Link to="/dashboard" className="home-forecast-link">
        Forecast →
      </Link>
    </div>
  );
}

export default function Home() {
  const { turns } = useTutor();
  const { data, error } = usePolling(dashApi.dashboard, 5000, [turns]);
  const last = data?.recent.find((a) => a.status !== 'in_progress');

  return (
    <div className="dash-page">
      <NavBar />
      <div className="dash-layout">
        <main className="dash home">
          {error && <div className="banner error">Couldn’t load your progress: {error}</div>}
          <DsaCard data={data} />

          {last && (
            <p className="muted small home-last">
              Last attempt: <Link to={`/history?attempt=${last.id}`}>{last.title}</Link> ({last.status === 'abandoned' ? 'abandoned' : 'completed'},{' '}
              {fmtDate(last.finishedAt ?? last.startedAt)}) · <Link to="/dashboard">Full stats →</Link>
            </p>
          )}

          <div className="home-soon">
            {(data?.tracks ?? []).filter((tr) => !tr.enabled).map((tr) => (
              <div key={tr.id} className="home-soon-card">
                <div className="home-soon-head">
                  <b>{tr.name}</b>
                  <span className="pill">coming soon</span>
                </div>
                <p className="muted small">{SOON[tr.id] ?? ''}</p>
              </div>
            ))}
          </div>

          <p className="muted small home-tip">
            In a session you can just talk: “give me a hint”, “I’m done”, “skip this one”. The buttons under the chat do the same.
          </p>
        </main>
        <aside className="dash-tutor">
          <TutorPanel />
        </aside>
      </div>
    </div>
  );
}
