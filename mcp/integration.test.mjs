import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('Claude MCP client reads categories and creates importable proposals', async () => {
  const directory = await mkdtemp(join(tmpdir(), '5ive-mcp-test-'));
  const settingsPath = join(directory, 'settings.json');
  const dataPath = join(directory, 'data.json');
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
  let client;
  try {
    await writeFile(settingsPath, JSON.stringify(settings));
    await writeFile(dataPath, JSON.stringify(data));
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, 'server.mjs'), settingsPath, dataPath, directory] }));
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['list_categories', 'list_transactions', 'list_rules', 'propose_rules', 'propose_assignments', 'propose_category_maintenance']);
    const listed = await client.callTool({ name: 'list_transactions', arguments: { category: 'Unkategorisiert' } });
    assert.equal(JSON.parse(listed.content[0].text).rows[0].id, 'csv:2');
    const dated = await client.callTool({ name: 'list_transactions', arguments: { from: '2026-10-02' } });
    assert.equal(JSON.parse(dated.content[0].text).total, 0);
    assert.match(client.getInstructions(), /question tool/);
    const proposed = await client.callTool({ name: 'propose_rules', arguments: { rules: [{ category: 'Food', field: 'name', text: 'BAKERY' }] } });
    assert.equal(proposed.isError, undefined);
    assert.equal(JSON.parse(await readFile(join(directory, '5ive_mcp_settings_proposal.json'), 'utf8')).rules.length, 2);
    const assignments = await client.callTool({ name: 'propose_assignments', arguments: { assignments: [{ id: 'csv:2', category: 'Food' }] } });
    assert.equal(assignments.isError, undefined);
    assert.deepEqual(JSON.parse(await readFile(join(directory, '5ive_mcp_assignments.json'), 'utf8')), { overrides: { 'csv:2': 'Food' } });
    const cleanup = await client.callTool({ name: 'propose_category_maintenance', arguments: { operations: [{ action: 'rename', category: 'Food', target: 'Groceries' }] } });
    assert.equal(cleanup.isError, undefined);
    const proposal = JSON.parse(await readFile(join(directory, '5ive_mcp_category_maintenance.json'), 'utf8'));
    assert.equal(proposal.kind, 'category-maintenance');
    assert.deepEqual(proposal.preview[0].affectedIds, ['csv:1']);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), settings);
    assert.deepEqual(JSON.parse(await readFile(dataPath, 'utf8')), data);
  } finally {
    await client?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('MCP permissions expose only selected tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), '5ive-mcp-permissions-'));
  let client;
  try {
    const settingsPath = join(directory, 'settings.json');
    const dataPath = join(directory, 'data.json');
    const permissionsPath = join(directory, 'permissions.json');
    await writeFile(settingsPath, JSON.stringify({ groups: [], mainCategories: [], rules: [] }));
    await writeFile(dataPath, JSON.stringify({ importedEntries: [], manualEntries: [], overrides: {} }));
    await writeFile(permissionsPath, JSON.stringify({ allowedTools: ['list_categories'] }));
    client = new Client({ name: 'restricted-client', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [join(import.meta.dirname, 'server.mjs'), settingsPath, dataPath, directory, permissionsPath] }));
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['list_categories']);
    const listed = await client.callTool({ name: 'list_categories', arguments: {} });
    assert.equal(listed.isError, undefined);
    const denied = await client.callTool({ name: 'propose_rules', arguments: { rules: [] } });
    assert.equal(denied.isError, true);
    const cleanupDenied = await client.callTool({ name: 'propose_category_maintenance', arguments: { operations: [{ action: 'create', category: 'Test' }] } });
    assert.equal(cleanupDenied.isError, true);
  } finally {
    await client?.close();
    await rm(directory, { recursive: true, force: true });
  }
});