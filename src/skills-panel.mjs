import { mountFloatingPanel } from '../owners/design/site/floating-panel.js';
import { mountSkillsCommandsReference } from '../owners/design/site/skills-commands.js';
import catalog from '../owners/os/catalog/invocation.json' with { type: 'json' };

export const tradingSkill = catalog.entries.find(entry => entry.token === '@skill:').descriptor;
export const tradingSkillEntries = catalog.entries.filter(entry =>
  entry.kind === 'command' && entry.action === 'skill' && entry.semantic === 'read-only' ||
  entry.token === '#read-only' || entry.token === '@skill:'
).map(entry => ({
  token: entry.kind === 'binding' ? entry.token + tradingSkill.id : entry.token,
  summary: entry.kind === 'binding' ? tradingSkill.description : entry.summary,
  subject: 'Trading',
  verb: entry.argv?.[0] ?? (entry.kind === 'binding' ? 'select' : 'constrain'),
  object: entry.kind === 'semantic' ? 'Authority' : 'Portable skill',
}));

export function openTradingSkills(trigger, root) {
  const page = root.ownerDocument.createElement('section');
  mountSkillsCommandsReference(page, tradingSkillEntries,
    `Agentic Trading Skills · ${tradingSkill.owner} · @skill:${tradingSkill.id}. Pinned offline reference; commands run in the owning CLI, not this browser. No order authority.`);
  const source = root.ownerDocument.createElement('a');
  source.href = new URL('../owners/os/skills/trading/SKILL.md', import.meta.url).href;
  source.textContent = 'Read verified trading skill instructions';
  source.target = '_blank'; source.rel = 'noopener';
  const provenance = root.ownerDocument.createElement('p');
  provenance.className = 'agentic-skills-meta';
  provenance.append(source, root.ownerDocument.createTextNode(` · ${tradingSkill.source} · ${tradingSkill.digest}`));
  page.querySelector('.agentic-skills-body').append(provenance);
  root.replaceChildren(page);
  const panel = mountFloatingPanel(trigger, root, { label: 'Agentic Trading Skills', activeKey: 'skills-commands' });
  panel.open();
  return panel;
}
