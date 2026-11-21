import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { publicFeed } from '../runtime/public-feed.mjs';
const [directory, file, venue, symbol, marketType] = process.argv.slice(2);
if (!directory || !file) throw Error('Expected practice directory and snapshot file');
const feed = publicFeed(resolve(directory));
try {
  if (file === '--admission') console.log(JSON.stringify(feed.admission({ venue, symbol, marketType })));
  else {
    if (file !== '-' && statSync(file).size >= 500000) throw Error('FEED_BUDGET');
    let bytes;
    if (file === '-') {
      const chunks = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size >= 500000) throw Error('FEED_BUDGET');
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
    } else bytes = readFileSync(file);
    console.log(JSON.stringify(feed.publish(bytes)));
  }
} finally {
  feed.close();
}
