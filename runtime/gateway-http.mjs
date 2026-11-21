import { requireThat } from './core.mjs';

const MAX_BODY = 480_000;
function readBody(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY) { reject(Object.assign(new Error('INPUT_TOO_LARGE'), { code: 'INPUT_TOO_LARGE' })); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

// Inward API frontend. It authenticates only to the gateway audience and delegates every decision to
// the shared admission boundary; it holds no downstream credential and opens no direct provider route.
export function createGatewayApi({ gateway, mcp = null }) {
  requireThat(gateway?.admit && gateway?.discover && gateway?.authenticate, 'GATEWAY_REQUIRED');
  return (request, response) => {
    const url = request.url ?? '';
    if (!url.startsWith('/api/gateway') && !url.startsWith('/mcp')) return false;
    const send = (code, value) => {
      response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", Vary: 'Authorization' });
      response.end(request.method === 'HEAD' ? undefined : value === undefined ? undefined : JSON.stringify(value));
    };
    const host = '127.0.0.1:' + request.socket.localPort;
    if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== 'http://' + host) ||
      request.headers['sec-fetch-site'] === 'cross-site') { send(403, { error: 'ORIGIN_DENIED' }); return true; }
    const authorization = request.headers.authorization ?? '';
    const path = url.split('?')[0];
    (async () => {
      if (!gateway.authenticate(authorization)) { send(401, { error: 'UNAUTHORIZED' }); return; }
      if (path === '/api/gateway/capabilities') {
        if (!['GET', 'HEAD'].includes(request.method)) { send(405, { error: 'READ_ONLY' }); return; }
        send(200, { capabilities: gateway.discover() }); return;
      }
      if (path === '/api/gateway') {
        if (request.method !== 'POST') { send(405, { error: 'METHOD_NOT_ALLOWED' }); return; }
        let body;
        try { body = JSON.parse(await readBody(request)); } catch { send(400, { error: 'UNQUALIFIED' }); return; }
        send(200, await gateway.admit(body, authorization)); return;
      }
      if (path === '/mcp') {
        if (request.method !== 'POST') { send(405, { error: 'METHOD_NOT_ALLOWED' }); return; }
        if (!mcp) { send(503, { error: 'MCP_NOT_CONFIGURED' }); return; }
        let message;
        try { message = JSON.parse(await readBody(request)); } catch { send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
        const reply = await mcp.handle(message, authorization);
        if (reply === null) { response.writeHead(202, { 'Cache-Control': 'no-store' }); response.end(); return; }
        send(200, reply); return;
      }
      send(404, { error: 'NOT_FOUND' });
    })().catch(() => { if (!response.headersSent) send(503, { error: 'RUNTIME_UNAVAILABLE' }); else response.end(); });
    return true;
  };
}