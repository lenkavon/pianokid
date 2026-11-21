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

## Entering notes

Typing mode (default). One line per row of the sheet, fixed octaves, finger after each note:

```
C D E F G A H           octave 4: C = middle C (C4)
C'  C''   C,  C,,       one / two octaves up, one / two down (C5, C6, C3, C2)
E3                      finger 3 (missing → guessed from the previous note, marked ?)
R: / P:   L:            right / left hand; no prefix keeps the previous hand
C1+E3   E3+L: C,5       pressed together (chord), also across hands
|                       ignored, use for bars
```

"Pause after each line" turns lines into blocks. Notes outside the LK-S250's range (C2–C7) are flagged.
Texts saved before this format are rewritten from their saved notes when opened. Parser: `public/notation.js`.

**Import MIDI file** (next to the notes box) converts a .mid into this text: pick the tracks to keep
(usually just the melody) and the hand for each (or split at middle C); notes starting together become
chords, one line per 1/2/4 bars, tempo is taken from the file; fingers are then guessed (marked ?).
Parser: [@tonejs/midi](https://github.com/Tonejs/Midi) 2.0.28, vendored in `public/vendor` (MIT).
"Pause after each line" turns lines into blocks. Parser: `public/notation.js`.

## Data and access

Lessons and settings are shared by the family: `spaces/family/data/exercises` and `.../settings`,
each a JSON string in field `json`.
Only the Google accounts listed in `firestore.rules` (`family()`) can read or write them; anyone else
who signs in sees a "No access" screen. To add a person, add their email there and run
`firebase deploy --only firestore:rules` (the GitHub workflow deploys hosting only).

When the family space is empty, the first sign-in copies lessons from that user's older private
space (`users/{uid}/data`) or, failing that, from the browser.

## Locks and sharing

- **Editing lock** (🔒, per device): editing is hidden until unlocked by the secret melody
  (Settings) or, if none is set, by typing `edit`.
- **Shared songs** (🌍 "Free to share" on an exercise): copied to `shared/{sha256(door melody)}/data`.
  Without a family login the app shows a door screen; playing the door melody opens those songs
  (play only, stars kept on that device). Rules allow `get` but not `list` there, so the path is
  only reachable by someone who knows the melody. Changing the melody deletes the old copy.

## Keyboard

LK-S250: USB **Micro-B** port marked TO HOST. Android: USB-C ↔ Micro-B **data** cable.
No Bluetooth (the WU-BT10 adapter doesn't support this model).
