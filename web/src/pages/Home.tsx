import { Link, useNavigate } from 'react-router-dom';
import { dashApi, fmtDate, type Dashboard } from '../api';
import NavBar from '../components/NavBar';
import TutorPanel from '../components/TutorPanel';
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
    <section className="home-hero">
      <div className="home-track">DSA · Java 17</div>
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
      </div>
      {!t.connected && <p className="muted small">Connecting to the tutor…</p>}
      {busy && <p className="muted small">The tutor is working — follow along on the right.</p>}
      {data && (
        <div className="home-facts">
          <span>
            Sheet <b>{data.stats.prefs.sheetName}</b> · {data.stats.prefs.difficulty}
          </span>
          <span>
            Rating <b>{Math.round(data.stats.overall.rating)}</b> <span className="muted">({data.stats.overall.label})</span>
          </span>
          <span>
            <b>{data.stats.reviews.due}</b> review{data.stats.reviews.due === 1 ? '' : 's'} due
          </span>
          <span>
            <b>{data.stats.weaknesses.active}</b> active weakness{data.stats.weaknesses.active === 1 ? '' : 'es'}
          </span>
          <span>
            <b>{data.stats.completion.solved}</b>/{data.stats.completion.total} solved
          </span>
        </div>
      )}
    </section>
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
