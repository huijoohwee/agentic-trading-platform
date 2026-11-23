import test from 'node:test';
import assert from 'node:assert/strict';
import descriptor from '../runtime/quote-capability.json' with { type: 'json' };
import { createPortableQuoteReader, discoverPortableQuotes } from '../runtime/portable-quote.mjs';

test('portable quote discovery grants no dispatch and a bound read preserves native admission', async () => {
  const pin = descriptor.qualifiedBinding;
  const record = { adapter_digest:pin.adapterDigest, schema_digest:pin.schemaDigest, mapping_digest:pin.mappingDigest, source:'MOCK',rights:'MOCK',operations:['read.fixture','release'],allowlist:['read.fixture'],
    capability_digest:'fixture',cost:{hard_cap_usd:0,deny_at_exhaustion:true},qualification:{status:'QUALIFIED'} };
  const entries = discoverPortableQuotes([record,{...record,source:'PROVIDER'},{...record,schema_digest:'other'}]);
  assert.equal(entries.length,1);
  const [entry] = entries;
  assert.equal(entry.manifest.id,'trading/quote-read');
  assert.equal(entry.availability,'declared');
  let calls=0;
  const outcome={status:'REFUSED',error:{code:'STALE'}};
  const read=createPortableQuoteReader({discover:()=>[record], async admit(req, auth) {
    calls++;assert.equal(req.capability_digest,'fixture');assert.equal(auth,'native grant');return outcome;
  }},'fixture');
  assert.equal((await read({operation:'release',capability_digest:'fixture'})).reason,'native_binding_mismatch');
  assert.equal((await read({operation:'read.fixture',capability_digest:'another'})).reason,'native_binding_mismatch');
  assert.equal(calls,0);
  assert.equal((await read({operation:'read.fixture',capability_digest:'fixture'},'native grant')).native,outcome);
  assert.equal(calls,1);
});
