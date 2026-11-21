import { practiceCache } from './practice-cache.mjs';
import { initialPractice } from './practice-defaults.mjs';
import { SOURCE } from './market.mjs';

export async function deskSession(onChange, onStatus) {
  let cache = null,
    current = { session: initialPractice(), revision: 0 },
    online = false,
    queue = Promise.resolve();
  const status = (message) => onStatus(message);
  async function remember(data) {
    current = data;
    online = true;
    onChange(data);
    try {
      await cache?.put(data);
      status(
        'Saved on loopback · revision ' + data.revision + (cache ? ' · device copy' : ' · device cache unavailable')
      );
    } catch (error) {
      status('Server saved · device copy unavailable (' + error.message + ')');
    }
  }
  async function read() {
    const response = await fetch('/api/practice/session', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw Error('SESSION_UNAVAILABLE');
    const data = await response.json();
    if (data.session?.source !== SOURCE || !data.sessionId) throw Error('UNQUALIFIED_SESSION');
    await remember(data);
  }
  try {
    cache = await practiceCache();
    const saved = await cache.read();
    if (saved) current = saved;
  } catch (error) {
    status(error.message);
  }
  try {
    await read();
  } catch {
    onChange(current);
    status(
      'Offline research · ' + (current.sessionId ? 'cached revision ' + current.revision : 'no saved server session')
    );
  }
  function command(cmd) {
    const operation = queue.then(async () => {
      if (!online) throw Error('OFFLINE · reconnect to save practice changes');
      const requestId = crypto.randomUUID(),
        revision = current.revision;
      let response;
      try {
        response = await fetch('/api/practice/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId, revision, command: cmd }),
          signal: AbortSignal.timeout(5000)
        });
      } catch {
        online = false;
        status('Save outcome unknown · reconnecting for readback');
        throw Error('SAVE_UNKNOWN · verify the journal before retrying');
      }
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409) {
          await read();
          throw Error('Another tab saved first. Current revision loaded.');
        }
        throw Error(data.error ?? 'SAVE_REFUSED');
      }
      await remember(data);
      return data;
    });
    queue = operation.catch(() => {});
    return operation;
  }
  return {
    command,
    get data() {
      return current;
    },
    get online() {
      return online;
    },
    async reconnect() {
      if (!online)
        await (queue = queue.then(read).catch(() => {
          online = false;
        }));
    }
  };
}
