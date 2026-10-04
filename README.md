# 5ive Budgets

Local-first CSV budgeting app with a compact **Woche** view and a historical
**Übersicht** dashboard. Transactions and manual entries live in IndexedDB;
settings and preferences live in localStorage. Bank data is not sent to an LLM
by the app. You choose what to share with an external LLM.

## You only need 5 budgets

5ive Budgets is a local-first budgeting app for people who want a clear view
of their money without maintaining a spreadsheet full of tiny envelopes.

The idea is simple: organize your spending into **five meaningful budgets**.
Keep the budgets broad enough to stay useful, and use transaction categories
inside them for detail. The goal is not to create the perfect taxonomy. The
goal is to make the next spending decision obvious.

The app gives you:

- a weekly view that shows what is left to spend;
- an overview of historical spending, income, and cashflow;
- semantic transaction categories inside your budgets;
- recurring costs, salary streams, and additional income kept separate;
- CSV import, manual entries, and optional bank synchronization.

## Start locally

```sh
python3 -m http.server 3000
```
or

```sh
npm install
npm run dev
```

Open <http://localhost:3000>. The app stores transactions and manual entries
in IndexedDB and settings in localStorage. Bank data stays in the browser; the
app does not send it to an LLM. You decide what to share with an external LLM.

## Deploy manually from your PC

The site is hosted on Vercel. Link the project once, then deploy:

```sh
npx vercel login
npx vercel link
./deploy.sh
```

`deploy.sh` stamps a fresh service-worker cache name and publishes the static
site to production. Cloud sync runs directly against Firebase (Auth +
Firestore) from the browser; there is no server-side function.

For Google sign-in in the installed PWA, Vercel proxies Firebase's auth helper
through the app domain. Before deploying, add `https://5.1-1-1.de/__/auth/handler`
to the authorized redirect URIs of the Google OAuth web client used by Firebase,
and ensure `5.1-1-1.de` is an authorized domain under Firebase Authentication.
The proxy must remain a rewrite (not a browser redirect) so the helper uses the
same origin as the PWA. After deployment, verify that
`https://5.1-1-1.de/__/auth/handler` returns the Firebase helper page rather
than the app shell.

## A simple workflow

1. Import CSV files from your accounts.
2. Create or import a settings JSON with up to five main budgets.
3. Review the suggested categories, recurring costs, rules, and limits.
4. Use **Woche** to make day-to-day spending decisions.
5. Use **Übersicht** to understand patterns and refine the setup.

The optional prompt in
[examples/budget-llm-prompt.txt](examples/budget-llm-prompt.txt) can turn your
transaction history into a settings JSON. It asks for roughly five budgets,
but the important part is the structure: budgets describe broad areas of life,
while categories describe purposes such as food, mobility, or housing.

## The five-budget principle

Five budgets are a constraint, not a requirement to make five arbitrary
folders. A good setup usually combines essential spending, discretionary
spending, and other priorities that matter to you. Keep recurring contracts,
income, internal transfers, and unknown expenses separate from the budgets so
they do not distort your available spending money.

Amazon, PayPal, Klarna, banks, and other payment routes are not categories.
The category should describe what the money was for. When the purpose is not
clear, the app keeps the expense as **Unkategorisiert** in **Nicht zugeordnet**
until you can classify it.

The weekly allowance is based on regular salary minus normalized recurring
costs:

```text
weekly allowance = (monthly salary - monthly recurring costs) * 12 / 52
```

Salary is calculated from the median of the last three available salary-month
totals. Refunds, sales, gifts, and other additional income remain visible in
cashflow but do not increase the weekly allowance. Non-recurring expenses count
inside their budget and are not deducted a second time as fixed costs.

## CSV and PayPal matching

For reliable account trends and PayPal reconciliation, each imported file
needs a source account. Map the source-account column in CSV settings, or name
the account when a file contains only one account. Separate imports are
recommended for separate accounts.

Log purchases manually while waiting for the next bank export. When you import
the CSV later, the app reconciles those entries with the bank bookings before
calculating weekly budgets, cashflow, and historical statistics. A matched
purchase counts once. The CSV supplies the booking amount, date, account,
currency, and reference; your manual category assignment stays attached.

Automatic matching requires the same signed amount in integer cents and the
same currency, within a configurable date window (default **±3 days**, adjustable
from **0 to 14 days**). A known account on a manual entry must agree with the
imported account. Only a unique one-to-one match is accepted. Two purchases for
the same amount, delayed bookings, or missing account information can need
review; amount and date alone do not prove that two records describe the same
purchase.

Each CSV import records a separate covered date range for each account. The
range is inferred from the earliest and latest booking in that file, or you can
supply optional from/to dates when the statement covers a wider period. A
manual expense outside imported coverage stays **pending**. An unmatched manual
expense inside coverage is flagged **Unassigned**, and an uncertain match is
flagged for review in the week and overview views. It continues to count as
spending: it may be a real cash purchase, including spending birthday cash, or
a purchase that has not yet been correctly matched. The app does not assume
that every unmatched expense was paid in cash.

Review these exceptions by choosing a corresponding imported booking, marking
the entry as cash, or keeping it as a separate expense. These decisions and
the import ranges survive reloads, data exports, and transaction sync. Repeated
overlapping CSV imports preserve history and upsert existing bookings; matched
manual entries remain saved so reconciliation can be reviewed later. AI data
exports use the same reconciliation rules and include the status of each row.
Older saved imports have no reliable coverage metadata. Reimport a complete
account CSV once to establish its covered period; until then, unmatched manual
entries stay pending. Filtered merchant/category exports must not be used to
declare a complete account period.

Known PayPal merchant purchases can be matched to corresponding bank debits by
exact signed amount and date window. Ambiguous matches remain visible instead
of being silently removed. Other internal transfers require explicitly
classified transfer rows on different known accounts.

## Settings and imports

Settings JSON contains budgets (`mainCategories`), classification rules, and
optional budget recommendations. Amounts are integer cents. Rules can identify
salary, recurring contracts, transfers, and transaction purposes using
JavaScript regular expressions.

A spending category is a rule whose name is `"<budgetId>.<sub>"`, for example
`"alltag.Lebensmittel"`; the budget is the part before the first dot, exactly
like a recurring category can be `"Versicherungen.HDI Leben"`. The budget id
alone (`"alltag"`) is the budget's general category. A name without a budget id,
such as `Unkategorisiert`, stays unassigned. There is no separate mapping from
categories to budgets. Settings in the earlier format (`categoryMappings`,
`budgetCategory`, `entryCategory`) are converted once when loaded or imported,
including stored per-transaction assignments, manual entries and favorites;
categories that only existed as a mapping become rules without matchers.

Recurring-cost categories (`group: "fixed"`) describe contracts and are separate
from spending categories: only non-recurring spending categories can belong to
a budget, even if their name starts with a budget id. Recurring payments reduce the available budget through their
monthly fixed-cost value; their transactions never consume a spending budget.
Category names alone do not determine the role: the classification group does.

The first import can replace the bundled defaults. Later imports show proposed
additions, edits, and deletions before saving. Local rules and manual
per-transaction assignments take precedence over imported suggestions. Export
your settings before intentionally replacing local changes.

## Claude MCP (live, local)

Claude can read the app's current state and change it without export or import
files. The MCP server runs on your computer with `--live` and opens a bridge on
`127.0.0.1:8765`; the app in your browser connects to it and executes Claude's
requests against its own storage.

1. `npm install --prefix mcp`
2. Configure your MCP client with `"command": "node"` and
	 `"args": ["/absolute/path/to/mcp/server.mjs", "--live"]`.
3. In the app, open Settings > AI, tick the tools Claude may use, and enable
	 **Live-Verbindung zu lokalem Claude**. Keep the tab open; the setting is
	 remembered per browser.
4. Ask Claude to review and adjust classifications. `propose_rules`,
	 `propose_assignments` and `propose_category_maintenance` are applied
	 immediately in this mode (no file, no review dialog) and there is no undo
	 for them. Export your settings and data first if unsure.

The bridge accepts only the origins `http://localhost:3000`,
`http://127.0.0.1:3000` and `https://5.1-1-1.de`; set
`FIVE_ALLOWED_ORIGINS` (comma-separated) to change them, and `FIVE_BRIDGE_PORT`
to change the port (the app uses 8765 and is not configurable). Tool
permissions are enforced by the app's checkboxes, not by a permissions file.
Browsers may ask for permission to reach a local network address when the app
is served from a public domain; Safari blocks plain-HTTP loopback requests
from HTTPS pages, so use Chrome/Firefox or run the app on `localhost`.
Claude receives financial details returned by the read tools.

## Claude MCP (local exports)

Claude Desktop or Claude Code can inspect existing classifications and suggest
categories for new CSV transactions through the local MCP server. This also
works when the app is hosted on Vercel: the server runs on **your computer**,
not on Vercel, and never gets access to browser storage automatically.

1. Import your CSV in the app. In Settings > AI, download both
	 **Aktuelles SETTING exportieren** (`5ive_classification_settings.json`) and
	 **Aktuelle Daten exportieren** (`5ive_data_export.json`). Store these files privately.
2. Run `npm install --prefix mcp` in this repository. In Settings > AI, choose
	 which read and proposal tools Claude may use. Download the permissions file
	 (`5ive_mcp_permissions.json`) into a private output folder. Configure your
	 MCP client once with the absolute paths to the server, exports, output folder
	 and permissions file:

	 ```json
	 {
		 "mcpServers": {
			 "5ive-budgets": {
				 "command": "node",
				 "args": [
					 "/absolute/path/to/moneyMoneyAnalyzer/mcp/server.mjs",
					 "/absolute/path/to/5ive_classification_settings.json",
					 "/absolute/path/to/5ive_data_export.json",
					 "/absolute/path/to/private-output-folder",
					 "/absolute/path/to/private-output-folder/5ive_mcp_permissions.json"
				 ]
			 }
		 }
	 }
	 ```

3. Ask Claude to use `list_categories`, `list_rules`, and `list_transactions`
	 (filter by `Unkategorisiert`) to compare new purchases with earlier ones.
	 Use `propose_rules` for repeated, clearly identifiable merchants; use
	 `propose_assignments` for individual purchases with known purposes (enable
		 proposal tools in the AI tab first). Leave ambiguous transactions unclassified.
		 Rules are limited to existing expense categories and must not take over
		 previously classified entries.
4. Import `5ive_mcp_settings_proposal.json` via **SETTING-Vorschlag importieren**
	 in the AI tab and review each proposed change. Import
	 `5ive_mcp_assignments.json` via **Kategorisierungsvorschlag importieren** and confirm.
	 The latter adds only category overrides,
	 without replacing your CSV bookings. Export fresh files before the next
	 session. Use a fresh empty output folder for each proposal batch; the MCP
	 server never overwrites existing proposal files.

For duplicate-category cleanup, enable `propose_category_maintenance`. It accepts
an `operations` array: `create` (`category`, optional `budgetId`), `rename` or
`merge` (`category`, `target`), `move` (`ids`, `target`), and `delete` (`category`,
unused only). Renames and merges update both rules and existing transaction
assignments. Moves can deliberately replace earlier manual assignments. Recurring,
income, transfer and spending categories must retain their separate roles.
Import `5ive_mcp_category_maintenance.json` via **Kategorie-Bereinigung importieren**
in Settings > AI, inspect the affected bookings, then apply it. A proposal made
against outdated exports is rejected; export fresh settings and data to retry.

The permissions file controls only MCP clients started with that fifth argument;
restart the client to apply changes. Older four-argument configurations still
expose all tools. The browser cannot connect to or monitor a running local MCP
process. Claude receives financial details returned by the tools. Keep the export and
output folders outside the public site/repository; decide whether to share
that data with your Claude account. The server assumes the default CSV option
to ignore bank-provided categories; if you disabled that option, verify the
proposals carefully in the app before importing.

## Optional bank sync

GoCardless synchronization is provided through the optional proxy in
[gocardless-proxy/README.md](gocardless-proxy/README.md). It is not required
for CSV-based use.

## Validation

```sh
node --test tests/*.test.mjs
```

For browser-backed IndexedDB migration and upsert tests, open
`tests/storage.test.html` through the local server.
```

Open `tests/storage.test.html` through the local server for real IndexedDB
migration/upsert/override tests. It uses a unique test database, leaving the app's
records untouched. Logic tests cover PayPal funding/bundled debits/refunds,
ambiguous matches, account preservation, manual rule precedence, import conflicts,
semantic budget coverage, salary aggregation, recurring intervals, and timelines.
