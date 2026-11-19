// Firebase: Google sign-in + Firestore, each user's data under users/{uid}/data/{key}.
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
    { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut },
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
    signIn: () => signInWithPopup(auth, new GoogleAuthProvider()),
    signOut: () => signOut(auth),
    store(uid) {
      const ref = k => doc(db, 'users', uid, 'data', k);
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
