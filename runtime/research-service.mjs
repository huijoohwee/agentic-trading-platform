import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { sha, requireThat as need } from './core.mjs';
import { dateRange } from './research-data.mjs';
import { hypotheses } from '../src/research-catalog.mjs';
import { compileStrategy } from '../src/strategy-language.mjs';
import { packageInventory } from '../src/scientific-packages.mjs';
import { readArtifact, verifiedBytes } from './research-artifact.mjs';
import { activityScope } from './observer.mjs';
const day = 86400000,
  leaseMs = 180000;
export function researchService({ store, directory, now }) {
  const active = new Map();
  let closed = false,
    timer;
  const jobScope = (owner) => ({ ...owner, account_alias: 'research/' + sha(owner.account_alias) });
  const artifactDir = (scope) => join(directory, 'research', sha(scope.account_alias));
  function view(scope, id) {
    const run = store.read(scope).configs.runs?.[id];
    need(run, 'UNKNOWN_RUN');
    return run;
  }
  function trace(run, status) {
    run.status = status;
    run.trace.push({ at: now(), status });
  }
  function complete(scope, id, lease, output) {
    store.transaction(scope, (s) => {
      const run = s.configs.runs[id];
      if (run?.lease !== lease || run.status !== 'running') return;
      if (output?.result) {
        Object.assign(run, output.result);
        trace(run, output.result.status);
      } else {
        run.error = output?.error ?? 'WORKER_STOPPED';
        trace(run, 'failed');
      }
      delete run.lease;
      delete run.leaseUntil;
    });
  }
  function pump() {
    clearTimeout(timer);
    if (closed) return;
    for (const scope of store.listScopes('research/')) {
      const jobs = Object.values(store.read(scope).configs.runs ?? {});
      for (const job of jobs) {
        if (active.size >= 2) break;
        if (job.status !== 'queued' && (job.status !== 'running' || job.leaseUntil > now())) continue;
        const lease = randomUUID(),
          id = job.id;
        const admitted = store.transaction(scope, (s) => {
          const r = s.configs.runs[id];
          if (r.status !== 'queued' && (r.status !== 'running' || r.leaseUntil > now())) return false;
          trace(r, 'running');
          r.lease = lease;
          r.leaseUntil = now() + leaseMs;
          return true;
        });
        if (!admitted) continue;
        let worker, timeout;
        const finish = (output) => {
          if (active.get(id)?.lease !== lease) return;
          active.delete(id);
          clearTimeout(timeout);
          complete(scope, id, lease, output);
          schedule();
        };
        try {
          worker = new Worker(new URL('./research-worker.mjs', import.meta.url), {
            execArgv: [],
            resourceLimits: { maxOldGenerationSizeMb: 384 },
            workerData: { directory, artifactDir: artifactDir(scope), id, input: job.input, range: job.range }
          });
          active.set(id, { worker, lease, scope });
          worker.once('message', finish);
          worker.once('error', () => finish({ error: 'WORKER_FAILED' }));
          worker.once('exit', () => finish({ error: 'WORKER_STOPPED' }));
          timeout = setTimeout(() => {
            finish({ error: 'RESEARCH_TIMEOUT' });
            void worker.terminate();
          }, 120000);
          active.get(id).timeout = timeout;
          timeout.unref();
        } catch {
          complete(scope, id, lease, { error: 'WORKER_START_FAILED' });
        }
      }
    }
    timer = setTimeout(pump, 10000);
    timer.unref();
  }
  function schedule() {
    clearTimeout(timer);
    if (!closed) {
      timer = setTimeout(pump, 10);
      timer.unref();
    }
  }
  schedule();
  function invoke(owner, op, inputs, requestId, session) {
    const scope = jobScope(owner),
      current = store.read(scope).configs;
    if (op === 'research.strategies')
      return {
        catalog: hypotheses,
        packages: packageInventory,
        saved: Object.values(current.strategies ?? {}),
        runs: Object.values(current.runs ?? {})
          .slice(-30)
          .reverse()
          .map(({ id, status, created }) => ({ id, status, created }))
      };
    if (op === 'research.get') {
      const run = view(scope, inputs.id);
      if (run.receipt) readArtifact(artifactDir(scope), run.receipt);
      const { lease, leaseUntil, ...publicRun } = run;
      return publicRun;
    }
    const binding = sha([op, inputs]),
      prior = current.requests?.[requestId];
    if (prior) {
      need(prior.binding === binding, 'CONFLICT');
      return prior.out;
    }
    if (op === 'research.save') {
      need(inputs.name.trim() === inputs.name && inputs.name.length > 0, 'INVALID_NAME');
      compileStrategy(inputs.code);
    }
    if (inputs.basket)
      need(
        (op === 'research.suite' ||
          (op === 'research.start' && inputs.hypothesis === 19 && inputs.basket[0] === inputs.symbol)) &&
          inputs.basket.every(
            (s) => /^[A-Z0-9]+\.[A-Z0-9]+$/.test(s) && s.split('.')[1] === inputs.basket[0].split('.')[1]
          ),
        'INVALID_BASKET'
      );
    const range = ['research.start', 'research.suite'].includes(op) ? dateRange(inputs, now()) : null;
    let overlay;
    if (op === 'research.overlay') {
      const run = view(scope, inputs.id);
      need(run.receipt, 'RUN_NOT_READY');
      const stored = readArtifact(artifactDir(scope), run.receipt).rows.find((r) => r.id === inputs.hypothesis);
      need(stored && stored.status !== 'blocked', 'NO_SIGNALS');
      need(
        stored.market.symbol === session.symbol &&
          stored.market.venue === (session.venue ?? 'synthetic') &&
          stored.market.frame === session.frame &&
          stored.market.marketType === session.marketType,
        'CHART_BINDING'
      );
      overlay = {
        ...stored.market,
        markers: stored.signals.slice(-1000),
        id: inputs.id,
        hypothesis: inputs.hypothesis
      };
    }
    const out = store.transaction(scope, (s) => {
      const c = s.configs;
      c.requests ??= {};
      c.runs ??= {};
      c.strategies ??= {};
      const existing = c.requests[requestId];
      if (existing) {
        need(existing.binding === binding, 'CONFLICT');
        return existing.out;
      }
      need(Object.keys(c.requests).length < 10000, 'RECEIPT_CAPACITY');
      let result;
      if (op === 'research.save') {
        const hash = sha(inputs.code),
          key = sha([inputs.name, hash]);
        need(c.strategies[key] || Object.keys(c.strategies).length < 100, 'STRATEGY_LIMIT');
        result = c.strategies[key] ??= {
          ...inputs,
          hash,
          created: now(),
          language: 'Python (bounded offline subset)'
        };
      } else if (range) {
        need(Object.values(c.runs).filter((r) => r.created > now() - day).length < 30, 'RESEARCH_QUOTA');
        const id = randomUUID(),
          created = now(),
          input = { ...inputs, capital: inputs.capital ?? 100000, venue: inputs.venue ?? 'uniswap-v3-500' };
        delete input.start;
        delete input.end;
        c.runs[id] = { id, created, input, range, status: 'queued', trace: [{ at: created, status: 'queued' }] };
        result = { id, status: 'queued', range };
      } else if (op === 'research.cancel') {
        const r = c.runs[inputs.id];
        need(r, 'UNKNOWN_RUN');
        need(['queued', 'running', 'cancelled'].includes(r.status), 'RUN_FINISHED');
        if (r.status !== 'cancelled') trace(r, 'cancelled');
        delete r.lease;
        delete r.leaseUntil;
        result = { id: r.id, status: r.status };
      } else if (overlay) result = overlay;
      else throw Error('UNSUPPORTED');
      c.requests[requestId] = { binding, out: result };
      return result;
    });
    if (op === 'research.cancel') {
      const entry = active.get(inputs.id);
      if (entry) {
        active.delete(inputs.id);
        clearTimeout(entry.timeout);
        void entry.worker.terminate();
      }
    }
    if (overlay)
      store.transaction(activityScope(owner), (s) => {
        s.configs.overlay = overlay;
      });
    if (range || op === 'research.cancel')
      store.transaction(activityScope(owner), (s) => {
        s.configs.research = { id: out.id, status: out.status };
      });
    schedule();
    return out;
  }
  return {
    invoke,
    download(owner, id) {
      const scope = jobScope(owner),
        r = view(scope, id);
      need(r.receipt, 'RUN_NOT_READY');
      return {
        filename: r.receipt.scientificHash + '.json.gz',
        bytes: verifiedBytes(artifactDir(scope), r.receipt)
      };
    },
    runStatus(owner, id) {
      return view(jobScope(owner), id).status;
    },
    close() {
      closed = true;
      clearTimeout(timer);
      for (const [id, { worker, lease, scope, timeout }] of active) {
        clearTimeout(timeout);
        active.delete(id);
        store.transaction(scope, (s) => {
          const r = s.configs.runs[id];
          if (r.lease === lease) {
            trace(r, 'queued');
            delete r.lease;
            delete r.leaseUntil;
          }
        });
        void worker.terminate();
      }
    }
  };
}
