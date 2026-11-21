import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
// This optional listener serves only the shared view. Owner routes stay on loopback.
export async function serveObserver({ host, port, cert, key, assets, api, policy }) {
  if (!isIP(host) || !Number.isInteger(port) || port < 0 || port > 65535) throw Error('INVALID_OBSERVER_BINDING');
  const allow = new Set([
    'observe.html',
    'desk.css',
    'owners/design/profile.css',
    'src/observer-view.mjs',
    'src/chart.mjs',
    'src/indicators.mjs',
    'src/market.mjs'
  ]);
  const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/api/practice/observe') {
      api.observe(req, res);
      return;
    }
    if (req.method !== 'GET' || !allow.has(path.slice(1))) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': path.endsWith('.html') ? 'text/html' : path.endsWith('.css') ? 'text/css' : 'text/javascript',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': policy
    });
    res.end(assets.get(path.slice(1)));
  });
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, ok);
  });
  return server;
}

export function observerEnvironment(env) {
  return env.TRADING_OBSERVER_HOST
    ? {
        host: env.TRADING_OBSERVER_HOST,
        port: Number(env.TRADING_OBSERVER_PORT ?? 4182),
        cert: env.TRADING_OBSERVER_CERT,
        key: env.TRADING_OBSERVER_KEY
      }
    : undefined;
}
