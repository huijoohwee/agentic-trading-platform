export function asText(value) {
  if (value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

// The Base table and Sheets snapshot project the same ordered records.
// Keep numeric data native in Sheets and leave missing observations blank.
async function workbookSnapshot({ workbookId, sheetId, name, headers, records }) {
  const { CONTRACT, executeWorkbook, encodeSnapshot } = await import('../owners/sheets/sheets/core.mjs');
  const { addressOf } = await import('../owners/sheets/sheets/schema.mjs');
  const cells = {};
  function write(row, values) {
    values.forEach((value, column) => {
      if (value === undefined) return;
      cells[addressOf(row, column)] = typeof value === 'number'
        ? { type: 'number', value } : { type: 'text', value: asText(value) };
    });
  }
  write(0, headers);
  records.forEach((record, index) => write(index + 1, record.values));
  const { workbook } = await executeWorkbook(null, {
    contract: CONTRACT, operationId: 'export-' + sheetId, operation: 'create', expectedRevision: 0,
    payload: { workbookId, sheetId, name, fitToCells: true, cells },
  });
  return encodeSnapshot(workbook);
}

export function bindWorkbookExport(button, error, spec, downloadJson) {
  button.onclick = async () => {
    button.disabled = true;
    error.textContent = '';
    try {
      const text = await workbookSnapshot(spec);
      if (button.isConnected) downloadJson(text, spec.filename);
    } catch (failure) { error.textContent = failure.message; }
    finally { button.disabled = false; }
  };
}
