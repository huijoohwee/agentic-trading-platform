// The Gateway supplies decimal spellings of provider numbers. Keep subtraction and
// the final percentage rounding in base 10, even when the quote uses an exponent.
function decimalParts(text) {
  if (typeof text !== 'string' || text.length > 64) return null;
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?(?:e([+-]?\d{1,3}))?$/i.exec(text);
  if (!match || Math.abs(Number(match[3] ?? 0)) > 324) return null;
  const fraction = match[2] ?? '';
  return { units: BigInt(match[1] + fraction), power: Number(match[3] ?? 0) - fraction.length };
}

function fixed(units, places) {
  const digits = String(units).padStart(places + 1, '0');
  return places ? digits.slice(0, -places) + '.' + digits.slice(-places) : digits;
}

export function quoteChange(last, previous) {
  const current = decimalParts(last), prior = decimalParts(previous);
  if (!current || !prior) return { text: 'UNKNOWN', accent: 'neutral' };
  const power = Math.min(0, current.power, prior.power);
  const base = prior.units * 10n ** BigInt(prior.power - power);
  const delta = current.units * 10n ** BigInt(current.power - power) - base;
  const magnitude = delta < 0n ? -delta : delta;
  const sign = delta < 0n ? '-' : '+';
  const exact = fixed(magnitude, -power);
  let text = sign + (exact.includes('.') ? exact.replace(/0+$/, '').replace(/\.$/, '') : exact);
  if (base > 0n) {
    const hundredths = (magnitude * 10000n + base / 2n) / base;
    text += ' (' + sign + fixed(hundredths, 2) + '%)';
  }
  return { text, accent: delta < 0n ? 'secondary' : 'success' };
}

function quoteUtcMillis(value) {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(ms) || ms <= 0 || !Number.isFinite(new Date(ms).getTime())) return null;
  const iso = new Date(ms).toISOString();
  return typeof value === 'number' || value === iso || value === iso.replace('.000Z', 'Z') ? ms : null;
}

export function addQuoteProvenance(add, marketTime, capturedUtc) {
  // The Gateway projects ISO UTC with milliseconds. Capture summaries keep epoch milliseconds.
  const ms = quoteUtcMillis(marketTime);
  const capture = typeof capturedUtc === 'string' ? quoteUtcMillis(capturedUtc) : null;
  add('Quote time (UTC)', ms === null ? 'Unknown' : new Date(ms).toISOString());
  add('Captured UTC', capture === null ? 'Unknown' : capturedUtc);
  let age = 'Unknown';
  if (ms !== null && capture !== null) {
    if (ms > capture) age = 'Unknown (source time follows capture)';
    else {
      const elapsed = capture - ms;
      const hours = Math.floor(elapsed / 3600000), minutes = Math.floor(elapsed / 60000) % 60;
      age = hours + ' h ' + minutes + ' min ' + (elapsed % 60000) / 1000 + ' s';
    }
  }
  add('Age at capture', age);
  add('Price precision', 'Provider number. Original decimal scale unknown.');
}
