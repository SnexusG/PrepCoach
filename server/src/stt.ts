import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { sttArgs, sttPython, type SttConfig } from '@prepcoach/core';

/**
 * Local speech-to-text: a long-lived Python helper (server/stt/whisper_server.py, faster-whisper) spoken to over
 * JSON lines on stdin/stdout. The browser detects speech (Silero VAD) and posts 16 kHz float32 PCM per utterance.
 */

export type SttState = 'disabled' | 'starting' | 'ready' | 'error';

interface Pending {
  resolve: (r: { text: string; ms: number }) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class Stt {
  state: SttState;
  error: string | null = null;
  device: string | null = null;
  model: string | null = null;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private restarts = 0;
  private stopping = false;
  private stderrTail = '';

  constructor(
    private cfg: SttConfig,
    private root: string,
  ) {
    this.state = cfg.engine === 'whisper' ? 'starting' : 'disabled';
  }

  status() {
    return { state: this.state, error: this.error, device: this.device, model: this.model };
  }

  start(): void {
    if (this.cfg.engine !== 'whisper' || this.proc) return;
    this.state = 'starting';
    this.error = null;
    const proc = spawn(sttPython(this.root, this.cfg), sttArgs(this.root, this.cfg), {
      cwd: this.root,
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_SYMLINKS_WARNING: '1' },
    });
    this.proc = proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
    proc.stderr.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-2000);
    });
    proc.on('error', (e) => this.onExit(`could not start ${sttPython(this.root, this.cfg)}: ${e.message}`));
    proc.on('exit', (code) => this.onExit(`speech helper exited (code ${code}). ${this.stderrTail.trim().split('\n').slice(-3).join(' ')}`));
  }

  stop(): void {
    this.stopping = true; // a deliberate stop must not look like a crash (which would schedule a restart)
    const p = this.proc;
    this.proc = null;
    p?.kill();
  }

  private onLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // stray output
    }
    if (msg.type === 'ready') {
      this.state = 'ready';
      this.device = msg.device;
      this.model = msg.model;
      this.restarts = 0;
      console.log(`Whisper speech recognition ready: ${msg.model} on ${msg.device} (${msg.computeType})`);
      return;
    }
    if (msg.type === 'fatal') {
      this.error = msg.error;
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve({ text: String(msg.text ?? ''), ms: Number(msg.ms ?? 0) });
  }

  private onExit(reason: string) {
    if (this.stopping) return;
    if (!this.proc && this.state !== 'starting' && this.state !== 'ready') return;
    this.proc = null;
    const wasReady = this.state === 'ready';
    this.state = 'error';
    this.error = this.error ?? reason;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('speech helper stopped'));
    }
    this.pending.clear();
    console.error(`Whisper speech recognition unavailable: ${this.error}`);
    // A crash after a good start is retried a few times; a failed start (missing packages, no model) is not.
    if (wasReady && this.restarts < 3) {
      this.restarts++;
      setTimeout(() => {
        this.error = null;
        this.start();
      }, 3000);
    }
  }

  /** Transcribes one utterance (16 kHz mono float32 PCM). */
  transcribe(pcm: Buffer, prompt: string): Promise<{ text: string; ms: number }> {
    if (this.state !== 'ready' || !this.proc) return Promise.reject(new Error(this.error ?? `speech recognition is ${this.state}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('transcription timed out'));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin.write(JSON.stringify({ id, audio: pcm.toString('base64'), prompt }) + '\n');
    });
  }
}

// ---------------------------------------------------------------- vocabulary prompt

/** Terms general speech models mangle in a coding interview. Whisper's prompt biases it toward them. */
const GLOSSARY = [
  'HashMap', 'HashSet', 'TreeMap', 'ArrayList', 'LinkedList', 'ArrayDeque', 'deque', 'PriorityQueue', 'min-heap',
  'max-heap', 'trie', 'BFS', 'DFS', 'DP', 'memoization', 'tabulation', 'backtracking', 'two pointers',
  'sliding window', 'binary search', 'prefix sum', 'monotonic stack', 'topological sort', 'Dijkstra',
  'union-find', 'bit manipulation', 'XOR', 'O(n)', 'O(n log n)', 'O(1)', 'O(n²)', 'time complexity',
  'space complexity', 'edge case', 'null', 'int', 'Integer', 'boolean', 'char', 'String', 'StringBuilder',
  'array', 'subarray', 'substring', 'index', 'pointer', 'recursion', 'base case', 'iterate', 'mid', 'left', 'right',
];

const JAVA_WORDS = new Set(
  ('abstract assert boolean break byte case catch char class const continue default do double else enum extends final ' +
    'finally float for goto if implements import instanceof int interface long native new package private protected ' +
    'public return short static strictfp super switch synchronized this throw throws transient try void volatile while ' +
    'var true false null String Integer List Map Set Arrays Math System out println length size get put add remove ' +
    'Solution util java lang').split(' '),
);

/** Identifiers the user wrote (variable/method names), most specific first, without Java keywords. */
export function identifiersFrom(code: string, max = 30): string[] {
  const seen = new Set<string>();
  for (const m of code.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ' ').matchAll(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g)) {
    const w = m[0];
    if (!JAVA_WORDS.has(w) && !seen.has(w)) seen.add(w);
    if (seen.size >= max) break;
  }
  return [...seen];
}

/**
 * The prompt for one utterance. faster-whisper keeps only the last ~224 prompt tokens, so the most specific context
 * (the current problem and the user's own identifiers) goes last and the general glossary first.
 */
export function buildPrompt(opts: { title?: string; topic?: string; code?: string | null; extra?: string[] }): string {
  const parts = [
    'A software engineer explains a coding interview solution in Java.',
    `Terms: ${[...GLOSSARY, ...(opts.extra ?? [])].join(', ')}.`,
  ];
  if (opts.title) parts.push(`Problem: ${opts.title}${opts.topic ? ` (${opts.topic})` : ''}.`);
  const ids = opts.code ? identifiersFrom(opts.code) : [];
  if (ids.length) parts.push(`In the code: ${ids.join(', ')}.`);
  return parts.join(' ');
}
