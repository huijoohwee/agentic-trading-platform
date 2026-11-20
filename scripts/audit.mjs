import { readFile } from 'node:fs/promises';
import { boundedText } from './local-file.mjs';
import { rehearseImport } from '../src/landing.mjs';
import { auditSnapshot, restoreAudit } from '../src/local-audit.mjs';

const jsonFile = async path => JSON.parse(await boundedText(path, 499_999));
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--mock') {
  const fixture = JSON.parse(await readFile(new URL('../src/audit-fixture.json', import.meta.url)));
  const capabilities = Object.keys(fixture).filter(key => key.startsWith('IN_'));
  const report = await rehearseImport(fixture, { capabilities, read: ({ sheet }) => ({ rows:fixture[sheet], next:null }) },
    { callHeadroom:12, hardCapUsd:0, now:Date.now });
  if (!report.ok) throw Error(report.reason);
  const audit = await auditSnapshot(report.input);
  console.log(JSON.stringify({ manifest:report.manifest, cost:report.cost, witness:audit.witness }, null, 2));
} else if (args[0] === '--restore' && args.length === 3) {
  const restored = await restoreAudit(await jsonFile(args[1]), await jsonFile(args[2]));
  console.log(JSON.stringify({ restored: true, witness: restored.witness }));
} else if ((!args.length || ['--export', '--witness','--input'].includes(args[0])) && args.length <= 2 &&
    !(args[0] === '--input' && args.length !== 2)) {
  const input = args[1] ? await jsonFile(args[1]) : JSON.parse(await readFile(new URL('../src/audit-fixture.json', import.meta.url)));
  const audit = await auditSnapshot(input);
  const result = args[0] === '--export' ? { input, audit } : args[0] === '--witness' ? audit.witness : audit;
  const json = JSON.stringify(result, null, 2);
  if (Buffer.byteLength(json) > 500_000) throw Error('Audit output exceeds the portable file budget');
  console.log(json);
} else throw Error('Usage: npm run audit:local -- [--input FILE | --export [FILE] | --witness [FILE] | --restore ARCHIVE WITNESS]');
