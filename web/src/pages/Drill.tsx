import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  drillApi,
  fmtDate,
  WEAKNESS_AREA_LABELS,
  type DrillAnswer,
  type DrillQuestion,
  type DrillSet,
  type DrillTarget,
} from '../api';
import NavBar from '../components/NavBar';
import TutorPanel from '../components/TutorPanel';
import { useTutor } from '../tutor/TutorContext';

const areaLabel = (a: string | null) => (a ? WEAKNESS_AREA_LABELS[a] ?? a : 'General');

type DrillList = Awaited<ReturnType<typeof drillApi.list>>;
/** What the user chose: one weakness, or a mixed drill over all open ones. */
type Choice = { kind: 'one'; weakness: DrillTarget } | { kind: 'mixed'; weaknesses: DrillTarget[]; ready: boolean };

// ---------------------------------------------------------------- pick a drill

function Picker({ onStart }: { onStart: (c: Choice) => void }) {
  const [data, setData] = useState<DrillList | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    drillApi.list().then(setData, (e) => setError((e as Error).message));
  }, []);

  if (error) return <div className="banner error">Couldn't load your weaknesses: {error}</div>;
  if (!data) return <div className="page-msg">Loading…</div>;
  if (!data.weaknesses.length) {
    return (
      <div className="drill-card">
        <h2>Nothing to drill</h2>
        <p className="muted">You have no active weaknesses. Solve some problems — the tutor logs skill gaps as it sees them.</p>
        <Link to="/">← Home</Link>
      </div>
    );
  }
  const ordered = [...data.weaknesses].sort((a, b) => (a.id === data.suggested ? -1 : b.id === data.suggested ? 1 : 0));
  const areas = [...new Set(data.weaknesses.map((w) => areaLabel(w.area)))];
  const m = data.mixed;
  return (
    <div className="drill-pick">
      <h1>Drill</h1>
      <button className="drill-mixed" onClick={() => onStart({ kind: 'mixed', weaknesses: data.weaknesses, ready: m.ready })}>
        <span className="drill-mixed-title">⚡ Mixed practice</span>
        <span className="drill-mixed-sub">
          {m.questions} questions across your {m.weaknessCount} focus area{m.weaknessCount === 1 ? '' : 's'} · about {Math.round(m.questions * 0.6)} minutes
        </span>
        <span className="drill-mixed-areas">{areas.join(' · ')}</span>
        <span className="drill-mixed-go">{m.ready ? 'Start →' : m.generating ? 'Being prepared… start →' : 'Start (takes ~40 s to prepare) →'}</span>
        {m.error && <span className="t-warn small">Last preparation failed: {m.error}</span>}
      </button>

      <h2 className="drill-or">Or practise one area</h2>
      <ul>
        {ordered.map((w) => (
          <li key={w.id} className={w.id === data.suggested ? 'suggested' : ''}>
            <button className="drill-target" onClick={() => onStart({ kind: 'one', weakness: w })}>
              <span className="muted small">
                {areaLabel(w.area)} · {w.status} · seen {w.timesObserved}×
                {w.id === data.suggested && <b className="drill-badge">least recently drilled</b>}
              </span>
              <span className="drill-target-desc">{w.description}</span>
              <span className="muted small">
                {w.lastDrill ? `last drill ${w.lastDrill.correct}/${w.lastDrill.total} on ${fmtDate(w.lastDrill.at)}` : 'never drilled'}
                {' · '}
                {w.ready ? 'ready to start' : w.generating ? 'being prepared…' : 'takes ~30 s to prepare'}
              </span>
              {w.error && <span className="t-warn small">Last preparation failed: {w.error}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- one question

function Code({ code, pick, picked, correctLine, wrongLine }: {
  code: string;
  pick?: (line: number) => void;
  picked?: number | null;
  correctLine?: number;
  wrongLine?: number;
}) {
  return (
    <pre className={`drill-code ${pick ? 'pickable' : ''}`}>
      {code.split('\n').map((l, i) => {
        const n = i + 1;
        const cls = [n === picked ? 'picked' : '', n === correctLine ? 'right' : '', n === wrongLine ? 'wrong' : ''].join(' ');
        return (
          <div key={n} className={`line ${cls}`} onClick={pick ? () => pick(n) : undefined} role={pick ? 'button' : undefined}>
            <span className="ln">{n}</span>
            <span>{l || ' '}</span>
          </div>
        );
      })}
    </pre>
  );
}

function Question({
  q,
  index,
  result,
  busy,
  onAnswer,
}: {
  q: DrillQuestion;
  index: number;
  result: DrillAnswer | null;
  busy: boolean;
  onAnswer: (a: number | string) => void;
}) {
  const [text, setText] = useState(q.type === 'fix' ? q.code : '');
  const [line, setLine] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setText(q.type === 'fix' ? q.code : '');
    setLine(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [index, q]);

  // Number keys answer multiple choice.
  useEffect(() => {
    if (q.type !== 'mcq' || result || busy) return;
    const h = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (n >= 1 && n <= q.options.length && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) onAnswer(n - 1);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [q, result, busy, onAnswer]);

  const answered = !!result;
  return (
    <>
      <div className="drill-prompt">{q.prompt}</div>
      {q.type === 'bug' ? (
        <Code
          code={q.code}
          pick={answered || busy ? undefined : setLine}
          picked={answered ? Number(result!.answer) : line}
          correctLine={answered ? q.answer : undefined}
          wrongLine={answered && !result!.correct ? Number(result!.answer) : undefined}
        />
      ) : (
        q.code && q.type !== 'fix' && <Code code={q.code} />
      )}

      {q.type === 'mcq' && (
        <div className="drill-options">
          {q.options.map((o, i) => {
            const cls = answered ? (i === q.answer ? 'right' : i === result!.answer ? 'wrong' : '') : '';
            return (
              <button key={i} className={`drill-option ${cls}`} disabled={answered || busy} onClick={() => onAnswer(i)}>
                <span className="key">{i + 1}</span> {o}
              </button>
            );
          })}
        </div>
      )}

      {q.type === 'short' && (
        <form
          className="drill-input"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) onAnswer(text.trim());
          }}
        >
          <input
            ref={inputRef}
            value={answered ? String(result!.answer) : text}
            onChange={(e) => setText(e.target.value)}
            disabled={answered || busy}
            placeholder="Type your answer, e.g. O(n log n)"
          />
          {!answered && (
            <button type="submit" disabled={!text.trim() || busy}>
              Check
            </button>
          )}
        </form>
      )}

      {q.type === 'fix' && (
        <div className="drill-input fix">
          <textarea
            value={answered ? String(result!.answer) : text}
            onChange={(e) => setText(e.target.value)}
            disabled={answered || busy}
            rows={Math.min(10, Math.max(3, text.split('\n').length + 1))}
            spellCheck={false}
          />
          {!answered && (
            <button disabled={!text.trim() || text.trim() === q.code.trim() || busy} onClick={() => onAnswer(text)}>
              Check
            </button>
          )}
        </div>
      )}

      {q.type === 'bug' && !answered && (
        <div className="drill-input">
          <span className="muted small">{line ? `Line ${line} selected` : 'Click the line with the bug.'}</span>
          <button disabled={!line || busy} onClick={() => line && onAnswer(line)}>
            Check
          </button>
        </div>
      )}

      {busy && <div className="muted small drill-checking">Checking your answer…</div>}

      {answered && (
        <div className={`drill-feedback ${result!.correct ? 'right' : 'wrong'}`}>
          <b>{result!.correct ? '✓ Correct' : '✗ Not quite'}</b>
          {result!.feedback && result!.feedback !== 'Correct.' && <p>{result!.feedback}</p>}
          {(q.type === 'short' || q.type === 'fix') && !result!.correct && q.expected && (
            <pre className="drill-expected">{q.expected}</pre>
          )}
          {q.explanation && <p className="muted">{q.explanation}</p>}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- the drill

function Runner({ choice, onExit }: { choice: Choice; onExit: () => void }) {
  const tutor = useTutor();
  const [set, setSet] = useState<DrillSet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ weaknessId: number; correct: number; total: number }[] | null>(null);
  const mixed = choice.kind === 'mixed';
  const all = choice.kind === 'mixed' ? choice.weaknesses : [choice.weakness];
  const weaknessOf = (q: DrillQuestion | undefined) =>
    all.find((w) => w.id === (q?.weaknessId ?? (choice.kind === 'one' ? choice.weakness.id : -1)));

  useEffect(() => {
    let stop = false;
    drillApi.start(choice.kind === 'mixed' ? 'mixed' : choice.weakness.id).then(
      (s) => {
        if (stop) return;
        setSet(s);
        const firstOpen = s.questions.findIndex((_, i) => !s.answers[i]);
        setIndex(firstOpen < 0 ? s.questions.length - 1 : firstOpen);
      },
      (e) => !stop && setError((e as Error).message),
    );
    return () => {
      stop = true;
    };
  }, [choice]);

  const finish = useCallback(async (s: DrillSet) => {
    try {
      const r = await drillApi.finish(s.id);
      setDone(r.drills);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const answer = useCallback(
    async (a: number | string) => {
      if (!set || busy || set.answers[index]) return;
      setBusy(true);
      setError(null);
      try {
        const r = await drillApi.answer(set.id, index, a);
        setSet(r.set);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [set, busy, index],
  );

  const title = choice.kind === 'mixed' ? 'a mix of your focus areas' : choice.weakness.description;

  if (error && !set) {
    return (
      <div className="drill-card">
        <div className="banner error">{error}</div>
        <button onClick={onExit}>← Back</button>
      </div>
    );
  }
  if (!set) {
    const ready = choice.kind === 'mixed' ? choice.ready : choice.weakness.ready;
    return (
      <div className="drill-card drill-loading">
        <div className="spinner" />
        <div>
          Writing your questions on <b>{title}</b>…
        </div>
        <div className="muted small">
          {ready ? 'Almost there.' : `Usually ${mixed ? '30–60' : '20–40'} seconds the first time; the next drill is prepared in the background.`}
        </div>
      </div>
    );
  }

  const total = set.questions.length;
  const answeredCount = Object.keys(set.answers).length;
  const result = set.answers[index] ?? null;
  const last = index === total - 1;
  const q = set.questions[index];
  const qw = weaknessOf(q);

  if (done) {
    const correct = done.reduce((n, d) => n + d.correct, 0);
    const outOf = done.reduce((n, d) => n + d.total, 0);
    return (
      <div className="drill-card">
        <div className="muted small">{mixed ? 'Mixed practice' : areaLabel(all[0].area)}</div>
        <h2>
          {correct}/{outOf} — {correct === outOf ? 'clean sweep' : correct >= outOf * 0.6 ? 'solid' : 'worth another round'}
        </h2>
        {mixed && done.length > 0 && (
          <ul className="drill-breakdown">
            {done.map((d) => {
              const w = all.find((x) => x.id === d.weaknessId);
              return (
                <li key={d.weaknessId}>
                  <b className={d.correct === d.total ? 'st solved' : d.correct === 0 ? 'down' : ''}>
                    {d.correct}/{d.total}
                  </b>{' '}
                  {w?.description ?? `weakness #${d.weaknessId}`} <span className="muted small">({areaLabel(w?.area ?? null)})</span>
                </li>
              );
            })}
          </ul>
        )}
        <ul className="drill-recap">
          {set.questions.map((qq, i) => (
            <li key={i} className={set.answers[i] ? (set.answers[i].correct ? 'right' : 'wrong') : 'skipped'}>
              {set.answers[i] ? (set.answers[i].correct ? '✓' : '✗') : '–'} {qq.prompt}
            </li>
          ))}
        </ul>
        <p className="muted small">Drills are practice: they don't change a weakness's status — clean work on real problems does.</p>
        <div className="drill-actions">
          <button className="cta" onClick={onExit}>
            Drill again
          </button>
          <Link to="/">Back home</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="drill-card">
      <div className="drill-head">
        <span className="muted small">{mixed ? 'Mixed practice' : `${areaLabel(all[0].area)} · ${title}`}</span>
        <span className="drill-dots" aria-label={`Question ${index + 1} of ${total}`}>
          {set.questions.map((_, i) => (
            <i key={i} className={`${i === index ? 'cur' : ''} ${set.answers[i] ? (set.answers[i].correct ? 'right' : 'wrong') : ''}`} />
          ))}
        </span>
      </div>
      <div className="muted small">
        Question {index + 1} of {total}
        {mixed && qw && (
          <span className="drill-q-weakness">
            {' '}
            · {areaLabel(qw.area)}: {qw.description}
          </span>
        )}
      </div>
      <Question q={q} index={index} result={result} busy={busy} onAnswer={answer} />
      {error && <div className="banner error">{error}</div>}
      <div className="drill-actions">
        {result && !last && (
          <button className="cta" onClick={() => setIndex(index + 1)} autoFocus>
            Next →
          </button>
        )}
        {result && last && (
          <button className="cta" onClick={() => finish(set)} autoFocus>
            See results
          </button>
        )}
        {result && (
          <button
            onClick={() => {
              const fence = '```';
              tutor.send(
                `About a drill question on "${qw?.description ?? title}": ${q.prompt}${q.code ? `\n${fence}java\n${q.code}\n${fence}` : ''}\n` +
                  `I answered ${JSON.stringify(q.type === 'mcq' ? q.options[Number(result.answer)] : result.answer)} and it was marked ${result.correct ? 'right' : 'wrong'}. Can you explain it?`,
              );
            }}
            title="Sends this question to the tutor chat on the right"
          >
            Ask the tutor
          </button>
        )}
        <span className="spacer" />
        {answeredCount > 0 && !last && (
          <button className="link-btn" onClick={() => finish(set)} title="Record the questions answered so far">
            Finish early
          </button>
        )}
      </div>
    </div>
  );
}

export default function Drill() {
  const [params, setParams] = useSearchParams();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [round, setRound] = useState(0);

  // /drill?mixed=1 starts the mixed drill directly (the home page's Quick drill); /drill?w=<id> one weakness.
  useEffect(() => {
    if (choice) return;
    const w = Number(params.get('w')) || null;
    if (!w && params.get('mixed') !== '1') return;
    drillApi.list().then((d) => {
      if (w) {
        const t = d.weaknesses.find((x) => x.id === w);
        if (t) setChoice({ kind: 'one', weakness: t });
      } else if (d.weaknesses.length) {
        setChoice({ kind: 'mixed', weaknesses: d.weaknesses, ready: d.mixed.ready });
      }
    });
  }, [params, choice]);

  return (
    <div className="dash-page">
      <NavBar />
      <div className="dash-layout">
        <main className="dash drill">
          {choice ? (
            <Runner
              key={`${choice.kind === 'mixed' ? 'mixed' : choice.weakness.id}-${round}`}
              choice={choice}
              onExit={() => {
                setChoice(null);
                setRound((r) => r + 1);
                setParams({});
              }}
            />
          ) : (
            <Picker key={round} onStart={setChoice} />
          )}
        </main>
        <aside className="dash-tutor">
          <TutorPanel />
        </aside>
      </div>
    </div>
  );
}
