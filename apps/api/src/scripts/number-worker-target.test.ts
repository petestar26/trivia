import { expect, it } from 'vitest';
import { numberWorkerTarget } from './number-worker-target.js';
const env = {
  DATABASE_URL: 'postgresql://api:x@db.internal/practice',
  NUMBER_WORKER_DATABASE_URL: 'postgresql://number_worker:x@db.internal/practice',
};
it('accepts only a distinct Number worker on the same database', () => {
  expect(numberWorkerTarget(env)).toBe(env.NUMBER_WORKER_DATABASE_URL);
  for (const value of [
    undefined,
    env.DATABASE_URL,
    'postgresql://number_worker:x@other.internal/practice',
    'postgresql://number_worker:x@db.internal/production',
    'postgresql://number_worker:x@db.internal:9999/practice',
    'https://number_worker:x@db.internal/practice',
  ])
    expect(() => numberWorkerTarget({ ...env, NUMBER_WORKER_DATABASE_URL: value })).toThrow();
});
