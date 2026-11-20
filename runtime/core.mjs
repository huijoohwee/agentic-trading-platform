import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonical, utcMillis } from '../src/rules.mjs';

export { canonical, utcMillis };
export const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
export const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
export const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function fail(code) { throw Object.assign(new Error(code), { code }); }
export function requireThat(condition, code) { if (!condition) fail(code); }
export function scopeKey(scope) {
  requireThat(scope?.environment === 'SIMULATE' && ['practice', 'competition'].includes(scope.profile) && id(scope.account_alias), 'ACCOUNT_BINDING');
  requireThat(Object.keys(scope).sort().join(',') === 'account_alias,environment,profile', 'ACCOUNT_BINDING');
  return sha(scope);
}
export function sameScope(a, b) { return scopeKey(a) === scopeKey(b); }
export function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function boundedJson(value, maxBytes = 480_000) {
  let text;
  try { text = JSON.stringify(value); } catch { fail('INVALID_JSON'); }
  requireThat(typeof text === 'string' && Buffer.byteLength(text) <= maxBytes, 'INPUT_TOO_LARGE');
  return JSON.parse(text);
}
export function current(value, now) {
  const issued = utcMillis(value?.issued_utc), expiry = utcMillis(value?.expires_utc);
  return Number.isFinite(now) && issued !== null && expiry !== null && issued <= now && now < expiry;
}
export function verifyEnvelope(envelope, { keys, role, kind, scope, candidate, now }) {
  const signed = boundedJson(envelope);
  requireThat(signed && Object.keys(signed).sort().join(',') === 'key_id,payload,signature' && id(signed.key_id), 'INVALID_SIGNATURE');
  const key = Object.hasOwn(keys ?? {}, signed.key_id) ? keys[signed.key_id] : null;
  requireThat(key && key.role === role && key.revoked !== true && id(key.principal) && id(key.runtime), 'UNTRUSTED_PRINCIPAL');
  requireThat(typeof signed.signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(signed.signature), 'INVALID_SIGNATURE');
  let valid = false;
  try {
    const publicKey = createPublicKey(key.publicKey);
    valid = publicKey.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(canonical(signed.payload)), publicKey, Buffer.from(signed.signature, 'base64url'));
  } catch { fail('INVALID_SIGNATURE'); }
  requireThat(valid, 'INVALID_SIGNATURE');
  const payload = signed.payload;
  requireThat(payload?.schema === 'trading-runtime-envelope/v1' && payload.kind === kind &&
    payload.principal === key.principal && payload.runtime === key.runtime, 'PRINCIPAL_BINDING');
  requireThat(payload.revoked !== true, 'REVOKED');
  requireThat(current(payload, now), 'STALE_EVIDENCE');
  requireThat(sameScope(payload.scope, scope) && hash(candidate) && payload.candidate === candidate, 'CANDIDATE_BINDING');
  return freeze(payload);
}
export function requireProofs(grant, kinds, now) {
  requireThat(Array.isArray(grant.proofs) && grant.proofs.every(proof => proof && proof.revoked !== true &&
    hash(proof.digest) && utcMillis(proof.expires_utc) > now) &&
    kinds.every(kind => grant.proofs.some(proof => proof.kind === kind)), 'MISSING_ADMISSION_PROOF');
  requireThat(grant.cost?.hard_cap_usd === 0 && grant.cost?.deny_at_exhaustion === true &&
    Number.isSafeInteger(grant.cost.remaining_calls) && grant.cost.remaining_calls > 0, 'BUDGET_HALT');
}
export async function boundedCall(call, timeoutMs) {
  requireThat(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 600_000, 'INVALID_TIMEOUT');
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => call(controller.signal)),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })); }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); controller.abort(); }
}
