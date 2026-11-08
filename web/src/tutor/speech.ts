// Browser speech: recognition (Web Speech API) with pause-based turn-taking, and sentence-streamed synthesis.

// ---------------------------------------------------------------- recognition

interface SRAlternative { transcript: string }
interface SRResult { isFinal: boolean; 0: SRAlternative; length: number }
interface SREvent { resultIndex: number; results: { length: number; [i: number]: SRResult } }
interface SR {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SREvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}

const SRClass: (new () => SR) | undefined =
  (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

export const recognitionSupported = !!SRClass;
export const synthesisSupported = 'speechSynthesis' in window;

export interface ListenerCallbacks {
  /** Live (not yet committed) words — for the ghost bubble and barge-in. */
  onInterim(text: string): void;
  /** A finished turn: the user paused for `pauseMs`. */
  onUtterance(text: string): void;
  onError(message: string): void;
  onActiveChange(active: boolean): void;
}

/**
 * Hands-free listener: keeps the mic open (restarting when the browser ends recognition), and commits a turn
 * once nothing new has been heard for `pauseMs`.
 */
export class Listener {
  private rec: SR | null = null;
  private wanted = false;
  private committedUpTo = 0;
  private text = '';
  private timer: number | undefined;
  private restartTimer: number | undefined;
  pauseMs = 1800;
  lang = 'en-US';

  constructor(private cb: ListenerCallbacks) {}

  get active() {
    return this.wanted;
  }

  start() {
    if (!SRClass) return this.cb.onError('Speech recognition needs Chrome or Edge.');
    if (this.wanted) return;
    this.wanted = true;
    this.cb.onActiveChange(true);
    this.open();
  }

  stop() {
    this.wanted = false;
    window.clearTimeout(this.timer);
    window.clearTimeout(this.restartTimer);
    this.rec?.abort();
    this.rec = null;
    this.text = '';
    this.cb.onInterim('');
    this.cb.onActiveChange(false);
  }

  /** Drop whatever has been heard so far (e.g. it was the tutor's own voice). */
  discard() {
    window.clearTimeout(this.timer);
    this.text = '';
    this.cb.onInterim('');
  }

  private open() {
    const rec = new SRClass!();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.lang;
    this.committedUpTo = 0;
    rec.onresult = (e) => {
      let s = '';
      for (let i = this.committedUpTo; i < e.results.length; i++) s += e.results[i][0].transcript;
      this.text = s.trim();
      this.cb.onInterim(this.text);
      window.clearTimeout(this.timer);
      const resultsLen = e.results.length;
      this.timer = window.setTimeout(() => this.commit(resultsLen), this.pauseMs);
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.cb.onError('Microphone permission was denied.');
        this.stop();
      } else if (e.error === 'network') {
        this.cb.onError('Speech recognition lost its connection; retrying…');
      } // 'no-speech' / 'aborted' are routine
    };
    rec.onend = () => {
      if (this.rec !== rec) return;
      // Chrome ends continuous recognition periodically: commit what we have and reopen.
      if (this.text) this.commit(Infinity);
      this.rec = null;
      if (this.wanted) this.restartTimer = window.setTimeout(() => this.wanted && this.open(), 250);
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      /* already started */
    }
  }

  private commit(upTo: number) {
    window.clearTimeout(this.timer);
    const t = this.text.trim();
    this.text = '';
    this.committedUpTo = upTo === Infinity ? 0 : upTo;
    this.cb.onInterim('');
    if (t) this.cb.onUtterance(t);
  }
}

// ---------------------------------------------------------------- synthesis

/** Turn markdown-ish tutor text into something pleasant to hear. Code blocks are shown, not read. */
export function speakable(md: string): string {
  return md
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\bO\(([^)]+)\)/g, (_, x: string) => `O of ${x.replace(/\^2/g, ' squared').replace(/\*/g, ' times ')}`)
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\|/g, ', ')
    .replace(/[*_~]+/g, '')
    .replace(/\s*(→|->)\s*/g, ', ')
    .replace(/≤/g, ' at most ')
    .replace(/≥/g, ' at least ')
    .replace(/([^.!?:;,\s])[ \t]*\n/g, '$1.\n') // a line break is a pause
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits a streaming reply into speakable sentences, skipping fenced code. */
export class SentenceStream {
  private buf = '';
  private inFence = false;

  constructor(private emit: (sentence: string) => void) {}

  push(delta: string) {
    this.buf += delta;
    this.drain(false);
  }

  flush() {
    this.drain(true);
  }

  private drain(final: boolean) {
    for (;;) {
      if (this.inFence) {
        const close = this.buf.indexOf('```');
        if (close < 0) {
          if (final) this.buf = '';
          return;
        }
        this.buf = this.buf.slice(close + 3).replace(/^[^\n]*\n?/, '');
        this.inFence = false;
        continue;
      }
      const fence = this.buf.indexOf('```');
      const endRe = /[.!?](?=\s)|\n/g;
      const m = endRe.exec(this.buf);
      const end = m ? m.index + 1 : -1;
      if (fence >= 0 && (end < 0 || fence < end)) {
        this.say(this.buf.slice(0, fence));
        this.buf = this.buf.slice(fence + 3);
        this.inFence = true;
        continue;
      }
      if (end < 0) {
        if (final) {
          this.say(this.buf);
          this.buf = '';
        }
        return;
      }
      this.say(this.buf.slice(0, end));
      this.buf = this.buf.slice(end);
    }
  }

  private say(raw: string) {
    const s = speakable(raw);
    if (/[a-z0-9]/i.test(s)) this.emit(s);
  }
}

/** Queue of utterances with a speaking flag and a memory of recent words (for echo filtering). */
export class Speaker {
  private pending = 0;
  private recent: { words: string[]; at: number }[] = [];
  private lastEnd = 0;
  voiceURI: string | null = null;
  rate = 1.05;
  enabled = true;
  onSpeakingChange: (speaking: boolean) => void = () => {};

  get speaking() {
    return this.pending > 0;
  }

  /** True while speaking or just after — when the mic may still be hearing us. */
  get echoWindow() {
    return this.speaking || Date.now() - this.lastEnd < 1500;
  }

  speak(text: string) {
    if (!this.enabled || !synthesisSupported || !text) return;
    const u = new SpeechSynthesisUtterance(text);
    const v = speechSynthesis.getVoices().find((x) => x.voiceURI === this.voiceURI) ?? defaultVoice();
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
    u.rate = this.rate;
    this.recent.push({ words: words(text), at: Date.now() });
    this.recent = this.recent.filter((r) => Date.now() - r.at < 60000);
    this.pending++;
    if (this.pending === 1) this.onSpeakingChange(true);
    const done = () => {
      this.pending = Math.max(0, this.pending - 1);
      this.lastEnd = Date.now();
      if (this.pending === 0) this.onSpeakingChange(false);
    };
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
  }

  cancel() {
    if (!synthesisSupported) return;
    speechSynthesis.cancel();
    if (this.pending) {
      this.pending = 0;
      this.lastEnd = Date.now();
      this.onSpeakingChange(false);
    }
  }

  /** Is this transcript mostly the tutor's own voice coming back through the mic? */
  isEcho(text: string): boolean {
    if (!this.echoWindow) return false;
    const spoken = new Set(this.recent.flatMap((r) => r.words));
    const w = words(text);
    if (w.length === 0) return true;
    const fresh = w.filter((x) => !spoken.has(x)).length;
    return fresh < 2 || fresh / w.length < 0.5;
  }
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);

export function englishVoices(): SpeechSynthesisVoice[] {
  if (!synthesisSupported) return [];
  return speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('en'));
}

function defaultVoice(): SpeechSynthesisVoice | undefined {
  const vs = englishVoices();
  const score = (v: SpeechSynthesisVoice) =>
    (/natural/i.test(v.name) ? 8 : 0) +
    (/online/i.test(v.name) ? 2 : 0) +
    (/google/i.test(v.name) ? 4 : 0) +
    (/aria|jenny|guy|ava|andrew|emma/i.test(v.name) ? 3 : 0) +
    (v.lang === 'en-US' ? 1 : 0);
  return [...vs].sort((a, b) => score(b) - score(a))[0];
}
