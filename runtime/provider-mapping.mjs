import { boundedJson, hash, id, requireThat, sha, utcMillis } from './core.mjs';

// General reviewed provider-mapping framework. A provider definition is a brand-neutral, independently
// reviewed artifact that pins one outbound transport (origin + protocol) and one mapping, together with
// adapter/schema/mapping digests, operations, allowlist, $0 cost and qualification. The registry admits
// definitions in isolation and binds each gateway capability to its reviewed definition fail-closed before
// any dispatch. No provider endpoint, tool name or credential lives in this reusable contract; those are
// supplied by the reviewed definition and private credential slots, never by a caller-selected request.
export const MCP_PROTOCOLS = ['2025-03-26', '2025-06-18', '2025-11-25'];
// REST-only provider features (for example the earnings calendar) are admitted as reviewed
// transport-specific mappings under the same schema, isolation and $0 pins as MCP. The protocol
// token is the reviewed REST API version, never a caller-selected value.
export const REST_PROTOCOLS = ['1.0'];
const TRANSPORT_PROTOCOLS = { MCP: MCP_PROTOCOLS, REST: REST_PROTOCOLS, WEBSOCKET: ['13'] };
const DEFINITION_KEYS = 'schema,provider,adapter_version,transport,adapter_digest,schema_digest,mapping_digest,mapping,operations,allowlist,mode,source,cost,qualification';
const TRANSPORT_KEYS = 'kind,origin,protocol';
const only = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.split(',').includes(key));
const distinct = values => new Set(values).size === values.length;

// The reviewed transport selects the secure URL scheme. The complete endpoint is pinned.
function validOrigin(origin, kind) {
  if (typeof origin !== 'string' || origin.length > 256 || /\s/.test(origin) || origin.includes('@') ||
    origin.includes('?') || origin.includes('#')) return false;
  let url;
  try { url = new URL(origin); } catch { return false; }
  return url.protocol === (kind === 'WEBSOCKET' ? 'wss:' : 'https:') && url.username === '' && url.password === '' && url.search === '' &&
    url.hash === '' && /^[A-Za-z0-9.-]+$/.test(url.hostname) && url.href === origin;
}

export function validateProviderDefinition(candidate) {
  const c = boundedJson(candidate);
  requireThat(only(c, DEFINITION_KEYS) && c.schema === 'trading-provider-definition/v1' &&
    id(c.provider) && id(c.adapter_version), 'INVALID_PROVIDER_DEFINITION');
  requireThat(only(c.transport, TRANSPORT_KEYS) && Object.hasOwn(TRANSPORT_PROTOCOLS, c.transport.kind) &&
    validOrigin(c.transport.origin, c.transport.kind) && TRANSPORT_PROTOCOLS[c.transport.kind].includes(c.transport.protocol), 'INVALID_TRANSPORT_PIN');
  requireThat(hash(c.adapter_digest) && hash(c.schema_digest) && hash(c.mapping_digest), 'INVALID_PIN');
  requireThat(c.mapping && typeof c.mapping === 'object' && !Array.isArray(c.mapping) &&
    sha(c.mapping) === c.mapping_digest, 'MAPPING_DRIFT');
  requireThat(Array.isArray(c.operations) && c.operations.length > 0 && c.operations.every(id) && distinct(c.operations), 'INVALID_PROVIDER_DEFINITION');
  requireThat(Array.isArray(c.allowlist) && c.allowlist.every(id) && distinct(c.allowlist), 'INVALID_PROVIDER_DEFINITION');
  requireThat(c.mode === 'account' && c.source === 'PROVIDER', 'UNSUPPORTED');
  requireThat(c.cost?.hard_cap_usd === 0 && c.cost?.deny_at_exhaustion === true, 'BUDGET_HALT');
  requireThat(c.qualification && id(c.qualification.status) && hash(c.qualification.receipt_digest) &&
    utcMillis(c.qualification.expires_utc) !== null, 'INVALID_PROVIDER_DEFINITION');
  return Object.freeze({ definition: Object.freeze(c), digest: sha(c) });
}

// Bind one gateway capability record to its reviewed provider definition. Every pin must match exactly;
// any drift refuses with a typed code before dispatch. Operations and allowlist may narrow but never widen
// the reviewed definition, so a capability cannot smuggle an unreviewed operation or tool.
function bindDefinition(entry, capability) {
  const d = entry.definition;
  requireThat(id(capability?.provider) && capability.provider === d.provider, 'PROVIDER_UNKNOWN');
  requireThat(capability.adapter_version === d.adapter_version && capability.adapter_digest === d.adapter_digest, 'ADAPTER_DRIFT');
  requireThat(capability.schema_digest === d.schema_digest, 'SCHEMA_DRIFT');
  requireThat(capability.mapping_digest === d.mapping_digest, 'MAPPING_DRIFT');
  requireThat(capability.transport === d.transport.kind && capability.protocol === d.transport.protocol, 'PROTOCOL_DRIFT');
  requireThat(capability.source === d.source && capability.mode === d.mode, 'UNSUPPORTED');
  requireThat(Array.isArray(capability.operations) && capability.operations.length > 0 &&
    capability.operations.every(operation => d.operations.includes(operation)), 'UNSUPPORTED');
  requireThat(Array.isArray(capability.allowlist) && capability.allowlist.every(tool => d.allowlist.includes(tool)), 'SCOPE_DENIED');
  return Object.freeze({ definition_digest: entry.digest, capability_digest: sha(capability), provider: d.provider,
    adapter_version: d.adapter_version, transport: d.transport, mapping: d.mapping, definition: d });
}

export function createProviderRegistry(definitions) {
  const entries = (Array.isArray(definitions) ? definitions : []).map(validateProviderDefinition);
  const byProvider = new Map();
  const seenAdapter = new Set(), seenSchema = new Set(), seenMapping = new Set(), seenOrigin = new Set();
  for (const entry of entries) {
    const d = entry.definition;
    // A provider binds once per transport kind, so distinct pinned MCP and REST bindings coexist.
    // Every binding carries isolated pins: a second transport or provider must use its own adapter,
    // schema, mapping and origin, never reuse another binding's reviewed artifacts.
    const transports = byProvider.get(d.provider) ?? new Map();
    requireThat(!transports.has(d.transport.kind), 'DUPLICATE_PROVIDER');
    requireThat(!seenAdapter.has(d.adapter_digest) && !seenSchema.has(d.schema_digest) &&
      !seenMapping.has(d.mapping_digest) && !seenOrigin.has(d.transport.origin), 'PROVIDER_ISOLATION');
    transports.set(d.transport.kind, entry);
    byProvider.set(d.provider, transports);
    seenAdapter.add(d.adapter_digest); seenSchema.add(d.schema_digest);
    seenMapping.add(d.mapping_digest); seenOrigin.add(d.transport.origin);
  }
  const bind = capability => {
    const transports = byProvider.get(capability?.provider);
    requireThat(transports, 'PROVIDER_UNKNOWN');
    const entry = transports.get(capability.transport);
    requireThat(entry, 'PROTOCOL_DRIFT');
    return bindDefinition(entry, capability);
  };
  // Discovery exposes reviewed metadata only; it grants no admission, dispatch or credential access.
  const discover = () => entries.map(entry => {
    const d = entry.definition;
    return { definition_digest: entry.digest, provider: d.provider, adapter_version: d.adapter_version,
      adapter_digest: d.adapter_digest, schema_digest: d.schema_digest, mapping_digest: d.mapping_digest,
      transport: { kind: d.transport.kind, protocol: d.transport.protocol }, operations: [...d.operations],
      allowlist: [...d.allowlist], mode: d.mode, source: d.source,
      cost: { hard_cap_usd: d.cost.hard_cap_usd, deny_at_exhaustion: d.cost.deny_at_exhaustion },
      qualification: { status: d.qualification.status, expires_utc: d.qualification.expires_utc } };
  });
  return Object.freeze({ bind, discover, size: entries.length });
}
