// This runs before the entry module: React cannot recover a failed entry import.
(() => {
  const attemptKey = 'playqube.app-recovery.v1';
  let booted = false;
  let recovering = false;
  let failedEntry = false;
  let timer;
  let observer;
  let panel;
  let updateButton = () => {};
  let cleanupPanel = () => {};
  const root = () => document.getElementById('root');
  const rendered = () => Boolean(root()?.childElementCount);
  function ready() {
    if (!rendered()) return false;
    booted = true;
    clearTimeout(timer);
    observer?.disconnect();
    cleanupPanel();
    panel?.remove();
    try {
      sessionStorage.removeItem(attemptKey);
    } catch {
      /* recovery stays manual */
    }
    return true;
  }
  function fallback() {
    if (ready() || panel || !document.body) return;
    panel = document.createElement('main');
    panel.id = 'app-recovery';
    panel.setAttribute('role', 'alert');
    Object.assign(panel.style, {
      background: '#171329',
      color: '#f4efff',
      fontFamily: 'system-ui, sans-serif',
      margin: '24px auto',
      padding: '24px',
      maxWidth: '480px',
      borderRadius: '16px',
    });
    const heading = document.createElement('h1');
    heading.textContent = 'The app couldn’t load';
    const description = document.createElement('p');
    description.textContent =
      'Reconnect and reload. Confirmed tickets and requests remain saved on the server.';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Reload app';
    Object.assign(button.style, { minHeight: '44px', padding: '12px 20px', borderRadius: '12px' });
    updateButton = () => {
      button.disabled = navigator.onLine === false || recovering;
    };
    updateButton();
    window.addEventListener('online', updateButton);
    window.addEventListener('offline', updateButton);
    cleanupPanel = () => {
      window.removeEventListener('online', updateButton);
      window.removeEventListener('offline', updateButton);
    };
    button.addEventListener('click', () => {
      if (navigator.onLine === false || recovering) return;
      recovering = true;
      button.disabled = true;
      reload(false).catch(() => {
        // A worker failure must not trap an explicit user retry in the blank shell.
        try {
          window.location.reload();
        } catch {
          recovering = false;
          updateButton();
        }
      });
    });
    panel.append(heading, description, button);
    document.body.append(panel);
  }
  async function reload(automatic) {
    let deadline;
    let registration;
    try {
      registration = await Promise.race([
        navigator.serviceWorker?.getRegistration?.(),
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('Update lookup timed out')), 10000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
    if (automatic && ready()) return;
    const workers = navigator.serviceWorker;
    const controlled = Boolean(workers?.controller);
    const waiting =
      registration?.waiting ??
      registration?.installing ??
      (registration?.active && registration.active !== workers?.controller
        ? registration.active
        : null);
    if (waiting) {
      await new Promise((resolve, reject) => {
        let deadline;
        let finished = false;
        let requested = false;
        const finish = (error) => {
          if (finished) return;
          finished = true;
          clearTimeout(deadline);
          waiting.removeEventListener('statechange', changed);
          workers?.removeEventListener?.('controllerchange', changed);
          error ? reject(error) : resolve();
        };
        const changed = () => {
          if (waiting.state === 'activated' && (!controlled || workers?.controller === waiting))
            finish();
          else if (waiting.state === 'redundant') finish(new Error('Update unavailable'));
          else if (waiting.state === 'installed' && !requested) {
            requested = true;
            try {
              waiting.postMessage({ type: 'SKIP_WAITING' });
            } catch (error) {
              finish(error);
            }
          }
        };
        waiting.addEventListener('statechange', changed);
        workers?.addEventListener?.('controllerchange', changed);
        deadline = setTimeout(() => finish(new Error('Update timed out')), 10000);
        changed();
      });
    }
    if (!automatic || !ready()) window.location.reload();
  }
  function recover() {
    if (booted || ready() || recovering || !document.body) return;
    if (navigator.onLine === false) {
      fallback();
      return;
    }
    try {
      // A failed retry remains marked across reload. Storage failure is manual-only.
      if (sessionStorage.getItem(attemptKey)) {
        fallback();
        return;
      }
      sessionStorage.setItem(attemptKey, '1');
    } catch {
      fallback();
      return;
    }
    recovering = true;
    fallback();
    reload(true).catch(() => {
      recovering = false;
      fallback();
      updateButton();
    });
  }
  window.addEventListener(
    'error',
    (event) => {
      const entry = document.querySelector('script[type="module"][src]');
      if (event.target !== entry || !entry || booted) return;
      failedEntry = true;
      if (document.readyState !== 'loading') recover();
    },
    true
  );
  window.addEventListener('vite:preloadError', () => {
    if (booted || ready()) window.dispatchEvent(new Event('playqube:app-update-needed'));
    else {
      failedEntry = true;
      if (document.readyState !== 'loading') recover();
    }
    // Keep the original error visible to the mounted error boundary.
  });
  function watch() {
    if (ready()) return;
    observer = new MutationObserver(ready);
    if (root()) observer.observe(root(), { childList: true, subtree: true });
    timer = setTimeout(recover, 30000);
    if (failedEntry) recover();
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', watch, { once: true });
  else watch();
})();
