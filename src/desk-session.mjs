import { practiceCache } from './practice-cache.mjs';
import { initialPractice } from './practice-defaults.mjs';
import { SOURCE } from './market.mjs';

export async function deskSession(onChange, onStatus) {
  let cache = null,
    current = { session: initialPractice(), revision: 0 },
    online = false,
    queue = Promise.resolve(),
    uncertain = null;
  const status = (message) => onStatus(message);
  const receiptKey = 'trading-practice-pending/v1';
  try {
    uncertain = JSON.parse(sessionStorage.getItem(receiptKey));
  } catch {}
  function pending(value) {
    uncertain = value;
    try {
      if (value) sessionStorage.setItem(receiptKey, JSON.stringify(value));
      else sessionStorage.removeItem(receiptKey);
    } catch {}
  }
  async function commandHash(cmd) {
    const bytes = new TextEncoder().encode(JSON.stringify(cmd));
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
      v.toString(16).padStart(2, '0')
    ).join('');
  }
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
    if (uncertain && uncertain.sessionId !== data.sessionId) pending(null);
    await remember(data);
    if (uncertain) {
      const receipt = await fetch('/api/practice/receipt?id=' + encodeURIComponent(uncertain.requestId), {
        cache: 'no-store',
        signal: AbortSignal.timeout(4000)
      });
      if (receipt.ok) {
        const { accepted } = await receipt.json();
        if (uncertain) pending({ ...uncertain, accepted });
      }
      status(
        uncertain?.accepted
          ? 'Last save confirmed · revision ' + data.revision
          : 'Last save unconfirmed · retry the same change'
      );
    }
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
      'Offline research · ' +
        (current.sessionId ? 'cached revision ' + current.revision : 'no saved server session')
    );
  }
  function command(cmd) {
    const operation = queue.then(async () => {
      if (!online) throw Error('OFFLINE · reconnect to save practice changes');
      const bytes = await commandHash(cmd),
        retry = uncertain?.bytes === bytes;
      if (uncertain?.accepted && !retry) pending(null);
      if (uncertain && !retry) throw Error('PENDING_RECEIPT · reconcile the last save before another change');
      const requestId = retry ? uncertain.requestId : crypto.randomUUID(),
        revision = retry ? uncertain.revision : current.revision;
      let response, data;
      pending({ bytes, requestId, revision, sessionId: current.sessionId });
      try {
        response = await fetch('/api/practice/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId, revision, command: cmd }),
          signal: AbortSignal.timeout(5000)
        });
        data = await response.json();
      } catch {
        online = false;
        status('Save outcome unknown · reconnecting for readback');
        throw Error('SAVE_UNKNOWN · verify the journal before retrying');
      }
      pending(null);
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
  let directory;
  async function invoke(operation, inputs = {}, requestId = crypto.randomUUID(), actor = 'human') {
    if (!online) throw Error('OFFLINE');
    directory ??= await (await fetch('/api/practice/capabilities', { cache: 'no-store' })).json();
    const body = {
      contract_version: '1',
      request_id: requestId,
      capability_digest: directory.capabilities[0].capability_digest,
      operation,
      scope: directory.scope,
      inputs,
      deadline_utc: new Date(Date.now() + 60000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    };
    const response = await fetch('/api/practice/' + (actor === 'human' ? 'ui' : 'gateway'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw Error('GATEWAY_UNAVAILABLE');
    const result = await response.json();
    if (result.status === 'REFUSED' && ['STALE_EVIDENCE', 'UNQUALIFIED'].includes(result.error.code))
      directory = null;
    return result;
  }
  return {
    invoke,
    reload: read,
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
