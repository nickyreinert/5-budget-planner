// --- sync.js ---
// Optional cloud sync via "Sign in with Google" (Google Identity Services)
// + a Netlify Function backed by Netlify Database (Postgres) - see
// netlify/README.md for the one-time backend setup. There is nothing to
// configure here: the Google OAuth Client ID lives server-side as an env
// var and is fetched once from the function on first use. Inert (the
// sign-in button throws `not_configured`, caught by the caller to show a
// "not set up yet" message) until that env var exists on the Netlify site.

const SYNC_ENDPOINT = '/.netlify/functions/sync';
const INCLUDE_TX_KEY = 'syncIncludeTransactions';

export function get_sync_settings() {
  return { includeTransactions: localStorage.getItem(INCLUDE_TX_KEY) === '1' };
}

export function save_sync_settings({ includeTransactions }) {
  localStorage.setItem(INCLUDE_TX_KEY, includeTransactions ? '1' : '0');
}

let publicConfig = null;
async function fetch_public_config() {
  if (publicConfig) return publicConfig;
  const res = await fetch(SYNC_ENDPOINT);
  if (!res.ok) throw new Error(`config_failed_${res.status}`);
  publicConfig = await res.json();
  return publicConfig;
}

let gsiReady = null;
function load_gsi() {
  if (gsiReady) return gsiReady;
  gsiReady = new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve(window.google);
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => resolve(window.google);
    script.onerror = () => reject(new Error('gsi_load_failed'));
    document.head.append(script);
  });
  return gsiReady;
}

function decode_id_token(idToken) {
  const payload = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(payload));
}

let session = null; // { idToken, email, sub, ... }
export function current_session() { return session; }

export function sign_out() {
  session = null;
  window.google?.accounts?.id?.disableAutoSelect?.();
}

// Renders Google's own "Sign in with Google" button into `container` - the
// ID-token-based Google Identity Services API only supports its own
// button/One-Tap UI, not a custom button triggering a popup. Throws
// `not_configured` if the backend has no Google Client ID set yet.
export async function render_google_button(container, onSignedIn) {
  const { googleClientId } = await fetch_public_config();
  if (!googleClientId) throw new Error('not_configured');
  const google = await load_gsi();
  google.accounts.id.initialize({
    client_id: googleClientId,
    auto_select: true,
    callback: (response) => {
      session = { idToken: response.credential, ...decode_id_token(response.credential) };
      onSignedIn(session);
    }
  });
  container.replaceChildren();
  google.accounts.id.renderButton(container, { theme: 'outline', size: 'large', text: 'signin_with' });
}

async function call_api(action, collection, data) {
  if (!session) throw new Error('not_signed_in');
  const res = await fetch(SYNC_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: session.idToken, action, collection, data })
  });
  if (res.status === 401) { session = null; throw new Error('session_expired'); }
  if (!res.ok) throw new Error(`sync_failed_${res.status}`);
  return res.json();
}

// `collection` is one of 'setup' or 'transactions' - see index.html, which
// decides what goes into each (setup = SETTING JSON, transactions = CSV
// imports + manual entries + category overrides, only gathered when the
// user opted in via the "also sync transaction data" checkbox).
export async function push_data(collection, data) {
  await call_api('push', collection, data);
}

export async function pull_data(collection) {
  const { data } = await call_api('pull', collection, undefined);
  return data;
}
