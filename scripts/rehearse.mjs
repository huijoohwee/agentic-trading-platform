import { readFile } from 'node:fs/promises';
import { boundedText } from './local-file.mjs';

const args = process.argv.slice(2);
if (args.length <= 2 && args[0] === '--bindings') {
  const { inspectBindings } = await import('../src/forward-bindings.mjs');
  const file = args[1] ?? new URL('../src/binding-fixture.json', import.meta.url);
  const result = inspectBindings(JSON.parse(await boundedText(file, 32_000)));
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} else if (args.length === 1 && args[0] === '--schedule') {
  const { rehearseForward } = await import('../src/forward-rehearsal.mjs');
  console.log(JSON.stringify(rehearseForward(), null, 2));
} else {
  if (args.length && !(args.length === 2 && ['--export','--restore'].includes(args[0]))) {
    throw Error('Usage: npm run rehearsal [-- --bindings [FILE] | --schedule | --export A|B | --restore FILE]');
  }
  const { archive, MAX_ARCHIVE, readRehearsal, restore } = await import('../src/replay.mjs');
  const fixture = await readRehearsal(await readFile(new URL('../src/rehearsal.json', import.meta.url), 'utf8'));
  if (args[0] === '--export') console.log(JSON.stringify(await archive(fixture, args[1])));
  else if (args[0] === '--restore') {
    const pack = await restore(fixture, await boundedText(args[1], MAX_ARCHIVE));
    console.log('Restored run ' + pack.snapshot.run + ' · ' + pack.sha256);
  } else {
    for (const { id } of fixture.runs) {
      const { snapshot, sha256, verifiedBoundaries } = await archive(fixture, id);
      console.log(JSON.stringify({ run:id, profile:snapshot.profile, verifiedBoundaries, events:snapshot.receipts.length,
        equityMicros:snapshot.equity, rankedMicros:snapshot.ranked, sha256 }));
    }
  }
}
