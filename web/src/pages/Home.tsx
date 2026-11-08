import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ProblemListItem } from '../api';
import TutorPanel from '../components/TutorPanel';

/** Landing page: the voice tutor, plus problems on disk. The full dashboard arrives in phase 6. */
export default function Home() {
  const [items, setItems] = useState<ProblemListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.problems().then(setItems, (e) => setError(e.message));
  }, []);

  return (
    <div className="home">
      <header className="topbar">
        <span className="brand">PrepCoach</span>
        <span className="muted">Talk to your tutor — problems open automatically when one is served.</span>
      </header>
      <div className="home-grid">
        <TutorPanel />
        <aside className="home-side">
          <h2>Problems on disk</h2>
          {error && <div className="banner error">API unreachable: {error}</div>}
          {!items && !error && <p className="muted">Loading…</p>}
          {items?.length === 0 && <p className="muted">No problems generated yet.</p>}
          <ul className="problem-list">
            {items?.map((p) => (
              <li key={p.slug}>
                <Link to={`/problem/${p.slug}`}>{p.title}</Link>
                <span className={`badge ${p.difficulty}`}>{p.difficulty}</span>
                <span className="muted small">
                  {p.topic}
                  {p.attempt && ` · ${p.attempt.status.replace('_', ' ')}`}
                </span>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}
