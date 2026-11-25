import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  worker: { format: 'es' },
  // BlockNote is ~400 kB gzipped; translations load separately on demand.
  // `target`: syntax is written down to what Safari 15 can read (iPhones that stopped at iOS 15 or 16 still open the app).
  // One syntax error in a file makes the browser reject the whole file, which is how a page can fail to render on an older iPhone.
  build: { outDir: '../dist/client', emptyOutDir: true, chunkSizeWarningLimit: 1500, target: ['es2020', 'safari15'] },
});
