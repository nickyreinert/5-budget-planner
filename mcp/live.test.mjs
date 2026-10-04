import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const origin = 'http://localhost:3000';
const settings = {
  groups: [{ id: 'discretionary', label: 'Budget' }],
  mainCategories: [{ id: 'food', label: 'Food' }],
  rules: [{ id: 'old', category: 'Food', label: 'Food', group: 'discretionary', namePattern: 'MARKET', priority: 1 }]
};
const data = {
  importedEntries: [{ id: 'csv:1', Datum: '01.10.2026', Name: 'MARKET', Verwendungszweck: '', Betrag: '-10.00' },
    { id: 'csv:2', Datum: '01.10.2026', Name: 'BAKERY', Verwendungszweck: '', Betrag: '-5.00' }],
  manualEntries: [], overrides: {}
};

// Stands in for the app: answers bridge commands like index.html does.
function fake_app(url, allowedTools) {
  const received = [];
  const controller = new AbortController();
  (async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(`${url}/poll`, { headers: { Origin: origin }, signal: controller.signal });
        if (response.status !== 200) continue;
        const { id, type, payload } = await response.json();
        received.push({ type, payload });
        const body = !allowedTools.includes(payload.tool) ? { id, ok: false, error: `Tool ${payload.tool} is disabled` }
          : type === 'state' ? { id, ok: true, value: { settings, data } } : { id, ok: true, value: { applied: payload.kind } };
        await fetch(`${url}/result`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      } catch { if (controller.signal.aborted) return; }
    }
  })();
  return { received, stop: () => controller.abort() };
}

test('live mode reads state from the app and applies changes without files', async () => {
  const port = 18765;
  const url = `http://127.0.0.1:${port}`;
  const client = new Client({ name: 'live-client', version: '1.0.0' });
  let app;
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, 'server.mjs'), '--live'],
      env: { ...process.env, FIVE_BRIDGE_PORT: String(port), FIVE_ALLOWED_ORIGINS: origin } }));
    const offline = await client.callTool({ name: 'list_rules', arguments: {} });
    assert.equal(offline.isError, true);
    assert.match(offline.content[0].text, /not connected/);

    assert.equal((await fetch(`${url}/poll`, { headers: { Origin: 'https://evil.example' } })).status, 403);

    app = fake_app(url, ['list_transactions', 'propose_rules', 'propose_assignments', 'propose_category_maintenance']);
    await new Promise(resolve => setTimeout(resolve, 200));
    const listed = await client.callTool({ name: 'list_transactions', arguments: { category: 'Unkategorisiert' } });
    assert.equal(JSON.parse(listed.content[0].text).rows[0].id, 'csv:2');

    const denied = await client.callTool({ name: 'list_rules', arguments: {} });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /disabled/);

    const rules = await client.callTool({ name: 'propose_rules', arguments: { rules: [{ category: 'Food', field: 'name', text: 'BAKERY' }] } });
    assert.equal(rules.isError, undefined);
    const applied = app.received.findLast(({ type }) => type === 'apply');
    assert.equal(applied.payload.kind, 'rules');
    assert.equal(applied.payload.rules[0].verwendungPattern, undefined);
    assert.equal(applied.payload.rules[0].namePattern, 'BAKERY');

    const assignments = await client.callTool({ name: 'propose_assignments', arguments: { assignments: [{ id: 'csv:2', category: 'Food' }] } });
    assert.equal(assignments.isError, undefined);
    assert.deepEqual(app.received.findLast(({ type }) => type === 'apply').payload.overrides, { 'csv:2': 'Food' });

    const cleanup = await client.callTool({ name: 'propose_category_maintenance', arguments: { operations: [{ action: 'rename', category: 'Food', target: 'Groceries' }] } });
    assert.equal(cleanup.isError, undefined);
    assert.deepEqual(app.received.findLast(({ type }) => type === 'apply').payload.operations, [{ action: 'rename', category: 'Food', target: 'Groceries' }]);
  } finally {
    app?.stop();
    await client.close();
  }
});
