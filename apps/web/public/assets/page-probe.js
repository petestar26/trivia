// TEMPORARY FIXTURE ONLY. No fetch, register, update, activation, or cache mutation.
(() => {
  const key = 'playqube.pwa.probe.timeline';
  let rows = [];
  try { rows = JSON.parse(sessionStorage.getItem(key) || '[]'); if (!Array.isArray(rows)) rows = []; } catch {}
  let output;
  const ids = new WeakMap(); let nextId = 0;
  const worker = (value) => {
    if (!value) return null;
    if (!ids.has(value)) ids.set(value, ++nextId);
    return { id: ids.get(value), state: value.state, script: value.scriptURL };
  };
  const record = (event, detail = {}) => {
    rows.push({ at: new Date().toISOString(), page: document.title, event, ...detail });
    rows = rows.slice(-180);
    try { sessionStorage.setItem(key, JSON.stringify(rows)); } catch {}
    if (output) output.textContent = JSON.stringify(rows, null, 2);
  };
  const seen = new WeakSet();
  const observe = (value) => {
    if (!value || seen.has(value)) return;
    seen.add(value); record('worker-observed', { worker: worker(value) });
    value.addEventListener('statechange', () => record('worker-state', { worker: worker(value) }));
  };
  const workers = navigator.serviceWorker;
  record('page-loaded', { userAgent: navigator.userAgent });
  if (workers) {
    workers.addEventListener('message', ({ data }) => {
      if (data?.channel === 'playqube-pwa-probe') record('worker-message', { build: data.build, message: data.event, workerAt: data.at });
    });
    workers.addEventListener('controllerchange', () => {
      observe(workers.controller); record('controllerchange', { controller: worker(workers.controller) });
    });
    const registrations = new WeakSet();
    const snapshot = () => workers.getRegistration('/').then((registration) => {
      if (!registration) return;
      [registration.active, registration.waiting, registration.installing, workers.controller].forEach(observe);
      if (!registrations.has(registration)) {
        registrations.add(registration);
        registration.addEventListener('updatefound', () => { observe(registration.installing); record('updatefound'); });
      }
      const state = { controller: worker(workers.controller), active: worker(registration.active), waiting: worker(registration.waiting), installing: worker(registration.installing) };
      const serialized = JSON.stringify(state);
      if (serialized !== lastState) { lastState = serialized; record('snapshot', state); }
    }).catch(() => record('read-registration-failed'));
    let lastState = '';
    void snapshot(); setInterval(snapshot, 1000);
    document.addEventListener('click', (event) => {
      const button = event.target.closest?.('button');
      if (button && ['Reload app', 'Later'].includes(button.textContent.trim())) {
        record('click', { action: button.textContent.trim(), controller: worker(workers.controller) });
        void snapshot();
      }
    }, true);
  }
  document.addEventListener('DOMContentLoaded', () => {
    const panel = document.createElement('details');
    panel.id = 'pwa-probe-timeline';
    panel.style.cssText = 'position:fixed;bottom:8px;left:8px;z-index:9999;max-width:90vw;color:white;background:#142235;padding:8px;border:1px solid #82bbdd;font:12px monospace';
    const summary = document.createElement('summary'); summary.textContent = 'Temporary update timeline';
    output = document.createElement('pre'); output.style.cssText = 'max-height:35vh;overflow:auto;white-space:pre-wrap';
    output.textContent = JSON.stringify(rows, null, 2);
    panel.append(summary, output); document.body.append(panel);
  });
})();
