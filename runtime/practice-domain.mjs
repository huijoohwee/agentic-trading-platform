import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { requireThat, sha } from './core.mjs';
import { createPaperGuard } from './paper-guard.mjs';
import { createGateway } from './gateway.mjs';
import { marketRead, marketOperations } from '../src/market-reads.mjs';
import { history, SOURCE } from '../src/market.mjs';
import { portfolio, journalCsv } from '../src/practice-account.mjs';
import { assessPrediction } from '../src/predictions.mjs';

const writes = ['select', 'settings', 'order', 'tick', 'cancel', 'funds', 'reset', 'prediction'];
const operations = [
  ...marketOperations,
  ...['session', 'portfolio', 'journal', 'predictions', 'experiment', ...writes].map((v) => 'practice.' + v)
];
const files = [
  './practice-domain.mjs',
  './practice-replay.mjs',
  './paper-guard.mjs',
  '../src/practice-account.mjs',
  '../src/practice-defaults.mjs',
  '../src/indicators.mjs',
  '../src/market.mjs',
  '../src/market-reads.mjs',
  '../src/predictions.mjs',
  '../src/experiment.mjs',
  '../src/strategy-example.mjs',
  '../src/strategy-language.mjs',
  './strategy-worker.mjs'
];
const candidate = sha(files.map((f) => [f, sha(readFileSync(new URL(f, import.meta.url)))]));
let workerCount = 0;
function research(code, bars) {
  requireThat(workerCount < 2 && typeof code === 'string' && code.length <= 8192, 'BUDGET_HALT');
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./strategy-worker.mjs', import.meta.url), {
      workerData: { code, bars },
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 32 }
    });
    workerCount++;
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(Error('TIMEOUT'));
    }, 5000);
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (status) => {
      clearTimeout(timer);
      workerCount--;
      if (status) reject(Error('WORKER_STOPPED'));
    });
  });
}
export function practiceDomain({ scope, store, token, now }) {
  const guard = createPaperGuard({ mode: 'synthetic-replay', scope, store, now });
  const expires = new Date(Math.floor(now() / 86400000) * 86400000 + 86400000).toISOString().replace('.000Z', 'Z');
  const capability = {
    provider: 'local-practice',
    adapter_version: '1',
    adapter_digest: candidate,
    transport: 'LOCAL',
    mode: 'account',
    source: 'MOCK',
    schema_digest: sha(operations),
    mapping_digest: sha(SOURCE),
    operations,
    allowlist: [],
    rights: 'local synthetic session',
    cost: { hard_cap_usd: 0, deny_at_exhaustion: true },
    qualification: { status: 'QUALIFIED', expires_utc: expires, receipt_digest: candidate }
  };
  const capability_digest = sha(capability);
  // Only this source-bound fixture owns the dedicated practice scope. All mutations use
  // the guard transaction and its expected revision, including HTTP and MCP redeliveries.
  async function invoke(body) {
    const { operation, inputs, request_id } = body,
      at = now();
    let current = guard.read(),
      data;
    const verb = operation.slice('practice.'.length);
    if (writes.includes(verb) && operation.startsWith('practice.')) {
      requireThat(!Object.hasOwn(inputs, 'kind'), 'UNSUPPORTED');
      const { revision, ...args } = inputs;
      current = guard.apply({ ...args, kind: verb }, revision, request_id);
      data = current;
    } else if (marketOperations.includes(operation)) data = marketRead(operation, inputs, at);
    else
      switch (operation) {
        case 'practice.session':
          data = current;
          break;
        case 'practice.portfolio':
          data = portfolio(current.session, at);
          break;
        case 'practice.journal':
          data = { csv: journalCsv(current.session.fills), source: SOURCE };
          break;
        case 'practice.predictions':
          data = current.session.predictions.map((p) => ({ ...p, ...assessPrediction(p, at) }));
          break;
        case 'practice.experiment':
          data = await research(
            inputs.code ?? current.session.code,
            history(inputs.symbol ?? current.session.symbol, inputs.frame ?? current.session.frame, at, 300).slice(
              0,
              -1
            )
          );
          break;
        default:
          throw Error('UNSUPPORTED');
      }
    return { data, revision: current.receiptRevision ?? current.revision };
  }
  const gateway = createGateway({
    store,
    scope,
    candidate,
    capabilities: [capability],
    audienceToken: token,
    now,
    practice: { capability_digest, invoke }
  });
  function request(operation, inputs, id) {
    return {
      contract_version: '1',
      request_id: id,
      operation,
      inputs,
      scope,
      capability_digest,
      deadline_utc: new Date(now() + 60000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    };
  }
  return { gateway, request };
}
