export async function prepareOffline(status) {
  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    if (!navigator.serviceWorker.controller) await new Promise((resolve, reject) => {
      const pending = registration.installing ?? registration.waiting ?? registration.active;
      const timer = setTimeout(() => finish(false), 15000);
      function finish(ok) {
        clearTimeout(timer);
        pending?.removeEventListener('statechange', observe);
        navigator.serviceWorker.removeEventListener('controllerchange', observe);
        if (ok) resolve(); else reject(new Error('Offline shell installation failed.'));
      }
      function observe() {
        if (navigator.serviceWorker.controller) finish(true);
        else if (pending?.state === 'redundant') finish(false);
      }
      pending?.addEventListener('statechange', observe);
      navigator.serviceWorker.addEventListener('controllerchange', observe);
      observe();
    });
    function show() {
      status.textContent = registration.waiting
        ? 'Update ready. Save edits, close all Trading tabs at this address, then reopen.'
        : navigator.onLine ? 'Offline ready' : 'Working offline';
    }
    function watchInstall() {
      registration.installing?.addEventListener('statechange', show);
      show();
    }
    // Let the browser activate the verified shell after the last old tab closes.
    // An active journal or paper desk can still contain unsaved work.
    let lastCheck = 0;
    function checkOnReturn() {
      show();
      if (document.hidden || !navigator.onLine || registration.waiting || registration.installing ||
          Date.now() - lastCheck < 60_000) return;
      lastCheck = Date.now();
      void registration.update().catch(show);
    }
    registration.addEventListener('updatefound', watchInstall);
    watchInstall();
    window.addEventListener('online', checkOnReturn);
    window.addEventListener('offline', show);
    document.addEventListener('visibilitychange', checkOnReturn);
  } catch { status.textContent = 'Offline shell unavailable'; }
}
