import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The window's interface. `base: './'` so the built files load from disk (file://) in the app.
export default defineConfig({
  root: 'renderer',
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome130' },
  server: { port: 5199, strictPort: true },
});
