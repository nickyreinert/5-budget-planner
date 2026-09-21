// --- sync.js ---
// Optional cloud sync via Firebase (Google sign-in + Firestore), configured
// by pasting a Firebase project's web config under Settings > Sync. Nothing
// here loads or runs until a config is saved and a sync action is
// triggered - the Firebase SDK is fetched from its CDN lazily on first use,
// so projects that never touch Sync pay no extra cost.

const CONFIG_KEY = 'syncFirebaseConfig';
const INCLUDE_TX_KEY = 'syncIncludeTransactions';
const FIREBASE_VERSION = '10.13.0';

export function get_sync_config() {
  let firebaseConfig = null;
  try { firebaseConfig = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null'); } catch (e) { /* ignore malformed value */ }
  return { firebaseConfig, includeTransactions: localStorage.getItem(INCLUDE_TX_KEY) === '1' };
}

export function save_sync_config({ firebaseConfig, includeTransactions }) {
  if (firebaseConfig) localStorage.setItem(CONFIG_KEY, JSON.stringify(firebaseConfig));
  else localStorage.removeItem(CONFIG_KEY);
  localStorage.setItem(INCLUDE_TX_KEY, includeTransactions ? '1' : '0');
}

let firebaseApp = null;
let firebaseAuth = null;
let firebaseDb = null;
let firebaseSdk = null;

// Loads the Firebase SDK and initializes app/auth/firestore on first use;
// reused afterwards since Firebase throws if initializeApp() runs twice.
async function ensure_firebase(firebaseConfig) {
  if (firebaseApp) return { auth: firebaseAuth, db: firebaseDb, sdk: firebaseSdk };
  const [{ initializeApp }, authMod, storeMod] = await Promise.all([
    import(/* webpackIgnore: true */ `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`),
    import(/* webpackIgnore: true */ `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-auth.js`),
    import(/* webpackIgnore: true */ `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-firestore.js`)
  ]);
  firebaseApp = initializeApp(firebaseConfig);
  firebaseAuth = authMod.getAuth(firebaseApp);
  firebaseDb = storeMod.getFirestore(firebaseApp);
  firebaseSdk = { ...authMod, ...storeMod };
  return { auth: firebaseAuth, db: firebaseDb, sdk: firebaseSdk };
}

export async function sign_in(firebaseConfig) {
  const { auth, sdk } = await ensure_firebase(firebaseConfig);
  const { user } = await sdk.signInWithPopup(auth, new sdk.GoogleAuthProvider());
  return user;
}

export async function sign_out(firebaseConfig) {
  const { auth, sdk } = await ensure_firebase(firebaseConfig);
  await sdk.signOut(auth);
}

export async function current_user(firebaseConfig) {
  const { auth } = await ensure_firebase(firebaseConfig);
  return auth.currentUser;
}

// auth.currentUser can still be null right after ensure_firebase() even for
// an already-signed-in browser, since Firebase restores persisted auth
// state asynchronously - subscribe instead of polling current_user() to
// reflect that restored state once it resolves (e.g. right after the Sync
// tab is opened).
export async function on_auth_change(firebaseConfig, callback) {
  const { auth, sdk } = await ensure_firebase(firebaseConfig);
  return sdk.onAuthStateChanged(auth, callback);
}

// `collection` is one of 'setup' or 'transactions' - see index.html, which
// decides what goes into each (setup = SETTING JSON, transactions = CSV
// imports + manual entries + category overrides, only gathered when the
// user opted in via the "also sync transaction data" checkbox).
export async function push_data(firebaseConfig, uid, collection, data) {
  const { db, sdk } = await ensure_firebase(firebaseConfig);
  await sdk.setDoc(sdk.doc(db, 'users', uid, 'sync', collection), { data, updatedAt: sdk.serverTimestamp() });
}

export async function pull_data(firebaseConfig, uid, collection) {
  const { db, sdk } = await ensure_firebase(firebaseConfig);
  const snap = await sdk.getDoc(sdk.doc(db, 'users', uid, 'sync', collection));
  return snap.exists() ? snap.data().data : null;
}
