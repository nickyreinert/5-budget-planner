// --- gocardless-proxy: minimal Cloudflare Worker ---
// Holds the GoCardless secret_id/secret_key (never exposed to the browser)
// and proxies the handful of Bank Account Data API calls the MoneyMoney
// Analyzer frontend needs. Deliberately stateless - no KV/token caching:
// this serves one personal user, so re-fetching a token per incoming
// request is simpler to deploy and plenty fast enough. Add caching later
// if that ever stops being true.
//
// API reference used (verified against the live docs on 2026-09-20):
// https://docs.gocardless.com/bank-account-data/quick-start-guide
// If GoCardless renames a field, gc_token()/the route handlers below are
// the only places that need touching.

const GC_BASE = 'https://bankaccountdata.gocardless.com';

function cors_headers(origin, allowedOrigin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
  // Also allow localhost on any port, for local frontend development.
  if (origin && (origin === allowedOrigin || /^https?:\/\/localhost(:\d+)?$/.test(origin))) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function json_response(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders }
  });
}

// Manual constant-time string comparison for the shared app-key header -
// avoids a timing side-channel without needing the nodejs_compat flag just
// for Node's crypto.timingSafeEqual (Web Crypto's SubtleCrypto has no
// equivalent).
function safe_equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The only place that talks to GoCardless's auth endpoints. Some GoCardless
// deployments return an access token directly from /token/new/; others only
// a refresh token that then needs exchanging via /token/refresh/ - handle
// both so a minor API-shape difference doesn't break everything.
async function gc_token(env) {
  const newTokenRes = await fetch(`${GC_BASE}/api/v2/token/new/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret_id: env.GC_SECRET_ID, secret_key: env.GC_SECRET_KEY })
  });
  if (!newTokenRes.ok) {
    throw new Error(`GoCardless token/new/ failed: ${newTokenRes.status} ${await newTokenRes.text()}`);
  }
  const tokenData = await newTokenRes.json();
  if (tokenData.access) return tokenData.access;
  if (!tokenData.refresh) throw new Error('GoCardless token/new/ returned neither an access nor a refresh token');

  const refreshRes = await fetch(`${GC_BASE}/api/v2/token/refresh/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh: tokenData.refresh })
  });
  if (!refreshRes.ok) {
    throw new Error(`GoCardless token/refresh/ failed: ${refreshRes.status} ${await refreshRes.text()}`);
  }
  return (await refreshRes.json()).access;
}

async function gc_fetch(path, token, options = {}) {
  const res = await fetch(`${GC_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`GoCardless ${path} failed: ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowedOrigin = env.ALLOWED_ORIGIN || 'https://money.nickyreinert.de';
    const headers = cors_headers(origin, allowedOrigin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    // Lightweight abuse gate on this Worker's otherwise-public URL - not
    // real security (a key visible to the browser can't be secret), just
    // raises the bar above "anyone who finds this URL can burn my
    // GoCardless API quota". Skipped if APP_KEY isn't set.
    if (env.APP_KEY && !safe_equal(request.headers.get('X-App-Key') || '', env.APP_KEY)) {
      return json_response({ error: 'unauthorized' }, 401, headers);
    }

    try {
      if (request.method === 'GET' && url.pathname === '/institutions') {
        const country = url.searchParams.get('country') || 'de';
        const token = await gc_token(env);
        const data = await gc_fetch(`/api/v2/institutions/?country=${encodeURIComponent(country)}`, token);
        return json_response(data, 200, headers);
      }

      if (request.method === 'POST' && url.pathname === '/requisitions') {
        const body = await request.json();
        if (!body.institution_id || !body.redirect) {
          return json_response({ error: 'institution_id and redirect are required' }, 400, headers);
        }
        const token = await gc_token(env);

        // Ask for as much transaction history as this specific bank
        // allows, rather than guessing a fixed number of days.
        const country = body.country || 'de';
        const institutions = await gc_fetch(`/api/v2/institutions/?country=${encodeURIComponent(country)}`, token);
        const institution = Array.isArray(institutions) ? institutions.find((i) => i.id === body.institution_id) : null;
        const maxHistoricalDays = Math.min(institution?.transaction_total_days || 90, 730);

        const agreement = await gc_fetch('/api/v2/agreements/enduser/', token, {
          method: 'POST',
          body: JSON.stringify({
            institution_id: body.institution_id,
            max_historical_days: maxHistoricalDays,
            access_valid_for_days: 90,
            access_scope: ['transactions']
          })
        });

        const requisition = await gc_fetch('/api/v2/requisitions/', token, {
          method: 'POST',
          body: JSON.stringify({
            redirect: body.redirect,
            institution_id: body.institution_id,
            agreement: agreement.id,
            reference: crypto.randomUUID()
          })
        });

        return json_response({ id: requisition.id, link: requisition.link }, 200, headers);
      }

      const requisitionMatch = url.pathname.match(/^\/requisitions\/([^/]+)$/);
      if (request.method === 'GET' && requisitionMatch) {
        const token = await gc_token(env);
        const data = await gc_fetch(`/api/v2/requisitions/${encodeURIComponent(requisitionMatch[1])}/`, token);
        return json_response({ status: data.status, accounts: data.accounts || [] }, 200, headers);
      }

      const accountMatch = url.pathname.match(/^\/accounts\/([^/]+)\/transactions$/);
      if (request.method === 'GET' && accountMatch) {
        const token = await gc_token(env);
        const data = await gc_fetch(`/api/v2/accounts/${encodeURIComponent(accountMatch[1])}/transactions/`, token);
        return json_response(data, 200, headers);
      }

      return json_response({ error: 'not found' }, 404, headers);
    } catch (err) {
      console.error(err);
      return json_response({ error: 'proxy_error', message: String(err.message || err) }, err.status && err.status >= 400 && err.status < 600 ? err.status : 502, headers);
    }
  }
};
