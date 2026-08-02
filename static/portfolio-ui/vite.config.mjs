import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',                 // relative asset URLs — required inside the Forge iframe
  build: {
    outDir: 'build',          // match the path your Forge manifest packages
    emptyOutDir: true,        // clear the stale CRA bundle on each build
  },
  test: {
    globals: true,
    setupFiles: ['./src/setupTests.js'],
    environment: 'jsdom',
  },
});