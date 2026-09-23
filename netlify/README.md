# netlify/ — cloud sync backend

Backs the Settings → 🔄 Sync tab. The app itself is a static, client-only
site, so this is the one piece of server-side code needed to let a user
sign in with their Google account and back up/restore their SETTING (and
optionally transaction data) across devices - via a Netlify Function and
Netlify Database (managed Postgres).

Nothing here is required to use the app - Sync just stays inert (shows
"noch nicht eingerichtet") until it's set up.

## How it works

- **Auth**: the client uses Google Identity Services ("Sign in with
  Google") to get a short-lived ID token - no password, no Netlify
  Identity (deprecated for new sites). The Google OAuth Client ID itself
  is not a secret, but it still isn't hardcoded in the repo: the client
  fetches it once from this function's `GET` response, which reads it
  from an env var. That keeps the whole thing configurable per
  deployment without touching source.
- **Verification**: every write/read request re-verifies the ID token
  server-side (`google-auth-library`, audience pinned to
  `GOOGLE_CLIENT_ID` from the env - never a client-supplied value, or
  anyone could pass verification with a token minted for a totally
  different app). There is no server-side session/cookie - the client
  just re-sends the ID token with each request; when it expires (~1h)
  the user re-connects.
- **Storage**: one row per `(user_sub, collection)` in a `sync_data`
  table (`collection` is `'setup'` or `'transactions'`, matching what
  `index.html` already gathers for Export/Import). See
  `netlify/database/migrations/0001_create_sync_data.sql`.

## One-time setup

1. **Netlify Database**: this project has no root `package.json` (static
   site, no build step) - Netlify only auto-provisions a database if the
   `@netlify/database` module is installed, so run this once against the
   linked site:

   ```bash
   npx netlify-cli database init
   ```

   Confirm the pending migration in `netlify/database/migrations/` when
   prompted. This creates the `sync_data` table and sets `NETLIFY_DB_URL`
   automatically for Functions/builds - nothing to copy/paste.

2. **Google Cloud OAuth Client ID**: in the
   [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
   create an **OAuth client ID** of type **Web application**. Add your
   site's real origin (e.g. `https://money.nickyreinert.de`) under
   *Authorized JavaScript origins* - Google Identity Services requires an
   exact origin match, `http://127.0.0.1:5500` (or whatever you use
   locally) needs to be added too if you want to test signed-in flows
   before deploying.

3. **Set the env var** on the Netlify site (never commit it):

   ```bash
   npx netlify-cli env:set GOOGLE_CLIENT_ID "your-client-id.apps.googleusercontent.com"
   ```

4. **Deploy** (or push to the branch Netlify builds from) - migrations
   apply automatically before the deploy goes live.

## Cost note

Netlify Database is only available on credit-based plans and consumes
credits while active (storage itself is free until 2026-07-01 per
Netlify's current pricing page at the time this was written - re-check
before relying on that). For a single-user hobby app the usage is tiny,
but it isn't unconditionally free like the rest of this static site.

## Local testing

```bash
npx netlify-cli dev
```

Runs the function + a local database branch together. Point the app's
`fetch('/.netlify/functions/sync')` calls at whatever origin `netlify dev`
prints (proxies the static files too, so you can usually just open that
URL directly instead of the plain `http://127.0.0.1:5500` dev server).
