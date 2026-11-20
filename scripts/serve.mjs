import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assemble, ownerRoot } from './build.mjs';

async function loadCommercePolicies() {
  const revision = 'aa4151f82816c0e18796549a2be0e861d0e772d7';
  const path = 'src/local-first/content-security-policy.ts';
  // This pinned owner module is standalone ESM. Read committed bytes even in a dirty checkout.
  const source = execFileSync('git', ['show', revision + ':' + path], {
    cwd: join(ownerRoot(), 'agentic-commerce-os'), maxBuffer: 8192,
  });
  return import('data:text/javascript;base64,' + source.toString('base64'));
}

export async function serve(port = 4181) {
  const { LOCAL_FIRST_DEV_CSP, LOCAL_FIRST_CSP } = await loadCommercePolicies();
  const { assets } = await assemble({ devDocumentPolicy: LOCAL_FIRST_DEV_CSP });
  const types = { '.html':'text/html', '.mjs':'text/javascript', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml' };
  const server = http.createServer((request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    const target = (request.url ?? '').split('?')[0];
    if (target === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const path = target === '/' ? 'index.html' : target.slice(1);
    const bytes = assets.get(path);
    if (!bytes) { response.writeHead(404); response.end('File unavailable'); return; }
    response.writeHead(200, { 'Content-Type': (types[extname(path)] ?? 'text/plain') + '; charset=utf-8',
      'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
      'Content-Security-Policy': path === 'index.html' ? LOCAL_FIRST_DEV_CSP : LOCAL_FIRST_CSP });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done); });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = await serve(Number(process.env.PORT ?? '4181'));
  console.log('Agentic Trading · http://127.0.0.1:' + server.address().port);
}
