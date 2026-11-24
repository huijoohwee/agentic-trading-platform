import { DatabaseSync } from 'node:sqlite';
import { closeSync, lstatSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { boundedJson, canonical, fail, id, requireThat, scopeKey, sha } from './core.mjs';

function initial(scope) {
  return { schema: 'trading-runtime-state/v1', scope, revision: 0, halted: false, haltReason: null,
    events: [], checkpoints: {}, snapshots: {}, currentSnapshot: null, intents: {}, usedApprovals: {},
    decisions: [], telemetry: {}, configs: {} };
}
export function appendEvent(state, { id: eventId, type, at, data }) {
  requireThat(id(eventId) && id(type), 'INVALID_EVENT');
  const content = boundedJson({ id: eventId, type, at, data });
  const digest = sha(content), previous = state.events.find(event => event.id === eventId);
  if (previous) { requireThat(previous.digest === digest, 'CONFLICTING_EVENT'); return previous; }
  requireThat(state.events.length < 10000, 'LEDGER_CAPACITY');
  const prev_hash = state.events.at(-1)?.hash ?? null;
  const event = { ...content, digest, prev_hash, hash: sha({ digest, prev_hash }) };
  state.events.push(event);
  return event;
}
function validate(state, scope) {
  requireThat(state?.schema === 'trading-runtime-state/v1' && scopeKey(state.scope) === scopeKey(scope) &&
    Number.isSafeInteger(state.revision) && state.revision >= 0 && Array.isArray(state.events), 'STORED_STATE_INVALID');
  let previous = null;
  const seen = new Set();
  for (const event of state.events) {
    const { digest, prev_hash, hash, ...content } = event;
    requireThat(!seen.has(event.id) && sha(content) === digest && prev_hash === previous && sha({ digest, prev_hash }) === hash, 'AUDIT_INTEGRITY');
    seen.add(event.id); previous = hash;
  }
  return state;
}
export function openStore(path) {
  requireThat(typeof path === 'string' && path !== ':memory:', 'DURABLE_PATH_REQUIRED');
  const absolute = resolve(path), parent = lstatSync(dirname(absolute));
  requireThat(parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o077) === 0, 'PRIVATE_DIRECTORY_REQUIRED');
  try { closeSync(openSync(absolute, 'wx', 0o600)); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = lstatSync(absolute);
  requireThat(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0, 'PRIVATE_DATABASE_REQUIRED');
  const db = new DatabaseSync(absolute, { enableForeignKeyConstraints: true, allowExtension: false });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  requireThat(version === 0 || version === 1, 'STORAGE_VERSION');
  db.exec('CREATE TABLE IF NOT EXISTS accounts (scope TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL) STRICT; PRAGMA user_version=1;');
  const get = db.prepare('SELECT revision, body FROM accounts WHERE scope=?');
  const put = db.prepare('INSERT INTO accounts(scope,revision,body) VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision, body=excluded.body');
  function read(scope) {
    const row = get.get(scopeKey(scope));
    if (!row) return initial(boundedJson(scope));
    let state;
    try { state = JSON.parse(row.body); } catch { fail('STORED_STATE_INVALID'); }
    requireThat(state.revision === row.revision, 'STORED_STATE_INVALID');
    return validate(state, scope);
  }
  function transactionScopes(scopes, mutate, readOnlyWhen) {
    const keys = scopes.map(scopeKey);
    requireThat(keys.length > 0 && keys.length <= 2 && new Set(keys).size === keys.length, 'ACCOUNT_BINDING');
    db.exec('BEGIN IMMEDIATE');
    try {
      const states = scopes.map(read);
      const result = mutate(states);
      requireThat(!result || typeof result.then !== 'function', 'ASYNC_TRANSACTION_FORBIDDEN');
      if (readOnlyWhen?.(result)) {
        const output = boundedJson(result ?? null, 16_000_000);
        db.exec('ROLLBACK');
        return output;
      }
      for (const [index, state] of states.entries()) {
        state.revision++;
        validate(state, scopes[index]);
        const body = canonical(state);
        requireThat(Buffer.byteLength(body) <= 16_000_000, 'LEDGER_CAPACITY');
        put.run(keys[index], state.revision, body);
      }
      const output = boundedJson(result ?? null, 16_000_000);
      db.exec('COMMIT');
      return output;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return {
    read,
    listScopes(prefix) {
      requireThat(prefix === 'research/', 'ACCOUNT_BINDING');
      return db.prepare("SELECT json_extract(body,'$.scope') AS scope FROM accounts WHERE json_extract(body,'$.scope.account_alias') LIKE 'research/%'").all().map(row=>JSON.parse(row.scope));
    },
    transactionScopes,
    transaction(scope, mutate, expectedRevision, { readOnlyWhen } = {}) {
      return transactionScopes([scope], ([state]) => {
        if (expectedRevision !== undefined) requireThat(state.revision === expectedRevision, 'CONFLICT');
        return mutate(state);
      }, readOnlyWhen);
    },
    close() { db.close(); },
  };
}
