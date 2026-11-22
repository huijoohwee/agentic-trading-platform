// Both Trading pages use the native Design System toolbar and the same lazy panel.
const toolbar = document.getElementById('trading-toolbar');
const trigger = document.createElement('button');
const root = document.createElement('div');
root.id = 'trading-skills-panel';
root.hidden = true;
document.body.append(root);

trigger.type = 'button';
trigger.id = 'trading-skills-trigger';
trigger.className = 'agentic-toolbar-item';
trigger.textContent = 'Skills & Commands';
trigger.setAttribute('aria-haspopup', 'dialog');
trigger.setAttribute('aria-controls', root.id);
trigger.setAttribute('aria-expanded', 'false');
toolbar.append(trigger);

const styles = new Map();
function panelStyle(name) {
  if (!styles.has(name)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('../owners/design/site/' + name + '.css', import.meta.url);
    styles.set(name, new Promise((resolve, reject) => {
      link.onload = resolve;
      link.onerror = () => {
        styles.delete(name);
        link.remove();
        reject(new Error('Unavailable stylesheet: ' + name));
      };
      document.head.append(link);
    }));
  }
  return styles.get(name);
}

async function firstOpen() {
  trigger.disabled = true;
  try {
    const [panel] = await Promise.all([
      import('./skills-panel.mjs'),
      ...['floating-panel', 'panel-section', 'skills-commands'].map(panelStyle)
    ]);
    trigger.textContent = 'Skills & Commands';
    trigger.disabled = false;
    panel.openTradingSkills(trigger, root);
    trigger.removeEventListener('click', firstOpen);
  } catch {
    trigger.disabled = false;
    trigger.textContent = 'Retry Skills & Commands';
    trigger.focus();
  }
}
trigger.addEventListener('click', firstOpen);
