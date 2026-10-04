import { useEffect, useState } from 'react';

export function AppUpdateNotice({ reload = () => window.location.reload() }: { reload?: () => void }) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const workers = navigator.serviceWorker;
    let controller = workers.controller;
    const changed = () => {
      const next = workers.controller;
      // The first installation isn't an upgrade. Never interrupt a draft or game
      // automatically; let the user choose when to load the new app shell.
      if (controller && next && next !== controller) setAvailable(true);
      controller = next;
    };
    workers.addEventListener('controllerchange', changed);
    return () => workers.removeEventListener('controllerchange', changed);
  }, []);

  if (!available) return null;
  return <aside role="status" aria-label="App update available" className="fixed bottom-4 left-4 right-4 z-[80] mx-auto flex max-w-lg flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-200 bg-white p-4 text-slate-900 shadow-xl dark:border-emerald-800 dark:bg-slate-900 dark:text-white">
    <div><p className="text-sm font-semibold">A new version is ready</p><p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Finish your message or game, then reload to update.</p></div>
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => setAvailable(false)} className="min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800">Later</button>
      <button type="button" onClick={reload} className="min-h-11 rounded-xl bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900">Reload app</button>
    </div>
  </aside>;
}
