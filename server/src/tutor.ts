import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TutorConfig } from '@prepcoach/core';

/**
 * Bridges the web app to a headless Claude Code session (`claude -p` with stream-json in/out).
 * Claude Code is still the tutor — same CLAUDE.md, slash commands and `npx prep` state rules — the browser only
 * replaces the terminal with speech. One long-lived process per server; the session id is persisted so a
 * server restart resumes the same conversation.
 *
 * Conversations are per study session: `/prep-start` (or a long idle gap) starts a fresh Claude conversation and
 * archives the old transcript — all durable state is in the database, which the tutor reloads with `prep context`.
 * Transcript entries are tagged with the problem they belong to (`scope`), so the UI shows one problem's chat.
 */

export type TutorState = 'stopped' | 'starting' | 'idle' | 'thinking';

export interface TranscriptEntry {
  id: string;
  role: 'user' | 'tutor' | 'activity' | 'error';
  text: string;
  at: string;
  /** user entries: which browser tab sent it (that tab speaks the reply). */
  clientId?: string;
  /** tutor entries: still streaming. */
  streaming?: boolean;
  interrupted?: boolean;
  /** The problem this message belongs to (slug), or null for session-level chat. */
  scope?: string | null;
}

export type TutorEvent =
  | { type: 'state'; state: TutorState }
  | { type: 'entry'; entry: TranscriptEntry }
  | { type: 'delta'; id: string; text: string }
  | { type: 'entry_end'; id: string; interrupted?: boolean }
  | { type: 'turn_end' }
  | { type: 'navigate'; slug: string }
  | { type: 'scope'; scope: string | null; title: string | null }
  | { type: 'reset' };

export interface TutorBridgeOptions {
  /** Problem title for a slug (for the "Chat for …" label). */
  titleOf?: (slug: string) => string | null;
}

const VOICE_PROMPT = (refDir: string) => `
# VOICE MODE (PrepCoach web app)
You are talking with the user out loud. Their speech is transcribed automatically (expect recognition errors:
"hash map" may arrive as "hashmap"/"has map", "O of n" as "o n" — interpret charitably, ask if it truly matters),
and every word of your text reply is read aloud by a speech synthesizer. Everything in CLAUDE.md still applies.
- Speak like an interviewer on a call: usually 1–3 short sentences, then stop and let them talk. One question at a time.
- No markdown in spoken text: no headings, bullets, tables, bold, links or emoji. Say complexities as people say
  them ("O of n log n").
- The problem statement, the code editor and test results are on the user's screen. Never read a statement,
  constraints or examples aloud. When you serve a problem, say its title, topic, difficulty and why it was picked,
  give a one-sentence gist, then ask for the approach. The page navigates to it automatically after \`npx prep start\`.
- The user's code autosaves to problems/<slug>/Solution.java — read it yourself instead of asking them to paste.
- If something must be shown rather than spoken (code at hint level 4, a status table), put it in a fenced code
  block — it is displayed, not read — and say "it's on your screen".
- Don't narrate tool use ("let me run…"); just do it and speak the outcome.
- Problem generation: private reference solutions go only in ${refDir} and are removed with \`npx prep ref-clean\`.
`;

const MAX_ENTRIES = 400;

export class TutorBridge extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private stderrTail = '';
  private sessionId: string | null = null;
  private entries: TranscriptEntry[] = [];
  private current: TranscriptEntry | null = null; // tutor message being streamed
  private pendingStarts = new Map<string, string>(); // tool_use id -> slug for `npx prep start <slug>`
  private phase: 'text' | 'tools' | null = null;
  private resumeFailed = false;
  /** Problem the conversation is currently about (set when the tutor runs `npx prep start <slug>`). */
  private scope: string | null = null;
  state: TutorState = 'stopped';

  constructor(
    private cfg: TutorConfig,
    private cwd: string,
    private dataDir: string,
    private opts: TutorBridgeOptions = {},
  ) {
    super();
    fs.mkdirSync(dataDir, { recursive: true });
    this.sessionId = this.readJson<{ sessionId: string }>('session.json')?.sessionId ?? null;
    this.entries = this.readTranscript();
    this.scope = this.readJson<{ scope: string | null }>('scope.json')?.scope ?? null;
  }

  private scopeTitle(): string | null {
    if (!this.scope) return null;
    try {
      return this.opts.titleOf?.(this.scope) ?? this.scope;
    } catch {
      return this.scope;
    }
  }

  snapshot() {
    return { state: this.state, entries: this.entries, sessionId: this.sessionId, scope: this.scope, scopeTitle: this.scopeTitle() };
  }

  /** Send a user turn. If the tutor is mid-reply in text (not mid-tool), interrupt it first, like a real call. */
  send(text: string, clientId?: string) {
    const t = text.trim();
    if (!t) return;
    const last = this.entries.length ? Date.parse(this.entries[this.entries.length - 1].at) : null;
    const idleHours = last ? (Date.now() - last) / 36e5 : 0;
    if (this.state !== 'thinking' && (/^\/prep-start\b/.test(t) || idleHours > this.cfg.freshConversationAfterHours)) {
      this.freshConversation(/^\/prep-start\b/.test(t) ? 'new session' : `idle for ${Math.round(idleHours)} h`);
    }
    if (this.state === 'thinking' && this.phase === 'text') this.interrupt();
    this.ensureStarted();
    this.addEntry({ id: randomUUID(), role: 'user', text: t, at: new Date().toISOString(), clientId });
    this.write({ type: 'user', message: { role: 'user', content: t } });
    this.setState('thinking');
  }

  /** Stop the current reply (barge-in). The process stays alive and keeps the conversation. */
  interrupt() {
    if (!this.proc || this.state !== 'thinking') return;
    this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
    this.endCurrent(true);
  }

  /**
   * Start a new Claude conversation: the old transcript is archived (data/tutor/archive/) and the chat starts empty.
   * A new study session also clears the problem scope; an idle-gap restart keeps it (the problem may still be open).
   */
  private freshConversation(reason: string) {
    if (!this.sessionId && !this.entries.length) return;
    this.kill();
    this.sessionId = null;
    this.resumeFailed = false;
    this.current = null;
    fs.rmSync(path.join(this.dataDir, 'session.json'), { force: true });
    const f = path.join(this.dataDir, 'transcript.jsonl');
    if (fs.existsSync(f)) {
      const archive = path.join(this.dataDir, 'archive');
      fs.mkdirSync(archive, { recursive: true });
      fs.renameSync(f, path.join(archive, `transcript-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`));
    }
    this.entries = [];
    this.emitEvent({ type: 'reset' });
    if (reason === 'new session') this.setScope(null);
    this.addEntry({ id: randomUUID(), role: 'activity', text: `new conversation (${reason}); the previous one is archived`, at: new Date().toISOString() });
    this.setState('stopped');
  }

  /** On first run (no saved scope yet), take the problem that's currently open as the chat's problem. */
  adoptScope(slug: string | null) {
    if (!fs.existsSync(path.join(this.dataDir, 'scope.json')) && slug) this.setScope(slug);
  }

  private setScope(scope: string | null) {
    if (this.scope === scope) return;
    this.scope = scope;
    this.writeJson('scope.json', { scope });
    this.emitEvent({ type: 'scope', scope, title: this.scopeTitle() });
  }

  /** Forget the conversation and start a fresh Claude Code session on the next message. */
  reset() {
    this.kill();
    this.sessionId = null;
    this.entries = [];
    this.current = null;
    fs.rmSync(path.join(this.dataDir, 'session.json'), { force: true });
    fs.rmSync(path.join(this.dataDir, 'transcript.jsonl'), { force: true });
    this.emitEvent({ type: 'reset' });
    this.setState('stopped');
  }

  kill() {
    if (this.proc) {
      this.proc.removeAllListeners();
      this.proc.stdout.removeAllListeners();
      this.proc.kill();
      this.proc = null;
    }
  }

  // ---------------------------------------------------------------- process

  private ensureStarted() {
    if (this.proc) return;
    const refDir = path.join(os.tmpdir(), 'prepcoach-ref');
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', this.cfg.permissionMode,
      '--allowedTools', ...this.cfg.allowedTools,
      '--append-system-prompt', VOICE_PROMPT(refDir),
    ];
    if (this.cfg.model) args.push('--model', this.cfg.model);
    if (this.sessionId && !this.resumeFailed) args.push('--resume', this.sessionId);

    const bin = process.env.PREP_CLAUDE_BIN || this.cfg.claudeBin;
    this.setState('starting');
    this.stderrTail = '';
    const proc = spawn(bin, args, { cwd: this.cwd, env: process.env, windowsHide: true });
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d: string) => this.onStdout(d));
    proc.stderr.on('data', (d) => (this.stderrTail = (this.stderrTail + String(d)).slice(-2000)));
    proc.on('error', (e) => this.onExit(null, e.message));
    proc.on('exit', (code) => this.onExit(code));
  }

  private onExit(code: number | null, error?: string) {
    if (!this.proc) return;
    this.proc = null;
    this.endCurrent(this.state === 'thinking');
    const resumeBroke = this.sessionId && !this.resumeFailed && /resume|session|conversation/i.test(this.stderrTail);
    const detail = error ?? (this.stderrTail.trim() || `exit code ${code}`);
    if (resumeBroke) {
      // Saved session is gone (e.g. cleaned up) — start fresh next time.
      this.resumeFailed = true;
      this.sessionId = null;
    }
    this.addEntry({
      id: randomUUID(),
      role: 'error',
      text: error
        ? `Couldn't start Claude Code (${detail}). Is the \`claude\` CLI installed and logged in?`
        : `The tutor process stopped: ${detail.slice(-500)}`,
      at: new Date().toISOString(),
    });
    this.setState('stopped');
  }

  private write(msg: unknown) {
    this.proc?.stdin.write(JSON.stringify(msg) + '\n');
  }

  private onStdout(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try {
        this.onMessage(JSON.parse(line));
      } catch {
        /* non-JSON noise */
      }
    }
  }

  private onMessage(m: any) {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init' && m.session_id) {
          this.sessionId = m.session_id;
          this.resumeFailed = false;
          this.writeJson('session.json', { sessionId: m.session_id });
          if (this.state === 'starting') this.setState('thinking');
        }
        break;

      case 'stream_event': {
        const e = m.event;
        if (m.parent_tool_use_id) break; // subagent chatter
        if (e?.type === 'content_block_start' && e.content_block?.type === 'tool_use') this.phase = 'tools';
        if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          this.phase = 'text';
          if (!this.current) {
            this.current = { id: randomUUID(), role: 'tutor', text: '', at: new Date().toISOString(), streaming: true };
            this.addEntry(this.current, false);
          }
          this.current.text += e.delta.text;
          this.emitEvent({ type: 'delta', id: this.current.id, text: e.delta.text });
        }
        if (e?.type === 'content_block_stop' && this.current) this.endCurrent(false);
        break;
      }

      case 'assistant': {
        if (m.parent_tool_use_id) break;
        for (const c of m.message?.content ?? []) {
          if (c.type !== 'tool_use') continue;
          this.addEntry({ id: randomUUID(), role: 'activity', text: describeTool(c.name, c.input), at: new Date().toISOString() });
          const cmd = c.name === 'Bash' ? String(c.input?.command ?? '') : '';
          const start = /npx prep start ([a-z0-9-]+)/.exec(cmd);
          if (start) this.pendingStarts.set(c.id, start[1]);
        }
        break;
      }

      case 'user': {
        for (const c of m.message?.content ?? []) {
          if (c.type === 'tool_result' && this.pendingStarts.has(c.tool_use_id)) {
            const slug = this.pendingStarts.get(c.tool_use_id)!;
            this.pendingStarts.delete(c.tool_use_id);
            if (!c.is_error) {
              this.setScope(slug); // from here on, the chat is about this problem
              this.emitEvent({ type: 'navigate', slug });
            }
          }
        }
        break;
      }

      case 'result':
        this.endCurrent(false);
        this.phase = null;
        if (m.is_error && m.subtype !== 'error_during_execution') {
          this.addEntry({ id: randomUUID(), role: 'error', text: `Tutor error: ${m.result ?? m.subtype}`, at: new Date().toISOString() });
        }
        this.emitEvent({ type: 'turn_end' });
        this.setState('idle');
        break;
    }
  }

  // ---------------------------------------------------------------- transcript

  private endCurrent(interrupted: boolean) {
    const c = this.current;
    if (!c) return;
    this.current = null;
    c.streaming = false;
    if (interrupted) c.interrupted = true;
    this.persist(c);
    this.emitEvent({ type: 'entry_end', id: c.id, interrupted });
  }

  private addEntry(e: TranscriptEntry, persist = true) {
    if (e.scope === undefined) e.scope = this.scope;
    this.entries.push(e);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    if (persist) this.persist(e);
    this.emitEvent({ type: 'entry', entry: e });
  }

  private persist(e: TranscriptEntry) {
    fs.appendFileSync(path.join(this.dataDir, 'transcript.jsonl'), JSON.stringify(e) + '\n');
  }

  private readTranscript(): TranscriptEntry[] {
    const f = path.join(this.dataDir, 'transcript.jsonl');
    if (!fs.existsSync(f)) return [];
    const out: TranscriptEntry[] = [];
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push({ ...JSON.parse(line), streaming: false });
      } catch {
        /* skip */
      }
    }
    return out.slice(-MAX_ENTRIES);
  }

  private readJson<T>(name: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dataDir, name), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  private writeJson(name: string, v: unknown) {
    fs.writeFileSync(path.join(this.dataDir, name), JSON.stringify(v));
  }

  private setState(s: TutorState) {
    if (this.state === s) return;
    this.state = s;
    this.emitEvent({ type: 'state', state: s });
  }

  private emitEvent(e: TutorEvent) {
    this.emit('event', e);
  }
}

/** Short, human label for a tool call shown in the transcript ("running tests", "reading your code"). */
function describeTool(name: string, input: any): string {
  if (name === 'Bash') {
    const cmd = String(input?.command ?? '');
    const m = /npx prep ([a-z-]+)(?: ([a-z0-9-]+))?/.exec(cmd);
    if (m) {
      const labels: Record<string, string> = {
        context: 'loading your progress',
        session: 'updating the session',
        next: 'picking the next problem',
        start: 'starting the timer',
        'run-tests': 'running tests',
        hint: 'logging a hint',
        'record-attempt': 'recording the attempt',
        abandon: 'abandoning the problem',
        scaffold: 'generating the problem',
        tag: 'tagging the problem',
        stats: 'loading stats',
        weakness: 'checking weaknesses',
        reviews: 'checking reviews',
        set: 'updating preferences',
        'ref-clean': 'cleaning up',
      };
      return labels[m[1]] ?? `prep ${m[1]}`;
    }
    return input?.description ? String(input.description) : 'running a command';
  }
  if (name === 'Read') {
    const f = String(input?.file_path ?? '');
    return /Solution\.java$/.test(f) ? 'reading your code' : `reading ${path.basename(f)}`;
  }
  if (name === 'Write' || name === 'Edit') return `writing ${path.basename(String(input?.file_path ?? 'a file'))}`;
  if (name === 'Skill') return `running /${input?.skill ?? 'command'}`;
  return name;
}
