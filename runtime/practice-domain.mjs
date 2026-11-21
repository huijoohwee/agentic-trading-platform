import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { requireThat, sha } from './core.mjs';
import { createPaperGuard } from './paper-guard.mjs';
import { createGateway } from './gateway.mjs';
import { marketRead, marketOperations } from '../src/market-reads.mjs';
import { history, SOURCE } from '../src/market.mjs';
import { portfolio, journalCsv } from '../src/practice-account.mjs';
import { assessPrediction } from '../src/predictions.mjs';

import { deskActions, actionFor, validate } from '../src/desk-actions.mjs';
import { deskRead } from './desk-reads.mjs';
import { observerLink, activityScope, recordActivity } from './observer.mjs';
const writes = ['select', 'settings', 'order', 'tick', 'cancel', 'funds', 'reset', 'prediction'];
const operations = [
  ...new Set([
    ...marketOperations,
    ...deskActions.map((a) => a.operation),
    'desk.tab',
    'desk.markers',
    'desk.activity',
    ...['session', 'portfolio', 'journal', 'predictions', 'experiment', ...writes].map((v) => 'practice.' + v)
  ])
];
const files = [
  './practice-domain.mjs',
  './desk-reads.mjs',
  './market-library.mjs',
  './practice-prices.mjs',
  './public-feed.mjs',
  './observer.mjs',
  './research-service.mjs',
  './research-artifact.mjs',
  './research-engine.mjs',
  './research-events.mjs',
  './research-portfolio.mjs',
  './research-data.mjs',
  './research-signals.mjs',
  './research-statistics.mjs',
  '../src/desk-actions.mjs',
  '../src/research-catalog.mjs',
  './practice-replay.mjs',
  './paper-guard.mjs',
  '../src/practice-account.mjs',
  '../src/contracts.mjs',
  '../src/practice-defaults.mjs',
  '../src/indicators.mjs',
  '../src/market.mjs',
  '../src/market-reads.mjs',
  '../src/predictions.mjs',
  '../src/experiment.mjs',
  '../src/strategy-example.mjs',
  '../src/strategy-language.mjs',
  '../src/scientific-packages.mjs',
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
export function practiceDomain({
  scope,
  store,
  token,
  now,
  archive,
  researchService,
  observerOrigin,
  actor = 'agent'
}) {
  const guard = createPaperGuard({ mode: 'synthetic-replay', scope, store, now, market: archive?.market });
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
    const action = actionFor(operation);
    if (action) validate(inputs, action.inputSchema);
    const context = { s: current.session, archive, at, store, scope };
    if (
      ['practice.select', 'practice.settings'].includes(operation) &&
      (inputs.venue ?? current.session.venue ?? 'synthetic') !== 'synthetic'
    ) {
      const target = { ...current.session, ...inputs };
      requireThat(
        archive?.catalog.some(
          (m) => m.venue === target.venue && m.marketType === target.marketType && m.symbol === target.symbol
        ),
        'ARCHIVE_REQUIRED'
      );
      archive.read({ ...target, count: 1 });
    }
    if (writes.includes(verb) && operation.startsWith('practice.')) {
      requireThat(!Object.hasOwn(inputs, 'kind'), 'UNSUPPORTED');
      const { revision, ...args } = inputs;
      current = guard.apply({ ...args, kind: verb }, revision, request_id);
      data = current;
    } else if (operation === 'desk.observer')
      data = {
        ...observerLink({ store, scope, token, now }),
        ...(observerOrigin ? { origin: observerOrigin } : {})
      };
    else if (operation === 'desk.markers') {
      const s = current.session;
      requireThat(
        inputs.symbol === s.symbol &&
          inputs.frame === s.frame &&
          inputs.venue === (s.venue ?? 'synthetic') &&
          inputs.marketType === s.marketType,
        'CHART_BINDING'
      );
      requireThat(Array.isArray(inputs.markers) && inputs.markers.length <= 1000, 'INVALID_MARKERS');
      const markers = inputs.markers.map((m) => {
        requireThat(
          ['buy', 'sell', 'short', 'cover', 'entry', 'exit', 'stop', 'target'].includes(m.action) &&
            Number.isSafeInteger(m.time) &&
            Number.isFinite(m.price) &&
            m.price > 0,
          'INVALID_MARKERS'
        );
        return { action: m.action, time: m.time, price: m.price, label: m.action };
      });
      data = store.transaction(
        activityScope(scope),
        (s) =>
          (s.configs.overlay = {
            symbol: inputs.symbol,
            frame: inputs.frame,
            venue: inputs.venue,
            marketType: inputs.marketType,
            markers
          })
      );
    } else if (operation === 'desk.studies') {
      current = guard.apply({ kind: 'studies', studies: inputs.studies }, inputs.revision, request_id);
      data = current;
    } else if (operation === 'desk.tab') {
      requireThat(
        Object.keys(inputs).join() === 'tab' &&
          ['market', 'portfolio', 'research', 'predictions'].includes(inputs.tab),
        'INVALID_INPUT'
      );
      data = store.transaction(activityScope(scope), (s) => ({ tab: (s.configs.tab = inputs.tab) }));
    } else if (operation.startsWith('research.'))
      data = researchService.invoke(scope, operation, inputs, request_id, current.session);
    else if (
      [
        'desk.describe',
        'desk.chart',
        'desk.history',
        'desk.activity',
        'read.catalog',
        'read.depth',
        'read.tape',
        'read.ticker'
      ].includes(operation)
    )
      data = deskRead(operation, inputs, context);
    else if (operation === 'read.candles' && (inputs.venue ?? current.session.venue) !== 'synthetic') {
      const r = deskRead('desk.chart', inputs, context);
      data = { ...r, rows: r.forming ? [...r.bars, r.forming] : r.bars };
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
          const chart = deskRead('desk.chart', { ...inputs, count: 300 }, context);
          data = await research(inputs.code ?? current.session.code, chart.bars);
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
    practice: {
      capability_digest,
      async invoke(body) {
        const start = now();
        let status = 'REFUSED',
          runId;
        try {
          const result = await invoke(body);
          status = 'OK';
          runId = result.data?.id;
          return result;
        } finally {
          if (
            ![
              'practice.session',
              'desk.activity',
              'desk.chart',
              'research.get',
              'desk.describe',
              'practice.tick'
            ].includes(body.operation)
          )
            recordActivity(store, scope, {
              operation: body.operation,
              status,
              actor,
              at: now(),
              elapsed: now() - start,
              runId,
              delivery: sha([body.operation, body.request_id, body.inputs, status])
            });
        }
      }
    }
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
