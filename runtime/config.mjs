import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { boundedJson, hash, requireThat, scopeKey } from './core.mjs';
import { openStore } from './store.mjs';

export function readPrivateJson(path) {
  requireThat(typeof path === 'string' && isAbsolute(path) && !path.split('/').includes('..'), 'PRIVATE_PATH_REQUIRED');
  const parent = lstatSync(dirname(path));
  requireThat(parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o077) === 0 && parent.uid === process.getuid(), 'PRIVATE_DIRECTORY_REQUIRED');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const file = fstatSync(fd);
    requireThat(file.isFile() && (file.mode & 0o077) === 0 && file.uid === process.getuid() && file.size <= 480_000, 'PRIVATE_FILE_REQUIRED');
    return boundedJson(JSON.parse(readFileSync(fd, 'utf8')));
  } finally { closeSync(fd); }
}

export function openConfiguredRuntime(path) {
  const config = readPrivateJson(path);
  requireThat(config?.schema === 'trading-runtime-config/v1' && hash(config.candidate) &&
    typeof config.database === 'string' && /^[A-Za-z0-9_-]+\.sqlite$/.test(config.database) &&
    config.keys && typeof config.keys === 'object' && !Array.isArray(config.keys), 'INVALID_RUNTIME_CONFIG');
  scopeKey(config.scope);
  const store = openStore(join(dirname(path), config.database));
  return { config, store };
}
