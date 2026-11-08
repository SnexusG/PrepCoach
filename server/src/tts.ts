import path from 'node:path';

/**
 * Local neural text-to-speech with Kokoro-82M (ONNX, runs on the CPU via onnxruntime-node).
 * The model (~330 MB fp32) downloads once from Hugging Face into data/models/ and is cached.
 * fp32 is used on purpose: on desktop CPUs it is ~3× faster than the q8 build.
 */

export const KOKORO_VOICES: { id: string; label: string }[] = [
  { id: 'af_bella', label: 'Bella (US, female)' },
  { id: 'af_nicole', label: 'Nicole (US, female, soft)' },
  { id: 'af_sarah', label: 'Sarah (US, female)' },
  { id: 'am_michael', label: 'Michael (US, male) — default' },
  { id: 'af_heart', label: 'Heart (US, female)' },
  { id: 'am_fenrir', label: 'Fenrir (US, male)' },
  { id: 'am_puck', label: 'Puck (US, male)' },
  { id: 'bf_emma', label: 'Emma (UK, female)' },
  { id: 'bm_george', label: 'George (UK, male)' },
  { id: 'bm_fable', label: 'Fable (UK, male)' },
];
const VOICE_IDS = new Set(KOKORO_VOICES.map((v) => v.id));

type Kokoro = { generate(text: string, o: { voice: string; speed: number }): Promise<{ toWav(): ArrayBuffer }> };

export class Tts {
  private model: Promise<Kokoro> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  state: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  error: string | null = null;

  constructor(
    private modelDir: string,
    private dtype: 'fp32' | 'q8' | 'q4' = 'fp32',
  ) {}

  status() {
    return { state: this.state, error: this.error, voices: KOKORO_VOICES };
  }

  /** Load (and on first run download) the model. Safe to call repeatedly. */
  load(): Promise<Kokoro> {
    if (!this.model) {
      this.state = 'loading';
      this.model = (async () => {
        const { env } = await import('@huggingface/transformers');
        env.cacheDir = path.resolve(this.modelDir);
        const { KokoroTTS } = await import('kokoro-js');
        const m = (await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
          dtype: this.dtype,
          device: 'cpu',
        })) as unknown as Kokoro;
        await m.generate('Ready.', { voice: 'am_michael', speed: 1 }); // warm-up
        this.state = 'ready';
        this.error = null;
        return m;
      })().catch((e) => {
        this.state = 'error';
        this.error = (e as Error).message;
        this.model = null;
        throw e;
      });
    }
    return this.model;
  }

  /**
   * Synthesize one sentence to WAV. Jobs run one at a time in arrival order (the client requests sentences in
   * speaking order); `cancelled()` lets a job be skipped if the listener has gone away (barge-in).
   */
  synthesize(text: string, voice: string, speed: number, cancelled: () => boolean): Promise<Buffer | null> {
    const v = VOICE_IDS.has(voice) ? voice : 'am_michael';
    const s = Math.min(1.6, Math.max(0.7, Number.isFinite(speed) ? speed : 1));
    const job = this.chain.then(async () => {
      if (cancelled()) return null;
      const m = await this.load();
      if (cancelled()) return null;
      const audio = await m.generate(text, { voice: v, speed: s });
      return Buffer.from(audio.toWav());
    });
    this.chain = job.catch(() => {});
    return job;
  }
}
