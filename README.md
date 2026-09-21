# MoneyMoney Analyzer

Local-first CSV budgeting app with a compact **Woche** view and a historical
**Übersicht** dashboard. Transactions and manual entries live in IndexedDB;
settings and preferences live in localStorage. Bank data is not sent to an LLM
by the app. You choose what to share with an external LLM.

Run locally:

```sh
python3 -m http.server 3000
```

Open http://localhost:3000. Production has a service-worker app shell and PWA
manifest. Localhost skips service-worker registration so development changes
are visible. Chart.js currently loads from its CDN and needs network access.

## CSV → suggested settings → manual refinement

1. Copy the prompt in **Einstellungen → Export / Import** and give it your CSV
   history (or the app's LLM export). The prompt also lives in
   [examples/budget-llm-prompt.txt](examples/budget-llm-prompt.txt).
2. Ask the LLM to identify salary streams, ongoing contracts, semantic
   transaction categories, approximately five main budgets, and weekly limits.
3. Import the returned JSON and your CSV in either order.
4. Review and adjust categories, contracts, income patterns, budget mappings,
   and limits in Settings. Right-click an expense category or tap its menu to
   rename it or remove it by moving its rules/bookings to another category.

Untouched bundled defaults can be replaced by the first JSON import. Subsequent
imports show each proposed addition, edit, or deletion before saving. Local
changes are unchecked by default. Local rules run before imported rules,
regardless of the LLM's numeric priority. Manual per-transaction assignments
continue to win. The import baseline and local precedence survive reload.
Imports validate the complete selected result before saving; cancel changes
nothing. Export settings before intentionally replacing local changes.

## Accounts and PayPal

The source account must be known to reconcile PayPal reliably. A MoneyMoney
export's **Konto / Bank may describe the counterparty**, so these columns are
never assumed to be the source account. In CSV settings either:

- Map the source-account column (default `Kontoname`; `Account` and `Eigenes Konto`
  are also recognized), or
- For a file containing a single account, enter its name, such as `DKB Giro` or
  `PayPal`, before importing it. Use separate imports for separate accounts.

Mixed-account CSVs without a source-account identifier remain usable for
categorization, but cannot safely provide account trends or PayPal matching.
The dashboard explicitly identifies this missing information.

For known accounts, the app links PayPal merchant purchases to bank PayPal
debits of the same sign and exact amount within seven days (or the larger
configured transfer window). Unique combinations of purchases can match a
bundled debit. Each purchase is used once. Merchant details and categories are
retained, and the purchase is attributed to the funding bank in consolidated
and bank views. Selecting PayPal also allows inspection of its original merchant
activity; these account views are not additive. Purchase dates are retained.
PayPal bank-account funding legs and matched bank settlements are excluded from
consolidated cashflow. Ambiguous/unmatched settlements remain visible with a
notice; incomplete or ambiguous imports can therefore still include duplicates
until the missing history or account information is supplied. The app never
hides every PayPal debit merely because its name contains PayPal.

Other internal-transfer pairing requires explicitly classified transfer rows
on different known accounts. An arbitrary expense and an unrelated incoming
payment no longer disappear just because their amounts cancel.

Overlapping CSV imports upsert records and retain history. Identity includes
source account, date, payee, purpose, signed cents, and occurrence number.
Accountless legacy records are upgraded on reimport, including category/amount
overrides. Already stored records from older app versions may lack account
information and need reimporting with the source-account mapping.

Manual purchases reconcile one-to-one with both CSV imports and booked DKB/GoCardless transactions by exact calendar date and signed cents. The manual category is retained; unmatched imports use classification rules, then Unkategorisiert / Nicht zugeordnet for expenses or Zusätzliche Einnahmen for incoming amounts. Repeated imports and bank syncs retain this reconciliation. This existing heuristic can match unrelated same-day amounts;
source records remain stored. GoCardless records are also stored independently.
See [gocardless-proxy/README.md](gocardless-proxy/README.md) for optional bank sync.

## Budget model

Every non-recurring expense belongs to a transaction category and a main budget.
Unknown purposes use **Unkategorisiert → Nicht zugeordnet** until refined. Amazon,
PayPal, Klarna and banks are merchants/payment routes, not semantic categories.
Income, recurring contracts and internal transfers have their own treatment.

Monthly income is the median of the last three available salary-month totals,
including multiple salary streams. Salary rules use `incomeType: "salary"`;
legacy categories containing Gehalt/Lohn/Salary are recognized as well.
Current ongoing contracts are normalized to monthly amounts. An explicit
`recurring.intervalMonths` supports new monthly, quarterly, semiannual and annual
contracts; otherwise the interval is inferred from repeated bookings.

```text
weekly allowance = (monthly salary − monthly recurring costs) × 12 / 52
```

All non-recurring outgoing payments, including legacy reserve/savings categories,
count toward budgets. They are not also deducted from the allowance as reserves.
Other incoming payments (including refunds and sales) appear as **Zusätzliche Einnahmen**
in cashflow; they do not increase salary or the weekly allowance and do not
reduce recorded budget spend. Manually set budget limits are optional; their
sum and the calculated allowance are displayed in Settings. A negative allowance
is shown as a shortfall rather than silently increased.

LLM limits are suggestions, expressed in integer cents. A `budgetRecommendation`
can explain its income/fixed-cost basis. Its proposed allowance cannot exceed
income minus contracts, and proposed caps cannot exceed that allowance. The app
also calculates its own basis from the imported transactions.

## Übersicht and Woche

Übersicht begins with expenses, income, net cashflow and savings rate. Its sticky
filters apply to all three charts: year, selected week/month, account, and
week/month/year granularity. Charts default to monthly stacked bars:

- **Budgetausgaben**: budget → transaction categories.
- **Wiederkehrende Ausgaben**: recurring category → payment recipients.
- **Finanzielle Entwicklung**: salary, additional income, and expenses, with net
  cashflow per period. This is movement, not an absolute bank balance.

Top cards scroll to the corresponding chart. Weekly savings cells filter the
charts to that week; a monthly Gesamt cell selects that month. Reset clears time
drilldown and chart drilldown while retaining year/account/granularity. Historical
weeks are anchored to available data, avoiding invented savings after the last
import. Chart drill buttons provide keyboard/touch alternatives to clicking bars.
There is no YoY view or transaction table at the bottom.

Woche shows allowance, expandable main-budget progress, editable transactions,
favorite expense categories, and the budget calculation. Desktop uses two columns;
phone layouts keep compact rows and readable transaction descriptions.

## Settings fields

See the in-app prompt for a complete example. Core fields:

- `version`, `name`, `groups`, `rules`.
- Rule: unique `id`, `category`, `group`, optional regex fields `namePattern`,
  `verwendungPattern`, `kategoriePattern`, `matchType`, `priority`, `budgetCategory`.
- Optional rule `incomeType: "salary" | "other"` and
  `recurring: { "intervalMonths": 1 | 3 | 6 | 12 }`.
- `mainCategories`: ordered `{ id, label, color?, entryCategory? }` budgets.
- `categoryMappings`: transaction category → main budget ID.
- `subBudgetCaps`: main budget ID → weekly integer cents.
- `budgetRecommendation`: `monthlyIncomeCents`, `monthlyFixedCents`,
  `weeklyLimitCents`, optional `rationale`.

CSV categories are ignored by default; when enabled, fallback can only use
categories in the active settings catalog. Missing expense mappings remain explicitly unassigned. Unkategorisiert is always available in quick entry, even before importing settings. Invalid regexes, duplicate IDs, invalid intervals, unknown
budget references, and invalid limits are rejected before import.

## Validation

```sh
node --test tests/*.test.mjs
```

Open `tests/storage.test.html` through the local server for real IndexedDB
migration/upsert/override tests. It uses a unique test database, leaving the app's
records untouched. Logic tests cover PayPal funding/bundled debits/refunds,
ambiguous matches, account preservation, manual rule precedence, import conflicts,
semantic budget coverage, salary aggregation, recurring intervals, and timelines.
