// Shared tool set for the probe fixtures.
export function addTools(server) {
  server.registerTool('metrics.query', { description: 'Run a metrics query', annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  server.registerTool('alerts.silence', { description: 'Silence an alert', annotations: { destructiveHint: true } }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  server.registerTool('annotations.create', { description: 'Mark a deploy' }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
}
