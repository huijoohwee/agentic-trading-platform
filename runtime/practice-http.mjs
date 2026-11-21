import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { practiceDomain } from './practice-domain.mjs';
import { createGatewayMcp } from './gateway-mcp.mjs';
import { sha } from './core.mjs';
import { marketRead } from '../src/market-reads.mjs';

export function createPracticeApi(directory, { now = Date.now } = {}) {
  let store;
  const streams = new Set();
  const cookieName = 'trading_practice_id';
  async function handle(req, res) {
    const host = '127.0.0.1:' + req.socket.localPort,
      origin = 'http://' + host,
      url = new URL(req.url, origin);
    const send = (code, value) => {
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(JSON.stringify(value));
    };
    if (
      req.headers.host !== host ||
      req.headers['sec-fetch-site'] === 'cross-site' ||
      (req.headers.origin && req.headers.origin !== origin)
    )
      return send(403, { error: 'ORIGIN_DENIED' });
    try {
      if (url.pathname === '/api/practice/events' && req.method === 'GET') {
        if (streams.size >= 16) return send(429, { error: 'STREAM_CAPACITY' });
        const symbol = url.searchParams.get('symbol');
        const event = () => JSON.stringify(marketRead('read.ticker', { symbol }, now()));
        const first = event();
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        res.write('retry: 4000\ndata: ' + first + '\n\n');
        const timer = setInterval(() => {
          if (!res.writableNeedDrain) res.write('data: ' + event() + '\n\n');
        }, 2000);
        streams.add(res);
        res.on('close', () => {
          clearInterval(timer);
          streams.delete(res);
        });
        return;
      }
      if (url.pathname === '/api/practice/market' && req.method === 'GET') {
        return send(200, marketRead('read.ticker', { symbol: url.searchParams.get('symbol') }, now()));
      }
      const route = url.pathname.slice('/api/practice/'.length);
      if (!['session', 'capabilities', 'gateway', 'mcp'].includes(route)) return send(404, { error: 'UNSUPPORTED' });
      if (!['GET', 'POST'].includes(req.method)) return send(405, { error: 'METHOD_NOT_ALLOWED' });
      let token = (req.headers.cookie ?? '')
        .split(';')
        .map((v) => v.trim())
        .find((v) => v.startsWith(cookieName + '='))
        ?.slice(cookieName.length + 1);
      if (!/^[0-9a-f]{64}$/.test(token ?? '')) {
        if (req.method !== 'GET' || route !== 'session') return send(401, { error: 'SESSION_REQUIRED' });
        token = randomBytes(32).toString('hex');
        res.setHeader(
          'Set-Cookie',
          cookieName + '=' + token + '; HttpOnly; SameSite=Strict; Path=/api/practice; Max-Age=31536000'
        );
      }
      if (!store) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        store = openStore(join(directory, 'practice.sqlite'));
      }
      const scope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'desk/' + sha(token) };
      const { gateway, request } = practiceDomain({ store, scope, token, now }),
        auth = 'Bearer ' + token;
      const unwrap = (result) => {
        if (result.status !== 'OK') throw Error(result.error.code);
        return { ...result.data, sessionId: sha(scope.account_alias) };
      };
      if (req.method === 'GET') {
        if (route === 'session')
          return send(200, unwrap(await gateway.admit(request('practice.session', {}, randomUUID()), auth)));
        if (route === 'capabilities') return send(200, { scope, capabilities: gateway.discover() });
        return send(405, { error: 'METHOD_NOT_ALLOWED' });
      }
      if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json')
        return send(403, { error: 'ORIGIN_DENIED' });
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32000) return send(413, { error: 'INPUT_TOO_LARGE' });
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks));
      if (route === 'gateway') return send(200, await gateway.admit(payload, auth));
      if (route === 'mcp') return send(200, await createGatewayMcp({ gateway }).handle(payload, auth));
      if (route !== 'session') return send(405, { error: 'METHOD_NOT_ALLOWED' });
      const { command, revision, requestId } = payload;
      const { kind, ...args } = command;
      send(200, unwrap(await gateway.admit(request('practice.' + kind, { ...args, revision }, requestId), auth)));
    } catch (error) {
      const code = error.code ?? error.message;
      const known = /^[A-Z][A-Z0-9_]{1,50}$/.test(code) ? code : 'INVALID_REQUEST';
      send(known === 'CONFLICT' ? 409 : 400, { error: known });
    }
  }
  return {
    route(req, res) {
      if (!req.url?.startsWith('/api/practice/')) return false;
      void handle(req, res);
      return true;
    },
    closeStreams() {
      for (const response of streams) response.end();
    },
    close() {
      store?.close();
    }
  };
}
