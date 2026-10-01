import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { load_exports, categories, transactions, propose_rules, propose_assignments, write_proposal, proposalName, assignmentsName } from './classification.mjs';

const [settingsPath, dataPath, outputDirectory] = process.argv.slice(2);
if (!settingsPath || !dataPath || !outputDirectory) {
  console.error('Usage: node server.mjs /path/to/5ive_classification_settings.json /path/to/5ive_data_export.json /path/to/output-directory');
  process.exit(1);
}

const settingsFile = resolve(settingsPath);
const dataFile = resolve(dataPath);
const outputDir = resolve(outputDirectory);
const server = new McpServer({ name: '5ive-budgets', version: '1.0.0' });
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const run = action => async args => {
  try { return reply(await action(args)); }
  catch (error) { return { content: [{ type: 'text', text: error.message }], isError: true }; }
};
const load = () => load_exports(settingsFile, dataFile);

server.registerTool('list_categories', {
  description: 'Read existing transaction categories, budget mappings and real classified examples. Read this before assigning transactions.',
  inputSchema: {}
}, run(async () => {
  const { settings, data } = await load();
  return categories(settings, data);
}));

server.registerTool('list_transactions', {
  description: 'Read exported CSV transactions with current category and classification source. Filter by category or payee/purpose; use offset to paginate. Never guess unclear purchases.',
  inputSchema: {
    category: z.string().optional(), search: z.string().optional(),
    offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50)
  }
}, run(async filters => {
  const { settings, data } = await load();
  return transactions(settings, data, filters);
}));

server.registerTool('list_rules', {
  description: 'Read existing classification rules and their matcher patterns before suggesting new rules. Highest priority wins; manual transaction assignments win over rules.',
  inputSchema: {}
}, run(async () => (await load()).settings.rules));

server.registerTool('propose_rules', {
  description: 'Create ONE importable settings file with up to 50 new literal name/purpose rules. Rejects interception of already classified transactions. Review via Settings > Export/Import > Import SETTING. Output file must not already exist.',
  inputSchema: { rules: z.array(z.object({ category: z.string(), field: z.enum(['name', 'purpose']), text: z.string(), exact: z.boolean().default(false) })).min(1).max(50) }
}, run(async ({ rules }) => {
  const { settings, data } = await load();
  const { candidate, proposals } = propose_rules(settings, data, rules);
  const path = await write_proposal(outputDir, proposalName, candidate);
  return { path, proposals, instruction: 'Import this SETTING JSON in the app and review the proposed changes.' };
}));

server.registerTool('propose_assignments', {
  description: 'Create an importable data file containing ONLY explicit per-transaction category overrides (no CSV rows). Will not change an existing manual classification. Import via Settings > Export/Import > Import data and confirm. Output file must not already exist.',
  inputSchema: { assignments: z.array(z.object({ id: z.string(), category: z.string() })).min(1).max(100) }
}, run(async ({ assignments }) => {
  const { settings, data } = await load();
  const proposal = propose_assignments(settings, data, assignments);
  const path = await write_proposal(outputDir, assignmentsName, proposal);
  return { path, count: Object.keys(proposal.overrides).length, instruction: 'Import this data JSON in the app and confirm the import.' };
}));

await load();
await server.connect(new StdioServerTransport());