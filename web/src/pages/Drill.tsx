import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

// ---------------------------------------------------------------- pick a weakness

function Picker({ onStart }: { onStart: (w: DrillTarget) => void }) {
  const [data, setData] = useState<{ suggested: number | null; weaknesses: DrillTarget[] } | null>(null);
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
  return (
    <div className="drill-pick">
      <h1>Drill a weakness</h1>
      <p className="muted">Five quick questions aimed at one skill gap and your actual slips. About 3 minutes.</p>
      <ul>
        {ordered.map((w) => (
          <li key={w.id} className={w.id === data.suggested ? 'suggested' : ''}>
            <button className="drill-target" onClick={() => onStart(w)}>
              <span className="muted small">
                {areaLabel(w.area)} · {w.status} · seen {w.timesObserved}×
                {w.id === data.suggested && <b className="drill-badge">suggested</b>}
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

function Runner({ target, onExit }: { target: DrillTarget; onExit: (again: boolean) => void }) {
  const tutor = useTutor();
  const [set, setSet] = useState<DrillSet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ correct: number; total: number } | null>(null);

  useEffect(() => {
    let stop = false;
    drillApi.start(target.id).then(
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
  }, [target.id]);

  const finish = useCallback(async (s: DrillSet) => {
    try {
      const r = await drillApi.finish(s.id);
      setDone({ correct: r.drill.correct, total: r.drill.total });
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

  if (error && !set) {
    return (
      <div className="drill-card">
        <div className="banner error">{error}</div>
        <button onClick={() => onExit(false)}>← Back</button>
      </div>
    );
  }
  if (!set) {
    return (
      <div className="drill-card drill-loading">
        <div className="spinner" />
        <div>
          Writing your questions on <b>{target.description}</b>…
        </div>
        <div className="muted small">{target.ready ? 'Almost there.' : 'Usually 20–40 seconds the first time; the next drill is prepared in the background.'}</div>
      </div>
    );
  }

  const total = set.questions.length;
  const answeredCount = Object.keys(set.answers).length;
  const result = set.answers[index] ?? null;
  const last = index === total - 1;

  if (done) {
    return (
      <div className="drill-card">
        <div className="muted small">{areaLabel(target.area)}</div>
        <h2>
          {done.correct}/{done.total} — {done.correct === done.total ? 'clean sweep' : done.correct >= done.total * 0.6 ? 'solid' : 'worth another round'}
        </h2>
        <ul className="drill-recap">
          {set.questions.map((q, i) => (
            <li key={i} className={set.answers[i] ? (set.answers[i].correct ? 'right' : 'wrong') : 'skipped'}>
              {set.answers[i] ? (set.answers[i].correct ? '✓' : '✗') : '–'} {q.prompt}
            </li>
          ))}
        </ul>
        <p className="muted small">Drills are practice: they don't change the weakness's status — clean work on real problems does.</p>
        <div className="drill-actions">
          <button className="cta" onClick={() => onExit(true)}>
            Drill another
          </button>
          <Link to="/">Back home</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="drill-card">
      <div className="drill-head">
        <span className="muted small">
          {areaLabel(target.area)} · {target.description}
        </span>
        <span className="drill-dots" aria-label={`Question ${index + 1} of ${total}`}>
          {set.questions.map((_, i) => (
            <i key={i} className={`${i === index ? 'cur' : ''} ${set.answers[i] ? (set.answers[i].correct ? 'right' : 'wrong') : ''}`} />
          ))}
        </span>
      </div>
      <div className="muted small">
        Question {index + 1} of {total}
      </div>
      <Question q={set.questions[index]} index={index} result={result} busy={busy} onAnswer={answer} />
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
              const q = set.questions[index];
              tutor.send(
                `About a drill question on "${target.description}": ${q.prompt}${q.code ? `\n\`\`\`java\n${q.code}\n\`\`\`` : ''}\n` +
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
  const [target, setTarget] = useState<DrillTarget | null>(null);
  const [round, setRound] = useState(0);
  const wanted = useMemo(() => Number(params.get('w')) || null, [params]);

  // /drill?w=<id> starts that weakness directly (e.g. from the home page).
  useEffect(() => {
    if (!wanted || target) return;
    drillApi.list().then((d) => {
      const w = d.weaknesses.find((x) => x.id === wanted);
      if (w) setTarget(w);
    });
  }, [wanted, target]);

  return (
    <div className="dash-page">
      <NavBar />
      <div className="dash-layout">
        <main className="dash drill">
          {target ? (
            <Runner
              key={`${target.id}-${round}`}
              target={target}
              onExit={() => {
                setTarget(null);
                setRound((r) => r + 1);
                setParams({});
              }}
            />
          ) : (
            <Picker key={round} onStart={setTarget} />
          )}
        </main>
        <aside className="dash-tutor">
          <TutorPanel />
        </aside>
      </div>
    </div>
  );
}
