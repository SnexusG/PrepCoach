import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ProblemListItem } from '../api';

/** Temporary landing page: the full dashboard arrives in phase 6. */
export default function Home() {
  const [items, setItems] = useState<ProblemListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.problems().then(setItems, (e) => setError(e.message));
  }, []);

  return (
    <div className="home">
      <h1>PrepCoach</h1>
      <p className="muted">
        Run <code>/prep-start</code> then <code>/next</code> in Claude Code — the problem opens here. The dashboard
        comes in the next phase.
      </p>
      <h2>Problems on disk</h2>
      {error && <div className="banner error">API unreachable: {error}</div>}
      {!items && !error && <p className="muted">Loading…</p>}
      {items?.length === 0 && <p className="muted">No problems generated yet.</p>}
      <ul className="problem-list">
        {items?.map((p) => (
          <li key={p.slug}>
            <Link to={`/problem/${p.slug}`}>{p.title}</Link>
            <span className={`badge ${p.difficulty}`}>{p.difficulty}</span>
            <span className="muted">{p.topic}</span>
            {p.attempt && <span className="muted">· last attempt: {p.attempt.status.replace('_', ' ')}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
