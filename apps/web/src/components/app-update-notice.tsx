import { useEffect, useRef, useState } from 'react';

const activationTimeoutMs = 10_000;
const updateCheckIntervalMs = 60_000;

export function AppUpdateNotice({
  reload = () => window.location.reload(),
}: {
  reload?: () => void;
}) {
  const [available, setAvailable] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState('');
  const reloadRef = useRef(reload);
  const activateRef = useRef<(() => void) | null>(null);
  const dismissRef = useRef<(() => void) | null>(null);
  reloadRef.current = reload;

  useEffect(() => {
    const workers = 'serviceWorker' in navigator ? navigator.serviceWorker : null;
    let disposed = false;
    let reloaded = false;
    let controller = workers?.controller ?? null;
    let registration: ServiceWorkerRegistration | null = null;
    let registering: Promise<ServiceWorkerRegistration | null> | null = null;
    let registrationGeneration = 0;
    let checking = false;
    let checkGeneration = 0;
    let offeredWorker: ServiceWorker | null = null;
    let dismissedWorker: ServiceWorker | null | undefined;
    const observedWorkers = new Map<ServiceWorker, () => void>();
    type Attempt = {
      target: ServiceWorker | null;
      requested: boolean;
      timer: ReturnType<typeof setTimeout>;
      detach?: () => void;
    };
    let pending: Attempt | null = null;

    function offer(worker: ServiceWorker | null, force = false) {
      if (disposed || reloaded) return;
      const changed = worker !== offeredWorker;
      offeredWorker = worker;
      if (force || worker !== dismissedWorker) setAvailable(true);
      if (changed || force) setError('');
    }
    function refreshWaiting() {
      const waiting = registration?.waiting;
      // A previous active worker distinguishes an upgrade from first install,
      // including when this tab has not acquired its controller yet.
      if (
        waiting &&
        (workers?.controller || (registration?.active && registration.active !== waiting))
      )
        offer(waiting);
    }
    function observe(worker: ServiceWorker | null) {
      if (!worker || observedWorkers.has(worker)) return;
      const changed = () => {
        if (disposed) return;
        if (
          worker.state === 'installed' &&
          (workers?.controller || (registration?.active && registration.active !== worker))
        )
          offer(worker);
        refreshWaiting();
      };
      observedWorkers.set(worker, changed);
      worker.addEventListener('statechange', changed);
      changed();
    }
    const updateFound = () => observe(registration?.installing ?? null);
    function getRegistration() {
      if (!workers) return Promise.resolve(null);
      if (registration) return Promise.resolve(registration);
      if (!registering) {
        const generation = ++registrationGeneration;
        registering = Promise.resolve()
          .then(() => workers.register('/sw.js', { scope: '/' }))
          .then((value) => {
            if (disposed || generation !== registrationGeneration) return null;
            registration = value;
            registration.addEventListener('updatefound', updateFound);
            observe(registration.installing);
            refreshWaiting();
            return value;
          })
          .finally(() => {
            if (generation === registrationGeneration) registering = null;
          });
      }
      return registering;
    }
    function clearAttempt(attempt: Attempt) {
      clearTimeout(attempt.timer);
      attempt.detach?.();
      if (pending === attempt) pending = null;
    }
    function fail(attempt: Attempt) {
      if (disposed || pending !== attempt) return;
      clearAttempt(attempt);
      if (!registration) {
        // A stalled register() must not hold every later explicit retry captive.
        registrationGeneration++;
        registering = null;
        checkGeneration++;
        checking = false;
      }
      setUpdating(false);
      setAvailable(true);
      setError(
        'The update could not finish. Your current page is still open. Try Reload app again.'
      );
    }
    function finish(attempt: Attempt) {
      if (disposed || reloaded || pending !== attempt) return;
      clearAttempt(attempt);
      reloaded = true;
      setUpdating(false);
      reloadRef.current();
    }
    const changedController = () => {
      const previous = controller;
      const next = workers?.controller ?? null;
      controller = next;
      if (pending?.target && next === pending.target) finish(pending);
      // Another tab or a legacy automatic update may still take control. Notify
      // without reloading a live draft unless this tab requested activation.
      if (previous && next && next !== previous) offer(next, true);
    };
    function activate() {
      if (disposed || reloaded || pending) return;
      const attempt: Attempt = {
        target: null,
        requested: false,
        timer: setTimeout(() => fail(attempt), activationTimeoutMs),
      };
      pending = attempt;
      setUpdating(true);
      setError('');
      void getRegistration()
        .then((value) => {
          if (disposed || pending !== attempt) return;
          const target =
            value?.waiting ??
            (offeredWorker?.state === 'installed' ||
            offeredWorker?.state === 'activating' ||
            (offeredWorker?.state === 'activated' && offeredWorker !== workers?.controller)
              ? offeredWorker
              : (value?.installing ??
                (value?.active &&
                value.active !== workers?.controller &&
                (value.active.state === 'activating' || value.active.state === 'activated')
                  ? value.active
                  : null)));
          if (!target) {
            finish(attempt);
            return;
          }
          attempt.target = target;
          const advance = () => {
            if (disposed || pending !== attempt) return;
            // Activation can precede takeover. A controlled tab must wait until
            // the target controls it; an uncontrolled tab can navigate to acquire it.
            if (
              target.state === 'activated' &&
              (!workers?.controller || workers.controller === target)
            )
              finish(attempt);
            else if (target.state === 'redundant') fail(attempt);
            else if (target.state === 'installed' && !attempt.requested) {
              attempt.requested = true;
              try {
                target.postMessage({ type: 'SKIP_WAITING' });
              } catch {
                fail(attempt);
              }
            }
          };
          target.addEventListener('statechange', advance);
          attempt.detach = () => target.removeEventListener('statechange', advance);
          advance();
        })
        .catch(() => fail(attempt));
    }
    function dismiss() {
      dismissedWorker = offeredWorker;
      setAvailable(false);
    }
    const preloadFailed = () => offer(registration?.waiting ?? workers?.controller ?? null, true);
    const check = () => {
      if (disposed || checking || document.visibilityState === 'hidden') return;
      checking = true;
      const generation = ++checkGeneration;
      void getRegistration()
        .then(async (value) => {
          if (disposed || generation !== checkGeneration || !value) return;
          refreshWaiting();
          await value.update();
          if (!disposed && generation === checkGeneration) refreshWaiting();
        })
        .catch(() => {
          // Background check failures must not interrupt the current page.
        })
        .finally(() => {
          if (generation === checkGeneration) checking = false;
        });
    };

    activateRef.current = activate;
    dismissRef.current = dismiss;
    window.addEventListener('playqube:app-update-needed', preloadFailed);
    workers?.addEventListener('controllerchange', changedController);
    if (workers) void getRegistration().catch(() => {});
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', check);
    const interval = workers ? setInterval(check, updateCheckIntervalMs) : null;
    return () => {
      disposed = true;
      if (interval !== null) clearInterval(interval);
      if (pending) clearAttempt(pending);
      registration?.removeEventListener('updatefound', updateFound);
      observedWorkers.forEach((listener, worker) =>
        worker.removeEventListener('statechange', listener)
      );
      workers?.removeEventListener('controllerchange', changedController);
      window.removeEventListener('playqube:app-update-needed', preloadFailed);
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', check);
      if (activateRef.current === activate) activateRef.current = null;
      if (dismissRef.current === dismiss) dismissRef.current = null;
    };
  }, []);

  if (!available) return null;
  return (
    <aside
      role="status"
      aria-label="App update available"
      className="fixed bottom-4 left-4 right-4 z-[80] mx-auto flex max-w-lg flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-200 bg-white p-4 text-slate-900 shadow-xl dark:border-emerald-800 dark:bg-slate-900 dark:text-white"
    >
      <div>
        <p className="text-sm font-semibold">A new version is ready</p>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Finish your message or game, then reload to update.
        </p>
        {error && <p className="mt-1 text-xs text-red-700 dark:text-red-300">{error}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={updating}
          onClick={() => dismissRef.current?.()}
          className="min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800 disabled:opacity-50"
        >
          Later
        </button>
        <button
          type="button"
          disabled={updating}
          onClick={() => activateRef.current?.()}
          className="min-h-11 rounded-xl bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:opacity-50"
        >
          {updating ? 'Updating…' : 'Reload app'}
        </button>
      </div>
    </aside>
  );
}
