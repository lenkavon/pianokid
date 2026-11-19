// Firebase: Google sign-in + Firestore. Lessons are shared by the family under spaces/family/data/{key}.
// Config comes from Firebase Hosting's reserved URL, so there's nothing to paste.
// Anywhere else (local dev server) connectCloud() returns null and the app uses browser storage.
const V = '13.4.0';
const B = `https://www.gstatic.com/firebasejs/${V}`;

export async function connectCloud() {
  let config;
  try {
    const r = await fetch('/__/firebase/init.json');
    if (!r.ok) return null;
    config = await r.json();
  } catch (e) {
    return null;
  }

  const [
    { initializeApp },
    { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut },
    { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, getDoc, setDoc, deleteDoc },
  ] = await Promise.all([
    import(`${B}/firebase-app.js`),
    import(`${B}/firebase-auth.js`),
    import(`${B}/firebase-firestore.js`),
  ]);

  const app = initializeApp(config);
  const auth = getAuth(app);
  // Offline cache: practice works without wifi, changes sync when back online
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });

  const user = await new Promise(resolve => {
    const stop = onAuthStateChanged(auth, u => { stop(); resolve(u); });
  });

  return {
    user,
    async signIn() {
      const provider = new GoogleAuthProvider();
      try {
        await signInWithPopup(auth, provider);
      } catch (e) {
        // popups can be blocked, e.g. when opened from a home-screen shortcut → fall back to a full-page redirect
        if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(e.code)) return signInWithRedirect(auth, provider);
        throw e;
      }
    },
    signOut: () => signOut(auth),
    // path: collection segments, e.g. ['spaces', 'family', 'data']
    store(path) {
      const ref = k => doc(db, ...path, k);
      return {
        // throws when offline and nothing is cached, so callers can tell "missing" from "unknown"
        async get(k) {
          const snap = await getDoc(ref(k));
          return snap.exists() ? JSON.parse(snap.data().json) : null;
        },
        // stored as a JSON string: simple, and well under Firestore's 1 MiB document limit
        set: (k, v) => setDoc(ref(k), { json: JSON.stringify(v), updated: Date.now() }),
        del: k => deleteDoc(ref(k)),
      };
    },
  };
}
