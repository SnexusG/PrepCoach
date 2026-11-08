import Editor, { type OnMount } from '@monaco-editor/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Link, useParams } from 'react-router-dom';
import remarkGfm from 'remark-gfm';
import { api, ApiError, type Attempt, type Meta, type ProblemData, type RunResult } from '../api';
import ResultsPanel from '../components/ResultsPanel';

type MonacoEditor = Parameters<OnMount>[0];
type Monaco = Parameters<OnMount>[1];
type SaveStatus = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';

const AUTOSAVE_MS = 700;
const POLL_MS = 2000;

const fmtDuration = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
};

function Timer({ attempt }: { attempt: Attempt | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (attempt?.status !== 'in_progress') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [attempt?.status]);

  if (!attempt) return <span className="pill muted" title="Start the problem with /next in Claude Code">not started</span>;
  if (attempt.status === 'in_progress') {
    const sec = Math.max(0, Math.floor((now - new Date(attempt.startedAt).getTime()) / 1000));
    return <span className="pill timer" title="Time since the attempt started">⏱ {fmtDuration(sec)}</span>;
  }
  const label = attempt.status === 'completed' ? 'submitted' : 'abandoned';
  return (
    <span className="pill muted">
      {label}
      {attempt.solveTimeSec != null && ` · ${fmtDuration(attempt.solveTimeSec)}`}
    </span>
  );
}

function HintPill({ attempt, meta }: { attempt: Attempt | null; meta: Meta | null }) {
  const lvl = attempt?.hintsUsed ?? 0;
  const name = meta?.hintNames[lvl] ?? '';
  const cap = meta?.hintCaps[lvl];
  return (
    <span className={`pill ${lvl ? 'hint' : 'muted'}`} title="Hints are given and logged by the tutor (/hint)">
      hints: {lvl}
      {lvl > 0 && ` · ${name}${cap != null ? ` (max ${cap})` : ''}`}
    </span>
  );
}

const SAVE_LABEL: Record<SaveStatus, string> = {
  saved: 'saved',
  dirty: 'unsaved',
  saving: 'saving…',
  conflict: 'conflict',
  error: 'save failed',
};

export default function ProblemPage() {
  const { slug = '' } = useParams();
  const [data, setData] = useState<ProblemData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [conflict, setConflict] = useState<{ code: string; mtime: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const editorRef = useRef<MonacoEditor | null>(null);
  const savedCode = useRef<string>(''); // content known to be on disk
  const baseMtime = useRef<number | null>(null); // disk mtime matching savedCode
  const resultsMtime = useRef<number | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const saveChain = useRef<Promise<boolean>>(Promise.resolve(true));
  const saving = useRef(false);
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;
  const runningRef = useRef(running);
  runningRef.current = running;

  // ---- initial load ----
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setLoadError(null);
    api.meta().then(setMeta, () => {});
    api.problem(slug).then(
      (d) => {
        if (cancelled) return;
        savedCode.current = d.solution ?? '';
        baseMtime.current = d.solutionMtime;
        resultsMtime.current = d.resultsMtime;
        setAttempt(d.attempt);
        setResult(d.lastResults);
        setSaveStatus('saved');
        setConflict(null);
        setData(d);
      },
      (e) => !cancelled && setLoadError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const editorValue = () => editorRef.current?.getValue() ?? savedCode.current;

  /** Replace the editor content (keeps undo history), after updating what we consider saved. */
  const applyDiskCode = useCallback((code: string, mtime: number | null) => {
    savedCode.current = code;
    baseMtime.current = mtime;
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (ed && model && model.getValue() !== code) {
      ed.pushUndoStop();
      ed.executeEdits('disk', [{ range: model.getFullModelRange(), text: code }]);
      ed.pushUndoStop();
    }
    setSaveStatus('saved');
  }, []);

  // ---- saving ----
  const doSave = useCallback(
    async (force: boolean): Promise<boolean> => {
      const code = editorValue();
      if (!force && code === savedCode.current) {
        setSaveStatus('saved');
        return true;
      }
      if (!force && conflictRef.current) return false;
      saving.current = true;
      setSaveStatus('saving');
      try {
        const r = await api.save(slug, code, baseMtime.current, force);
        savedCode.current = code;
        baseMtime.current = r.mtime;
        setConflict(null);
        setSaveStatus(editorValue() === code ? 'saved' : 'dirty');
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setConflict({ code: e.body.code ?? '', mtime: e.body.mtime });
          setSaveStatus('conflict');
        } else {
          setSaveStatus('error');
          setNotice(`Save failed: ${(e as Error).message}`);
        }
        return false;
      } finally {
        saving.current = false;
      }
    },
    [slug],
  );

  const save = useCallback(
    (force = false) => {
      window.clearTimeout(saveTimer.current);
      saveChain.current = saveChain.current.then(() => doSave(force));
      return saveChain.current;
    },
    [doSave],
  );

  const onChange = () => {
    if (conflictRef.current) return;
    setSaveStatus(editorValue() === savedCode.current ? 'saved' : 'dirty');
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void save(), AUTOSAVE_MS);
  };

  // ---- running tests ----
  const runTests = useCallback(async () => {
    if (runningRef.current) return;
    if (conflictRef.current) {
      setNotice('Resolve the file conflict before running tests.');
      return;
    }
    setRunError(null);
    setRunning(true);
    try {
      if (!(await save())) return;
      const r = await api.run(slug);
      resultsMtime.current = r.resultsMtime;
      setResult(r.result);
      setAttempt(r.attempt);
    } catch (e) {
      setRunError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }, [save, slug]);

  const runRef = useRef(runTests);
  runRef.current = runTests;
  const saveRef = useRef(save);
  saveRef.current = save;

  const onMount: OnMount = (editor, monaco: Monaco) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void runRef.current());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current());
  };

  // ---- polling: external edits (IDE), hint level / attempt changes, CLI test runs ----
  useEffect(() => {
    if (!data?.generated) return;
    let stopped = false;
    const tick = async () => {
      try {
        const s = await api.state(slug);
        if (stopped) return;
        setAttempt(s.attempt);
        if (s.solutionMtime !== baseMtime.current && !saving.current && !conflictRef.current) {
          const disk = await api.solution(slug);
          if (stopped || saving.current || disk.code == null) return;
          if (disk.code === savedCode.current) {
            baseMtime.current = disk.mtime; // touched but unchanged
          } else if (editorValue() === savedCode.current) {
            applyDiskCode(disk.code, disk.mtime);
            setNotice('Reloaded Solution.java — it was changed outside the browser.');
          } else {
            setConflict({ code: disk.code, mtime: disk.mtime! });
            setSaveStatus('conflict');
          }
        }
        if (s.resultsMtime !== resultsMtime.current && !runningRef.current) {
          const r = await api.results(slug);
          if (stopped) return;
          resultsMtime.current = r.resultsMtime;
          setResult(r.results);
        }
      } catch {
        /* server restarting — try again next tick */
      }
    };
    const t = setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [data?.generated, slug, applyDiskCode]);

  // Flush pending edits / warn when leaving with unsaved changes.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (editorValue() !== savedCode.current) {
        void save();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [save]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  // ---- render ----
  if (loadError) return <div className="page-msg">Couldn’t load “{slug}”: {loadError}. <Link to="/">Home</Link></div>;
  if (!data) return <div className="page-msg">Loading…</div>;
  const { problem } = data;

  return (
    <div className="problem-page">
      <header className="topbar">
        <Link to="/" className="brand">PrepCoach</Link>
        <h1>{problem.title}</h1>
        <span className={`badge ${problem.difficulty}`}>{problem.difficulty}</span>
        <span className="muted topic">{[problem.topic, ...problem.secondaryTopics].join(' · ')}</span>
        {attempt?.isReview && attempt.status === 'in_progress' && <span className="pill review">review</span>}
        <span className="spacer" />
        <HintPill attempt={attempt} meta={meta} />
        <Timer attempt={attempt} />
      </header>

      {!data.generated ? (
        <div className="page-msg">
          This problem’s files haven’t been generated yet. Run <code>/next</code> in Claude Code.
        </div>
      ) : (
        <div className="split">
          <section className="statement">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{ a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}
            >
              {data.statement ?? ''}
            </ReactMarkdown>
          </section>

          <section className="workbench">
            {conflict && (
              <div className="banner warn">
                <span>
                  <b>Solution.java changed on disk</b> while you had unsaved edits here.
                </span>
                <button onClick={() => { applyDiskCode(conflict.code, conflict.mtime); setConflict(null); }}>
                  Load disk version
                </button>
                <button onClick={() => void save(true)}>Keep mine (overwrite)</button>
              </div>
            )}
            <div className="editor-bar">
              <span className="filename">Solution.java</span>
              <span className={`save-status ${saveStatus}`}>{SAVE_LABEL[saveStatus]}</span>
              <span className="spacer" />
              {notice && <span className="notice">{notice}</span>}
              <button className="run" onClick={() => void runTests()} disabled={running} title="Ctrl+Enter">
                {running ? 'Running…' : '▶ Run tests'}
              </button>
            </div>
            <div className="editor">
              <Editor
                language="java"
                theme="vs-dark"
                defaultValue={data.solution ?? ''}
                onMount={onMount}
                onChange={onChange}
                options={{
                  fontSize: 14,
                  tabSize: 4,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  renderWhitespace: 'selection',
                  fixedOverflowWidgets: true,
                }}
              />
            </div>
            <div className="results-pane">
              {runError && <div className="banner error">{runError}</div>}
              <ResultsPanel result={result} running={running} />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
