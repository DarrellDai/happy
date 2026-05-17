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
# Then edit packages/happy-app/app.config.js to remove `owner` field
# and clear `extra.eas.projectId`. Run:
npx eas-cli@latest init           # creates a new project under their account
# Note the new projectId. Put it in app.config.js for the duration of builds.
```

These config edits are *temporary, build-time only* — they MUST be reverted before any git commit (the upstream PR shouldn't include the fork-specific projectId or `owner` removal). Keep the upstream values in mind:

- Upstream `owner`: `bulkacorp`
- Upstream `eas.projectId`: `4558dd3d-cd5a-47cd-bad9-e591a241cc06`

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

The build has to bake the new `google-services.json` into the APK so the app registers FCM tokens under the right Firebase project. Same temporary-config-edit dance as `eas init`:

```bash
cd /home/darrelldai/Projects/happy/packages/happy-app
# Temporarily set fork's projectId in app.config.js and comment out `owner`
# (see the dance pattern used in earlier builds)
npx eas-cli@latest build --platform android --profile preview --non-interactive
# Build runs ~15 min. Revert app.config.js immediately after submission.
```

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
