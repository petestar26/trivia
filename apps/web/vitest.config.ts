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
// happens to run on a UTC machine. Must be set here, at config-load time in
// vitest's main process — NOT via `test.env` or a test file's own
// `beforeAll`, both of which run inside an already-spawned test worker
// thread. Confirmed empirically: mutating `process.env.TZ` from inside a
// running `worker_threads` Worker does not change that worker's own `Date`
// local-time calculations, even though the identical mutation works fine in
// a plain main-thread Node process — Node/V8 resolves and caches each
// thread's local timezone from its environment at thread start, and a
// worker's later in-thread `process.env` write isn't re-read. Setting it
// here means every worker thread inherits the already-correct value at
// spawn time instead.
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