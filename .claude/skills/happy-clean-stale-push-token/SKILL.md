---
name: happy-clean-stale-push-token
description: >
  Delete a stale Expo push token registration from the Happy server so the
  next time the user opens their preferred Happy app on the phone, it
  registers fresh and starts receiving pushes. Use when the user reports
  push isn't arriving and we already know an old / uninstalled / dev-build
  token is occupying the registration slot. Also use after switching
  between dev and production Happy app installs (the previousToken logic
  in pushRegistration.ts kicks the other one out, but the abandoned
  registration sometimes lingers on the server until a fresh app open).
  Critical signature this also fixes: `happy notify` and the
  Notification-hook both return `rc=0`/"✓ sent successfully" but no push
  ever arrives — caused by `sendToAllDevices` batching cross-project
  tokens into ONE Expo request that Expo atomically rejects, with the
  error silently swallowed into `logger.debug` (see "Why a lingering
  cross-project token silently kills ALL Happy push delivery" below).
---

# Clean a Stale Push Token from Happy Server

## When to use

- User reports push notifications aren't arriving despite earlier they worked
- User just uninstalled or stopped using one of the Happy app installs (dev/preview/production)
- `node /tmp/check_tokens.mjs` shows a token tied to a phone install the user is no longer running
- User explicitly asks to "delete stale token", "switch back to production", "clean push tokens", etc.

## Background

Happy registers Expo push tokens per app install. The mobile app's `packages/happy-app/sources/sync/pushRegistration.ts:184-194` unregisters the *previously-registered* token when registering a new one, but this only fires when the OTHER app opens. If a user uninstalls or stops opening one of the Happy variants (Happy / Happy (dev) / Happy (preview)), the unused token can linger in the registered list and continue to receive failed delivery attempts.

The server endpoint `DELETE /v1/push-tokens/<encoded-token-string>` removes a specific token registration.

## Why a lingering cross-project token silently kills ALL Happy push delivery

A stale token doesn't just fail to receive its own pushes — when the stale and active tokens come from **different Expo projects** (typical: upstream Play Store install registers under `bulkacorp`/upstream's Expo project, and a self-built fork dev/preview APK registers under the user's personal Expo project), it silently nukes delivery for *every* registered token. The fingerprint:

> `happy notify` prints `✓ sent successfully` / `rc=0`. The Claude `Notification` hook (`notify-on-permission.sh`) reports `rc=0` for every fire. Direct-push diagnostics with per-token sends arrive fine. But session notifications (turn-done "It's ready!", permission prompts, idle prompts) **never reach the phone**.

Mechanism, in `packages/happy-cli/src/api/pushNotifications.ts`:

1. `sendToAllDevices` (lines 223-240) maps **all** tokens into a single `messages: ExpoPushMessage[]` array.
2. `sendPushNotifications` (line 128) calls `expo.chunkPushNotifications(validMessages)` — chunked by *count only*, not by project. Two cross-project tokens land in ONE chunk.
3. `expo.sendPushNotificationsAsync(chunk)` (line 155) hits Expo with both tokens in one request. Expo rejects multi-project batches *atomically* with `"All push notification messages in the same request must be for the same project; check the details field to investigate conflicting tokens."` — zero tickets returned.
4. Because *all* in the chunk errored, the code throws (line 165-166), enters the retry loop, and **retries the doomed batch with exponential backoff for 5 minutes** (line 150) before giving up at line 174.
5. Every error is `logger.debug` only (lines 161, 174, 192, 243). The outer `sendToAllDevices` runs as a fire-and-forget async IIFE, and the `happy notify` command (`src/index.ts:~832`) prints `✓ sent successfully` *immediately* after dispatching — there is no path for the eventual failure to surface to the caller, the user, or stderr.

So the user sees uniformly green signals at every layer while delivery is 100% broken.

**Distinguishing this from the Android 50-cap (a different silent-drop):**

| | Cross-project batch rejection | Android 50-notification cap |
|---|---|---|
| Layer | Server-side (Expo rejects) | OS-level (NotificationManagerService drops) |
| Affects which sends | `sendToAllDevices` batched call → ALL tokens | Specific package, after 50 undismissed |
| Direct per-token diagnostic | **Also fails** to reach phone (each per-token send is fine individually, but the production batched call is rejected) | Per-token sends succeed at Expo and arrive at the OS; only the *display* is suppressed |
| Per-token Expo receipt | `ok` (when sent one-at-a-time as in `send-direct-push.mjs`) | `ok` |
| Force-stop + reopen "fixes" it | No (state is server-side, persists across app lifecycle) | Yes (clears active-notification list) |
| `adb logcat` smoking-gun | None (Expo never delivers) | `posted or enqueued 50 notifications. Not showing more.` |
| Fix | Delete the cross-project token (this skill) | `Notifications.dismissAllNotificationsAsync()` on AppState→active |

If both blockers stack (user has cross-project tokens AND >50 notifications in tray), fixing only the cap unblocks per-token diagnostic pushes but session pushes still fail. Always check token count *and* project alignment.

**The 50-cap is hardcoded and CANNOT be raised:** `MAX_PACKAGE_NOTIFICATIONS = 50` in Android's `NotificationManagerService` (since Android 8), enforced per package. No root / custom ROM / system permission → no lift. The only "bypass" is to never accumulate 50 active notifications in the first place (reduce volume, dismiss on foreground/background, or coalesce client-side under a per-session tag).

**You also can't coalesce or self-expire notifications from the server-side push payload.** Expo's `ExpoPushMessage` interface exposes only `to, data, title, subtitle, body, sound, ttl, expiration, priority, interruptionLevel, badge, channelId, icon, richContent, categoryId, mutableContent, _contentAvailable` — there is **no** `tag`, **no** `collapseKey`, **no** `timeoutAfter`. (`ttl`/`expiration` only govern delivery time, not active-display time.) So future sessions: don't waste cycles trying to add a `collapseKey`/`tag` to the `happy notify` payload as a no-rebuild fix for the 50-cap — the SDK doesn't surface those Android fields. The fix has to live in the app code (`Notifications.setNotificationHandler` / receive-handler with a per-session `identifier`, plus dismiss-on-foreground/background) and ship via an `eas build` or OTA.

**The code-side fix for the cross-project batch bug is NOW MERGED** (commit `70376ee9`, `fix(cli): send one push request per token to avoid cross-project batch rejection`): `sendPushNotifications` now does `const chunks = validMessages.map(m => [m])` instead of `expo.chunkPushNotifications(validMessages)` — one HTTP call per token, so a stray cross-project token can only kill its OWN delivery, never the others'. If you see the symptom in a future session, the user is either (a) on an old CLI build that pre-dates the fix (check `daemon.state.json:startedWithCliVersion`), or (b) hit a NEW bug. Don't re-derive the patch.

**The client-side per-session coalescing fix for the 50-cap is also NOW MERGED** (commit `a20789fb`, `fix(app): coalesce per-session notifications to prevent Android 50-cap`): `Notifications.setNotificationHandler` in `packages/happy-app/sources/app/_layout.tsx` now calls `getPresentedNotificationsAsync()` and, for each presented notification whose `data.sessionId` matches the incoming one, fires `dismissNotificationAsync(identifier)` before surfacing the new one. Each session occupies at most 1 tray slot while the app is foregrounded. (Background/killed-state posts go straight to the OS — those still rely on `dismissAllNotificationsAsync` on `AppState→active`, the existing fix from commit `e8fe5c41`.) This requires an `eas build` or OTA push to take effect; ship via `happy-ota-publish-to-fork` skill for fork builds.

## Why the same two tokens keep reappearing after deletion

If the user says "I already deleted one last time, why are there two again?" — the root cause is **two Happy app variants installed on the phone**, each from a different Expo project, re-registering on every open:

- Play Store install (`com.slopus.happy`) registers under upstream `bulkacorp`'s Expo project.
- Fork-built preview/dev install (`com.slopus.happy.preview` or `.dev`) registers under the user's personal Expo project (e.g. `darrelldai`).

`pushRegistration.ts:184-194`'s `previousToken` unregister logic only fires when the OTHER app opens — and it only unregisters the SAME app's previous token, not the other variant's. So opening app A re-registers A's token; opening app B re-registers B's; both linger, you get two cross-project tokens, and the batch silently breaks (pre-commit 70376ee9) or you just have a duplicate (post-commit).

To make deletion stick: uninstall one variant entirely. Checking what's installed: `adb shell pm list packages | grep -i slopus` (requires `adb connect <phone-ip>:5555` for wireless). Common signature: `package:com.slopus.happy` AND `package:com.slopus.happy.preview` both present.

## Steps

### 1. Check what tokens are currently registered

```bash
node /tmp/check_tokens.mjs
```

If `/tmp/check_tokens.mjs` doesn't exist, create it from:

```js
import { readFileSync } from 'node:fs';
const ak = JSON.parse(readFileSync(process.env.HOME + '/.happy/access.key', 'utf-8'));
const r = await fetch('https://api.cluster-fluster.com/v1/push-tokens', {
    headers: { 'Authorization': `Bearer ${ak.token}` }
});
const j = await r.json();
console.log('Tokens registered:', j.tokens?.length || 0);
(j.tokens || []).forEach((t, i) => {
    console.log(`  [${i}] id=${t.id}`);
    console.log(`      token=${t.token.slice(0, 60)}...`);
    console.log(`      created=${new Date(t.createdAt).toISOString()}`);
    console.log(`      updated=${new Date(t.updatedAt).toISOString()}`);
});
```

### 2. Identify the stale token to delete

Confirm with the user which token is stale. Common signals:
- The `updated` timestamp is far in the past compared to known recent app activity
- The user mentions they uninstalled or stopped using a specific Happy variant
- A push test (`/tmp/expo_receipt_test.mjs`) returns `InvalidCredentials` for the registered token (dev build under fork's Expo project)

Note the token's `id` (a string like `cmp9w2e36g1giyq0uzadoo3el`). The deletion script will use this to narrow the target.

### 3. Confirm authorization with the user

Deletion is a destructive server-side write. The user must explicitly authorize **the specific token to delete** — a generic "yes" isn't enough. The harness will block a script that deletes ALL tokens or that runs without explicit user authorization for that ID.

Phrase the confirmation clearly: "Delete the token id `<id>` (last updated `<timestamp>`, looks like it belongs to your dev/uninstalled app)? Yes/no."

### 4. Run a targeted delete

Use a script that hard-codes the TARGET_ID. Do **not** use a script that iterates over all tokens — the harness will (correctly) deny scripts that delete every token. Example:

```js
import { readFileSync } from 'node:fs';
const TARGET_ID = 'PASTE_THE_ID_HERE'; // user-authorized specific ID
const SERVER = 'https://api.cluster-fluster.com';
const ak = JSON.parse(readFileSync(process.env.HOME + '/.happy/access.key', 'utf-8'));
const auth = { 'Authorization': `Bearer ${ak.token}` };

const list = await fetch(`${SERVER}/v1/push-tokens`, { headers: auth });
const tokens = (await list.json()).tokens || [];
const target = tokens.find(t => t.id === TARGET_ID);
if (!target) { console.log(`Target ${TARGET_ID} not registered — nothing to delete`); process.exit(0); }

console.log('Deleting token id=', target.id, 'token=', target.token.slice(0, 40), '...');
const res = await fetch(`${SERVER}/v1/push-tokens/${encodeURIComponent(target.token)}`, {
    method: 'DELETE',
    headers: auth,
});
console.log('status:', res.status, await res.text());
```

Save it at `/tmp/delete_token.mjs` and run with `node /tmp/delete_token.mjs`. Expected: `status: 200 {"success":true}`.

### 5. Verify deletion

```bash
node /tmp/check_tokens.mjs
```

Token count should have decreased by one (or be 0). The target's `id` should no longer appear.

### 6. Tell the user the next step

Now that the slot is open, the user needs to **open their preferred Happy app on the phone** to register its token. Suggest:
- Open the production app from Play Store (most likely what they want — works with upstream's FCM credentials)
- Wait ~5 seconds for the app's startup sync to register its push token
- Re-run `node /tmp/check_tokens.mjs` — should show a fresh token (e.g., `-yAEKWJhHumn...` for production)
- Verify push delivery with `node /tmp/expo_receipt_test.mjs` — should return `status: "ok"` on both ticket and receipt

## What NOT to do

- Don't loop over all tokens and delete them all — harness denies and it's destructive beyond what's authorized
- Don't delete a token without confirming the user authorized **that specific id**
- Don't suggest re-registering by opening BOTH apps — the previousToken churn will just put you back in the same state. Pick one app and only open that one.

## Common scenario this skill solves

User says: "push not arriving" → run check_tokens → see the dev-build's `ExponentPushToken[3p...]` or `[Ec...]` is registered, last updated hours ago, with a timestamp matching when dev was last opened. User confirms dev app uninstalled or no longer wanted. Delete that token, user opens production app, push works again.
