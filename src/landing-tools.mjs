import { registerActions, landingActions, deskActions } from './desk-actions.mjs';
registerActions(landingActions, async (op) => {
  if (op === 'desk.enter') location.assign('./desk.html');
  return {
    status: 'OK',
    data: { route: './desk.html', actions: deskActions.map((a) => a.operation) },
    provenance: 'local desk',
    warnings: []
  };
});
