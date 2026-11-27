import fs from 'node:fs';
import path from 'node:path';
import type { SttConfig } from './config';

/** Where `prep stt-setup` puts the helper's Python environment. */
export function sttVenvDir(root: string): string {
  return path.join(root, 'data', 'stt', 'venv');
}

/** The helper's interpreter: stt.python, else the venv from `prep stt-setup` if present, else `python`. */
export function sttPython(root: string, cfg: SttConfig): string {
  if (cfg.python) return cfg.python;
  const venv = path.join(sttVenvDir(root), process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return fs.existsSync(venv) ? venv : 'python';
}

/** Arguments for server/stt/whisper_server.py (models download to data/models/whisper/). */
export function sttArgs(root: string, cfg: SttConfig, extra: string[] = []): string[] {
  return [
    path.join(root, 'server', 'stt', 'whisper_server.py'),
    '--model', cfg.model,
    '--device', cfg.device,
    '--compute-type', cfg.computeType,
    '--cpu-model', cfg.cpuModel,
    '--beam-size', String(cfg.beamSize),
    '--download-root', path.join(root, 'data', 'models', 'whisper'),
    ...extra,
  ];
}

/** Packages the helper needs; the NVIDIA wheels provide the CUDA libraries faster-whisper loads on Windows/Linux. */
export const STT_PACKAGES = ['faster-whisper', 'nvidia-cublas-cu12', 'nvidia-cudnn-cu12==9.*'];
