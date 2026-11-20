/** The API owns a narrowly scoped, opt-in PVP loop. Solo practice workers remain separate. */
let healthyAt = 0;
export const groupPvpWorkerReady = () => healthyAt > 0 && Date.now() - healthyAt < 10_000;
export function startGroupPvpRuntime(options: {
  enabled: boolean;
  tick: (onError: (id: string, error: unknown) => void) => Promise<void>;
  report: () => void;
}) {
  healthyAt = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastReport = 0;
  let active: Promise<void> = Promise.resolve();
  const run = async () => {
    if (stopped) return;
    let failed = false;
    try {
      await options.tick(() => {
        failed = true;
      });
    } catch {
      failed = true;
    }
    if (stopped) return;
    if (failed) {
      healthyAt = 0;
      if (!lastReport || Date.now() - lastReport > 60_000) {
        lastReport = Date.now();
        options.report();
      }
    } else healthyAt = Date.now();
    timer = setTimeout(launch, 1000);
    timer.unref?.();
  };
  const launch = () => {
    if (stopped) return;
    active = run();
    // Observe reporting errors without allowing an unhandled rejection.
    void active.catch(() => {});
  };
  if (options.enabled) launch();
  return async () => {
    stopped = true;
    healthyAt = 0;
    if (timer) clearTimeout(timer);
    await active;
  };
}
