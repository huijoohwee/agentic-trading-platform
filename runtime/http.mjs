import { timingSafeEqual, createHash } from 'node:crypto';
import { requireThat } from './core.mjs';
import { projectRuntime } from './projection.mjs';

const digest = text => createHash('sha256').update(text).digest();
export function createRuntimeApi({ store, scope, candidate, viewerToken, now = Date.now }) {
  requireThat(typeof viewerToken === 'string' && viewerToken.length >= 32 && !/\s/.test(viewerToken), 'VIEWER_CREDENTIAL_REQUIRED');
  const expected = digest('Bearer ' + viewerToken);
  return (request, response) => {
    if (!request.url?.startsWith('/api/runtime')) return false;
    const send = (code, value) => {
      response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", Vary: 'Authorization' });
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(value));
    };
    const host = '127.0.0.1:' + request.socket.localPort;
    if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== 'http://' + host) ||
      request.headers['sec-fetch-site'] === 'cross-site') { send(403, { error: 'ORIGIN_DENIED' }); return true; }
    if (!['GET', 'HEAD'].includes(request.method)) { send(405, { error: 'READ_ONLY' }); return true; }
    if (request.url !== '/api/runtime') { send(404, { error: 'NOT_FOUND' }); return true; }
    if (!timingSafeEqual(expected, digest(request.headers.authorization ?? ''))) { send(401, { error: 'VIEWER_AUTH_REQUIRED' }); return true; }
    try { send(200, projectRuntime(store.read(scope), candidate, now(), store.read({ ...scope, profile: 'practice' }))); }
    catch { send(503, { error: 'RUNTIME_UNAVAILABLE' }); }
    return true;
  };
}
