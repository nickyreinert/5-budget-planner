// --- sync.js ---
// Optional cloud sync via Firebase Auth ("Sign in with Google") + Firestore.
// Data lives under users/{uid}/sync_{collection}/ - see the Firestore rules
// that restrict access to the owning user. The firebaseConfig below is
// public by design; access is enforced by the rules, not by hiding it.
//
// A Firestore document is capped at 1 MiB, so the JSON payload is split
// into text chunks (docs "0", "1", ...) plus a "meta" doc holding the
// chunk count, written last so a half-finished upload is never read.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { getFirestore, doc, getDoc, getDocs, setDoc, deleteDoc, collection } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyDLklCTVAjelhrogbMl7dvPkLIUIqbQ_OI',
  authDomain: location.hostname === '5.1-1-1.de' ? location.host : 'budgets-83ffd.firebaseapp.com',
  projectId: 'budgets-83ffd',
  storageBucket: 'budgets-83ffd.firebasestorage.app',
  messagingSenderId: '283214914221',
  appId: '1:283214914221:web:a976bb56ad6dfcf9635c24'
};

const INCLUDE_TX_KEY = 'syncIncludeTransactions';
const CHUNK_CHARS = 300000; // well under 1 MiB even at 3 bytes/char

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export function get_sync_settings() {
  return { includeTransactions: localStorage.getItem(INCLUDE_TX_KEY) === '1' };
}

export function save_sync_settings({ includeTransactions }) {
  localStorage.setItem(INCLUDE_TX_KEY, includeTransactions ? '1' : '0');
}

export function current_session() {
  const user = auth.currentUser;
  return user ? { uid: user.uid, email: user.email } : null;
}

export async function sign_out() {
  await signOut(auth);
}

// Renders a "Sign in with Google" button into `container`. A session
// restored from a previous visit calls `onSignedIn` right away.
export async function render_google_button(container, onSignedIn) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Sign in with Google';
  button.addEventListener('click', async () => {
    const { user } = await signInWithPopup(auth, new GoogleAuthProvider());
    onSignedIn({ uid: user.uid, email: user.email });
  });
  container.replaceChildren(button);
  await auth.authStateReady();
  if (auth.currentUser) onSignedIn(current_session());
}

function user_collection(name) {
  if (!auth.currentUser) throw new Error('not_signed_in');
  return collection(db, 'users', auth.currentUser.uid, `sync_${name}`);
}

// `name` is one of 'setup' or 'transactions' - see index.html, which
// decides what goes into each (setup = SETTING JSON, transactions = CSV
// imports + manual entries + category overrides, only gathered when the
// user opted in via the "also sync transaction data" checkbox).
export async function push_data(name, data) {
  const col = user_collection(name);
  const text = JSON.stringify(data);
  const count = Math.max(1, Math.ceil(text.length / CHUNK_CHARS));
  const previous = await getDoc(doc(col, 'meta'));
  const previousCount = previous.exists() ? previous.data().count : 0;
  for (let i = 0; i < count; i++) {
    await setDoc(doc(col, String(i)), { text: text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) });
  }
  await setDoc(doc(col, 'meta'), { count, updatedAt: Date.now() });
  for (let i = count; i < previousCount; i++) await deleteDoc(doc(col, String(i)));
}

export async function pull_data(name) {
  const col = user_collection(name);
  const meta = await getDoc(doc(col, 'meta'));
  if (!meta.exists()) return null;
  const { count } = meta.data();
  const chunks = new Array(count);
  (await getDocs(col)).forEach(d => {
    if (d.id !== 'meta' && Number(d.id) < count) chunks[Number(d.id)] = d.data().text;
  });
  if (chunks.some(c => c === undefined)) throw new Error('sync_incomplete');
  return JSON.parse(chunks.join(''));
}
