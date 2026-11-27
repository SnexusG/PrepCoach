// Copies the Silero VAD model, its audio worklet and the ONNX Runtime wasm files into web/public/vad/, where the
// browser loads them at runtime (they can't be bundled). Runs before `vite` and `vite build`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'public', 'vad');

/** Finds an installed package directory, walking up from web/ (npm workspaces hoist to the repo root). */
function pkgDir(name, from = path.join(here, '..')) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) throw new Error(`Cannot find ${name} — run npm install`);
  }
}

const vad = pkgDir('@ricky0123/vad-web');
// The ONNX Runtime that vad-web itself resolves (it may have its own nested copy).
const ort = pkgDir('onnxruntime-web', vad);

const files = [
  [path.join(vad, 'dist', 'vad.worklet.bundle.min.js'), 'vad.worklet.bundle.min.js'],
  [path.join(vad, 'dist', 'silero_vad_v5.onnx'), 'silero_vad_v5.onnx'],
  [path.join(vad, 'dist', 'silero_vad_legacy.onnx'), 'silero_vad_legacy.onnx'],
  ...fs
    .readdirSync(path.join(ort, 'dist'))
    .filter((f) => /^ort-wasm-simd-threaded(\.jsep)?\.(wasm|mjs)$/.test(f))
    .map((f) => [path.join(ort, 'dist', f), f]),
];

fs.mkdirSync(out, { recursive: true });
let copied = 0;
for (const [src, name] of files) {
  const dest = path.join(out, name);
  const s = fs.statSync(src);
  if (fs.existsSync(dest) && fs.statSync(dest).size === s.size) continue;
  fs.copyFileSync(src, dest);
  copied++;
}
if (copied) console.log(`copy-vad-assets: ${copied} file(s) → web/public/vad/`);
