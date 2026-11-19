import { readFile, stat } from 'node:fs/promises';
import { archive, MAX_ARCHIVE, readRehearsal, restore } from '../src/replay.mjs';

const fixture = await readRehearsal(await readFile(new URL('../src/rehearsal.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
if (!args.length) {
  for (const { id } of fixture.runs) {
    const { snapshot, sha256, verifiedBoundaries } = await archive(fixture,id);
    console.log(JSON.stringify({ run:id, profile:snapshot.profile, verifiedBoundaries, events:snapshot.receipts.length,
      equityMicros:snapshot.equity, rankedMicros:snapshot.ranked, sha256 }));
  }
} else if (args.length === 2 && args[0] === '--export') {
  console.log(JSON.stringify(await archive(fixture,args[1])));
} else if (args.length === 2 && args[0] === '--restore') {
  if ((await stat(args[1])).size > MAX_ARCHIVE) throw Error('Archive exceeds limit');
  const pack = await restore(fixture,await readFile(args[1],'utf8'));
  console.log('Restored run ' + pack.snapshot.run + ' · ' + pack.sha256);
} else {
  throw Error('Usage: npm run rehearsal [-- --export A|B | --restore FILE]');
}
