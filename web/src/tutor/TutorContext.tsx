import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Listener, recognitionSupported as webSpeechSupported, SentenceStream, Speaker, synthesisSupported, type TtsEngine } from './speech';
import { fetchSttStatus, WhisperListener, type SttStatus } from './whisper';

export type SttEngine = 'whisper' | 'browser';

export type TutorState = 'stopped' | 'starting' | 'idle' | 'thinking';

export interface TranscriptEntry {
  id: string;
  role: 'user' | 'tutor' | 'activity' | 'error';
  text: string;
  at: string;
  clientId?: string;
  streaming?: boolean;
  interrupted?: boolean;
}

export interface VoiceSettings {
  voiceOut: boolean;
  /** kokoro = natural local neural voice; browser = built-in (robotic) voices. */
  engine: TtsEngine;
  kokoroVoice: string;
  voiceURI: string | null;
  rate: number;
  pauseMs: number;
  /** Show the full chat while the mic is on (otherwise it collapses to a caption strip). */
  chatInVoice: boolean;
  /** Speech recognition: local Whisper (falls back to the browser when unavailable) or the browser's own. */
  sttEngine: SttEngine;
}

const DEFAULT_SETTINGS: VoiceSettings = {
  sttEngine: 'whisper',
  voiceOut: true,
  engine: 'kokoro',
  kokoroVoice: 'am_michael',
  voiceURI: null,
  rate: 1.05,
  pauseMs: 1800,
  chatInVoice: false,
};

interface TutorApi {
  connected: boolean;
  state: TutorState;
  entries: TranscriptEntry[];
  interim: string;
  listening: boolean;
  speaking: boolean;
  micError: string | null;
  voiceError: string | null;
  /** Increments after every completed tutor turn — pages refetch on it (an attempt may have been recorded). */
  turns: number;
  settings: VoiceSettings;
  /** The local Whisper helper's state (null until fetched / when the server is down). */
  sttStatus: SttStatus | null;
  /** Which recognizer the mic is using right now (null when it's off). */
  sttInUse: SttEngine | null;
  recognitionSupported: boolean;
  synthesisSupported: boolean;
  send(text: string): void;
  toggleMic(): void;
  startMic(): void;
  stopSpeaking(): void;
  preview(text: string): void;
  interrupt(): void;
  reset(): void;
  updateSettings(p: Partial<VoiceSettings>): void;
}

const Ctx = createContext<TutorApi | null>(null);

export const useTutor = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useTutor outside TutorProvider');
  return c;
};

// Per-tab id: only the tab that spoke/typed the last turn reads replies aloud. Survives reloads of the tab.
function tabId(): string {
  try {
    let id = sessionStorage.getItem('prep.tabId');
    if (!id) sessionStorage.setItem('prep.tabId', (id = crypto.randomUUID()));
    return id;
  } catch {
    return 'tab';
  }
}

function loadSettings(): VoiceSettings {
  try {
    // v2 stores only what the user changed, so new defaults still reach them.
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('prep.voice.v2') ?? '{}') };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const post = (url: string, body?: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

export function TutorProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<TutorState>('stopped');
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [interim, setInterim] = useState('');
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [turns, setTurns] = useState(0);
  const [settings, setSettings] = useState<VoiceSettings>(loadSettings);

  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location.pathname);
  locationRef.current = location.pathname;

  const myId = useMemo(tabId, []);
  const speaker = useMemo(() => new Speaker(), []);
  const ownsTurn = useRef(false); // did this tab send the turn being answered?
  const streams = useRef(new Map<string, SentenceStream>());

  /** Stop talking now, and don't speak the rest of any reply still streaming in. */
  const hush = useCallback(() => {
    streams.current.clear();
    speaker.cancel();
  }, [speaker]);

  // ---- sending ----
  const send = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t) return;
      hush();
      ownsTurn.current = true;
      void post('/api/tutor/message', { text: t, clientId: myId });
    },
    [myId, hush],
  );

  // ---- listeners (hands-free): local Whisper, or the browser's Web Speech as the fallback ----
  const [sttStatus, setSttStatus] = useState<SttStatus | null>(null);
  const [sttInUse, setSttInUse] = useState<SttEngine | null>(null);
  const callbacks = useMemo(
    () => ({
      onInterim: (t: string) => {
        // Barge-in: real (non-echo) speech while the tutor talks stops the voice immediately.
        if (t && speaker.speaking && !speaker.isEcho(t)) hush();
        setInterim(t && speaker.echoWindow && speaker.isEcho(t) ? '' : t);
      },
      onUtterance: (t: string) => {
        if (speaker.isEcho(t)) return; // the tutor's own voice through the speakers
        send(t);
      },
      onError: (m: string) => setMicError(m),
      onActiveChange: (a: boolean) => {
        setListening(a);
        if (a) setMicError(null);
        else setSttInUse(null);
      },
    }),
    [speaker, send, hush],
  );
  const listener = useMemo(() => new Listener(callbacks), [callbacks]);
  const whisper = useMemo(() => new WhisperListener(callbacks), [callbacks]);

  // The helper loads its model at server start; poll until it settles, then now and then.
  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    const poll = async () => {
      const s = await fetchSttStatus();
      if (stop) return;
      setSttStatus(s);
      timer = window.setTimeout(poll, !s || s.state === 'starting' ? 3000 : 30000);
    };
    void poll();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, []);

  const startMic = useCallback(async () => {
    if (listener.active || whisper.active) return;
    const s = settings.sttEngine === 'whisper' ? await fetchSttStatus() : null;
    if (s) setSttStatus(s);
    if (s?.state === 'ready') {
      setSttInUse('whisper');
      whisper.start(s);
      return;
    }
    if (!webSpeechSupported) {
      setMicError(`Local speech recognition isn't available (${s?.error ?? s?.state ?? 'server offline'}), and this browser has no built-in one.`);
      return;
    }
    setSttInUse('browser');
    listener.start();
    if (settings.sttEngine === 'whisper') {
      const why = s?.state === 'starting' ? 'still loading' : s?.error ?? s?.state ?? 'server offline';
      setMicError(`Whisper isn't available (${why}), so the browser's recognition is listening instead.`);
    }
  }, [listener, whisper, settings.sttEngine]);

  const stopMic = useCallback(() => {
    listener.stop();
    whisper.stop();
  }, [listener, whisper]);

  useEffect(() => {
    speaker.onSpeakingChange = setSpeaking;
    speaker.onEngineError = setVoiceError;
    speaker.enabled = settings.voiceOut;
    speaker.engine = settings.engine;
    speaker.kokoroVoice = settings.kokoroVoice;
    speaker.voiceURI = settings.voiceURI;
    speaker.rate = settings.rate;
    listener.pauseMs = settings.pauseMs;
    whisper.pauseMs = settings.pauseMs;
    try {
      const changed = Object.fromEntries(
        Object.entries(settings).filter(([k, v]) => DEFAULT_SETTINGS[k as keyof VoiceSettings] !== v),
      );
      localStorage.setItem('prep.voice.v2', JSON.stringify(changed));
      localStorage.removeItem('prep.voice');
    } catch {
      /* private mode */
    }
    if (!settings.voiceOut) speaker.cancel();
  }, [settings, speaker, listener, whisper]);

  useEffect(() => () => stopMic(), [stopMic]);

  // ---- server events ----
  useEffect(() => {
    const es = new EventSource('/api/tutor/events');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      const e = JSON.parse(msg.data);
      switch (e.type) {
        case 'snapshot':
          setEntries(e.entries);
          setState(e.state);
          break;
        case 'state':
          setState(e.state);
          break;
        case 'reset':
          setEntries([]);
          hush();
          break;
        case 'entry': {
          const entry = e.entry as TranscriptEntry;
          if (entry.role === 'user') ownsTurn.current = entry.clientId === myId;
          if (entry.role === 'tutor' && ownsTurn.current) {
            streams.current.set(entry.id, new SentenceStream((s) => speaker.speak(s)));
          }
          setEntries((xs) => [...xs, entry]);
          break;
        }
        case 'delta':
          streams.current.get(e.id)?.push(e.text);
          setEntries((xs) => xs.map((x) => (x.id === e.id ? { ...x, text: x.text + e.text } : x)));
          break;
        case 'entry_end': {
          const s = streams.current.get(e.id);
          streams.current.delete(e.id);
          if (e.interrupted && s) hush();
          else s?.flush();
          setEntries((xs) => xs.map((x) => (x.id === e.id ? { ...x, streaming: false, interrupted: e.interrupted } : x)));
          break;
        }
        case 'turn_end':
          setTurns((n) => n + 1);
          break;
        case 'navigate':
          if (locationRef.current !== `/problem/${e.slug}`) navigate(`/problem/${e.slug}`);
          break;
      }
    };
    return () => es.close();
  }, [myId, navigate, speaker, hush]);

  const api: TutorApi = {
    connected,
    state,
    entries,
    interim,
    listening,
    speaking,
    micError,
    voiceError,
    turns,
    settings,
    sttStatus,
    sttInUse,
    // getUserMedia is all Whisper needs, so the mic works beyond Chrome/Edge when the helper is up.
    recognitionSupported: webSpeechSupported || (sttStatus?.state === 'ready' && !!navigator.mediaDevices?.getUserMedia),
    synthesisSupported,
    send,
    toggleMic: () => (listener.active || whisper.active ? stopMic() : void startMic()),
    startMic: () => void startMic(),
    stopSpeaking: hush,
    preview: (text) => {
      hush();
      speaker.speak(text);
    },
    interrupt: () => {
      hush();
      void post('/api/tutor/interrupt');
    },
    reset: () => {
      hush();
      void post('/api/tutor/reset');
    },
    updateSettings: (p) => {
      setVoiceError(null);
      setSettings((s) => ({ ...s, ...p }));
    },
  };

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
