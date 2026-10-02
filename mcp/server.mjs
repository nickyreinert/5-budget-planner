import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { start_bridge } from './bridge.mjs';
import { load_exports, validate_exports, categories, transactions, propose_rules, propose_assignments, propose_category_maintenance, write_proposal, proposalName, assignmentsName, categoryMaintenanceName } from './classification.mjs';

// `--live` talks to the running app through a local bridge instead of reading
// exports and writing proposal files; tool permissions are then enforced by
// the app (Settings > AI).
const live = process.argv[2] === '--live';
const [settingsPath, dataPath, outputDirectory, permissionsPath] = live ? [] : process.argv.slice(2);
if (!live && (!settingsPath || !dataPath || !outputDirectory)) {
  console.error('Usage: node server.mjs /path/to/5ive_classification_settings.json /path/to/5ive_data_export.json /path/to/output-directory\n   or: node server.mjs --live');
  process.exit(1);
}

const settingsFile = live ? null : resolve(settingsPath);
const dataFile = live ? null : resolve(dataPath);
const outputDir = live ? null : resolve(outputDirectory);
const bridge = live ? start_bridge({
  port: Number(process.env.FIVE_BRIDGE_PORT || 8765),
  allowedOrigins: (process.env.FIVE_ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000,http://localhost:8000,http://127.0.0.1:8000,https://5.1-1-1.de').split(',')
}) : null;
const toolNames = ['list_categories', 'list_transactions', 'list_rules', 'propose_rules', 'propose_assignments', 'propose_category_maintenance'];
const permissions = permissionsPath ? JSON.parse(await readFile(resolve(permissionsPath), 'utf8')) : null;
if (permissions && (!Array.isArray(permissions.allowedTools) || permissions.allowedTools.some(name => !toolNames.includes(name)))) {
  throw new Error('MCP permissions require an allowedTools array of known tool names');
}
const enabled = name => !permissions || permissions.allowedTools.includes(name);
const server = new McpServer({ name: '5ive-budgets', version: '1.0.0' });
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const run = action => async args => {
  try { return reply(await action(args)); }
  catch (error) { return { content: [{ type: 'text', text: error.message }], isError: true }; }
};
const load = tool => live
  ? bridge.request('state', { tool }).then(({ settings, data }) => validate_exports(settings, data))
  : load_exports(settingsFile, dataFile);
const describe = text => live ? `${text} LIVE MODE: no file is written; the change is applied to the running app immediately and cannot be undone by you, so be conservative.` : text;
const apply = (tool, change) => bridge.request('apply', { tool, ...change });

if (enabled('list_categories')) server.registerTool('list_categories', {
  description: 'Read existing transaction categories, budget mappings and real classified examples. Read this before assigning transactions.',
  inputSchema: {}
}, run(async () => {
  const { settings, data } = await load('list_categories');
  return categories(settings, data);
}));

if (enabled('list_transactions')) server.registerTool('list_transactions', {
  description: 'Read exported CSV transactions with current category and classification source. Filter by category or payee/purpose; use offset to paginate. Never guess unclear purchases.',
  inputSchema: {
    category: z.string().optional(), search: z.string().optional(),
    offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50)
  }
}, run(async filters => {
  const { settings, data } = await load('list_transactions');
  return transactions(settings, data, filters);
}));

if (enabled('list_rules')) server.registerTool('list_rules', {
  description: 'Read existing classification rules and their matcher patterns before suggesting new rules. Highest priority wins; manual transaction assignments win over rules.',
  inputSchema: {}
}, run(async () => (await load('list_rules')).settings.rules));

if (enabled('propose_rules')) server.registerTool('propose_rules', {
  description: describe('Create ONE importable settings file with up to 50 new literal name/purpose rules. Rejects interception of already classified transactions. Review via Settings > AI > Import SETTING proposal. Output file must not already exist.'),
  inputSchema: { rules: z.array(z.object({ category: z.string(), field: z.enum(['name', 'purpose']), text: z.string(), exact: z.boolean().default(false) })).min(1).max(50) }
}, run(async ({ rules }) => {
  const { settings, data } = await load('propose_rules');
  const { candidate, proposals } = propose_rules(settings, data, rules);
  if (live) return { applied: await apply('propose_rules', { kind: 'rules', rules: proposals.map(({ rule }) => rule) }), proposals };
  const path = await write_proposal(outputDir, proposalName, candidate);
  return { path, proposals, instruction: 'Review and import this SETTING JSON via Settings > AI > Import SETTING proposal.' };
}));

if (enabled('propose_assignments')) server.registerTool('propose_assignments', {
  description: describe('Create an importable data file containing ONLY explicit per-transaction category overrides (no CSV rows). Will not change an existing manual classification. Import via Settings > AI > Import assignment proposal and confirm. Output file must not already exist.'),
  inputSchema: { assignments: z.array(z.object({ id: z.string(), category: z.string() })).min(1).max(100) }
}, run(async ({ assignments }) => {
  const { settings, data } = await load('propose_assignments');
  const proposal = propose_assignments(settings, data, assignments);
  if (live) return { applied: await apply('propose_assignments', { kind: 'assignments', overrides: proposal.overrides }) };
  const path = await write_proposal(outputDir, assignmentsName, proposal);
  return { path, count: Object.keys(proposal.overrides).length, instruction: 'Review and import this data JSON via Settings > AI > Import assignment proposal.' };
}));

if (enabled('propose_category_maintenance')) server.registerTool('propose_category_maintenance', {
  description: describe('Propose category cleanup: create a spending category, rename or merge categories, move explicit transaction IDs (including existing manual assignments), or delete an unused category. Keeps recurring and spending roles separate. Writes ONE proposal for review in Settings > AI > Import category cleanup. Never edits the app directly.'),
  inputSchema: { operations: z.array(z.object({ action: z.enum(['create', 'rename', 'merge', 'delete', 'move']), category: z.string().optional(), target: z.string().optional(), budgetId: z.string().optional(), ids: z.array(z.string()).min(1).max(1000).optional() })).min(1).max(50) }
}, run(async ({ operations }) => {
  const { settings, data } = await load('propose_category_maintenance');
  const proposal = propose_category_maintenance(settings, data, operations);
  if (live) return { applied: await apply('propose_category_maintenance', { kind: 'category-maintenance', operations }), preview: proposal.preview };
  const path = await write_proposal(outputDir, categoryMaintenanceName, proposal);
  return { path, preview: proposal.preview, instruction: 'Review and apply this JSON via Settings > AI > Import category cleanup.' };
}));

if (live) {
  const port = await bridge.listening;
  console.error(`5ive live bridge listening on http://127.0.0.1:${port}`);
} else await load();
await server.connect(new StdioServerTransport());
