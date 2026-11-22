import http from 'node:http';
import { extname } from 'node:path';

export async function serveAssets(
  port,
  { assets, documentPolicy, resourcePolicy, practiceDirectory, runtimeApi, observerConfig }
) {
  const types = {
    '.html': 'text/html',
    '.mjs': 'text/javascript',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml'
  };
  let practice,
    opening,
    closing = false;
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith('/api/practice/')) {
      opening ??= import('../runtime/practice-http.mjs').then(
        ({ createPracticeApi }) => (practice = createPracticeApi(practiceDirectory))
      );
      void opening
        .then((api) => {
          if (closing) {
            response.writeHead(503);
            response.end();
          } else api.route(request, response);
        })
        .catch(() => {
          opening = undefined;
          response.writeHead(503);
          response.end('Practice runtime unavailable');
        });
      return;
    }
    if (runtimeApi?.(request, response)) return;
    if (request.url?.startsWith('/api/')) {
      response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: 'RUNTIME_NOT_CONFIGURED' }));
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405);
      response.end();
      return;
    }
    const target = (request.url ?? '').split('?')[0];
    if (target === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    const path = target === '/' ? 'index.html' : target.slice(1);
    const bytes = assets.get(path);
    if (!bytes) {
      response.writeHead(404);
      response.end('File unavailable');
      return;
    }
    response.writeHead(200, {
      'Content-Type': (types[extname(path)] ?? 'text/plain') + '; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': path.endsWith('.html') ? documentPolicy : resourcePolicy
    });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  });
  let shared;
  if (observerConfig) {
    const { createPracticeApi } = await import('../runtime/practice-http.mjs');
    practice = createPracticeApi(practiceDirectory, {
      observerOrigin:
        observerConfig.origin ??
        'https://' +
          (observerConfig.host.includes(':') ? '[' + observerConfig.host + ']' : observerConfig.host) +
          ':' +
          observerConfig.port
    });
    opening = Promise.resolve(practice);
    const { serveObserver } = await import('./observer-server.mjs');
    shared = await serveObserver({ ...observerConfig, assets, api: practice, policy: documentPolicy });
    server.observer = shared;
  }
  const close = server.close.bind(server);
  server.close = (callback) => {
    closing = true;
    shared?.close();
    practice?.closeStreams();
    return close(callback);
  };
  server.once('close', () => practice?.close());
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', done);
  });
  return server;
}
