// TEMPORARY FIXTURE ONLY. Observes lifecycle; never activates or claims clients.
(() => {
  const build = 'probe-B';
  const packet = (event) => ({ channel: 'playqube-pwa-probe', build, event, at: new Date().toISOString() });
  self.addEventListener('message', (event) => {
    if (event.data?.type === 'SKIP_WAITING') event.source?.postMessage(packet('skip-received'));
  });
  self.addEventListener('activate', () => {
    // Deliberately no waitUntil: do not prolong or replace Workbox's activation.
    // This event proves start only. Page worker.state === activated proves completion.
    void self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => clients.forEach((client) => client.postMessage(packet('activate-start'))));
  });
})();
