import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'frontend',
  plugins: [react()],
  // Keep generated browser assets out of the source tree.
  build: { outDir: '../dist', emptyOutDir: true },
});
