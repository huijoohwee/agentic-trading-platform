import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { boundedText } from './local-file.mjs';

const execute = promisify(execFile);
const usage = 'Usage: quote:moomoo discover | replay SYMBOL FILE | snapshot SYMBOL --entitled-zero-cost --port=PORT';

export async function moomooQuote(args) {
  const [command, symbol, input, option] = args;
  if (command === 'discover' && args.length === 1) {
    const { discoverProviderProfiles } = await import('agentic-gateway/provider-profiles');
    return discoverProviderProfiles(['snapshot-replay', 'opend-reader']);
  }
  if (command === 'replay' && args.length === 3) {
    const { replayMoomooSnapshot } = await import('agentic-gateway/connectors/moomoo');
    return replayMoomooSnapshot(symbol, JSON.parse(await boundedText(input, 128000)));
  }
  if (command !== 'snapshot' || args.length !== 4 || input !== '--entitled-zero-cost' ||
      !/^--port=[0-9]{1,5}$/.test(option)) throw Error(usage);
  const port = Number(option.slice(7));
  if (port < 1 || port > 65535) throw Error('INVALID_PORT');
  const bridge = fileURLToPath(import.meta.resolve('agentic-gateway/connectors/moomoo-opend.py'));
  const client = {
    async GetSecuritySnapshot() {
      try {
        const { stdout } = await execute(process.env.MOOMOO_PYTHON || 'python3', [bridge, String(port), symbol, '--entitled-zero-cost'], {
          timeout: 25000, killSignal: 'SIGKILL', maxBuffer: 128000,
          env: { ...process.env, PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION: 'python' },
        });
        return JSON.parse(stdout);
      } catch (error) {
        if (error.killed) throw Error('OPEND_TIMEOUT');
        if (/UNQUALIFIED_SDK_VERSION|PackageNotFoundError|ModuleNotFoundError/.test(error.stderr || '')) throw Error('MOOMOO_SDK_REQUIRED');
        throw Error('OPEND_TRANSPORT_FAILED');
      }
    },
  };
  const { bindMoomooSnapshot } = await import('agentic-gateway/connectors/moomoo');
  return bindMoomooSnapshot(client, {
    symbol, entitled:true, costUsd:0, maxCalls:1, expiresAt:Date.now() + 25000,
  })();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  moomooQuote(process.argv.slice(2)).then(quote => console.log(JSON.stringify(quote))).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
