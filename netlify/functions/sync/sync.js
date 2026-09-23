// Netlify Function backing Settings > Sync (see src/sync.js + README.md
// in this folder). Two jobs, both stateless (no server-side sessions):
//
//   GET  -> returns the public Google OAuth Client ID so the client can
//           render "Sign in with Google" - not a secret, safe to expose.
//   POST -> { idToken, action: 'push'|'pull', collection: 'setup'|'transactions', data? }
//           verifies the Google ID token server-side (audience pinned to
//           GOOGLE_CLIENT_ID, never trusts a client-supplied audience),
//           then reads/writes one row per (user, collection) in Postgres.
//
// Required env vars (Netlify site settings, never committed):
//   GOOGLE_CLIENT_ID - Google Cloud OAuth Client ID (Web application)
//   NETLIFY_DB_URL   - auto-set once Netlify Database is enabled
const postgres = require('postgres');
const { OAuth2Client } = require('google-auth-library');

const COLLECTIONS = ['setup', 'transactions'];

let sql = null;
function db() {
  if (!sql) sql = postgres(process.env.NETLIFY_DB_URL);
  return sql;
}

let oauthClient = null;
async function verify_token(idToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!oauthClient) oauthClient = new OAuth2Client(clientId);
  const ticket = await oauthClient.verifyIdToken({ idToken, audience: clientId });
  return ticket.getPayload();
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type'
};

function json(statusCode, body) {
  return { statusCode, headers: { ...CORS_HEADERS, 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS };

  if (event.httpMethod === 'GET') {
    return json(200, { googleClientId: process.env.GOOGLE_CLIENT_ID || null });
  }

  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (!process.env.GOOGLE_CLIENT_ID) return json(503, { error: 'not_configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid_json' }); }
  const { idToken, action, collection, data } = body;
  if (!idToken || !action) return json(400, { error: 'missing_fields' });
  if (!COLLECTIONS.includes(collection)) return json(400, { error: 'invalid_collection' });

  let payload;
  try { payload = await verify_token(idToken); }
  catch { return json(401, { error: 'invalid_token' }); }

  const client = db();
  if (action === 'push') {
    if (data === undefined) return json(400, { error: 'missing_data' });
    await client`
      INSERT INTO sync_data (user_sub, collection, data, updated_at)
      VALUES (${payload.sub}, ${collection}, ${client.json(data)}, now())
      ON CONFLICT (user_sub, collection) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
    `;
    return json(200, { ok: true });
  }
  if (action === 'pull') {
    const rows = await client`SELECT data FROM sync_data WHERE user_sub = ${payload.sub} AND collection = ${collection}`;
    return json(200, { data: rows[0]?.data ?? null });
  }
  return json(400, { error: 'unknown_action' });
};
