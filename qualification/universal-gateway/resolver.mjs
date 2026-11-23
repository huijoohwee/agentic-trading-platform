// Local conformance host. The injected routes keep the native grant, result and receipt.
const id = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;
const revision = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const lists = ['routes', 'features', 'losses'];
const refused = reason => ({ ok: false, reason });

export function validateManifest(m) {
  if (!m || m.major !== 1 || !id.test(m.id) || !revision.test(m.revision) || !digest.test(m.schemaDigest)) {
    throw new TypeError('Invalid capability identity, version or pin');
  }
  for (const key of ['owner', 'operation', 'input', 'output', 'fidelity', 'mode']) {
    if (typeof m[key] !== 'string' || !m[key].trim()) throw new TypeError('Invalid manifest field ' + key);
  }
  for (const key of lists) {
    if (!Array.isArray(m[key]) || !m[key].every(x => typeof x === 'string' && x.length > 0)
      || new Set(m[key]).size !== m[key].length) throw new TypeError('Invalid manifest list ' + key);
  }
  if (!m.routes.length || m.locality !== 'device') throw new TypeError('Expected a local qualification route');
  return Object.freeze({ ...m, ...Object.fromEntries(lists.map(k => [k, Object.freeze([...m[k]])])) });
}

export function createResolver(entries) {
  const catalog = entries.map(({ manifest, bindings }) => ({ m: validateManifest(manifest), bindings }));
  const configured = binding => typeof binding?.invoke === 'function';
  function resolve(request) {
    const matches = catalog.filter(({ m }) => m.id === request.id && m.major === request.major);
    if (matches.length !== 1) return refused(matches.length ? 'ambiguous_owner' : 'unknown_capability');
    const { m, bindings } = matches[0];
    if (request.owner !== m.owner || request.revision !== m.revision || request.schemaDigest !== m.schemaDigest) return refused('stale_pin');
    if (!m.routes.includes(request.route)) return refused('unsupported_route');
    const binding = bindings[request.route];
    if (!configured(binding)) return refused('not_configured');
    if (binding.revision !== m.revision || binding.schemaDigest !== m.schemaDigest) return refused('stale_pin');
    if (binding.costUsd !== 0 || binding.offline !== true) return refused('cost_or_locality_unknown');
    if (!Array.isArray(request.required) || !request.required.every(f => m.features.includes(f))) return refused('missing_feature');
    if (!Array.isArray(request.acceptedLosses) || !m.losses.every(f => request.acceptedLosses.includes(f))) return refused('unapproved_loss');
    return { ok: true, m, binding };
  }
  return {
    discover() {
      return catalog.map(({ m, bindings }) => ({ manifest: m, configuredRoutes: m.routes.filter(r => configured(bindings[r])) }));
    },
    async invoke(request, nativeRequest, grant) {
      const decision = resolve(request);
      if (!decision.ok) return decision;
      const native = await decision.binding.invoke(nativeRequest, grant);
      return { ok: true, capability: decision.m.id, revision: decision.m.revision, losses: decision.m.losses, native };
    },
  };
}
