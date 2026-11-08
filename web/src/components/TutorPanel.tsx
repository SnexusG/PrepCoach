import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { englishVoices } from '../tutor/speech';
import { useTutor, type TranscriptEntry } from '../tutor/TutorContext';

const ACTIONS: { label: string; cmd: string; title: string }[] = [
  { label: 'Start session', cmd: '/prep-start', title: 'Status and confirm sheet + difficulty' },
  { label: 'Next problem', cmd: '/next', title: 'Serve the next problem' },
  { label: 'Hint', cmd: '/hint', title: 'Tiered hint — cost is announced first' },
  { label: 'Submit', cmd: '/submit', title: 'Interviewer review and record the attempt' },
  { label: 'End', cmd: '/end', title: 'Wrap up with takeaways' },
];

function Entry({ e }: { e: TranscriptEntry }) {
  if (e.role === 'activity') return <div className="t-activity">· {e.text}</div>;
  if (e.role === 'error') return <div className="t-error">{e.text}</div>;
  if (e.role === 'user') return <div className="t-msg user">{e.text}</div>;
  return (
    <div className={`t-msg bot ${e.streaming ? 'streaming' : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{e.text || '…'}</ReactMarkdown>
      {e.interrupted && <span className="t-interrupted">(interrupted)</span>}
    </div>
  );
}

function Settings({ onClose }: { onClose: () => void }) {
  const t = useTutor();
  const [voices, setVoices] = useState(englishVoices);
  useEffect(() => {
    if (!t.synthesisSupported) return;
    const h = () => setVoices(englishVoices());
    speechSynthesis.addEventListener('voiceschanged', h);
    return () => speechSynthesis.removeEventListener('voiceschanged', h);
  }, [t.synthesisSupported]);

  return (
    <div className="t-settings">
      <label>
        <input type="checkbox" checked={t.settings.voiceOut} onChange={(e) => t.updateSettings({ voiceOut: e.target.checked })} />
        Read replies aloud
      </label>
      <label>
        Voice
        <select value={t.settings.voiceURI ?? ''} onChange={(e) => t.updateSettings({ voiceURI: e.target.value || null })}>
          <option value="">Auto (best available)</option>
          {voices.map((v) => (
            <option key={v.voiceURI} value={v.voiceURI}>
              {v.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Speed {t.settings.rate.toFixed(2)}×
        <input type="range" min={0.8} max={1.5} step={0.05} value={t.settings.rate} onChange={(e) => t.updateSettings({ rate: +e.target.value })} />
      </label>
      <label title="How long you must pause before your turn is sent">
        Pause to send {(t.settings.pauseMs / 1000).toFixed(1)} s
        <input type="range" min={1000} max={4000} step={100} value={t.settings.pauseMs} onChange={(e) => t.updateSettings({ pauseMs: +e.target.value })} />
      </label>
      <div className="t-settings-row">
        <button
          onClick={() => {
            if (confirm('Start a fresh tutor conversation? The current transcript is cleared (your progress is not affected).')) {
              t.reset();
              onClose();
            }
          }}
        >
          New conversation
        </button>
        <span className="spacer" />
        <button onClick={onClose}>Done</button>
      </div>
      <p className="muted small">Tip: use headphones — the mic won’t pick up the tutor’s voice, so you can interrupt it cleanly.</p>
    </div>
  );
}

export default function TutorPanel() {
  const t = useTutor();
  const [draft, setDraft] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the newest message in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [t.entries, t.interim]);

  const busy = t.state === 'thinking' || t.state === 'starting';
  const status = !t.connected
    ? 'offline'
    : t.speaking
      ? 'speaking'
      : busy
        ? 'thinking'
        : t.listening
          ? 'listening'
          : 'ready';

  const submitDraft = () => {
    if (!draft.trim()) return;
    t.send(draft);
    setDraft('');
  };

  return (
    <div className="tutor">
      <div className="t-head">
        <span className={`t-dot ${status}`} />
        <b>Tutor</b>
        <span className="muted small">{status}</span>
        <span className="spacer" />
        {t.speaking && <button className="small-btn" onClick={t.stopSpeaking} title="Stop the voice">Stop voice</button>}
        {busy && <button className="small-btn" onClick={t.interrupt} title="Stop the tutor's current reply">Interrupt</button>}
        <button className="small-btn" onClick={() => setShowSettings((s) => !s)} title="Voice settings">⚙</button>
        <button
          className={`mic ${t.listening ? 'on' : ''}`}
          onClick={t.toggleMic}
          disabled={!t.recognitionSupported}
          title={t.recognitionSupported ? 'Hands-free: pause to send, talk over the tutor to interrupt' : 'Needs Chrome or Edge'}
        >
          {t.listening ? '🎙 Listening — click to mute' : '🎙 Start talking'}
        </button>
      </div>

      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
      {t.micError && <div className="t-error">{t.micError}</div>}

      <div className="t-list" ref={listRef}>
        {t.entries.length === 0 && (
          <div className="t-empty">
            Click <b>Start talking</b> and say “let’s start a session”, or use the buttons below.
            {!t.recognitionSupported && <div>Voice input needs Chrome or Edge — you can still type.</div>}
          </div>
        )}
        {t.entries.map((e) => (
          <Entry key={e.id} e={e} />
        ))}
        {t.interim && <div className="t-msg user interim">{t.interim}</div>}
      </div>

      <div className="t-actions">
        {ACTIONS.map((a) => (
          <button key={a.cmd} className="small-btn" title={a.title} onClick={() => t.send(a.cmd)}>
            {a.label}
          </button>
        ))}
      </div>
      <form
        className="t-input"
        onSubmit={(e) => {
          e.preventDefault();
          submitDraft();
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="…or type to the tutor" />
        <button type="submit" disabled={!draft.trim()}>Send</button>
      </form>
    </div>
  );
}
