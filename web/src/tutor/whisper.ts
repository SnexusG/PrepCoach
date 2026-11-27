// Local speech recognition: Silero VAD in the browser finds where you speak; each utterance is transcribed by the
// server's Whisper helper. Same contract as the Web Speech `Listener` (speech.ts), so the tutor can use either.
import type { MicVAD } from '@ricky0123/vad-web';
import type { ListenerCallbacks } from './speech';

export interface SttStatus {
  state: 'disabled' | 'starting' | 'ready' | 'error';
  error: string | null;
  device: string | null;
  model: string | null;
  engine: 'whisper' | 'browser';
  vadThreshold: number;
  minSpeechMs: number;
  previewMs: number;
}

export async function fetchSttStatus(): Promise<SttStatus | null> {
  try {
    const r = await fetch('/api/stt/status');
    return r.ok ? ((await r.json()) as SttStatus) : null;
  } catch {
    return null;
  }
}

async function transcribe(pcm: Float32Array): Promise<string> {
  const body = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength).slice();
  const r = await fetch('/api/stt', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return String(j.text ?? '').trim();
}

const concat = (frames: Float32Array[]) => {
  const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
  let o = 0;
  for (const f of frames) (out.set(f, o), (o += f.length));
  return out;
};

/** Whisper's typical hallucinations on silence / noise: never send these as a turn. */
const NOISE = /^(\W*|you|thank you\.?|thanks for watching!?|bye\.?|\[.*\]|\(.*\))$/i;

export class WhisperListener {
  private vad: MicVAD | null = null;
  private openToken = 0;
  private wanted = false;
  private status: SttStatus | null = null;
  /** Frames of the utterance in progress (for live previews). */
  private frames: Float32Array[] = [];
  private speaking = false;
  private lastPreview = 0;
  private previewBusy = false;
  /** Bumped when a segment is discarded or the listener stops: late results for older segments are dropped. */
  private generation = 0;
  /** Final transcriptions are delivered in speaking order. */
  private chain: Promise<void> = Promise.resolve();
  private _pauseMs = 1800;

  constructor(private cb: ListenerCallbacks) {}

  get active() {
    return this.wanted;
  }

  get pauseMs() {
    return this._pauseMs;
  }

  /** How long a pause ends your turn (the VAD's redemption time). */
  set pauseMs(ms: number) {
    this._pauseMs = ms;
    this.vad?.setOptions({ redemptionMs: ms });
  }

  start(status: SttStatus) {
    if (this.wanted) return;
    this.wanted = true;
    this.status = status;
    this.cb.onActiveChange(true);
    this.open(++this.openToken).catch((e) => {
      this.cb.onError(
        /denied|NotAllowed/i.test(String(e)) ? 'Microphone permission was denied.' : `Couldn't start the microphone: ${(e as Error).message}`,
      );
      this.stop();
    });
  }

  stop() {
    this.wanted = false;
    this.generation++;
    this.speaking = false;
    this.frames = [];
    this.openToken++; // an open() still in flight will destroy its VAD instead of starting it
    const vad = this.vad;
    this.vad = null;
    void vad?.destroy();
    this.cb.onInterim('');
    this.cb.onActiveChange(false);
  }

  /** Drop the utterance in progress (e.g. it was the tutor's own voice). */
  discard() {
    this.generation++;
    this.frames = [];
    this.cb.onInterim('');
  }

  private async open(token: number) {
    const { MicVAD } = await import('@ricky0123/vad-web');
    const s = this.status!;
    const vad = await MicVAD.new({
      model: 'v5',
      baseAssetPath: '/vad/',
      onnxWASMBasePath: '/vad/',
      positiveSpeechThreshold: s.vadThreshold,
      negativeSpeechThreshold: Math.max(0.05, s.vadThreshold - 0.15),
      redemptionMs: this._pauseMs,
      minSpeechMs: s.minSpeechMs,
      preSpeechPadMs: 400,
      getStream: () =>
        navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        }),
      onSpeechStart: () => {
        this.speaking = true;
        this.frames = [];
        this.lastPreview = performance.now();
      },
      onFrameProcessed: (_probs, frame) => {
        if (!this.speaking) return;
        this.frames.push(frame.slice());
        this.maybePreview();
      },
      onVADMisfire: () => {
        this.speaking = false;
        this.frames = [];
        this.cb.onInterim('');
      },
      onSpeechEnd: (audio) => {
        this.speaking = false;
        this.frames = [];
        this.finish(audio);
      },
    });
    if (token !== this.openToken) {
      await vad.destroy();
      return;
    }
    this.vad = vad;
    await vad.start();
  }

  /** While you talk: re-transcribe the audio so far for the live caption (one request at a time). */
  private maybePreview() {
    const every = this.status?.previewMs ?? 0;
    if (!every || this.previewBusy || performance.now() - this.lastPreview < every) return;
    this.lastPreview = performance.now();
    this.previewBusy = true;
    const gen = this.generation;
    transcribe(concat(this.frames))
      .then((text) => {
        if (gen === this.generation && this.speaking && text && !NOISE.test(text)) this.cb.onInterim(text + ' …');
      })
      .catch(() => {})
      .finally(() => (this.previewBusy = false));
  }

  private finish(audio: Float32Array) {
    const gen = this.generation;
    this.cb.onInterim('…');
    const job = transcribe(audio);
    this.chain = this.chain.then(async () => {
      try {
        const text = await job;
        if (gen !== this.generation) return;
        this.cb.onInterim('');
        if (text && !NOISE.test(text)) this.cb.onUtterance(text);
      } catch (e) {
        if (gen !== this.generation) return;
        this.cb.onInterim('');
        this.cb.onError(`Speech recognition failed: ${(e as Error).message}`);
      }
    });
  }
}
