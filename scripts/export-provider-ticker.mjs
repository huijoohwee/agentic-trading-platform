import { createPublicKey, sign } from 'node:crypto';
import { link, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openConfiguredRuntime, providerCredential, readPrivateJson } from '../runtime/config.mjs';
import { canonical, hash, id, requireProofs, requireThat, sameScope, sha, utcMillis, verifyEnvelope } from '../runtime/core.mjs';
import { createProviderRegistry } from '../runtime/provider-mapping.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const symbolPattern = /^[A-Z0-9][A-Z0-9./_-]{0,39}$/;
const pricePattern = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function effectiveRights(grant, provider, symbol, qualifications, now) {
  const rights = grant.proofs.filter(proof => proof.kind === 'rights');
  const policy = rights[0]?.ticker_receipt;
  requireThat(rights.length === 1 && policy?.audience === 'graph-mainpanel' && policy.provider === provider &&
    policy.symbol === symbol && policy.display === true && policy.offline_replay === true, 'TICKER_RIGHTS_REQUIRED');
  const windows = [policy.retain_until_utc, grant.expires_utc, ...grant.proofs.map(p => p.expires_utc),
    ...qualifications.map(q => q.expires_utc)];
  requireThat(windows.every(value => utcMillis(value) > now), 'RECEIPT_EXPIRED');
  return { rights_digest: rights[0].digest, retain_until_utc: windows.sort()[0] };
}

function quoteFields(data, symbol, now) {
  const row = Array.isArray(data.rows) && data.rows.length === 1 ? data.rows[0] : data.rows;
  const price = data.decimals?.[0]?.price;
  requireThat(data.source === 'AUTHENTICATED_ADAPTER' && data.market?.venue === 'provider' &&
    data.market.symbol === symbol && row?.symbol === symbol && typeof symbol === 'string' && symbolPattern.test(symbol), 'QUOTE_BINDING');
  requireThat(data.price_source === 'decimal-string' && data.decimals?.length === 1 && typeof price === 'string' && price.length <= 64 &&
    pricePattern.test(price) && Number.isFinite(row.price) && row.price > 0 && row.price === Number(price), 'PRECISION_UNKNOWN');
  requireThat(typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency) &&
    Number.isSafeInteger(data.at) && data.at >= 0 && data.at <= now, 'INVALID_QUOTE');
  const marketTime = row.market_time_utc ?? null;
  if (marketTime !== null) {
    const ms = Date.parse(marketTime);
    requireThat(typeof marketTime === 'string' && Number.isFinite(ms) && ms <= data.at &&
      (utcMillis(marketTime) !== null || new Date(ms).toISOString() === marketTime), 'INVALID_MARKET_TIME');
  }
  const delay = row.delay_class ?? 'unknown';
  requireThat(['unknown', 'delayed', 'realtime'].includes(delay), 'INVALID_FEED_DELAY');
  return { symbol, price, currency: row.currency, market_time_utc: marketTime,
    observed_utc: new Date(data.at).toISOString(), delay_class: delay };
}

export function providerTickerReceipt(configPath, requestPath) {
  const request = readPrivateJson(requestPath);
  const { config, store } = openConfiguredRuntime(configPath);
  try {
    const { scope, candidate, keys } = config;
    requireThat(request.operation === 'read.ticker' && id(request.request_id) && sameScope(request.scope, scope), 'REQUEST_BINDING');
    const record = store.read(scope).checkpoints['gateway:' + request.request_id];
    requireThat(record?.status === 'FINAL' && record.binding === sha(request) && record.result?.status === 'OK', 'FINAL_READ_REQUIRED');
    const { data, provenance, ledger_revision, request_id } = record.result;
    const cap = config.gateway?.capabilities?.find(item => sha(item) === request.capability_digest);
    requireThat(cap?.source === 'PROVIDER' && cap.operations.includes(request.operation), 'PROVIDER_REQUIRED');
    const binding = createProviderRegistry(config.providers).bind(cap);
    requireThat(cap.qualification.status === 'QUALIFIED' && binding.definition.qualification.status === 'QUALIFIED' &&
      provenance?.source === 'PROVIDER' && provenance.operation === request.operation && provenance.provider === cap.provider &&
      provenance.capability_digest === request.capability_digest && provenance.definition_digest === binding.definition_digest &&
      request_id === request.request_id && Number.isSafeInteger(ledger_revision) && ledger_revision >= 1 && hash(data?.digest), 'PROVENANCE_BINDING');
    const now = Date.now();
    const grant = verifyEnvelope(request.inputs.grant, { keys, role: 'operator', kind: 'read', scope, candidate, now });
    requireProofs(grant, ['cost', 'rights', 'account'], now);
    const symbol = request.inputs.symbol;
    const payload = { schema: 'trading-provider-ticker/v1', operation: request.operation, provider: cap.provider,
      candidate, definition_digest: binding.definition_digest, result_digest: data.digest,
      request_id: uuid.test(request_id) ? request_id : 'sha256:' + sha(request_id), ledger_revision,
      ...effectiveRights(grant, cap.provider, symbol, [cap.qualification, binding.definition.qualification], now),
      ...quoteFields(data, symbol, now) };
    const signer = providerCredential(config, cap.provider, cap.transport)?.attestation;
    const key = signer && keys[signer.key_id];
    requireThat(key?.role === 'integration' && key.revoked !== true && key.principal === signer.principal &&
      key.runtime === signer.runtime, 'UNTRUSTED_SIGNER');
    const pinnedKey = createPublicKey(key.publicKey);
    requireThat(pinnedKey.asymmetricKeyType === 'ed25519' && pinnedKey.equals(createPublicKey(signer.privateKey)), 'UNTRUSTED_SIGNER');
    return { payload, signature: sign(null, Buffer.from(canonical(payload)), signer.privateKey).toString('base64url') };
  } finally { store.close(); }
}

export async function exportProviderTicker(configPath, requestPath, destination) {
  const receipt = providerTickerReceipt(configPath, requestPath);
  const text = JSON.stringify(receipt) + '\n';
  requireThat(Buffer.byteLength(text) <= 4096, 'RECEIPT_TOO_LARGE');
  const staging = await mkdtemp(join(dirname(destination), '.ticker-export-'));
  try {
    const complete = join(staging, 'receipt.json');
    await writeFile(complete, text, { mode: 0o600 });
    await link(complete, destination);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 5) throw Error('Usage: node scripts/export-provider-ticker.mjs <private-config> <private-request> <new-receipt.json>');
  await exportProviderTicker(...process.argv.slice(2).map(path => resolve(path)));
}
