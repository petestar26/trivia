import { fileURLToPath } from 'node:url';
import { runSystemPracticeWorker, systemPracticeConfiguration, type SystemPracticeDependencies } from './system-practice-worker-runtime.js';

export const SYSTEM_PRACTICE_USAGE = 'system-practice-worker: explicitly enable SYSTEM_PRACTICE_WORKER_ENABLED=true and one or more of the six system-practice family flags; DATABASE_URL must use a separately verified restricted runtime role. No Number, PVP, social lifecycle, scheduled Spin or Trivia jobs are included.';

/** Trusted test dependencies are not configurable through requests, arguments or environment. */
export async function main(args = process.argv.slice(2), env = process.env, testDependencies?: SystemPracticeDependencies): Promise<number> {
  if (args.length === 1 && args[0] === '--help') { console.log(SYSTEM_PRACTICE_USAGE); return 0; }
  if (args.length) { console.error(JSON.stringify({ event: 'SYSTEM_PRACTICE_INVALID_ARGUMENTS' })); return 1; }
  // Refuse before adding signal handlers or invoking a dynamic module loader.
  try { systemPracticeConfiguration(env); }
  catch { console.error(JSON.stringify({ event: 'SYSTEM_PRACTICE_ADMISSION_REFUSED' })); return 1; }
  if (testDependencies) return runSystemPracticeWorker(env, testDependencies);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    return await runSystemPracticeWorker(env, {
      signal: controller.signal,
      loadServices: async config => (await import('./system-practice-worker-services.js')).loadSystemPracticeServices(config),
      report: event => console.error(JSON.stringify(event)),
    });
  } catch {
    console.error(JSON.stringify({ event: 'SYSTEM_PRACTICE_FATAL' })); return 1;
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // A timed-out transaction/engine may still hold handles. Exit after the bounded
  // stop result; exit is NOT evidence that remote database work was cancelled.
  void main().then(code => process.exit(code), () => {
    console.error(JSON.stringify({ event: 'SYSTEM_PRACTICE_FATAL' })); process.exit(1);
  });
}
