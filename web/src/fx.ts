/** Reward effects: tiny synthesized sounds (Web Audio, no assets) and confetti. Callers pass the user's toggles. */
import confetti from 'canvas-confetti';

let ctx: AudioContext | null = null;
const audio = () => {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
};

/** A soft bell-like note: sine + a quiet octave, quick attack, exponential decay. */
function note(freq: number, start: number, dur = 0.35, gain = 0.12) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + start;
  for (const [mult, g] of [
    [1, gain],
    [2, gain * 0.25],
  ] as const) {
    const o = a.createOscillator();
    const v = a.createGain();
    o.type = 'sine';
    o.frequency.value = freq * mult;
    v.gain.setValueAtTime(0, t);
    v.gain.linearRampToValueAtTime(g, t + 0.015);
    v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(v).connect(a.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
}

export const sounds = {
  /** A solve / quest: two rising notes. */
  chime: () => [659.25, 987.77].forEach((f, i) => note(f, i * 0.09)),
  /** A badge: a bright little arpeggio. */
  badge: () => [783.99, 987.77, 1318.51].forEach((f, i) => note(f, i * 0.08, 0.4)),
  /** A level up: a major arpeggio with a held top note. */
  levelUp: () => [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => note(f, i * 0.11, i === 3 ? 0.9 : 0.35, 0.14)),
};

export const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

const COLORS = ['#5b9dff', '#a6ccf8', '#3fb27f', '#d4a72c', '#e3e6eb'];

export const confettiFx = {
  /** A modest burst (rare badge). */
  burst: () => void confetti({ particleCount: 80, spread: 70, origin: { y: 0.6 }, colors: COLORS, disableForReducedMotion: true }),
  /** Two side cannons (level up / epic badge). */
  big: () => {
    const end = Date.now() + 900;
    const frame = () => {
      confetti({ particleCount: 6, angle: 60, spread: 60, origin: { x: 0, y: 0.7 }, colors: COLORS, disableForReducedMotion: true });
      confetti({ particleCount: 6, angle: 120, spread: 60, origin: { x: 1, y: 0.7 }, colors: COLORS, disableForReducedMotion: true });
      if (Date.now() < end) requestAnimationFrame(frame);
    };
    frame();
  },
};
