import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Link, useSearchParams } from 'react-router-dom';
import remarkGfm from 'remark-gfm';
import { dashApi, fmtDate, fmtDateTime, fmtDelta, fmtMins, WEAKNESS_AREA_LABELS, type AttemptDetail, type AttemptSummary } from '../api';
import NavBar from '../components/NavBar';
import { useTutor } from '../tutor/TutorContext';
import { usePolling } from '../usePolling';
import { StatusText } from './Dashboard';

type Result = 'all' | 'solved' | 'partial' | 'abandoned' | 'in_progress';

const RUBRIC_ORDER = ['correctness', 'optimality', 'approach', 'codeQuality', 'communication', 'independence'];
const RUBRIC_LABEL: Record<string, string> = {
  correctness: 'Correctness',
  optimality: 'Optimality',
  approach: 'Approach',
  codeQuality: 'Code quality',
  communication: 'Communication',
  independence: 'Independence',
};

function resultOf(a: AttemptSummary): Exclude<Result, 'all'> {
  if (a.status !== 'completed') return a.status;
  return a.testsTotal != null && a.testsPassed === a.testsTotal ? 'solved' : 'partial';
}

function Detail({ id, onClose }: { id: number; onClose: () => void }) {
  const [d, setD] = useState<AttemptDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setD(null);
    setError(null);
    dashApi.attempt(id).then(setD, (e) => setError(e.message));
  }, [id]);

  if (error) return <aside className="detail"><div className="banner error">{error}</div></aside>;
  if (!d) return <aside className="detail"><div className="page-msg">Loading…</div></aside>;
  const comps = d.rubric?.components ?? {};

  return (
    <aside className="detail">
      <div className="detail-head">
        <div>
          <h2>{d.title}</h2>
          <div className="muted small">
            Attempt #{d.id} · {d.topic} · <span className={`badge ${d.difficulty}`}>{d.difficulty}</span>
            {d.isReview && <span className="pill review">review</span>}
          </div>
        </div>
        <span className="spacer" />
        <button className="small-btn" onClick={onClose} aria-label="Close details">✕</button>
      </div>

      <div className="facts">
        <div><label>Result</label><StatusText a={d} /></div>
        <div><label>Outcome</label>{d.outcomeScore == null ? '—' : `${Math.round(d.outcomeScore * 100)}%`}</div>
        <div><label>Rating Δ</label><span className={d.ratingDelta == null ? '' : d.ratingDelta >= 0 ? 'up' : 'down'}>{fmtDelta(d.ratingDelta)}</span></div>
        <div title={d.activeTimeSec == null ? 'Recorded before active-time tracking' : 'Breaks excluded'}><label>Active time</label>{fmtMins(d.activeTimeSec)}</div>
        <div title="From starting the problem to submitting it"><label>Start → finish</label>{fmtMins(d.solveTimeSec)}</div>
        <div><label>Hints</label>{d.hintsUsed}</div>
        <div><label>Started</label>{fmtDateTime(d.startedAt)}</div>
      </div>

      {d.tutorSummary && (
        <section>
          <h3>Tutor summary</h3>
          <p>{d.tutorSummary}</p>
        </section>
      )}

      {Object.keys(comps).length > 0 && (
        <section>
          <h3>Rubric</h3>
          <div className="rubric">
            {RUBRIC_ORDER.filter((k) => k in comps).map((k) => (
              <div className="meter-row" key={k} title={`${RUBRIC_LABEL[k]}: ${comps[k].toFixed(2)}`}>
                <span className="meter-name">{RUBRIC_LABEL[k]}</span>
                <div className="meter"><div className="meter-fill" style={{ width: `${comps[k] * 100}%` }} /></div>
                <span className="meter-num">{comps[k].toFixed(2)}</span>
              </div>
            ))}
          </div>
          {d.rubric?.cap != null && d.rubric.cap < 1 && <div className="muted small">Hint cap applied: max outcome {d.rubric.cap}</div>}
        </section>
      )}

      {d.ratingChanges.length > 0 && (
        <section>
          <h3>Rating changes</h3>
          <table className="table compact">
            <tbody>
              {d.ratingChanges.map((c) => (
                <tr key={c.topic}>
                  <td>{c.topic}{!c.isPrimary && <span className="muted small"> (secondary)</span>}</td>
                  <td className="num">{Math.round(c.ratingBefore * 10) / 10} → {Math.round(c.ratingAfter * 10) / 10}</td>
                  <td className={`num ${c.ratingAfter >= c.ratingBefore ? 'up' : 'down'}`}>{fmtDelta(c.ratingAfter - c.ratingBefore)}</td>
                  <td className="num muted small" title="Expected score before the attempt">exp {c.expected.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {(d.hints.length > 0 || d.weaknesses.length > 0) && (
        <section>
          <h3>Hints & weaknesses</h3>
          {d.hints.map((h) => (
            <div key={h.level} className="small">💡 Hint level {h.level} at {fmtDateTime(h.givenAt)}</div>
          ))}
          {d.weaknesses.map((w) => (
            <div key={w.id} className="small">
              {w.kind === 'observed' ? '⚠ slipped:' : '✓ handled well:'} {w.description}
              {w.note && <span> — {w.note}</span>}{' '}
              <span className="muted">({w.area ? WEAKNESS_AREA_LABELS[w.area] ?? w.area : (w.topic ?? 'general')} · {w.status})</span>
            </div>
          ))}
        </section>
      )}

      {d.notes && (
        <section>
          <h3>Notes</h3>
          <div className="notes">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{d.notes}</ReactMarkdown>
          </div>
        </section>
      )}

      {d.solution && (
        <section>
          <details>
            <summary>
              <h3 className="inline">Code</h3> <span className="muted small">current Solution.java (latest version, not a per-attempt snapshot)</span>
            </summary>
            <pre className="code">{d.solution}</pre>
          </details>
          <Link to={`/problem/${d.slug}`}>Open in editor →</Link>
        </section>
      )}
    </aside>
  );
}

export default function History() {
  const { turns } = useTutor();
  const { data, error } = usePolling(dashApi.attempts, 8000, [turns]);
  const [params, setParams] = useSearchParams();
  const selected = Number(params.get('attempt')) || null;
  const [result, setResult] = useState<Result>('all');
  const [topic, setTopic] = useState('all');
  const [difficulty, setDifficulty] = useState('all');
  const [reviewOnly, setReviewOnly] = useState(false);
  const [q, setQ] = useState('');

  const topics = useMemo(() => [...new Set((data ?? []).map((a) => a.topic))].sort(), [data]);
  const rows = useMemo(
    () =>
      (data ?? []).filter(
        (a) =>
          (result === 'all' || resultOf(a) === result) &&
          (topic === 'all' || a.topic === topic) &&
          (difficulty === 'all' || a.difficulty === difficulty) &&
          (!reviewOnly || a.isReview) &&
          (!q || `${a.title} ${a.slug} ${a.tutorSummary ?? ''}`.toLowerCase().includes(q.toLowerCase())),
      ),
    [data, result, topic, difficulty, reviewOnly, q],
  );

  const select = (id: number | null) => {
    const p = new URLSearchParams(params);
    if (id) p.set('attempt', String(id));
    else p.delete('attempt');
    setParams(p, { replace: true });
  };

  return (
    <div className="history-page">
      <NavBar />
      <div className={`history-layout ${selected ? 'with-detail' : ''}`}>
        <main className="history">
          <div className="filters">
            <input className="filter search" placeholder="Search problems or summaries" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className="filter" value={result} onChange={(e) => setResult(e.target.value as Result)} aria-label="Result">
              <option value="all">All results</option>
              <option value="solved">Solved</option>
              <option value="partial">Partial</option>
              <option value="abandoned">Abandoned</option>
              <option value="in_progress">In progress</option>
            </select>
            <select className="filter" value={topic} onChange={(e) => setTopic(e.target.value)} aria-label="Topic">
              <option value="all">All topics</option>
              {topics.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <select className="filter" value={difficulty} onChange={(e) => setDifficulty(e.target.value)} aria-label="Difficulty">
              <option value="all">All difficulties</option>
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>
            <label className="small">
              <input type="checkbox" checked={reviewOnly} onChange={(e) => setReviewOnly(e.target.checked)} /> Reviews only
            </label>
            <span className="spacer" />
            <span className="muted small">{data ? `${rows.length} of ${data.length} attempts` : ''}</span>
          </div>

          {error && <div className="banner error">Couldn’t load history: {error}</div>}
          {data && data.length === 0 && <div className="empty">No attempts yet. Start a session with the tutor.</div>}
          {data && data.length > 0 && rows.length === 0 && <div className="empty">No attempts match these filters.</div>}
          {rows.length > 0 && (
            <table className="table hover">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Problem</th>
                  <th>Topic</th>
                  <th>Result</th>
                  <th className="num">Score</th>
                  <th className="num">Rating Δ</th>
                  <th className="num">Hints</th>
                  <th className="num">Time</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className={a.id === selected ? 'selected' : ''} onClick={() => select(a.id)}>
                    <td>{fmtDate(a.finishedAt ?? a.startedAt)}</td>
                    <td>
                      {a.title} <span className={`badge ${a.difficulty}`}>{a.difficulty}</span>
                      {a.isReview && <span className="pill review">review</span>}
                    </td>
                    <td className="muted">{a.topic}</td>
                    <td><StatusText a={a} /></td>
                    <td className="num">{a.outcomeScore == null ? '—' : `${Math.round(a.outcomeScore * 100)}%`}</td>
                    <td className={`num ${a.ratingDelta == null ? '' : a.ratingDelta >= 0 ? 'up' : 'down'}`}>{fmtDelta(a.ratingDelta)}</td>
                    <td className="num">{a.hintsUsed}</td>
                    <td className="num" title={a.activeTimeSec == null ? 'Recorded before active-time tracking' : 'Active time'}>{fmtMins(a.activeTimeSec)}</td>
                    <td className="summary-cell muted">{a.tutorSummary ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </main>
        {selected && <Detail id={selected} onClose={() => select(null)} />}
      </div>
    </div>
  );
}
