import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Forge serves Custom UI from a relative path, so assets must use relative URLs. The checker engine
// lives at the app root (shared with the Forge functions and the CLI), so the dev server may read it.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', assetsInlineLimit: 0 },
  server: { fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },
});
