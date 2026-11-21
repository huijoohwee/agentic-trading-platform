import {serveAssets} from './local-server.mjs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assemble, ownerRoot, root } from './build.mjs';

export async function loadCommercePolicies() {
  const revision = 'aa4151f82816c0e18796549a2be0e861d0e772d7';
  const path = 'src/local-first/content-security-policy.ts';
  // This pinned owner module is standalone ESM. Read committed bytes even in a dirty checkout.
  const source = execFileSync('git', ['show', revision + ':' + path], {
    cwd: join(ownerRoot(), 'agentic-commerce-os'), maxBuffer: 8192,
  });
  return import('data:text/javascript;base64,' + source.toString('base64'));
}

export async function serve(port = 4181, { runtimeApi, practiceDirectory=join(root,'.runtime-private','desk') } = {}) {
  const { LOCAL_FIRST_DEV_CSP, LOCAL_FIRST_CSP } = await loadCommercePolicies();
  const { assets } = await assemble({ devDocumentPolicy: LOCAL_FIRST_DEV_CSP });
  return serveAssets(port,{assets,documentPolicy:LOCAL_FIRST_DEV_CSP,resourcePolicy:LOCAL_FIRST_CSP,practiceDirectory,runtimeApi});
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = await serve(Number(process.env.PORT ?? '4181'));
  console.log('Agentic Trading · http://127.0.0.1:' + server.address().port);
}
