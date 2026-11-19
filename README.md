# Piano steps

Practice app for a young child on a MIDI keyboard (built for the Casio LK-S250).
Enter an exercise by finger numbers or by playing it; in practice the app waits for the
right key, builds a brick wall per block, and gives 1–3 stars.

Plain HTML/CSS/JS, no build step. Lessons are stored in Firestore per Google account,
with an offline cache. Run anywhere else (local server) and it falls back to browser storage.

## Run locally

```sh
npx serve public        # http://localhost:3000, browser storage only
```

Web MIDI works on `localhost` and HTTPS only, in Chrome/Edge (not Safari/iOS).

## Firebase setup (once, free Spark plan, no card)

1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
2. **Project settings → Your apps → Web** (`</>`): register a web app. No need to copy the config;
   Firebase Hosting serves it to the app at `/__/firebase/init.json`.
3. **Authentication → Sign-in method → Google**: enable.
4. **Firestore Database → Create database**: production mode, location `europe-west3` (Frankfurt).
   The location can't be changed later.
5. Deploy:

   ```sh
   npm i -g firebase-tools
   firebase login
   firebase use --add          # pick the project; writes .firebaserc (commit it)
   firebase deploy             # hosting + Firestore rules
   ```

   The app is at `https://<project-id>.web.app`.

## Auto-deploy from GitHub

```sh
firebase init hosting:github
```

It creates the service-account secret in the repo and writes the workflows
(deploy on push to `main`, preview channel on pull requests).
It deploys hosting only; after changing `firestore.rules`, run `firebase deploy --only firestore:rules`.

## Data

`users/{uid}/data/exercises` and `users/{uid}/data/settings`, each a JSON string in field `json`.
Rules (`firestore.rules`) let a user read and write only their own documents.
On first sign-in, lessons already in that browser are copied to the account if the account is empty.

## Keyboard

LK-S250: USB **Micro-B** port marked TO HOST. Android: USB-C ↔ Micro-B **data** cable.
No Bluetooth (the WU-BT10 adapter doesn't support this model).
