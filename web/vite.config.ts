import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import { defineConfig } from 'vite';

// Ports come from prep.config.json so there's one place to change them.
const cfg = JSON.parse(fs.readFileSync(new URL('../prep.config.json', import.meta.url), 'utf8'));
const apiPort = Number(process.env.PREP_API_PORT ?? cfg.ports.api);

export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 5000 }, // Monaco is big; this is a local app
  server: {
    port: cfg.ports.web,
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
  },
});
