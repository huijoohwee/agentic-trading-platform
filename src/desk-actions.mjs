import { frames } from './market.mjs';
import { studies } from './indicators.mjs';

const string = (maxLength = 80) => ({ type: 'string', minLength: 1, maxLength });
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const number = (minimum, maximum) => ({ type: 'number', minimum, maximum });
const choice = (...values) => ({ type: 'string', enum: values });
const bool = { type: 'boolean' },
  revision = integer(0, Number.MAX_SAFE_INTEGER),
  symbol = string(24);
const frame = choice(...Object.keys(frames)),
  venue = string(45),
  marketType = choice('spot', 'perpetual');
const count = integer(1, 600),
  before = integer(0, 8640000000000000),
  page = { offset: integer(0, 10000), count };
const selection = { type: 'array', maxItems: 20, uniqueItems: true, items: choice(...Object.keys(studies)) };
const bindings = { venue, marketType, symbol, frame };
const parameters = {
  start: string(10),
  end: string(10),
  capital: number(1, 1e9),
  venue: string(45),
  symbol,
  frame,
  marketType
};
const schema = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
});
function action(operation, description, properties, required, readOnlyHint = true) {
  return {
    name: operation.replaceAll('.', '_'),
    operation,
    description,
    inputSchema: schema(properties, required),
    annotations: { readOnlyHint, untrustedContentHint: true }
  };
}
const basket = { type: 'array', minItems: 3, maxItems: 3, uniqueItems: true, items: symbol };
export const deskActions = [
  action('desk.describe', 'Describe desk capabilities and data quality'),
  action('desk.observer', 'Open or resume the expiring read-only observer session', {}, [], false),
  action('read.catalog', 'Search instruments by venue and market type', {
    venue,
    marketType,
    query: { type: 'string', maxLength: 100 },
    ...page
  }),
  action(
    'practice.select',
    'Set the desk instrument, venue, type and interval',
    { ...bindings, revision },
    ['symbol', 'revision'],
    false
  ),
  action(
    'desk.studies',
    'Replace all selected chart studies',
    { studies: selection, revision },
    ['studies', 'revision'],
    false
  ),
  action('desk.chart', 'Inspect chart bars, source and matching markers', { ...bindings, before, count }),
  action('read.depth', 'Inspect book, spread and imbalance', { ...bindings, ...page }, ['symbol']),
  action('read.tape', 'Inspect aggressor trades and volumes', { ...bindings, ...page }, ['symbol']),
  action('practice.portfolio', 'Inspect spot and contract account, fees, margin and funding'),
  action('desk.history', 'Page closed paper fills newest first', page),
  action(
    'practice.order',
    'Place one explicitly requested paper order',
    {
      symbol,
      marketType,
      side: choice('BUY', 'SELL'),
      type: choice('MARKET', 'LIMIT', 'STOP'),
      qty: number(0.000001, 1e8),
      trigger: number(0, 1e7),
      leverage: integer(1, 2),
      reduceOnly: bool,
      explicitIntent: bool,
      revision
    },
    ['symbol', 'side', 'type', 'qty', 'explicitIntent', 'revision'],
    false
  ),
  action(
    'practice.cancel',
    'Cancel one working paper order',
    { id: string(), explicitIntent: bool, revision },
    ['id', 'explicitIntent', 'revision'],
    false
  ),
  action(
    'practice.funds',
    'Add virtual cash',
    { amount: number(0.000001, 1e8), explicitIntent: bool, revision },
    ['amount', 'explicitIntent', 'revision'],
    false
  ),
  action(
    'practice.prediction',
    'Record an owner prediction',
    {
      symbol,
      direction: choice('up', 'down'),
      horizon: string(6),
      confidence: integer(0, 100),
      note: { type: 'string', maxLength: 240 },
      explicitIntent: bool,
      revision
    },
    ['symbol', 'direction', 'horizon', 'confidence', 'note', 'explicitIntent', 'revision'],
    false
  ),
  action(
    'practice.reset',
    'Reset the paper session after the owner enters its displayed phrase',
    { confirm: string(32), explicitIntent: bool, revision },
    ['confirm', 'explicitIntent', 'revision'],
    false
  ),
  action('research.strategies', 'List the catalog and saved source versions'),
  action(
    'research.save',
    'Save named, hash-versioned Python source',
    { name: string(64), code: string(8192) },
    ['name', 'code'],
    false
  ),
  action(
    'research.start',
    'Queue one historical hypothesis',
    {
      ...parameters,
      hypothesis: integer(1, 20),
      basket
    },
    ['hypothesis'],
    false
  ),
  action(
    'research.suite',
    'Queue all 20 hypotheses with optional venues for spot and matched carry research',
    { ...parameters, basket, spotVenue: venue, carryVenue: venue },
    [],
    false
  ),
  action('research.get', 'Read run results or its selected hypothesis chart',
    { id: string(64), hypothesis: integer(1, 20) }, ['id']),
  action(
    'research.overlay',
    'Apply historical signals on their bound chart',
    { id: string(64), hypothesis: integer(1, 20) },
    ['id', 'hypothesis'],
    false
  ),
  action('research.cancel', 'Cancel a queued or running research job', { id: string(64) }, ['id'], false)
];
export const landingActions = [
  action('desk.discover', 'Discover the paper trading desk'),
  action('desk.enter', 'Open the local desk', {}, [], false)
];
export function validate(value, s) {
  const bad = () => {
    throw Error('INVALID_INPUT');
  };
  if (!s) bad();
  if (s.type === 'object') {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((k) => !Object.hasOwn(s.properties, k)) ||
      s.required.some((k) => !Object.hasOwn(value, k))
    )
      bad();
    for (const [k, v] of Object.entries(value)) validate(v, s.properties[k]);
  } else if (s.type === 'array') {
    if (
      !Array.isArray(value) ||
      value.length > s.maxItems ||
      value.length < (s.minItems ?? 0) ||
      (s.uniqueItems && new Set(value).size !== value.length)
    )
      bad();
    for (const item of value) validate(item, s.items);
  } else if (s.type === 'number' || s.type === 'integer') {
    if (
      !Number.isFinite(value) ||
      value < s.minimum ||
      value > s.maximum ||
      (s.type === 'integer' && !Number.isSafeInteger(value))
    )
      bad();
  } else if (
    typeof value !== s.type ||
    (s.enum && !s.enum.includes(value)) ||
    (s.type === 'string' && (value.length < s.minLength || value.length > s.maxLength))
  )
    bad();
}
export const actionFor = (operation) => deskActions.find((a) => a.operation === operation);
export function registerActions(actions, invoke, host = globalThis.window) {
  if (!host || host.top !== host) return;
  let active;
  function activate() {
    if (active) return;
    const model = host.document.modelContext ?? host.navigator.modelContext;
    if (typeof model?.registerTool !== 'function') return;
    const controller = new AbortController(),
      names = [];
    function clear() {
      controller.abort();
      for (const name of names) {
        try {
          model.unregisterTool?.(name);
        } catch {}
      }
    }
    try {
      for (const { operation, inputSchema, annotations, ...info } of actions) {
        const properties = { ...inputSchema.properties },
          required = [...inputSchema.required];
        if (!annotations.readOnlyHint && actions === deskActions && operation !== 'desk.observer') {
          properties.requestId = string(64);
          required.push('requestId');
        }
        const browserSchema = schema(properties, required);
        const registration = model.registerTool(
          {
            ...info,
            annotations,
            inputSchema: browserSchema,
            execute: async (input = {}) => {
              try {
                validate(input, browserSchema);
                const { requestId, ...args } = input;
                return await invoke(operation, args, requestId);
              } catch (error) {
                return { status: 'REFUSED', error: { code: error.message, retryable: false }, missing: [] };
              }
            }
          },
          { signal: controller.signal }
        );
        names.push(info.name);
        Promise.resolve(registration).catch(() => {
          if (!controller.signal.aborted) {
            clear();
            active = null;
          }
        });
      }
      active = clear;
    } catch (error) {
      clear();
      throw error;
    }
  }
  function stop() {
    active?.();
    active = null;
  }
  activate();
  host.addEventListener('pagehide', stop);
  host.addEventListener('pageshow', activate);
  return () => {
    stop();
    host.removeEventListener('pagehide', stop);
    host.removeEventListener('pageshow', activate);
  };
}
