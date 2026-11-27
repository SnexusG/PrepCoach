import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// Ports come from prep.config.json so there's one place to change them.
const cfg = JSON.parse(fs.readFileSync(new URL('../prep.config.json', import.meta.url), 'utf8'));
const apiPort = Number(process.env.PREP_API_PORT ?? cfg.ports.api);

const VAD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'vad');
const TYPES: Record<string, string> = {
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
};

/**
 * ONNX Runtime (used by the speech detector) loads its wasm glue module from /vad/ with a dynamic import. In dev,
 * Vite tags that request `?import` and refuses to serve a public/ file as a module. Serve /vad/ as plain static
 * files ahead of Vite's own middleware instead. Production builds are served statically and don't need this.
 */
function serveVadAssets(): Plugin {
  return {
    name: 'prepcoach-serve-vad-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/vad/')) return next();
        const name = decodeURIComponent(url.slice('/vad/'.length).split('?')[0]);
        const file = path.join(VAD_DIR, name);
        if (name.includes('..') || !fs.existsSync(file)) return next();
        res.setHeader('Content-Type', TYPES[path.extname(name)] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serveVadAssets()],
  build: { chunkSizeWarningLimit: 5000 }, // Monaco is big; this is a local app
  server: {
    port: cfg.ports.web,
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
  },
});
