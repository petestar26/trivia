import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Pinned to a fixed non-UTC offset so local→ISO datetime-conversion
// assertions (e.g. competitions/competitions.test.tsx) are meaningful
// regardless of the host/CI machine's own timezone: a regression that treats
// a `datetime-local` value as UTC would fail here even when the suite
// happens to run on a UTC machine. Set here, at config-load time in the main
// vitest process (before test worker threads/processes are spawned and
// inherit `process.env`), rather than via `test.env` or a test file's own
// `beforeAll` — by the time either of those run, Node/V8 has already
// resolved and cached the worker's local timezone from earlier setup work,
// and silently ignores a later runtime TZ change for `Date` local-time
// calculations.
process.env.TZ = 'America/New_York';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    globals: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@socialplay/shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
});