/** A dedicated Number draw identity; never reuse the shared API/social connection. */
export function numberWorkerTarget(env: NodeJS.ProcessEnv): string {
  const source = env.NUMBER_WORKER_DATABASE_URL;
  if (!source) throw Error('NUMBER_WORKER_CONNECTION_REQUIRED');
  const worker = new URL(source),
    main = new URL(env.DATABASE_URL ?? 'https://invalid');
  if (
    !['postgres:', 'postgresql:'].includes(worker.protocol) ||
    worker.hostname !== main.hostname ||
    worker.pathname !== main.pathname ||
    (worker.port || '5432') !== (main.port || '5432') ||
    !/^[a-z][a-z0-9_]{1,62}$/.test(worker.username) ||
    worker.username === main.username
  )
    throw Error('NUMBER_WORKER_TARGET_REFUSED');
  return source;
}
