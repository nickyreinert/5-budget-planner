# gocardless-proxy

A minimal Cloudflare Worker that holds your GoCardless Bank Account Data API
frontend needs. It exists because the 5ive app itself is a static, client-only
frontend needs. It exists because the app itself is a static, client-only
site with no backend — GoCardless's `secret_id`/`secret_key` must never
reach the browser, so this small Worker is the one piece of server-side
code in the whole project.

It is deliberately stateless: no KV, no token caching. It fetches a fresh
GoCardless access token on every incoming request. For one personal user
that's simpler to deploy and plenty fast; if you ever hit GoCardless's rate
limits, adding a Workers KV-backed token cache would be the first thing to
add (not included here — see `gc_token()` in `src/index.js`).

## One-time setup

1. **GoCardless**: create a free account at
   [bankaccountdata.gocardless.com](https://bankaccountdata.gocardless.com/)
   and grab your `secret_id` and `secret_key` from the dashboard. **Before
   deploying**, skim their current API docs
   (docs.gocardless.com/bank-account-data/quick-start-guide) and compare
   against `gc_token()`/the route handlers in `src/index.js` — this Worker
   was written against that doc on 2026-09-20, but third-party APIs do
   change field names occasionally.

2. **Cloudflare**: you need a (free) Cloudflare account and to be logged
   into Wrangler:

   ```bash
   cd gocardless-proxy
   npm install
   npx wrangler login
   ```

3. **Set the secrets** (you'll be prompted for each value interactively —
   never pass them as command-line arguments):

   ```bash
   npx wrangler secret put GC_SECRET_ID
   npx wrangler secret put GC_SECRET_KEY
   npx wrangler secret put APP_KEY
   ```

   `APP_KEY` is a value you make up yourself (e.g. a random password) — it's
   a lightweight abuse gate on this Worker's otherwise-public URL, not real
   security (anything the browser sends can't be a true secret). Enter the
   same value into the app's Settings → 🏦 Bank tab.

4. If you're hosting the app somewhere other than `money.nickyreinert.de`,
   edit `ALLOWED_ORIGIN` in `wrangler.jsonc` first.

5. **Deploy**:

   ```bash
   npx wrangler deploy
   ```

   This prints the Worker's URL (`https://five-gocardless-proxy.<your-subdomain>.workers.dev`).
   Enter that URL, along with the `APP_KEY` from step 3, into the app's
   Settings → 🏦 Bank tab.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in real values, never commit this file
npx wrangler dev
```

Point the app's Settings → 🏦 Bank tab at `http://localhost:8787` while
testing locally (the Worker allows any `http://localhost:*` origin in
addition to `ALLOWED_ORIGIN`).

## Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/institutions?country=de` | List banks GoCardless supports for a country |
| `POST` | `/requisitions` `{institution_id, redirect}` | Start a bank connection - creates the agreement + requisition, returns `{id, link}` (`link` is where the user consents at their bank) |
| `GET` | `/requisitions/:id` | Check consent status and get the resulting account id(s) |
| `GET` | `/accounts/:id/transactions` | Fetch an account's transactions |

All routes (except `OPTIONS` preflight) require an `X-App-Key` header
matching the `APP_KEY` secret, if one is set.
