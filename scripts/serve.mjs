import http from 'node:http';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assemble } from './build.mjs';

export async function serve(port = 4181) {
  const { assets } = await assemble();
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
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'" });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done); });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = await serve(Number(process.env.PORT ?? '4181'));
  console.log('Agentic Trading · http://127.0.0.1:' + server.address().port);
}
