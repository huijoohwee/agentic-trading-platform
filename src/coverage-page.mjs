import { mountDashboardPage } from './dashboard.mjs';
import { prepareOffline } from './offline-shell.mjs';

const host = document.createElement('div');
host.id = 'coverage-body';
mountDashboardPage(document, { sections: host });
void prepareOffline(document.getElementById('offline-status'));

async function openCoverage() {
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = 'Loading coverage…';
  host.replaceChildren(status);
  try {
    const { mountCoverageView } = await import('./coverage-view.mjs');
    const view = await mountCoverageView(host);
    const followBookmark = () => {
      if (location.hash.startsWith('#provider-coverage?')) void view.follow(location.hash.slice(1));
    };
    window.addEventListener('hashchange', followBookmark);
    followBookmark();
  } catch {
    status.textContent = 'Coverage could not be opened. ';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Retry loading coverage';
    retry.addEventListener('click', openCoverage, { once: true });
    status.append(retry);
    host.replaceChildren(status);
  }
}
void openCoverage();
