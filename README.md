# Tony's List — offline iPhone app (PWA)

Flight-strip task board that opens with no signal, keeps every edit on the device, and syncs through Supabase when you have a connection.
Same look as the claude.ai version: NOW / NEXT / LATER bays, types, steps, phones, places, Thoughts, Landed, split-flap board.

**Daily review:** the board builds its own "Today's 3" review on the device, once per day when you open the app (and on the REFRESH REVIEW button). Same rules as the old 0645 routine: overdue first, due today or tomorrow, top of NOW, due within 3 days, stuck over 14 days. No network, no cost, works offline, and it syncs to your other devices.

**Not in this version:** "Turn into strips" (needs Claude and an API key). Reminders import is a separate problem.

## One-time setup (about 30 minutes)

### 1. Supabase (the sync server, free tier)
1. supabase.com > New project. Pick a region near you. Save the database password somewhere.
2. SQL Editor > New query > paste all of `supabase/schema.sql` > Run. You should see "Success".
3. Authentication > Sign In / Providers (or Settings): turn **off** "Allow new users to sign up".
4. Authentication > Users > Add user > Create new user. Use your email and a strong password. Tick "Auto Confirm User".
5. Project Settings > API: copy the **Project URL** and the **anon public** key into `app/config.js`.
   Both are meant to be public. The row-level security in the SQL is what protects your data.

### 2. GitHub Pages (hosts the app code only, never your data)
1. Create a new **public** repo (free Pages needs public). Push this folder to `main`.
   `seed/` and `*.seed.json` are git-ignored on purpose. Keep your migration file out of the repo.
2. Repo > Settings > Pages > Source: **GitHub Actions**.
3. The "Deploy Tony's List" action runs on every push. It downloads the fonts and Sortable from npm, stamps a build id, and publishes `app/`.
4. Your URL will be `https://<you>.github.io/<repo>/`.

### 3. Put it on the iPhone
1. Open the URL in **Safari** (not Chrome). Share > Add to Home Screen.
2. Open it from the Home Screen icon once, **online**, and let it finish loading.
3. Tap SYNC / DATA > sign in with the user from step 1.4.
4. Test: turn on Airplane Mode, open the app, add a strip, mark one done. Turn Airplane Mode off and watch the banner clear.

### 4. Move your existing board over
On the Mac, open the app URL, SYNC / DATA > sign in > IMPORT JSON > pick `Tony's List seed ... .json`. It syncs to the phone on its own.
Import only adds what's missing, so running it twice is safe.

## Good to know
- Conflicts: last write wins per strip, by timestamp. Fine for one person on two devices. Keep both device clocks on automatic time.
- Free Supabase projects pause after about a week of no use. Opening the dashboard and clicking Restore brings it back. Nothing is lost, and your phone keeps working offline meanwhile.
- iOS can clear web storage for sites you haven't opened in weeks. The Home Screen install plus the persistent-storage request reduces this, and a full re-pull from Supabase repairs it. Export a JSON backup now and then from SYNC / DATA.
- Deletes are kept as tombstones on the server so they reach other devices. A strip can't come back from the dead after a sync.

## Run it on your Mac
```
npm install
npm run vendor
python3 -m http.server 8000 --directory app
```
Open http://localhost:8000. Service workers work on localhost.

## Files
- `app/index.html` the whole UI (your original, with the storage layer swapped)
- `app/localdb.js` IndexedDB store, same API the UI already used
- `app/sync.js` push/pull, sign-in, retry
- `app/sw.js` offline cache
- `supabase/schema.sql` table, row-level security, push function
- `.github/workflows/pages.yml` build and deploy
