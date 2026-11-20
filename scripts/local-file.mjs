import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export async function boundedText(path, maxBytes) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw Error('Input must be a regular file within ' + maxBytes + ' bytes');
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw Error('Input changed while reading');
    return new TextDecoder('utf-8', { fatal:true }).decode(bytes.subarray(0, offset));
  } finally { await file.close(); }
}
