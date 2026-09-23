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

Open <http://localhost:3000>. The app stores transactions and manual entries
in IndexedDB and settings in localStorage. Bank data stays in the browser; the
app does not send it to an LLM. You decide what to share with an external LLM.

## Deploy manually from your PC

Automatic Netlify builds can stay disabled. To publish the current working tree
from your computer, install/link the site once and then run:

```sh
npx netlify-cli login
npx netlify-cli link
./deploy.sh
```

`deploy.sh` publishes the static site and the optional Netlify Functions to the
production site. This keeps the public domain and cloud-sync backend while
avoiding a build on every Git push. Function environment variables such as
`GOOGLE_CLIENT_ID` and `NETLIFY_DB_URL` remain managed in Netlify site settings.

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

Known PayPal merchant purchases can be matched to corresponding bank debits by
exact signed amount and date window. Ambiguous matches remain visible instead
of being silently removed. Other internal transfers require explicitly
classified transfer rows on different known accounts.

## Settings and imports

Settings JSON contains budgets (`mainCategories`), transaction-to-budget
mappings (`categoryMappings`), classification rules, and optional budget
recommendations. Amounts are integer cents. Rules can identify salary,
recurring contracts, transfers, and transaction purposes using JavaScript
regular expressions.

The first import can replace the bundled defaults. Later imports show proposed
additions, edits, and deletions before saving. Local rules and manual
per-transaction assignments take precedence over imported suggestions. Export
your settings before intentionally replacing local changes.

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
