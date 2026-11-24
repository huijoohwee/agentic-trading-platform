import { completedRead } from './completed-read.mjs';
import { id, requireProofs, requireThat, sha, utcMillis, verifyEnvelope } from './core.mjs';
import { marketRestSpecs } from './moomoo-market-rest.mjs';

const snapshotOperations = new Map([['quote', 'read.ticker'], ['order_book', 'read.depth']]);

export function snapshotOperation(topic) {
  return snapshotOperations.get(topic);
}

// A bounded quote or book can start again from a fresh, separately admitted
// REST snapshot. Neither that observation nor this link certifies gap-free tape.
export function verifyQuoteBaseline({ store, scope, candidate, keys, resolveBaseline }, parameters, proof, interruption, now) {
  requireThat(proof && interruption && id(interruption.request_id) && proof.previous_request_id === interruption.request_id &&
    Number.isSafeInteger(interruption.after_ms) && interruption.after_ms <= now, 'BASELINE_REQUIRED');
  const request = proof.request;
  const operation = snapshotOperation(parameters.type);
  requireThat(operation && request?.operation === operation && id(request.request_id) && typeof resolveBaseline === 'function', 'SCOPE_DENIED');
  const { capability, definition, keyId } = resolveBaseline(request.capability_digest);
  const spec = marketRestSpecs[operation];
  requireThat(capability.source === 'PROVIDER' && capability.operations.includes(operation) && capability.allowlist.includes(spec.tool) &&
    capability.qualification.status === 'QUALIFIED' && definition.qualification.status === 'QUALIFIED' &&
    sha(definition.mapping.operations[operation]) === sha(spec), 'UNQUALIFIED');
  const definitionDigest = sha(definition);
  const { data } = completedRead(store, scope, request, capability, definitionDigest);
  const verify = { keys, scope, candidate, now };
  const { grant: signedGrant, ...inputs } = request.inputs;
  const grant = verifyEnvelope(signedGrant, { ...verify, role: 'operator', kind: 'read' });
  requireProofs(grant, ['cost', 'rights', 'account'], now);
  const rights = grant.proofs.find(item => item.kind === 'rights');
  requireThat(rights.scope === 'quote:read' && rights.symbol === parameters.symbol && rights.private_ledger === true && rights.display === true &&
    grant.mapping_digest === capability.mapping_digest && inputs.symbol === parameters.symbol &&
    grant.tools.some(tool => tool.operation === operation && tool.name === spec.tool && tool.effect === 'read' &&
      tool.schema_digest === spec.schema_digest && tool.inputs_digest === sha(inputs)), 'SCOPE_DENIED');
  const attestation = data.market_attestation;
  requireThat(id(keyId) && attestation?.key_id === keyId && data.digest === proof.digest &&
    Array.isArray(data.rows) && data.rows.length > 0 && data.rows.every(row => row.symbol === parameters.symbol), 'BASELINE_REQUIRED');
  const page = verifyEnvelope({ key_id: keyId, signature: attestation.signature,
    payload: { ...attestation.header, rows: data.rows, decimals: data.decimals } }, { ...verify, role: 'integration', kind: 'provider-market-page' });
  const binding = page.market_request;
  requireThat(page.operation === operation && page.schema_digest === spec.schema_digest &&
    data.digest === sha({ rows: page.rows, decimals: page.decimals, response_digest: page.response_digest }) &&
    binding?.definition_digest === definitionDigest && binding.grant_digest === sha(grant) && binding.inputs_digest === sha(inputs) &&
    Number.isSafeInteger(binding.started_ms) && binding.started_ms >= interruption.after_ms && binding.started_ms <= now, 'BASELINE_REQUIRED');
  const expires = Math.min(...[page, grant, ...grant.proofs, capability.qualification, definition.qualification].map(x => utcMillis(x.expires_utc)));
  requireThat(now < expires, 'STALE_EVIDENCE');
  return { expires, link: { previous_request_id: interruption.request_id, after_ms: interruption.after_ms,
    request_id: request.request_id, operation, digest: data.digest, observed_utc: page.observed_utc } };
}
