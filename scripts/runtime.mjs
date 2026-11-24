import { refuseRead } from '../runtime/completed-read.mjs';
import { simulatorOperation, simulatorSpecs, qualifySimulatorAdapter, withSimulatorAdmission } from '../runtime/moomoo-simulator-read.mjs';
import { marketOperations, marketRead } from '../src/market-reads.mjs';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openConfiguredRuntime, providerCredential, readPrivateJson } from '../runtime/config.mjs';
import { hash, id, requireProofs, requireThat, sha, utcMillis, verifyEnvelope } from '../runtime/core.mjs';
import { createRuntimeApi } from '../runtime/http.mjs';
import { createGateway } from '../runtime/gateway.mjs';
import { createGatewayApi } from '../runtime/gateway-http.mjs';
import { createGatewayMcp } from '../runtime/gateway-mcp.mjs';
import { createReadImporter, recoverReadImport } from '../runtime/ingestion.mjs';
import { createMcpReadAdapter } from '../runtime/mcp-read.mjs';
import { createMcpMarketReadAdapter, MARKET_READ_OPERATIONS } from '../runtime/mcp-market-read.mjs';
import { createRestMarketReadAdapter } from '../runtime/rest-market-read.mjs';
import { createMarketReadBoundary } from '../runtime/market-ingestion.mjs';
import { createProviderRegistry } from '../runtime/provider-mapping.mjs';
import { createPaperGuard } from '../runtime/paper-guard.mjs';
import { createPaperBroker } from '../runtime/paper-broker.mjs';
import { projectRuntime } from '../runtime/projection.mjs';
import { ingestTelemetry, provenanceProjection, validateConfiguration } from '../runtime/forward.mjs';
import { appendEvent } from '../runtime/store.mjs';
import { serve } from './serve.mjs';

export async function runtimeCommand(args) {
  const [command, path, ...rest] = args;
  requireThat(['serve', 'gateway', 'inspect', 'read', 'recover-read', 'configuration', 'telemetry', 'bind-roles', 'schedule-consent'].includes(command) && path,
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
      requireThat(rest.length === 3, 'READ_CONFIGURATION_REQUIRED');
      const [runId, grantPath, providerId] = rest;
      const definition = (config.providers ?? []).find(item => item.provider === providerId && item.transport.kind === 'MCP' && item.mapping.sheets);
      const credential = providerCredential(config, providerId, 'MCP');
      requireThat(definition && credential, 'READ_CONFIGURATION_REQUIRED');
      const grant = readPrivateJson(grantPath);
      const adapter = createMcpReadAdapter({ provider: definition, token: credential.token, mapping: definition.mapping,
        attestation: credential.attestation, aliasSecret: credential.alias_secret, scope: config.scope, candidate: config.candidate });
      const snapshot = await createReadImporter({ ...common, adapter })({ run_id: runId, grant });
      console.log(JSON.stringify({ status: 'SNAPSHOT_ACCEPTED', digest: snapshot.digest, cost: snapshot.cost, runtime_ready: false })); return;
    }
    if (command === 'gateway') {
      requireThat(rest.length <= 1 && (rest[0] === undefined || /^\d{1,5}$/.test(rest[0])), 'INVALID_PORT');
      requireThat(config.gateway && typeof config.gateway.audience_token === 'string' && Array.isArray(config.gateway.capabilities),
        'GATEWAY_CONFIGURATION_REQUIRED');
      const port = Number(rest[0] ?? 4182);
      requireThat(port >= 0 && port <= 65535, 'INVALID_PORT');
      const registry = createProviderRegistry(config.providers ?? []);
      const marketBoundaries = new Map(), snapshotImporters = new Map(), streamReaders = new Map();
      const definitions = config.providers ?? [];
      for (const definition of definitions) {
        const transport = definition.transport.kind;
        const credential = providerCredential(config, definition.provider, transport);
        if (!credential) continue;
        if (transport === 'WEBSOCKET') {
          const { createQuoteStreamReader } = await import('../runtime/moomoo-quote-stream.mjs');
          streamReaders.set(definition.mapping_digest, createQuoteStreamReader({ ...common, definition, credential }));
          continue;
        }
        const shared = { provider: definition, token: credential.token, mapping: definition.mapping,
          attestation: credential.attestation, scope: config.scope, candidate: config.candidate };
        // Each admission owns its own MCP session, grant, call counter and cursor.
        // All admissions still reserve against the same durable cost proof.
        if (definition.mapping?.operations) {
          const makeAdapter = transport === 'REST' ? createRestMarketReadAdapter : createMcpMarketReadAdapter;
          marketBoundaries.set(definition.mapping_digest, (capability, operation) => {
            const adapter = makeAdapter({ ...shared, simulatorAccount: credential.simulator_account, aliasSecret: credential.alias_secret });
            return createMarketReadBoundary({ ...common, adapter: simulatorOperation(operation)
              ? qualifySimulatorAdapter(adapter, capability, definition) : adapter });
          });
        }
        if (definition.mapping?.sheets) {
          snapshotImporters.set(definition.mapping_digest, () => createReadImporter({ ...common,
            adapter: createMcpReadAdapter({ ...shared, aliasSecret: credential.alias_secret }) }));
        }
      }
      const operations = new Set([...marketOperations, ...MARKET_READ_OPERATIONS, ...Object.keys(simulatorSpecs)]);
      const readers = Object.fromEntries([...operations].map(operation=>[operation, async ({capability,inputs,signal})=>{
        if (capability.source==='MOCK') return marketRead(operation,inputs,Date.now());
        const boundary = marketBoundaries.get(capability.mapping_digest);
        requireThat(capability.source==='PROVIDER' && boundary && (MARKET_READ_OPERATIONS.includes(operation) || simulatorOperation(operation)),'UNSUPPORTED');
        const read = boundary(capability, operation);
        const result = await read({ operation, inputs, grant: inputs.grant, signal });
        return { source: result.source, at: Date.parse(result.observed_utc), rows: result.rows, decimals: result.decimals,
          ...(result.price_source && { price_source: result.price_source }),
          ...(result.pagination && { pagination: result.pagination }),
          ...(Object.hasOwn(result, 'last_valid_time_ms') && { last_valid_time_ms: result.last_valid_time_ms }),
          ...(result.account ? { account: result.account } : { market: { venue: 'provider', symbol: inputs.symbol ?? null, marketType: inputs.marketType ?? 'spot', frame: inputs.frame ?? null } }),
          cost: result.cost, digest: result.digest };
      }]));
      function streamReader(capability) {
        const read = streamReaders.get(capability.mapping_digest);
        requireThat(read && capability.source === 'PROVIDER' && capability.transport === 'WEBSOCKET', 'UNQUALIFIED');
        return read;
      }
      readers['read.quote-stream'] = Object.assign(request => streamReader(request.capability)(request), {
        validateReplay: request => streamReader(request.capability).validateReplay(request),
      });
      if (config.gateway.capabilities.some(cap => cap.source === 'MOCK' && cap.operations?.includes('read.fixture'))) {
        readers['read.fixture'] = async () => ({ source: 'MOCK', fixture: true,
          rows: [{ symbol_key: 'US.AAPL', last: '100.25', prev_close: '99.50', ccy: 'USD', delay_class: 'realtime' }],
          decimals: [{ last: '100.25', prev_close: '99.50' }] });
      }
      // Connected reads reuse the reviewed adapter and the single hardened importer; the gateway
      // verifies the signed grant at admission and the importer owns the durable $0 counter.
      if (config.gateway.capabilities.some(cap => cap.source === 'PROVIDER' && cap.operations?.includes('read.snapshot'))) {
        readers['read.snapshot'] = async ({ capability, inputs }) => {
          const importer = snapshotImporters.get(capability.mapping_digest);
          requireThat(importer, 'READ_CONFIGURATION_REQUIRED');
          const read = importer();
          const snapshot = await read({ run_id: inputs.run_id, grant: inputs.grant });
          return { run_id: snapshot.run_id, digest: snapshot.digest, source: snapshot.source, observed_utc: snapshot.observed_utc,
            cost: snapshot.cost, symbols: new Set(snapshot.input.IN_Quotes.map(row => row.symbol_key)).size };
        };
      }
      let guard = null;
      if (config.paper) {
        requireThat(config.paper.attestation && config.paper.market, 'PAPER_CONFIGURATION_REQUIRED');
        const broker = createPaperBroker({ store, scope: config.scope, candidate: config.candidate, keys: config.keys,
          attestation: config.paper.attestation, market: config.paper.market, cash: config.paper.cash, fee: config.paper.fee_per_order,
          source: config.paper.source, provider: config.paper.provider });
        guard = createPaperGuard({ store, scope: config.scope, candidate: config.candidate, keys: config.keys, broker });
      }
      const nativeGateway = createGateway({ store, scope: config.scope, candidate: config.candidate,
        capabilities: config.gateway.capabilities, readers, guard, keys: config.keys, audienceToken: config.gateway.audience_token, providers: registry });
      const gateway = withSimulatorAdmission(nativeGateway, { ...common, providers: registry,
        credentialFor: record => providerCredential(config, record.provider, record.transport) });
      function inspectQuoteStreamReceipt(request) {
        try {
          const capability = gateway.discover().find(record => record.capability_digest === request?.capability_digest);
          requireThat(capability?.mode === 'account', 'SCOPE_DENIED');
          registry.bind(capability);
          return streamReader(capability).inspect(request, capability);
        } catch (error) { return refuseRead(request, error); }
      }
      const gatewayApi = createGatewayApi({ gateway, mcp: createGatewayMcp({ gateway }),
        inspectQuoteStreamReceipt: streamReaders.size ? inspectQuoteStreamReceipt : undefined });
      const runtimeApi = createRuntimeApi({ ...common, viewerToken: config.viewer_token });
      const server = await serve(port, { runtimeApi: (request, response) => gatewayApi(request, response) || runtimeApi(request, response) });
      const stop = () => server.close();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      server.once('close', () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        store.close();
      });
      retained = true;
      console.log('Provider-neutral gateway · http://127.0.0.1:' + server.address().port);
      return server;
    }
    if (command === 'bind-roles') {
      requireThat(rest.length === 2, 'ROLE_BINDINGS_REQUIRED');
      const permit = readPrivateJson(rest[0]), bindings = readPrivateJson(rest[1]);
      const grant = verifyEnvelope(permit, { keys: config.keys, role: 'operator', kind: 'role-binding', scope: config.scope, candidate: config.candidate, now: Date.now() });
      requireProofs(grant, ['cost', 'rights'], Date.now());
      requireThat(id(grant.nonce), 'INVALID_PERMIT');
      const template = JSON.parse(readFileSync(new URL('../runtime/roles.json', import.meta.url), 'utf8'));
      const merged = { ...template, mode: 'BOUND_READ_ONLY', bindings: bindings.bindings, snapshot: bindings.snapshot,
        reviewer_isolation: { ...template.reviewer_isolation, evidence_ref: bindings.reviewer_isolation?.evidence_ref ?? null } };
      merged.roles = template.roles.map(role => {
        const bound = bindings.roles?.find(item => item?.name === role.name);
        requireThat(bound, 'INVALID_ROLE_BINDING');
        return { ...role, agent_ref: bound.agent_ref, version: bound.version, principal_ref: bound.principal_ref,
          runtime_ref: bound.runtime_ref, skills: bound.skills ?? role.skills, mcp: bound.mcp ?? role.mcp, resources: bound.resources ?? role.resources };
      });
      const coordinator = merged.roles.find(role => role.name === 'coordinator');
      coordinator.children = coordinator.children.map(child => {
        const target = merged.roles.find(role => role.name === child.role);
        return { ...child, agent_ref: target.agent_ref, version: target.version };
      });
      const validated = validateConfiguration(merged);
      requireThat(validated.bound && validated.admissible, 'UNBOUND_CONFIGURATION');
      const result = store.transaction(config.scope, state => {
        requireThat(!Object.hasOwn(state.usedApprovals, 'role-binding:' + grant.nonce), 'GRANT_REPLAY');
        state.usedApprovals['role-binding:' + grant.nonce] = validated.digest;
        state.configs['forward:' + validated.digest] = validated.configuration;
        appendEvent(state, { id: 'roles-bound:' + validated.digest, type: 'roles-bound', at: new Date().toISOString(),
          data: { configuration_digest: validated.digest, permit_digest: sha(permit), admissible: validated.admissible } });
        return { configuration_digest: validated.digest, bound: validated.bound, admissible: validated.admissible, authority: false, dispatch_allowed: false };
      });
      console.log(JSON.stringify(result)); return;
    }
    if (command === 'schedule-consent') {
      requireThat(rest.length === 1, 'SCHEDULE_PERMIT_REQUIRED');
      const permit = readPrivateJson(rest[0]);
      const grant = verifyEnvelope(permit, { keys: config.keys, role: 'operator', kind: 'schedule-consent', scope: config.scope, candidate: config.candidate, now: Date.now() });
      requireProofs(grant, ['cost', 'rights'], Date.now());
      requireThat(id(grant.nonce) && hash(grant.identity_ref) && hash(grant.template_ref), 'INVALID_PERMIT');
      const policy = grant.trigger_policy;
      requireThat(policy && typeof policy === 'object' && !Array.isArray(policy) &&
        (policy.type === 'interval' ? Number.isSafeInteger(policy.interval_minutes) && policy.interval_minutes >= 1 && policy.interval_minutes <= 1440 && Object.keys(policy).length === 2 :
          policy.type === 'cron' ? typeof policy.expression === 'string' && policy.expression.length <= 128 && Object.keys(policy).length === 2 :
            policy.type === 'once' ? utcMillis(policy.at_utc) !== null && Object.keys(policy).length === 2 : false), 'INVALID_TRIGGER_POLICY');
      const start = utcMillis(grant.start_at_utc), stop = utcMillis(grant.stop_at_utc);
      requireThat(start !== null && stop !== null && start < stop && stop - start <= 30 * 86_400_000 &&
        (policy.type !== 'once' || (utcMillis(policy.at_utc) >= start && utcMillis(policy.at_utc) < stop)), 'INVALID_SCHEDULE_WINDOW');
      const result = store.transaction(config.scope, state => {
        requireThat(!Object.hasOwn(state.usedApprovals, 'schedule-consent:' + grant.nonce), 'GRANT_REPLAY');
        const bound = Object.entries(state.configs).filter(([key]) => key.startsWith('forward:'))
          .map(([, value]) => validateConfiguration(value)).find(value => value.admissible);
        requireThat(bound && bound.configuration.bindings.identity_ref === grant.identity_ref &&
          bound.configuration.bindings.template_ref === grant.template_ref, 'UNBOUND_CONFIGURATION');
        state.usedApprovals['schedule-consent:' + grant.nonce] = sha(permit);
        state.configs.scheduleConsent = { permit_digest: sha(permit), identity_ref: grant.identity_ref, template_ref: grant.template_ref,
          trigger_policy: policy, start_at_utc: grant.start_at_utc, stop_at_utc: grant.stop_at_utc,
          consented_utc: new Date().toISOString(), authority: false, activated: false };
        appendEvent(state, { id: 'schedule-consent:' + sha(permit), type: 'schedule-consent-recorded', at: new Date().toISOString(),
          data: { permit_digest: sha(permit), trigger_type: policy.type, start_at_utc: grant.start_at_utc, stop_at_utc: grant.stop_at_utc } });
        return { status: 'CONSENT_RECORDED', trigger_policy: policy, start_at_utc: grant.start_at_utc, stop_at_utc: grant.stop_at_utc,
          authority: false, activated: false, can_schedule: false };
      });
      console.log(JSON.stringify(result)); return;
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
