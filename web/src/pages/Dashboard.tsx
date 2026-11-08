import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { dashApi, fmtDate, fmtDelta, fmtMins, type Dashboard as DashData, type Difficulty, type TopicStat } from '../api';
import NavBar from '../components/NavBar';
import TutorPanel from '../components/TutorPanel';
import { useTutor } from '../tutor/TutorContext';
import { usePolling } from '../usePolling';

const DIFFS: Difficulty[] = ['easy', 'medium', 'hard'];

// ---------------------------------------------------------------- KPI tiles

function Tile({ label, children, sub }: { label: string; children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{children}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}

function Meter({ value, total, label }: { value: number; total: number; label?: string }) {
  const pct = total ? (100 * value) / total : 0;
  return (
    <div className="meter" title={`${label ? label + ': ' : ''}${value} of ${total} solved (${Math.round(pct)}%)`}>
      <div className="meter-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

function Trend({ d, span }: { d: number; span: string }) {
  const cls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  return (
    <span className={`trend ${cls}`}>
      {d > 0 ? '▲' : d < 0 ? '▼' : '•'} {fmtDelta(d)} <span className="muted">{span}</span>
    </span>
  );
}

// ---------------------------------------------------------------- rating over time (line)

function RatingChart({ data }: { data: DashData }) {
  const { stats, initialRating } = data;
  const [series, setSeries] = useState<string>('Overall');
  const attempted = stats.topics.filter((t) => t.attempts > 0).map((t) => t.topic);

  const points = useMemo(() => {
    const topic = series === 'Overall' ? null : series;
    const rows = stats.ratingHistory.filter((h) => h.topic === topic);
    // Anchor the line at the starting rating so a single attempt still draws a segment.
    const first = rows[0];
    const start = first ? [{ t: new Date(first.recordedAt).getTime() - 1, rating: initialRating, start: true }] : [];
    return [...start, ...rows.map((h) => ({ t: new Date(h.recordedAt).getTime(), rating: Math.round(h.rating * 10) / 10, start: false }))];
  }, [stats.ratingHistory, series, initialRating]);

  return (
    <section className="card">
      <div className="card-head">
        <h2>{series === 'Overall' ? 'DSA rating' : series} over time</h2>
        <span className="spacer" />
        <select className="filter" value={series} onChange={(e) => setSeries(e.target.value)} aria-label="Series">
          <option>Overall</option>
          {attempted.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>
      {points.length < 2 ? (
        <div className="empty">Your rating line starts after the first recorded attempt.</div>
      ) : (
        <div className="chart">
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--grid)" vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(t) => fmtDate(new Date(t).toISOString())}
                stroke="var(--axis)"
                tick={{ fill: 'var(--muted)', fontSize: 12 }}
                tickLine={false}
                minTickGap={40}
              />
              <YAxis
                domain={[(min: number) => Math.floor((Math.min(min, initialRating) - 20) / 10) * 10, (max: number) => Math.ceil((Math.max(max, initialRating) + 20) / 10) * 10]}
                stroke="var(--axis)"
                tick={{ fill: 'var(--muted)', fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                width={44}
              />
              <ReferenceLine y={initialRating} stroke="var(--axis)" strokeDasharray="4 4" label={{ value: 'start', fill: 'var(--muted)', fontSize: 11, position: 'insideTopLeft' }} />
              <Tooltip
                cursor={{ stroke: 'var(--muted)', strokeWidth: 1 }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const p = payload[0].payload as { t: number; rating: number; start: boolean };
                  return (
                    <div className="tip">
                      <div className="tip-value">{p.rating}</div>
                      <div className="muted">{p.start ? 'starting rating' : new Date(p.t).toLocaleString()}</div>
                    </div>
                  );
                }}
              />
              <Line type="monotone" dataKey="rating" stroke="var(--series-1)" strokeWidth={2} dot={{ r: 4, fill: 'var(--series-1)', stroke: 'var(--panel)', strokeWidth: 2 }} activeDot={{ r: 5 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- topic ratings (diverging from the start)

function TopicBars({ topics, initial }: { topics: TopicStat[]; initial: number }) {
  const attempted = topics.filter((t) => t.attempts > 0).sort((a, b) => a.rating - b.rating);
  const untouched = topics.filter((t) => t.attempts === 0);
  const span = Math.max(50, ...attempted.map((t) => Math.abs(t.rating - initial)));

  return (
    <section className="card">
      <div className="card-head">
        <h2>Topic ratings</h2>
        <span className="muted small">weakest first · bars show change from the {initial} start</span>
      </div>
      {attempted.length === 0 && <div className="empty">No topic attempted yet.</div>}
      <div className="dbars">
        {attempted.map((t) => {
          const d = t.rating - initial;
          const w = (50 * Math.abs(d)) / span;
          return (
            <div
              className="dbar-row"
              key={t.topic}
              title={`${t.topic}: ${t.rating} (${fmtDelta(d)} from start) · ${t.label} · ${t.attempts} attempt${t.attempts === 1 ? '' : 's'} · confidence ${Math.round(t.confidence * 100)}%`}
            >
              <span className="dbar-name">{t.topic}</span>
              <span className="dbar-track">
                <span className="dbar-axis" />
                <span
                  className={`dbar ${d >= 0 ? 'pos' : 'neg'} ${t.lowConfidence ? 'low' : ''}`}
                  style={d >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }}
                />
              </span>
              <span className="dbar-value">
                {Math.round(t.rating)} <span className="muted">{fmtDelta(d)}</span>
              </span>
              <span className={`conf ${t.lowConfidence ? 'low' : ''}`}>
                {t.lowConfidence ? `low confidence · ${t.attempts}` : `${t.attempts} attempts`}
              </span>
            </div>
          );
        })}
      </div>
      {untouched.length > 0 && (
        <details className="untouched">
          <summary>Not yet attempted ({untouched.length}) — at {initial}</summary>
          <div className="muted small">{untouched.map((t) => t.topic).join(' · ')}</div>
        </details>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- completion

function Completion({ data }: { data: DashData }) {
  const { completion, topics, prefs } = data.stats;
  return (
    <section className="card">
      <div className="card-head">
        <h2>{prefs.sheetName} completion</h2>
        <span className="muted small">
          {completion.solved}/{completion.total}
        </span>
      </div>
      <div className="meters diff">
        {DIFFS.map((d) => (
          <div className="meter-row" key={d}>
            <span className={`badge ${d}`}>{d}</span>
            <Meter value={completion.byDifficulty[d].solved} total={completion.byDifficulty[d].total} label={d} />
            <span className="meter-num">
              {completion.byDifficulty[d].solved}/{completion.byDifficulty[d].total}
            </span>
          </div>
        ))}
      </div>
      <div className="meters">
        {topics.map((t) => {
          const solved = DIFFS.reduce((s, d) => s + t.solved[d], 0);
          const total = DIFFS.reduce((s, d) => s + t.total[d], 0);
          if (!total) return null;
          return (
            <div className="meter-row" key={t.topic}>
              <span className="meter-name">{t.topic}</span>
              <Meter value={solved} total={total} label={t.topic} />
              <span className="meter-num">
                {solved}/{total}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- lists

function Weaknesses({ data }: { data: DashData }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Weaknesses to watch</h2>
        <span className="muted small">
          {data.stats.weaknesses.active} active · {data.stats.weaknesses.improving} improving · {data.stats.weaknesses.resolved} resolved
        </span>
      </div>
      {data.weaknesses.length === 0 && <div className="empty">None logged yet — the tutor records specific, reusable mistakes here.</div>}
      <ul className="wlist">
        {data.weaknesses.map((w) => (
          <li key={w.id}>
            <div>
              <span className={`wstatus ${w.status}`}>{w.status === 'active' ? '● active' : '◐ improving'}</span>
              <span className="muted small"> {w.topic ?? 'general'}</span>
            </div>
            <div>{w.description}</div>
            <div className="muted small">
              seen {w.timesObserved}× · last {fmtDate(w.lastSeen)}
              {w.status === 'improving' && ` · ${w.cleanDemonstrations} clean`}
              {w.examples[0] && (
                <>
                  {' · '}
                  <Link to={`/history?attempt=${w.examples[0].attemptId}`}>{w.examples[0].slug}</Link>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Reviews({ data }: { data: DashData }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Reviews</h2>
        <span className="muted small">
          {data.stats.reviews.due} due · {data.stats.reviews.upcoming7d} in the next 7 days
        </span>
      </div>
      {data.reviews.length === 0 && <div className="empty">Nothing scheduled — solved problems come back here for spaced review.</div>}
      <ul className="rlist">
        {data.reviews.map((r) => (
          <li key={r.slug}>
            <span className={`rdue ${r.due ? 'due' : ''}`}>{r.due ? 'due' : fmtDate(r.dueDate + 'T12:00:00')}</span>
            <Link to={`/problem/${r.slug}`}>{r.title}</Link>
            <span className="muted small">
              {r.topic} · last {Math.round(r.lastOutcome * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Recent({ data }: { data: DashData }) {
  return (
    <section className="card wide">
      <div className="card-head">
        <h2>Recent attempts</h2>
        <span className="spacer" />
        <Link to="/history" className="small">All history →</Link>
      </div>
      {data.recent.length === 0 ? (
        <div className="empty">No attempts yet.</div>
      ) : (
        <table className="table">
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
            </tr>
          </thead>
          <tbody>
            {data.recent.map((a) => (
              <tr key={a.id}>
                <td>{fmtDate(a.finishedAt ?? a.startedAt)}</td>
                <td>
                  <Link to={`/history?attempt=${a.id}`}>{a.title}</Link> <span className={`badge ${a.difficulty}`}>{a.difficulty}</span>
                  {a.isReview && <span className="pill review">review</span>}
                </td>
                <td className="muted">{a.topic}</td>
                <td>
                  <StatusText a={a} />
                </td>
                <td className="num">{a.outcomeScore == null ? '—' : `${Math.round(a.outcomeScore * 100)}%`}</td>
                <td className={`num ${a.ratingDelta == null ? '' : a.ratingDelta >= 0 ? 'up' : 'down'}`}>{fmtDelta(a.ratingDelta)}</td>
                <td className="num">{a.hintsUsed}</td>
                <td className="num">{fmtMins(a.solveTimeSec)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function StatusText({ a }: { a: { status: string; testsPassed: number | null; testsTotal: number | null } }) {
  if (a.status === 'in_progress') return <span className="st progress">◷ in progress</span>;
  if (a.status === 'abandoned') return <span className="st abandoned">⨯ abandoned</span>;
  const all = a.testsTotal != null && a.testsPassed === a.testsTotal;
  return (
    <span className={`st ${all ? 'solved' : 'partial'}`}>
      {all ? '✓ solved' : '◑ partial'} {a.testsTotal != null && <span className="muted">{a.testsPassed}/{a.testsTotal}</span>}
    </span>
  );
}

// ---------------------------------------------------------------- page

export default function Dashboard() {
  const { turns } = useTutor();
  const { data, error } = usePolling(dashApi.dashboard, 5000, [turns]);

  return (
    <div className="dash-page">
      <NavBar>
        {data && (
          <span className="muted small">
            {data.stats.prefs.sheetName} · {data.stats.prefs.difficulty}
            {data.session ? ` · session #${data.session.id} active` : ''}
          </span>
        )}
      </NavBar>
      <div className="dash-layout">
        <main className="dash">
          {error && <div className="banner error">Couldn’t load the dashboard: {error}</div>}
          {!data && !error && <div className="page-msg">Loading…</div>}
          {data && (
            <>
              <div className="kpis">
                <Tile label="DSA rating" sub={<><Trend d={data.stats.overall.trend7d} span="7d" /> <Trend d={data.stats.overall.trend30d} span="30d" /></>}>
                  <span className="hero">{Math.round(data.stats.overall.rating * 10) / 10}</span>
                  <span className="hero-label">{data.stats.overall.label}</span>
                </Tile>
                <Tile label="Solved" sub={<Meter value={data.stats.completion.solved} total={data.stats.completion.total} />}>
                  {data.stats.completion.solved}
                  <span className="muted"> / {data.stats.completion.total}</span>
                </Tile>
                <Tile label="Reviews due" sub={`${data.stats.reviews.upcoming7d} more in the next 7 days`}>
                  {data.stats.reviews.due}
                </Tile>
                <Tile label="Active weaknesses" sub={`${data.stats.weaknesses.improving} improving · ${data.stats.weaknesses.resolved} resolved`}>
                  {data.stats.weaknesses.active}
                </Tile>
                <Tile label="Attempts" sub={`${data.stats.attempts.abandoned} abandoned · ${data.stats.attempts.inProgress} open`}>
                  {data.stats.attempts.completed}
                </Tile>
              </div>

              <div className="grid2">
                <RatingChart data={data} />
                <TopicBars topics={data.stats.topics} initial={data.initialRating} />
              </div>
              <div className="grid2">
                <Weaknesses data={data} />
                <Reviews data={data} />
              </div>
              <div className="grid2">
                <Completion data={data} />
                <section className="card tracks">
                  <div className="card-head">
                    <h2>Tracks</h2>
                  </div>
                  {data.tracks.map((t) => (
                    <div key={t.id} className={`track ${t.enabled ? '' : 'soon'}`}>
                      <b>{t.name}</b>
                      <span className="muted small">{t.enabled ? 'active' : 'coming soon'}</span>
                    </div>
                  ))}
                </section>
              </div>
              <Recent data={data} />
            </>
          )}
        </main>
        <aside className="dash-tutor">
          <TutorPanel />
        </aside>
      </div>
    </div>
  );
}
