export function mountPrivateReceipt(host, panel, node, { endpoint, label, accepts, kind, controls: costUnit = 'provider calls', render }) {
  const file = node('input'), fileLabel = node('label', 'Original signed request file '), token = node('input'), tokenLabel = node('label', 'Local gateway token ');
  file.type = 'file'; file.accept = '.json,application/json'; fileLabel.append(file);
  token.type = 'password'; token.autocomplete = 'off'; token.spellcheck = false; tokenLabel.append(token);
  const load = node('button', 'Look up completed read'), clear = node('button', 'Clear receipt');
  load.type = clear.type = 'button'; const controls = node('div'); controls.className = 'agentic-dashboard-actions agentic-form-controls';
  const status = node('p'), output = node('section'); status.setAttribute('role', 'status'); output.setAttribute('aria-label', label);
  controls.append(fileLabel, tokenLabel, load, clear);
  host.append(node('p', 'Open a completed read from this local gateway. Closing the panel clears its contents.'), controls, status, output);
  let pending = null, expiration;
  function reset() {
    pending?.abort(); pending = null; clearTimeout(expiration); load.disabled = false;
    token.value = ''; file.value = ''; status.textContent = ''; output.replaceChildren();
  }
  function clearWhenClosed(event) { if (!event.currentTarget.open) reset(); }
  clear.addEventListener('click', reset);
  panel.addEventListener('toggle', clearWhenClosed);
  panel.parentElement.closest('details')?.addEventListener('toggle', clearWhenClosed);
  window.addEventListener('pagehide', reset);
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
  file.addEventListener('change', () => { pending?.abort(); pending = null; clearTimeout(expiration); load.disabled = false; output.replaceChildren(); status.textContent = ''; });
  load.addEventListener('click', async () => {
    const selected = file.files?.[0], localToken = token.value;
    reset();
    if (location.hostname !== '127.0.0.1' || !selected || selected.size > 480000 || localToken.length < 32) {
      status.textContent = 'Open the local gateway and supply its token and original request file (up to 480 kB).'; return;
    }
    const controller = new AbortController(); pending = controller;
    load.disabled = true; status.textContent = 'Looking up receipt…';
    try {
      const request = JSON.parse(await selected.text());
      if (!accepts(request?.operation) || !request?.inputs?.grant) throw Error('Select a signed ' + kind + ' read request.');
      if (controller.signal.aborted) return;
      const reply = await fetch(endpoint, { method: 'POST', credentials: 'omit', cache: 'no-store',
        redirect: 'error', signal: controller.signal, headers: { Authorization: 'Bearer ' + localToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(request) });
      if (!reply.ok) throw Error(reply.status === 401 ? 'Local gateway token rejected.' : 'Receipt lookup unavailable on this gateway.');
      const receipt = await reply.json(), data = receipt.data;
      if (controller.signal.aborted) return;
      if (receipt.status !== 'OK') throw Error(receipt.error?.code === 'FINAL_READ_REQUIRED' ? 'No matching completed read.' : 'This request no longer admits the receipt.');
      if (receipt.request_id !== request.request_id || receipt.provenance?.operation !== request.operation ||
        receipt.provenance.capability_digest !== request.capability_digest || data?.source !== 'AUTHENTICATED_ADAPTER') throw Error('Receipt identity mismatch.');
      const until = Date.parse(receipt.display_until_utc);
      if (!Number.isFinite(until) || until <= Date.now()) throw Error('Receipt display expired.');
      render(output, request, receipt);
      status.textContent = 'Completed read · ' + data.cost.tool_calls + ' original ' + costUnit + ' · 0 lookup calls to the provider';
      const expire = () => {
        if (until > Date.now()) expiration = setTimeout(expire, Math.min(until - Date.now(), 2147483647));
        else { reset(); status.textContent = 'Receipt display expired.'; }
      };
      expire();
    } catch (error) {
      if (!controller.signal.aborted) { output.replaceChildren(); status.textContent = error instanceof SyntaxError ? 'Invalid request file.' : error.message; }
    } finally { if (pending === controller) { pending = null; load.disabled = false; } }
  });
}
