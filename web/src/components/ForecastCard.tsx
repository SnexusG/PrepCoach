import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { dashApi, fmtDay, forecastHeadline, type Dashboard, type Difficulty } from '../api';

const DIFFS: Difficulty[] = ['easy', 'medium', 'hard'];
const dayMs = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

interface Point {
  t: number;
  solved?: number;
  projected?: number;
}

/** Solved so far (solid) and the projection to the forecast date (dashed, same series), with the goal as a rule. */
function ProgressChart({ f }: { f: Dashboard['stats']['forecast'] }) {
  const points = useMemo<Point[]>(() => {
    const actual: Point[] = f.history.map((h) => ({ t: dayMs(h.date), solved: h.solved }));
    if (!actual.length) return [];
    const now = dayMs(todayIso());
    if (actual[actual.length - 1].t < now) actual.push({ t: now, solved: f.solved });
    if (f.status !== 'ok' || !f.date) return actual;
    actual[actual.length - 1].projected = f.solved;
    return [...actual, { t: dayMs(f.date), projected: f.total }];
  }, [f]);

  if (points.length < 2) return <div className="empty">The progress line starts after your first solved problem.</div>;
  const target = f.target ? dayMs(f.target.date) : null;
  const maxT = Math.max(points[points.length - 1].t, target ?? 0);

  return (
    <div className="chart">
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', maxT]}
            tickFormatter={(t) => new Date(t).toLocaleDateString(undefined, { month: 'short', year: '2-digit' })}
            stroke="var(--axis)"
            tick={{ fill: 'var(--muted)', fontSize: 12 }}
            tickLine={false}
            minTickGap={48}
          />
          <YAxis
            domain={[0, f.total]}
            stroke="var(--axis)"
            tick={{ fill: 'var(--muted)', fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            width={36}
          />
          {target != null && (
            <ReferenceLine
              x={target}
              stroke="var(--axis)"
              strokeDasharray="4 4"
              label={{ value: 'goal', fill: 'var(--muted)', fontSize: 11, position: 'insideTopRight' }}
            />
          )}
          <Tooltip
            cursor={{ stroke: 'var(--muted)', strokeWidth: 1 }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as Point;
              const date = new Date(p.t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
              const isEnd = p.solved == null;
              return (
                <div className="tip">
                  <div className="tip-value">
                    {isEnd ? p.projected : p.solved} / {f.total}
                  </div>
                  <div className="muted">{isEnd ? `projected finish · ${date}` : `solved by ${date}`}</div>
                </div>
              );
            }}
          />
          <Line
            dataKey="solved"
            stroke="var(--series-1)"
            strokeWidth={2}
            dot={{ r: 4, fill: 'var(--series-1)', stroke: 'var(--panel)', strokeWidth: 2 }}
            activeDot={{ r: 5 }}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Line
            dataKey="projected"
            stroke="var(--series-1)"
            strokeWidth={2}
            strokeDasharray="6 5"
            dot={false}
            activeDot={{ r: 5 }}
            connectNulls
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
      <div className="fc-legend muted small">
        <span><i className="fc-key solid" /> solved</span>
        {f.status === 'ok' && <span><i className="fc-key dashed" /> projected at your current pace</span>}
        {f.target && <span><i className="fc-key rule" /> goal</span>}
      </div>
    </div>
  );
}

function TargetEditor({ f, onSaved }: { f: Dashboard['stats']['forecast']; onSaved: () => void }) {
  const [value, setValue] = useState(f.target?.date ?? '');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setValue(f.target?.date ?? ''), [f.target?.date]);

  const save = (date: string | null) => {
    setError(null);
    dashApi.setTargetDate(date).then(onSaved, (e) => setError((e as Error).message));
  };
  const t = f.target;

  return (
    <div className="fc-target">
      <label className="small">
        Goal date{' '}
        <input type="date" className="filter" value={value} min={todayIso()} onChange={(e) => setValue(e.target.value)} />
      </label>
      <button className="small-btn" disabled={!value || value === t?.date} onClick={() => save(value)}>
        Set goal
      </button>
      {t && (
        <button className="small-btn" onClick={() => save(null)}>
          Clear
        </button>
      )}
      {error && <span className="t-warn small">{error}</span>}
      {t && (
        <div className="fc-target-status small">
          {t.passed ? (
            <span className="t-warn">Your goal date ({fmtDay(t.date)}) has passed. Set a new one?</span>
          ) : f.status === 'complete' ? (
            <span className="st solved">✓ Finished before your goal</span>
          ) : (
            <>
              To finish by <b>{fmtDay(t.date)}</b> you need <b>{t.requiredPerWeek}</b> problems a week
              {f.status === 'ok' && (
                <>
                  {' '}
                  — you're at <b>{f.perWeek}</b>.{' '}
                  {t.onTrack ? <span className="st solved">✓ on track</span> : <span className="st partial">◑ behind</span>}
                </>
              )}
              {f.status !== 'ok' && '.'}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function ForecastCard({ data, onChanged }: { data: Dashboard; onChanged: () => void }) {
  const f = data.stats.forecast;
  const times = data.stats.activeTime;
  return (
    <section className="card forecast">
      <div className="card-head">
        <h2>Sheet completion forecast</h2>
        <span className="muted small">pace over the last {Math.round(f.spanDays)} days · harder problems count as more work</span>
      </div>
      <div className="fc-grid">
        <div className="fc-main">
          <div className="fc-headline">{forecastHeadline(f, data.stats.prefs.sheetName)}</div>
          {f.status === 'ok' && (
            <div className="muted small">
              Likely between {fmtDay(f.early)} and {f.late ? fmtDay(f.late) : 'an open-ended date (only one solve in the window)'} ·{' '}
              {f.perWeek} problems a week
            </div>
          )}
          <div className="fc-facts">
            <div>
              <label>Remaining</label>
              <b>{f.remaining}</b>
              <span className="muted small"> {DIFFS.map((d) => `${f.remainingByDifficulty[d]} ${d}`).join(' · ')}</span>
            </div>
            <div>
              <label>At 1 a day</label>
              <b>{fmtDay(f.atOnePerDay)}</b>
            </div>
            <div>
              <label>Avg active time</label>
              {DIFFS.some((d) => times[d].avgMinutes != null) ? (
                <span>
                  {DIFFS.filter((d) => times[d].avgMinutes != null)
                    .map((d) => `${d} ${times[d].avgMinutes} min`)
                    .join(' · ')}
                </span>
              ) : (
                <span className="muted small">tracked from your next problem</span>
              )}
            </div>
          </div>
          <TargetEditor f={f} onSaved={onChanged} />
        </div>
        <ProgressChart f={f} />
      </div>
    </section>
  );
}
