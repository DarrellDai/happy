---
name: setup-fork-fcm
description: >
  Set up push notifications (FCM) for a personal fork build of Happy when the
  user wants pushes to actually arrive on their phone from a custom EAS build
  (dev or preview profile). Required because the upstream `bulkacorp/happy`
  Expo project's FCM credentials don't transfer to a forked Expo project.
  Use when the user reports "push not arriving on my custom build", or asks
  to "set up FCM for my fork", or hits Expo's `InvalidCredentials` /
  `Unable to retrieve the FCM server key` error.
---

# Setup FCM for a Personal Fork Build

This walks the user through enabling Expo push delivery for a Happy build that runs under their own Expo account (instead of upstream `bulkacorp`). Happy uses Expo Push → FCM for Android delivery; a forked Expo project has no FCM credentials by default, so pushes silently fail with `InvalidCredentials`.

## When to invoke

Only when the user is building their own custom APK (dev or preview profile) and wants push notifications to land on their phone from that custom build. If they're using the Play Store production app, this skill is not needed — upstream's FCM setup already routes their pushes.

## Background — why this work is needed

Three things have to line up for Expo to deliver an Android push:

1. **Expo project** owns the push token registration. For a fork, this is `darrelldai/happy` (or similar) instead of `bulkacorp/happy`. It needs FCM credentials uploaded to its credentials store.
2. **Firebase project** issues the FCM tokens. The app's bundled `google-services.json` points at this project. For a custom build under a forked Expo project, the user needs their *own* Firebase project — they can't use upstream's because they don't have access to its credentials.
3. **FCM credentials must match the Firebase project** that issued the tokens. If the app has Firebase project A's `google-services.json` but Expo has Firebase project B's FCM key, delivery fails with `InvalidCredentials`.

So the setup is: create user's Firebase project, register the relevant Android package names, swap `google-services.json` in the repo, upload the matching FCM service account key to Expo.

## Steps

### 1. Verify the fork already has its own Expo project

The user should have a personal Expo account and an EAS project under it. If they don't have one yet, first walk through:

```bash
npx eas-cli@latest login          # interactive
# Then edit packages/happy-app/app.config.js — see "Three fields to swap" below
npx eas-cli@latest init           # creates a new project under their account
# Note the new projectId. Put it in app.config.js for the duration of builds.
```

These config edits are *temporary, build-time only* — they MUST be reverted before any git commit (the upstream PR shouldn't include the fork-specific projectId, url, or `owner` removal). Keep the upstream values in mind:

- Upstream `owner`: `bulkacorp`
- Upstream `eas.projectId`: `4558dd3d-cd5a-47cd-bad9-e591a241cc06`
- Upstream `updates.url`: `https://u.expo.dev/4558dd3d-cd5a-47cd-bad9-e591a241cc06`

### Three fields to swap (ALL of them — missing any is a permanent build defect)

`packages/happy-app/app.config.js` has **three** places that reference the
upstream project. ALL three must be swapped to fork values before a build —
or commented/replaced as noted. Missing ANY of them creates a half-fork APK
that misbehaves in subtle ways that no later OTA can fix:

```js
// (a) updates.url — line ~176. This is the URL the installed APK queries at
//     launch to fetch OTAs. If left at upstream, this build is PERMANENTLY
//     blind to your OTAs — every `eas update` to your fork will publish
//     successfully but the device will keep getting `isUpdateAvailable=false`
//     / `NoUpdatesAvailable` because it's hitting upstream's server. The only
//     remedy is a rebuild. This is the most-commonly-missed of the three.
updates: {
    url: "https://u.expo.dev/4558dd3d-cd5a-47cd-bad9-e591a241cc06",  // → fork's projectId
    requestHeaders: { "expo-channel-name": "production" }
}

// (b) extra.eas.projectId — line ~189. Identifies which EAS project the
//     build belongs to (build:list/build:view/credentials lookups, FCM key
//     pairing). If left at upstream, EAS rejects the build (no permission).
extra: { eas: { projectId: "4558dd3d-cd5a-47cd-bad9-e591a241cc06" } }  // → fork's projectId

// (c) owner — line ~200. Must be commented out (the fork's project has no
//     explicit owner; it defaults to the logged-in user). If left as
//     "bulkacorp", EAS rejects the build with an ownership error.
owner: "bulkacorp"  // → // owner: "bulkacorp"
```

A correctly-swapped fork build's APK manifest will show **fork** projectId in
the `EXPO_UPDATE_URL` metadata. Verify post-build via the APK-manifest
extraction in `happy-ota-publish-to-fork` ("Verify the APK's baked update
target") BEFORE relying on OTAs to this build — there's a long tail of
mixed-config builds in the wild because swap (a) is easy to forget.

### 2. Create the Firebase project

Open https://console.firebase.google.com → "Add project". Use any name (e.g. `happy-fork-NNNN`). Disable Analytics if desired; it's not required.

### 3. Register the Android apps in the Firebase project

In Firebase Console → Project Settings → General → "Your apps", click "Add app" → Android. **The package name must EXACTLY match the build profile's bundle ID** from `packages/happy-app/app.config.js`:

| Profile | Package name |
|---|---|
| development | `com.slopus.happy.dev` |
| preview | `com.slopus.happy.preview` |
| production | `com.ex3ndr.happy` (not relevant for fork builds) |

Register at least the ones the user will build (typically `preview` for testing, optionally `development`). Multiple Android apps under one Firebase project is fine.

### 4. Download the new `google-services.json`

After registering apps, Firebase generates a new `google-services.json` covering all of them. Download it from the Project Settings page.

### 5. Replace the local `google-services.json` (with backup)

```bash
cd /home/darrelldai/Projects/happy/packages/happy-app
cp google-services.json google-services.upstream.json   # back up upstream
mv ~/Downloads/google-services.json ./google-services.json   # install user's
```

**Critical: this file must never be committed.** It contains user's private Firebase config. Reverting before commit:
```bash
mv google-services.upstream.json google-services.json
```

### 6. Generate the FCM service account key

Firebase Console → Project Settings → Service accounts → click **"Generate new private key"**. Confirm the warning, browser downloads a JSON file like `happy-XXXXX-firebase-adminsdk-fbsvc-XXXX.json`.

This file is a privileged credential — treat it like a password. Don't commit it, don't share it.

### 7. Upload the FCM credentials to Expo

Two ways:

**Web dashboard (faster, recommended):**

```
https://expo.dev/accounts/<USERNAME>/projects/happy/credentials
```

Pick **Android** → scroll to **Service Credentials** / **FCM V1** → **Add a Google Service Account Key** → upload the JSON from step 6.

**CLI (interactive, slower):**

```bash
npx eas-cli@latest credentials -p android
# preview → Push Notifications → Manage Google Service Account Key → Set up → file path
```

### 8. Trigger a fresh preview build

The build has to bake the new `google-services.json` into the APK so the app
registers FCM tokens under the right Firebase project. Apply the three-field
swap from step 1 (`updates.url`, `extra.eas.projectId`, `owner`).

**Throwaway-commit gotcha.** By default `eas build` bundles the latest
committed state of the working tree, **NOT** the dirty edits you just made.
If you run `eas build` with the three config edits still uncommitted, EAS
silently ships *the upstream-committed config* to the cloud build — the
resulting APK has upstream's projectId/url and is the exact "permanent OTA
blindness" failure described in step 1. The same applies to a swapped-in
fork `google-services.json` — if the tree's committed copy is the
upstream/stale one, the build bakes that, not your fork's. Two safe shapes:

```bash
cd /home/darrelldai/Projects/happy/packages/happy-app

# Option A (recommended) — throwaway local commit, build from it, undo after.
#   Lets you keep the upstream values committed on the branch you actually
#   push to upstream, while still feeding the fork values to EAS.
git add app.config.js google-services.json
git commit -m "TEMP: fork build config (REVERT)"
TEMP_SHA=$(git rev-parse HEAD)

npx eas-cli@latest build --platform android --profile preview --non-interactive
# (Build kicks off ~30s after upload, runs ~15-20 min on EAS.)

# Once EAS has the upload, immediately undo the temp commit so working state
# matches main again. The build keeps running on EAS regardless.
git reset --soft HEAD~1                # drops the commit, keeps changes staged
git restore --staged app.config.js google-services.json   # unstage
git checkout -- app.config.js          # restore upstream values
# google-services.json stays as the fork's file in the working tree (NOT to be committed).

# Option B — build from the dirty tree without committing.
#   Pass --no-wait and answer "Yes" to the "tree is dirty, build anyway?"
#   prompt. Less reliable historically (EAS' detection of which files end
#   up in the upload bundle has flipped between versions); Option A is the
#   safer default.
```

After kicking off the build, immediately verify the upload's config is
**fork-aligned** by viewing the build in the dashboard or via
`eas build:view <buildId>` (note: `build:view` reads `extra.eas.projectId`
from your current `app.config.js`, so you may need to temporarily re-swap
it back to the fork projectId to make this query work — same swap pattern,
or `unset` it and pass `--platform android` explicitly). If `Channel` and
`Runtime Version` look right but you have any doubt about the URL field, do
the APK-manifest verification from `happy-ota-publish-to-fork` after the
build completes — that's the only authoritative check.

### 9. Install and verify

When the build completes, the user installs the APK on their phone (URL from `eas build:list` or the dashboard). The app registers a fresh FCM token bound to *their* Firebase project. Verify by running the receipt-test script:

```bash
node /tmp/expo_receipt_test.mjs    # if still in tmp, otherwise see test script template below
```

`status: "ok"` on the ticket AND on the receipt 10s later confirms Expo successfully handed the push off to FCM.

If still `InvalidCredentials` after install: it means the app's FCM token is still tied to the old (upstream) Firebase project. Sanity check:
- The new APK was actually installed (not still running the previous build)
- The user opened the app at least once after install so it registered with FCM
- The Android package names in Firebase Console match the build's bundle ID exactly

### Receipt test script template

```js
import { createRequire } from 'node:module';
const require = createRequire('/home/darrelldai/Projects/happy/packages/happy-cli/');
const { Expo } = require('expo-server-sdk');
import { readFileSync } from 'node:fs';

const SERVER = 'https://api.cluster-fluster.com';
const ak = JSON.parse(readFileSync(process.env.HOME + '/.happy/access.key', 'utf-8'));
const r = await fetch(`${SERVER}/v1/push-tokens`, { headers: { 'Authorization': `Bearer ${ak.token}` } });
const tokens = (await r.json()).tokens || [];
if (tokens.length === 0) { console.log('no tokens'); process.exit(1); }

const expo = new Expo();
const msg = { to: tokens[0].token, title: 'fcm-fork-test', body: 'verify', sound: 'default', priority: 'high' };
const tickets = await expo.sendPushNotificationsAsync([msg]);
console.log('tickets:', tickets);
const ids = tickets.filter(t => t.status === 'ok').map(t => t.id);
if (ids.length === 0) process.exit(0);
await new Promise(r => setTimeout(r, 10000));
console.log('receipts:', await expo.getPushNotificationReceiptsAsync(ids));
```

## What NOT to commit

After the work is done, before any commit/PR to upstream:

- Revert `packages/happy-app/app.config.js` (restore `owner: "bulkacorp"` and upstream `eas.projectId`)
- Revert `packages/happy-app/google-services.json` (restore from `google-services.upstream.json` backup)
- Delete the downloaded service account key from disk if no longer needed
- Consider adding `google-services.upstream.json` to `.gitignore` (currently untracked)

These files are all per-fork configuration and must not pollute the upstream PR.

## Common failure modes

- **`InvalidCredentials` after upload** — the FCM tokens currently registered with Expo were minted under a *different* Firebase project than the one whose credentials were uploaded. Need a fresh build with the matching `google-services.json` bundled, then a fresh install on phone.
- **`Unable to retrieve the FCM server key`** — same root cause: Expo project has no FCM credentials yet. Do step 7.
- **Build fails with package-name error** — the Android app for that build profile's bundle ID isn't registered in the Firebase project. Add it via step 3, re-download `google-services.json`, rebuild.
- **App crashes on launch / Firebase init failure** — the bundled `google-services.json` doesn't include the app's package name. Same fix: register the package in Firebase, re-download, rebuild.
- **Build succeeds, push works, but every `eas update` shows `isUpdateAvailable=false` / `NoUpdatesAvailable` on the device** — `updates.url` was left at upstream when the APK was built (step 1 swap (a) was missed, or the throwaway-commit pattern in step 8 was skipped so EAS picked up the upstream-committed config). The installed APK is permanently querying upstream's update server and can never receive your fork's OTAs. Diagnose via the APK-manifest check in `happy-ota-publish-to-fork`. Only fix is to rebuild with all three swaps applied — this is **the** canonical fork-build mistake.
- **Build succeeds with the right `updates.url` but push breaks (InvalidCredentials)** — the tree's `google-services.json` doesn't match what's committed in EAS's FCM credentials store (e.g. someone re-downloaded the file from a *different* Firebase project than the one whose FCM key was uploaded in step 7). Always verify the installed APK's Firebase sender prefix against the tree's `google-services.json` BEFORE kicking off a build (see `happy-ota-publish-to-fork` "Cross-check: which Firebase project did this APK bake in?"). `google-services.json` is normally tracked in git but typically only one historical version exists, so if the tree drifted to the wrong project, git history won't recover it — only the Firebase console can.
