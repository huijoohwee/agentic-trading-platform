import { utcMillis } from './rules.mjs';

const exact = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value) &&
  !['latest','current','default','main','head'].includes(value.toLowerCase());
const scopes = ['market-data','paper-account-read'];
const sameSet = (a,b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
  new Set(a).size === a.length && new Set(b).size === b.length && a.every(v => b.includes(v));
const pinnedSet = list => Array.isArray(list) && list.length > 0 && list.length <= 32 &&
  list.every(item => exact(item?.id) && exact(item.version)) && new Set(list.map(item => item.id)).size === list.length;
const keys = list => list.map(item => item.id + ':' + item.version);

// Check redacted observations only. This report cannot enable accounts, secrets, schedules or orders.
export function inspectBindings(record) {
  const reasons = [];
  if (record?.schema !== 'trading-forward-review/v1' || !['SYNTHETIC','REDACTED'].includes(record.source))
    return { ok:false, authority:false, reasons:['INVALID_RECORD'] };
  const { selected, desktop, cloud, budget, template, expected, channel } = record;
  const at = utcMillis(record.evaluatedUtc);
  const current = readback => utcMillis(readback?.observedUtc) !== null && utcMillis(readback.observedUtc) <= at &&
    utcMillis(readback.expiresUtc) !== null && utcMillis(readback.expiresUtc) > at;
  if (at === null || !current(desktop) || !current(cloud) || !current(budget)) reasons.push('STALE_EVIDENCE');
  if (record.registrationAccepted !== true || record.sameEmailVerified !== true)
    reasons.push('ELIGIBILITY_UNVERIFIED');
  if (!selected || selected.environment !== 'SIMULATE' || !['practice','competition'].includes(selected.profile) ||
      !exact(selected.alias) || ![desktop,cloud].every(r => r && r.alias === selected.alias &&
        r.environment === selected.environment && r.profile === selected.profile)) reasons.push('ACCOUNT_BINDING');
  if (![desktop,cloud].every(r => sameSet(r?.scopes, scopes)) || cloud?.vaultAttached !== true ||
      cloud?.patServerSide !== true || cloud?.patRevocable !== true) reasons.push('READ_GRANTS');
  const free = budget?.plan === 'free' || (budget?.plan === 'sponsored-free' && budget.zeroCostTermsVerified === true);
  if (!free || budget.addOns !== false || (budget.hardCapUsd !== 0 && budget.denyAtExhaustion !== true) ||
      !Number.isSafeInteger(budget.remaining) || !Number.isSafeInteger(budget.requested) ||
      budget.requested <= 0 || budget.remaining < budget.requested) reasons.push('BUDGET_HALT');
  if (!template || !expected || !exact(template.agentId) || !exact(template.cloudVersion) ||
      template.agentId !== expected.agentId || template.cloudVersion !== expected.cloudVersion ||
      utcMillis(template.retrievedUtc) === null || utcMillis(template.retrievedUtc) > at ||
      typeof template.changeSummary !== 'string' || !template.changeSummary.trim()) reasons.push('VERSION_RECORD');
  for (const field of ['skills','children']) {
    const actual = template?.[field], planned = expected?.[field];
    if (!pinnedSet(actual) || !pinnedSet(planned) || !sameSet(keys(actual),keys(planned))) reasons.push('BINDING_DRIFT_' + field.toUpperCase());
  }
  if (!Array.isArray(template?.mcp) || !template.mcp.length || template.mcp.length > 64 ||
      !template.mcp.every(exact) || !sameSet(template.mcp,expected?.mcp)) reasons.push('BINDING_DRIFT_MCP');
  const readTools = list => Array.isArray(list) && list.length > 0 && list.length <= 64 &&
    list.every(tool => exact(tool?.id) && tool.effect === 'read-only');
  if (!readTools(template?.tools) || !readTools(expected?.tools) ||
      !sameSet(template.tools.map(t => t.id),expected.tools.map(t => t.id))) reasons.push('BINDING_DRIFT_TOOLS');
  if (channel && (!Number.isInteger(channel.botCount) || channel.botCount < 1 || channel.botCount > 5 ||
      channel.pairing !== true || channel.socketMode !== true || channel.eventsEnabled !== true ||
      channel.botInstalled !== true || channel.member !== true || channel.pairedReply !== true ||
      channel.mirrorTools !== false || channel.mirrorThinking !== false || channel.userToken !== false))
    reasons.push('CHANNEL_UNVERIFIED');
  return { ok:reasons.length === 0, source:record.source, authority:false, reasons };
}
