import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openConfiguredRuntime, readPrivateJson } from '../runtime/config.mjs';
import { requireThat } from '../runtime/core.mjs';
import { createRuntimeApi } from '../runtime/http.mjs';
import { createReadImporter, recoverReadImport } from '../runtime/ingestion.mjs';
import { createMcpReadAdapter } from '../runtime/mcp-read.mjs';
import { projectRuntime } from '../runtime/projection.mjs';
import { ingestTelemetry, provenanceProjection } from '../runtime/forward.mjs';
import { serve } from './serve.mjs';

export async function runtimeCommand(args) {
  const [command, path, ...rest] = args;
  requireThat(['serve', 'inspect', 'read', 'recover-read', 'configuration', 'telemetry'].includes(command) && path,
    'USAGE_RUNTIME_COMMAND_PRIVATE_CONFIG');
  if (command === 'configuration') {
    requireThat(rest.length === 0, 'UNEXPECTED_ARGUMENT');
    console.log(JSON.stringify(provenanceProjection(readPrivateJson(path)))); return;
  }
  const { config, store } = openConfiguredRuntime(path);
  let retained = false;
  try {
    const common = { store, scope: config.scope, candidate: config.candidate, keys: config.keys };
    if (command === 'serve') {
      requireThat(rest.length <= 1 && (rest[0] === undefined || /^\d{1,5}$/.test(rest[0])), 'INVALID_PORT');
      const port = Number(rest[0] ?? 4181);
      requireThat(port > 0 && port <= 65535, 'INVALID_PORT');
      const runtimeApi = createRuntimeApi({ ...common, viewerToken: config.viewer_token });
      const server = await serve(port, { runtimeApi });
      server.once('close', () => store.close()); retained = true;
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
      console.log('Read-only runtime · http://127.0.0.1:' + server.address().port);
      return server;
    }
    if (command === 'inspect') {
      requireThat(rest.length === 0, 'UNEXPECTED_ARGUMENT');
      console.log(JSON.stringify(projectRuntime(store.read(config.scope), config.candidate, Date.now(), store.read({ ...config.scope, profile: 'practice' })))); return;
    }
    if (command === 'recover-read') {
      requireThat(rest.length === 1, 'RECOVERY_PERMIT_REQUIRED');
      console.log(JSON.stringify(recoverReadImport({ ...common, permit: readPrivateJson(rest[0]) }))); return;
    }
    if (command === 'read') {
      requireThat(rest.length === 2 && config.moomoo, 'READ_CONFIGURATION_REQUIRED');
      const grant = readPrivateJson(rest[1]);
      const adapter = createMcpReadAdapter({ token: config.moomoo.token, mapping: config.moomoo.mapping,
        attestation: config.moomoo.attestation, aliasSecret: config.moomoo.alias_secret, scope: config.scope, candidate: config.candidate });
      const snapshot = await createReadImporter({ ...common, adapter })({ run_id: rest[0], grant });
      console.log(JSON.stringify({ status: 'SNAPSHOT_ACCEPTED', digest: snapshot.digest, cost: snapshot.cost, runtime_ready: false })); return;
    }
    requireThat(rest.length === 3, 'TELEMETRY_FILES_REQUIRED');
    const result = ingestTelemetry({ ...common, permit: readPrivateJson(rest[0]), envelope: readPrivateJson(rest[1]), configuration: readPrivateJson(rest[2]) });
    console.log(JSON.stringify(result));
  } finally { if (!retained) store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runtimeCommand(process.argv.slice(2)); }
  catch (error) {
    const code = /^[A-Z_]{1,64}$/.test(error.code ?? '') ? error.code : 'RUNTIME_REFUSED';
    console.error(`Runtime command refused (${code}). Check private file permissions, immutable bindings and signed unexpired grants. No credential or provider error details are printed.`);
    process.exitCode = 1;
  }
}
