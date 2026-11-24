import { hash, id, requireThat, sameScope, sha } from './core.mjs';

// Read an existing final checkpoint. This path has no reader, transport or ledger writer.
export function completedRead(store, scope, request, record, definitionDigest) {
  requireThat(id(request?.request_id) && sameScope(request.scope, scope), 'SCOPE_DENIED');
  const checkpoint = store.read(scope).checkpoints['gateway:' + request.request_id];
  requireThat(checkpoint?.status === 'FINAL' && checkpoint.binding === sha(request) &&
    checkpoint.result?.status === 'OK', 'FINAL_READ_REQUIRED');
  const receipt = checkpoint.result, { provenance, data } = receipt;
  requireThat(receipt.request_id === request.request_id && provenance?.operation === request.operation &&
    provenance.source === 'PROVIDER' && provenance.capability_digest === request.capability_digest &&
    provenance.definition_digest === definitionDigest && provenance.provider === record.provider &&
    data?.source === 'AUTHENTICATED_ADAPTER' && hash(data.digest), 'SCOPE_DENIED');
  return receipt;
}

export function refuseRead(request, error) {
  const codes = { STALE_EVIDENCE: 'STALE', FINAL_READ_REQUIRED: 'FINAL_READ_REQUIRED', BUDGET_HALT: 'BUDGET_HALT' };
  return { request_id: id(request?.request_id) ? request.request_id : null, status: 'REFUSED',
    error: { code: codes[error.code] ?? 'UNAUTHORIZED' }, provenance: null, ledger_revision: null };
}
