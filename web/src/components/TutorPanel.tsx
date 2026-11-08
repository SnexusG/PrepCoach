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

const FENCE = /```[^\n]*\n[\s\S]*?(?:```|$)/g;

/**
 * Voice mode with the chat collapsed: a one-line caption of what was heard (gone once the tutor answers), plus
 * anything in the latest reply that is shown rather than spoken (fenced code / tables) and the latest error.
 */
function VoiceView({ onExpand }: { onExpand: () => void }) {
  const t = useTutor();
  const lastIdx = (pred: (e: TranscriptEntry) => boolean) => {
    for (let i = t.entries.length - 1; i >= 0; i--) if (pred(t.entries[i])) return i;
    return -1;
  };
  const iUser = lastIdx((e) => e.role === 'user');
  const iTutor = lastIdx((e) => e.role === 'tutor');
  const iError = lastIdx((e) => e.role === 'error');

  const caption = t.interim || (iUser > iTutor ? t.entries[iUser].text : '');
  const shown = iTutor >= 0 ? (t.entries[iTutor].text.match(FENCE) ?? []).join('\n\n') : '';

  return (
    <div className="t-voice">
      <div className={`t-caption ${caption ? 'on' : ''} ${t.interim ? 'live' : ''}`}>{caption || ' '}</div>
      {shown && (
        <div className="t-msg bot t-shown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{shown}</ReactMarkdown>
        </div>
      )}
      {iError > iTutor && <div className="t-error">{t.entries[iError].text}</div>}
      <button className="t-expand" onClick={onExpand}>
        Transcript hidden while talking. Show chat
      </button>
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

  // Natural (Kokoro) voice list + model state from the server.
  const [tts, setTts] = useState<{ state: string; error: string | null; voices: { id: string; label: string }[] } | null>(null);
  useEffect(() => {
    let stop = false;
    const poll = () =>
      fetch('/api/tts/status')
        .then((r) => r.json())
        .then((s) => {
          if (stop) return;
          setTts(s);
          if (s.state === 'loading') setTimeout(poll, 2000);
        })
        .catch(() => {});
    poll();
    return () => {
      stop = true;
    };
  }, []);

  const kokoro = t.settings.engine === 'kokoro';
  return (
    <div className="t-settings">
      <label>
        <input type="checkbox" checked={t.settings.voiceOut} onChange={(e) => t.updateSettings({ voiceOut: e.target.checked })} />
        Read replies aloud
      </label>
      <label>
        Engine
        <select value={t.settings.engine} onChange={(e) => t.updateSettings({ engine: e.target.value as 'kokoro' | 'browser' })}>
          <option value="kokoro">Natural — Kokoro (local neural voice)</option>
          <option value="browser">Browser built-in (instant, robotic)</option>
        </select>
      </label>
      {kokoro ? (
        <label>
          Voice
          <select value={t.settings.kokoroVoice} onChange={(e) => t.updateSettings({ kokoroVoice: e.target.value })}>
            {(tts?.voices ?? [{ id: 'am_michael', label: 'Michael (US, male)' }]).map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
          {tts?.state === 'loading' && <span className="muted small">loading model…</span>}
          {tts?.state === 'error' && <span className="t-warn small" title={tts.error ?? ''}>model failed — using browser voice</span>}
        </label>
      ) : (
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
      )}
      <div className="t-settings-row">
        <button onClick={() => t.preview("Hi! Walk me through your approach, and tell me the time and space complexity before you start coding.")}>
          ▶ Preview voice
        </button>
      </div>
      <label>
        Speed {t.settings.rate.toFixed(2)}×
        <input type="range" min={0.8} max={1.5} step={0.05} value={t.settings.rate} onChange={(e) => t.updateSettings({ rate: +e.target.value })} />
      </label>
      <label>
        <input type="checkbox" checked={t.settings.chatInVoice} onChange={(e) => t.updateSettings({ chatInVoice: e.target.checked })} />
        Show the chat while talking
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

  const collapsed = t.listening && !t.settings.chatInVoice;
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
        {t.listening && (
          <button
            className="small-btn"
            onClick={() => t.updateSettings({ chatInVoice: !t.settings.chatInVoice })}
            title={collapsed ? 'Show the full chat while talking' : 'Collapse the chat while talking'}
          >
            {collapsed ? 'Show chat' : 'Hide chat'}
          </button>
        )}
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
      {t.voiceError && <div className="t-error">{t.voiceError}</div>}

      {collapsed ? (
        <VoiceView onExpand={() => t.updateSettings({ chatInVoice: true })} />
      ) : (
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
      )}

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
