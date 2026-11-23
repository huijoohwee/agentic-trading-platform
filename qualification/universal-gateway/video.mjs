import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from './video.json' with { type: 'json' };
import { pinnedOwner } from './pinned-owner.mjs';

const root = process.argv[2], pin = pinnedOwner(root, manifest);
const require = createRequire(resolve(root, 'package.json'));
const { chromium } = require('playwright');
const core = fileURLToPath(new URL('./resolver.mjs', import.meta.url));
const { outputFiles } = await require('esbuild').build({
  absWorkingDir: resolve(root, 'canvas'), stdin: { resolveDir: resolve(root, 'canvas'), contents:
    'export {createResolver} from ' + JSON.stringify(core) +
    ';export {canvas2dAdapter} from "./src/features/html-video-renderer/engines/canvas2dAdapter.ts"' },
  logOverride: { 'empty-import-meta': 'silent' }, bundle: true, format: 'iife', globalName: 'pilot', minify: true, write: false, tsconfig: 'tsconfig.json',
  loader: { '.css': 'empty', '.md': 'text', '.svg': 'text' },
});
assert.ok(outputFiles[0].contents.length < 500000);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ offline: true, serviceWorkers: 'block' });
  let requests = 0;
  page.on('request', r => { if (/^https?:/.test(r.url())) requests++; });
  await page.addScriptTag({ content: outputFiles[0].text });
  const result = await page.evaluate(async ({ manifest, pin }) => {
    let calls = 0;
    const entry = { manifest, bindings: { browser: { ...pin, invoke(spec) { calls++; return pilot.canvas2dAdapter.render(spec); } } } };
    const resolver = pilot.createResolver([entry]);
    const plan = { ...manifest, route: 'browser', required: ['seek'], acceptedLosses: ['editability'] };
    const input = { html: '<div id="scene" style="background:red;width:64px;height:64px"></div>' +
      '<script>window.__hyperframesSeek=s=>scene.style.background=s>=0.5?"blue":"red"</script>', width: 64, height: 64, fps: 2, durationMs: 1000 };
    const reasons = [];
    for (const patch of [{route:'mcp'}, {schemaDigest:'0'.repeat(64)}, {required:['layers']}, {acceptedLosses:[]}]) {
      reasons.push((await resolver.invoke({...plan,...patch},input)).reason);
    }
    reasons.push((await pilot.createResolver([entry,entry]).invoke(plan,input)).reason);
    const unknown = { manifest, bindings: {browser:{...entry.bindings.browser,costUsd:null}} };
    reasons.push((await pilot.createResolver([unknown]).invoke(plan,input)).reason);
    const refusedCalls = calls;
    const result = await resolver.invoke(plan,input);
    const video = document.createElement('video');
    const ready = new Promise((yes,no) => { video.onloadeddata=yes; video.onerror=no; });
    video.src=URL.createObjectURL(result.native.blob);
    try {
      await ready;
      const pixels=document.createElement('canvas').getContext('2d'), samples=[];
      for(const seconds of [0.1,0.58]) {
        const done=new Promise(yes=>{video.onseeked=yes}); video.currentTime=seconds; await done;
        pixels.drawImage(video,0,0); samples.push([...pixels.getImageData(32,32,1,1).data].slice(0,3));
      }
      let nativeFailure;
      try {
        await resolver.invoke(plan, { ...input, html:'<div></div><script>window.__agenticGraphVideoProtocol={version:2}</script>' });
      } catch (error) { nativeFailure = error.code; }
      return { reasons, refusedCalls, calls, samples, nativeFailure, losses:result.losses, routes:resolver.discover()[0].configuredRoutes };
    } finally { URL.revokeObjectURL(video.src); }
  }, {manifest,pin});
  assert.deepEqual(result.reasons,['not_configured','stale_pin','missing_feature','unapproved_loss','ambiguous_owner','cost_or_locality_unknown']);
  assert.deepEqual(result.routes,['browser']); assert.deepEqual(result.losses,['editability']);
  assert.equal(result.refusedCalls,0); assert.equal(result.calls,2); assert.equal(result.nativeFailure,'protocol_version_unsupported'); assert.equal(requests,0);
  const [r,b]=result.samples;
  assert.ok(r[0]-Math.max(r[1],r[2])>=150 && b[2]-Math.max(b[0],b[1])>=150, JSON.stringify(result));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
