let healthyAt = 0;
export const togetherWorkerReady = () => healthyAt > 0 && Date.now() - healthyAt < 20_000;
export function startTogetherRuntime(tick: () => Promise<void>, report: () => void) {
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    reportedAt = 0;
  const run = async () => {
    try {
      await tick();
      if (!stopped) healthyAt = Date.now();
    } catch {
      healthyAt = 0;
      if (Date.now() - reportedAt > 60_000) {
        reportedAt = Date.now();
        report();
      }
    }
    if (!stopped) {
      timer = setTimeout(() => void run(), 1000);
      timer.unref?.();
    }
  };
  void run();
  return () => {
    stopped = true;
    healthyAt = 0;
    if (timer) clearTimeout(timer);
  };
}
