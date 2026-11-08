import { useEffect, useState } from 'react';
import type { CaseResult, RunResult } from '../api';

const ICON: Record<CaseResult['status'], string> = { pass: '✓', fail: '✗', timeout: '⏱', error: '!' };

const show = (v: unknown) => {
  const s = JSON.stringify(v);
  return s === undefined ? 'undefined' : s;
};

function CaseRow({ c, open, onToggle }: { c: CaseResult; open: boolean; onToggle: () => void }) {
  return (
    <li className={`case ${c.status}`}>
      <button className="case-head" onClick={onToggle}>
        <span className="case-icon">{ICON[c.status]}</span>
        <span className="case-num">{c.index + 1}</span>
        <span className="case-name">{c.name}</span>
        <span className="case-time">
          {c.status === 'timeout' ? 'timeout' : c.status === 'error' ? 'error' : `${c.timeMs} ms`}
        </span>
      </button>
      {open && (
        <div className="case-body">
          <div><label>input</label><pre>{show(c.input)}</pre></div>
          <div><label>expected</label><pre>{show(c.expected)}</pre></div>
          {c.status === 'fail' && <div><label>actual</label><pre>{show(c.actual)}</pre></div>}
          {c.error && <div><label>{c.status === 'fail' ? 'note' : 'error'}</label><pre className="err">{c.error}</pre></div>}
        </div>
      )}
    </li>
  );
}

export default function ResultsPanel({ result, running }: { result: RunResult | null; running: boolean }) {
  const [open, setOpen] = useState<Set<number>>(new Set());

  // Auto-expand the first failing case of each new run.
  useEffect(() => {
    setOpen(new Set(result?.firstFailure ? [result.firstFailure.index] : []));
  }, [result?.ranAt]);

  if (running && !result) return <div className="results-empty">Compiling and running…</div>;
  if (!result) return <div className="results-empty">No test run yet. Press <b>Run tests</b> (Ctrl+Enter).</div>;

  const toggle = (i: number) =>
    setOpen((s) => {
      const n = new Set(s);
      n.has(i) ? n.delete(i) : n.add(i);
      return n;
    });

  return (
    <div className={`results ${running ? 'stale' : ''}`}>
      {!result.compiled ? (
        <>
          <div className="summary fail">{result.compileError ? 'Compile error' : 'Run failed'}</div>
          <pre className="err block">{result.compileError || result.stdout}</pre>
        </>
      ) : (
        <>
          <div className={`summary ${result.allPassed ? 'pass' : 'fail'}`}>
            {result.allPassed ? 'All tests passed' : 'Tests failing'} · {result.passed}/{result.total}
            <span className="muted"> · runtime {result.runtimeMs} ms · {new Date(result.ranAt).toLocaleTimeString()}</span>
          </div>
          <ul className="cases">
            {result.cases.map((c) => (
              <CaseRow key={c.index} c={c} open={open.has(c.index)} onToggle={() => toggle(c.index)} />
            ))}
          </ul>
          {result.stdout.trim() && (
            <details className="stdout">
              <summary>stdout</summary>
              <pre>{result.stdout}</pre>
            </details>
          )}
        </>
      )}
    </div>
  );
}
