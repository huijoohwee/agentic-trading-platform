import { createResolver, validateManifest } from 'agentic-gateway';
import descriptor from './quote-capability.json' with { type: 'json' };

const manifest = validateManifest(descriptor);

// The qualifying fixture is local and labelled MOCK. Provider-backed snapshot reads stay native.
export function discoverPortableQuotes(records) {
  const pin = descriptor.qualifiedBinding;
  return records.filter(record =>
    record.adapter_digest === pin.adapterDigest && record.schema_digest === pin.schemaDigest &&
    record.mapping_digest === pin.mappingDigest &&
    record.source === 'MOCK' && record.rights === 'MOCK' &&
    record.operations.includes(manifest.operation) && record.allowlist.includes(manifest.operation) &&
    record.cost?.hard_cap_usd === 0 && record.cost?.deny_at_exhaustion === true
  ).map(record => ({
    manifest, nativeCapabilityDigest: record.capability_digest,
    nativeQualification: record.qualification, availability: 'declared',
  }));
}

// Callers bind one native fixture explicitly. Native admission decides scope, expiry, grants and replay.
export function createPortableQuoteReader(gateway, capabilityDigest) {
  const matches = discoverPortableQuotes(gateway.discover()).filter(item => item.nativeCapabilityDigest === capabilityDigest);
  if (matches.length !== 1) throw new Error('Expected one declared native fixture');
  const resolver = createResolver([{ manifest, bindings: { direct: {
    revision: manifest.revision, schemaDigest: manifest.schemaDigest, costUsd: 0, offline: true,
    invoke: (request, authorization) => gateway.admit(request, authorization),
  } } }]);
  return (request, authorization) => {
    if (request?.operation !== manifest.operation || request.capability_digest !== capabilityDigest) {
      return Promise.resolve({ ok: false, reason: 'native_binding_mismatch' });
    }
    return resolver.invoke({ ...manifest, route: 'direct', required: ['decimal-text'], acceptedLosses: [] }, request, authorization);
  };
}
