import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { bindMoomooQuoteCapture, MOOMOO_QUOTE_SOCKET } from 'agentic-gateway/connectors/moomoo-quote-socket';
import { boundedJson, canonical, fail, freeze, hash, id, requireProofs, requireThat, sha, utcMillis, verifyEnvelope } from './core.mjs';
import { readBudgetScope, reserveReadCalls } from './read-budget.mjs';

export const quoteStreamOperation = 'read.quote-stream';
export const quoteStreamSchema = freeze({ symbol: 'instrument', type: ['quote', 'order_book', 'ticker', 'kline'],
  kline: ['period', 'adjust'], frame_limit: [1, 64], capture_ms: [1, 60000], control_timeout_ms: [1, 10000] });
export const quoteStreamMapping = freeze({ profile: 'moomoo/quote-websocket/v1', operation: quoteStreamOperation,
  protocol: '13', controls: ['auth', 'subscribe', 'unsubscribe'], schema_digest: sha(quoteStreamSchema) });
export const quoteStreamAdapterDigest = sha(readFileSync(new URL(import.meta.resolve('agentic-gateway/connectors/moomoo-quote-socket'))));

const utc = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const publicDer = key => createPublicKey(key).export({ type: 'spki', format: 'der' });
const positive = n => Number.isSafeInteger(n) && n > 0;
const only = (value, keys) => Object.keys(value).every(key => keys.includes(key));

export function createQuoteStreamReader({ store, scope, candidate, keys, definition, credential }) {
  requireThat(definition.transport?.origin === MOOMOO_QUOTE_SOCKET && definition.transport.kind === 'WEBSOCKET' &&
    definition.transport.protocol === '13' && definition.adapter_digest === quoteStreamAdapterDigest &&
    definition.mapping_digest === sha(quoteStreamMapping) && definition.schema_digest === quoteStreamMapping.schema_digest &&
    sha(definition.mapping) === definition.mapping_digest && canonical(definition.operations) === canonical([quoteStreamOperation]) &&
    canonical(definition.allowlist) === canonical(['subscribe']), 'INVALID_MAPPING');
  requireThat(hash(credential.quota_pool) && typeof credential.token === 'string' &&
    /^[A-Za-z0-9._~+/-]+=*$/.test(credential.token) && credential.token.length <= 8192, 'READ_CREDENTIAL_REQUIRED');
  const signer = credential.attestation;
  requireThat(id(signer?.key_id), 'ATTESTATION_REQUIRED');
  const privateKey = createPrivateKey(signer.privateKey);
  const pool = { environment: 'SIMULATE', profile: 'practice', account_alias: 'runtime-budget/ws/' + credential.quota_pool };
  const budget = readBudgetScope(scope);
  const definitionDigest = sha(definition);

  function validate({ capability, inputs }) {
    requireThat(capability.source === 'PROVIDER' && capability.transport === 'WEBSOCKET' &&
      capability.provider === definition.provider && capability.qualification.status === 'QUALIFIED' &&
      definition.qualification.status === 'QUALIFIED', 'UNQUALIFIED');
    const key = Object.hasOwn(keys, signer.key_id) && keys[signer.key_id];
    requireThat(key?.role === 'integration' && key.revoked !== true && key.principal === signer.principal &&
      key.runtime === signer.runtime && privateKey.asymmetricKeyType === 'ed25519' &&
      publicDer(privateKey).equals(publicDer(key.publicKey)), 'UNTRUSTED_PRINCIPAL');
    const now = Date.now();
    const grant = verifyEnvelope(inputs.grant, { keys, role: 'operator', kind: 'read', scope, candidate, now });
    requireProofs(grant, ['cost', 'rights', 'account', 'stream-quota'], now);
    requireThat(new Set(grant.proofs.map(proof => proof.kind)).size === grant.proofs.length, 'ADMISSION_PROOF');
    const { grant: envelope, ...parameters } = inputs;
    const tool = grant.tools?.[0];
    requireThat(id(grant.nonce) && grant.definition_digest === definitionDigest && grant.mapping_digest === definition.mapping_digest &&
      grant.tools?.length === 1 && tool.operation === quoteStreamOperation && tool.name === 'subscribe' && tool.effect === 'read' &&
      tool.schema_digest === definition.schema_digest && tool.inputs_digest === sha(parameters) &&
      only(parameters, ['symbol', 'type', 'period', 'adjust', 'frame_limit', 'capture_ms', 'control_timeout_ms']), 'SCOPE_DENIED');
    const rights = grant.proofs.find(proof => proof.kind === 'rights');
    requireThat(rights.scope === 'quote:read' && rights.symbol === parameters.symbol && rights.topic === parameters.type &&
      rights.display === true && rights.private_ledger === true, 'SCOPE_DENIED');
    const quota = grant.proofs.find(proof => proof.kind === 'stream-quota');
    const checked = utcMillis(quota.observed_utc);
    requireThat(quota.pool === credential.quota_pool && checked !== null && checked <= utcMillis(grant.issued_utc) &&
      positive(quota.remaining_sessions) && positive(quota.remaining_keys) && grant.limits?.max_calls === 3 &&
      grant.cost.remaining_calls >= 3 && positive(grant.limits.timeout_ms) && grant.limits.timeout_ms <= 600000, 'BUDGET_HALT');
    const expires = Math.min(...[grant, ...grant.proofs, definition.qualification, capability.qualification].map(x => utcMillis(x.expires_utc)));
    requireThat(now < expires, 'STALE_EVIDENCE');
    return { grant, parameters, quota, checked, expires };
  }

  async function read(request) {
    const { grant, parameters: p, quota, checked, expires } = validate(request);
    const until = Math.min(expires, utcMillis(request.deadlineUtc), Date.now() + grant.limits.timeout_ms);
    const capture = bindMoomooQuoteCapture({ accessToken: () => credential.token, grant: {
      right: 'quote:read', entitled: true, providerHardCapUsd: 0, reservedSessions: 1, reservedKeys: 1, reservedControlCalls: 3,
      symbol: p.symbol, type: p.type, period: p.period, adjust: p.adjust, frameLimit: p.frame_limit,
      captureMs: p.capture_ms, controlTimeoutMs: p.control_timeout_ms, expiresAt: until,
    } });
    const reservation = sha({ scope, candidate, nonce: grant.nonce });
    // The upstream subscription pool is per user across aliases. Reserve it and the
    // existing call budget atomically, before opening a socket or reading the token.
    store.transactionScopes([budget, pool], ([costState, poolState]) => {
      requireThat(!request.signal?.aborted && Date.now() < until, 'WINDOW_CLOSED');
      requireThat(!poolState.usedApprovals['stream:' + reservation] && !poolState.usedApprovals['quota:' + quota.digest] &&
        checked >= (poolState.telemetry.next_quota_observation_ms ?? 0), 'BUDGET_HALT');
      reserveReadCalls(costState, grant);
      poolState.usedApprovals['stream:' + reservation] = true;
      poolState.usedApprovals['quota:' + quota.digest] = true;
      // After interruption, another session needs fresh provider headroom beyond this lease.
      poolState.telemetry.next_quota_observation_ms = until;
    });
    let result;
    try { result = await capture({ signal: request.signal }); }
    catch (error) {
      const code = /^QUOTE_PROVIDER_REFUSED_(\d{1,4})$/.exec(error.message)?.[1];
      if (code) throw Object.assign(Error('Provider refused quote capture'), {
        code: Number(code) === 4 ? 'BUDGET_HALT' : 'UNQUALIFIED', providerCode: Number(code),
      });
      if (['STREAM_EXPIRED', 'CAPTURE_ABORTED'].includes(error.message)) fail('WINDOW_CLOSED');
      throw error;
    }
    const finished = Date.now();
    requireThat(!request.signal?.aborted && finished < until, 'WINDOW_CLOSED');
    const payload = boundedJson({ schema: 'trading-runtime-envelope/v1', kind: 'quote-stream-capture', scope, candidate,
      principal: signer.principal, runtime: signer.runtime, issued_utc: utc(finished), expires_utc: utc(expires),
      definition_digest: definitionDigest, grant_digest: sha(request.inputs.grant), ...result }, 460000);
    const receipt = { key_id: signer.key_id, payload, signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64url') };
    verifyEnvelope(receipt, { keys, role: 'integration', kind: 'quote-stream-capture', scope, candidate, now: Date.now() });
    return { source: 'AUTHENTICATED_ADAPTER', digest: sha(receipt), receipt,
      cost: { tool_calls: 3, sessions: 1, subscription_keys: 1, provider_fees: 'UNKNOWN' } };
  }
  return Object.assign(read, { validateReplay(request) {
    validate(request);
    const receipt = request.data?.receipt;
    const payload = verifyEnvelope(receipt, { keys, role: 'integration', kind: 'quote-stream-capture',
      scope, candidate, now: Date.now() });
    requireThat(receipt.key_id === signer.key_id && request.data.digest === sha(receipt) &&
      payload.grant_digest === sha(request.inputs.grant) && payload.definition_digest === definitionDigest, 'SCOPE_DENIED');
  } });
}
