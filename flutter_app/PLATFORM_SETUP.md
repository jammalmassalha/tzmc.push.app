# Platform Configuration Notes

## Building the App

### Recommended: GitHub Actions

The easiest way to build is using GitHub Actions:

1. Go to **Actions** tab in GitHub
2. Select **Flutter Build** workflow
3. Click **Run workflow**
4. Select platforms to build (Android, Web, iOS)
5. Download artifacts from the completed workflow run

Output goes to `dist/` folder:
- `dist/android/` - APK and AAB files
- `dist/web/` - Web build for deployment
- `dist/ios/` - iOS app (requires code signing)

### Local Build

```bash
cd flutter_app
./build_all.sh
```

**Note:** Local builds may fail with SSL certificate errors on corporate networks. See troubleshooting below.

## Windows Desktop Setup

The Flutter Windows desktop target enables automatic login using the Windows logged-in
username (the `USERNAME` environment variable). The username is looked up against column O
of the Subscribe Google Sheet; if a match is found a session is created immediately without
any SMS verification.

### 1. Enable the Windows platform (one-time scaffold)

```bash
cd flutter_app
flutter create --platforms=windows .
```

This generates the `windows/` directory needed for desktop builds. No additional
Flutter dependencies are required — Windows desktop support is built-in.

### 2. Backend — `APP_SERVER_TOKEN`

The Windows endpoint (`POST /auth/session/windows-login`) requires a matching
`APP_SERVER_TOKEN` on the server. Set this in your server's environment / `.env`:

```
APP_SERVER_TOKEN=<your-secret-token>
```

### 3. Google Apps Script — `get_windows_user` action

In the Apps Script bound to the Subscribe sheet add a new branch in `doGet`:

```javascript
if (action === 'get_windows_user') {
  const windowsUser = String(e.parameter.windowsUser || '').trim().toLowerCase();
  const sheet = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName('Subscribe');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const colO = String(data[i][14] || '').trim().toLowerCase(); // column O = index 14
    if (colO === windowsUser) {
      const phone = String(data[i][0] || '').trim(); // column A = phone/username
      return ContentService
        .createTextOutput(JSON.stringify({ result: 'success', user: phone }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }
  return ContentService
    .createTextOutput(JSON.stringify({ result: 'not_found' }))
    .setMimeType(ContentService.MimeType.JSON);
}
```

Re-deploy the Apps Script Web App after adding this branch (**Deploy → Manage deployments → New version**).

### 4. Build the Windows desktop app

The `WINDOWS_APP_SERVER_TOKEN` dart-define must match `APP_SERVER_TOKEN` on the server:

```bash
cd flutter_app
flutter build windows --release \
  --dart-define=WINDOWS_APP_SERVER_TOKEN=<your-secret-token>
```

The built executable and its supporting files are placed in:
```
flutter_app/build/windows/x64/runner/Release/
```

Distribute the entire `Release/` folder to Windows users (it includes the required DLLs).

#### GitHub Actions Windows build

Add the token as a GitHub Actions secret (e.g. `WINDOWS_APP_SERVER_TOKEN`) and pass it
to the build step:

```yaml
- name: Build Windows
  run: |
    cd flutter_app
    flutter build windows --release \
      --dart-define=WINDOWS_APP_SERVER_TOKEN=${{ secrets.WINDOWS_APP_SERVER_TOKEN }}
```

> **Security note:** The token acts as a shared secret so only the trusted desktop
> build can use the Windows auto-login endpoint. Keep it out of source control and
> rotate it if it is ever leaked. Random internet requests without the token receive
> a `403` response.

### 5. How it works at runtime

1. The app starts and calls `GET /auth/session` — if a cookie session already exists,
   login is complete as normal.
2. If no session is found **and** the app is running on Windows, it reads
   `Platform.environment['USERNAME']` and calls `POST /auth/session/windows-login`
   with the username and the baked-in token.
3. The backend looks up the username in column O of the Subscribe sheet via the Apps
   Script `get_windows_user` action.
4. On a match, a session cookie is set and the app proceeds directly to the chat
   screen — the login screen is never shown.
5. If the username is not registered, the normal login screen is displayed.

## Flutter Web — Windows SSO (Integrated Windows Authentication)

The web build can also skip the SMS login for domain-joined machines, but the
mechanism is completely different from the desktop one above, for a security
reason worth stating plainly.

> **Why the web build does not reuse `/auth/session/windows-login`.**
> That endpoint trusts a **client-supplied** `windowsUser` and is gated only by
> the shared `APP_SERVER_TOKEN`. That is defensible for the desktop build, where
> the token is baked into a distributed binary. On the web the token would sit in
> a `--dart-define` inside `main.dart.js`, readable by anyone who opens devtools —
> at which point any user could POST `{"windowsUser": "someone_else"}` and receive
> a valid session cookie for that account. A full authentication bypass.
>
> The web path therefore uses a **separate** endpoint,
> `POST /auth/session/windows-sso`, which takes **no request body** and derives
> the username server-side only. Do not widen the desktop endpoint instead.

The browser sandbox exposes no API for the OS login name, so the username has to
come from a reverse proxy that terminates the Negotiate (Kerberos/NTLM)
handshake and passes the result to Node.

### 1. Choose where the Negotiate handshake terminates

The deployment image is `node:20-alpine`, which constrains the options:

- **A — IIS in front of Node (easiest with existing Windows infrastructure).**
  Enable Windows Authentication on the site, disable Anonymous, and reverse-proxy
  to Node via ARR or `iisnode`. Least code, best-trodden path in a Microsoft shop.
- **B — Apache or nginx with `mod_auth_gssapi` / SPNEGO (Linux-native).** Fits the
  container setup. Requires a keytab for the service account and an SPN registered
  in AD.
- **C — Node does it natively. Not viable here.** `node-expose-sspi` only runs on
  Windows hosts, so it is out for Alpine. **Do not use `express-ntlm`** — it does
  not validate against a domain controller, so it accepts any claimed username,
  which is the same spoofing hole described above.

Prefer A if IIS is available, otherwise B.

### 2. Pass the identity to Node without letting clients forge it

Whichever proxy is used, it ends up injecting a header such as
`X-Remote-User: DOMAIN\jmassalha`. Two guards are **non-negotiable**:

- **Strip the header on ingress.** If the proxy forwards a client-supplied
  `X-Remote-User` instead of overwriting it, anyone can send it directly and
  impersonate any user. Explicitly *unset* then *set* it — for example
  `RequestHeader unset X-Remote-User` before `RequestHeader set ...` in Apache, or
  `proxy_set_header X-Remote-User $remote_user;` in nginx (which replaces rather
  than appends).
- **Bind Node to localhost or the internal network only,** so nobody can bypass
  the proxy and hit Express directly with a forged header.

If the proxy and Node are **not** on the same host, also set
`WINDOWS_SSO_SIGNATURE_SECRET` and have the proxy send an HMAC-SHA256 (hex) of
the normalized, lowercased account name in `X-Remote-User-Signature`. The server
rejects the request when the signature is absent or does not match.

### 3. Backend configuration

SSO is **off by default** and the identity header is ignored entirely until it is
switched on, so a deployment with no proxy in front of it cannot be tricked into
trusting a client-supplied header:

```
WINDOWS_SSO_ENABLED=true
WINDOWS_SSO_USER_HEADER=X-Remote-User
# Optional, for a non-colocated proxy:
WINDOWS_SSO_SIGNATURE_HEADER=X-Remote-User-Signature
WINDOWS_SSO_SIGNATURE_SECRET=<shared-with-proxy>
```

`POST /auth/session/windows-sso` reads the header, strips the `DOMAIN\` prefix or
UPN suffix, lowercases the result, and then joins the *existing* desktop flow:
look up column O of the Subscribe sheet → check the restricted flag → create the
session token → set the session cookie. The response shape matches
`/auth/session/windows-login`. It returns **401** (not 403) when no identity is
present, so the client can cleanly fall back to the SMS login screen.

### 4. Client-side prerequisites — this is where these projects usually stall

Auto-login is only *silent* if the browser already trusts the site. Otherwise the
user gets a **native username/password popup**, which is worse UX than the
existing login screen:

- The site must be in the **Local Intranet zone** (Edge/IE) or listed in Chrome
  and Edge's `AuthServerAllowlist` policy — push this via GPO.
- It must be reached by **hostname, not IP**, or Kerberos falls back to NTLM.
- The **SPN** (e.g. `HTTP/tzmc.co.il`) must be registered to the service account,
  with **no duplicates** — duplicate SPNs are the classic silent-failure cause.
- Firefox needs `network.negotiate-auth.trusted-uris` set separately.
- Safari/macOS and mobile browsers will generally not participate at all.

The Flutter side needs no further work: the Dio web adapter already sets
`withCredentials = true` (see `lib/core/api/cookie_setup_web.dart`) so the session
cookie sticks, and the attempt is made silently inside the existing "no session
found" branch of `auth_state.dart`. Any failure falls through to the normal login
screen, which is what off-network and BYOD users will always see.

### 5. Verifying

CI cannot exercise any of this, so verify by hand:

1. From a domain-joined Windows machine in Edge, open the app — it should reach
   the chat screen with no prompt. Check the server log for
   `[WINDOWS SSO] Auto-login successful for windowsUser: ...` with the expected
   account.
2. From a machine outside the domain, confirm the SMS login screen appears —
   not an error and not a native credentials popup.
3. From a normal client, POST `/auth/session/windows-sso` with a forged
   `X-Remote-User` header and confirm it is rejected with 401.

### Status on the current host: IWA is not achievable

The production deployment is **cPanel + OpenResty + Phusion Passenger with user
level shell access only**. Terminating Negotiate there would require
recompiling OpenResty with the SPNEGO module and installing a Kerberos keytab,
neither of which is possible without root. `WINDOWS_SSO_ENABLED` therefore stays
`false`, and `/auth/session/windows-sso` correctly returns `401` for every
request.

The code above remains in place and is inert; it becomes usable unchanged if the
app is ever moved behind IIS or an Apache/nginx instance you control.

> Note for anyone debugging that `401`: do **not** "fix" it by having Node send
> `WWW-Authenticate: Negotiate`. That header is a promise to complete the
> handshake, and Node here has no keytab and no GSSAPI library to complete it
> with. The browser would send a ticket, get another 401, and fall back to a
> native username/password prompt that can never succeed — strictly worse than
> the SMS login screen, and it would fire for every public visitor too. The
> challenge must come from a proxy that can actually finish the exchange.

### The fallback: a long-lived session instead

Rather than IWA, web users get one SMS login and then stay logged in. This is
**already implemented** — see "Staying logged in" below.

## Staying logged in (remember-me)

There is no separate "remember me" checkbox or token; the ordinary session
cookie is the remember-me mechanism:

- **30-day TTL** (`SESSION_COOKIE_TTL_MS`, default `2592000000`).
- **Persistent, not a browser-session cookie** — it carries `Max-Age`/`Expires`,
  so it survives closing the browser or rebooting the PC.
- **Sliding renewal** — once a session passes the halfway point (15 days) the
  next request transparently issues a fresh 30-day token, keeping the same
  `sessionId` and CSRF token. An active user is effectively never logged out.
- **Stable signing secret**, so a Passenger restart does not invalidate anyone.

### If users still get logged out: check the cookie domain

The cookie is **host-only** by default, and this deployment answers on both
`tzmc.co.il` and `www.tzmc.co.il`. Those are two separate cookie jars, so a user
who logs in on one and later lands on the other is asked to log in again.

Set the apex domain so a single login covers both:

```
SESSION_COOKIE_DOMAIN=tzmc.co.il
```

No leading dot and no scheme. The value is applied to both the login and the
logout cookie, so signing out still works. If a request arrives on a host
outside that domain (localhost, a staging hostname) the attribute is omitted
automatically and the cookie stays host-only — emitting a mismatched `Domain`
would make the browser silently discard it, which presents as an endless login
loop rather than an error.

Restart the app after changing it; the value is read once at startup, and on
Passenger it must be exported into the app's environment (a `.env` file only
read by local tooling will not reach the process).

## Android Setup

After initializing the Flutter project with `flutter create`, configure:

1. **app/build.gradle**:
   - Set `minSdkVersion 21`
   - Set `targetSdkVersion 34`
   - Add Firebase dependencies

2. **AndroidManifest.xml**:
   - Add internet permission (already present by default)
   - Add notification permissions for Android 13+
   - Configure FCM service

3. **Firebase Setup**:
   - Download `google-services.json` from Firebase Console
   - Place in `android/app/`

4. **Release Signing** (required for Google Play):
   - Generate a keystore once (keep it safe — you can never change it for a published app):
     ```bash
     keytool -genkey -v -keystore ~/my-release-key.jks \
       -keyalg RSA -keysize 2048 -validity 10000 \
       -alias my-key-alias
     ```
   - Copy `android/key.properties.template` to `android/key.properties` and fill in the values:
     ```
     storePassword=<keystore password>
     keyPassword=<key password>
     keyAlias=my-key-alias
     storeFile=/path/to/my-release-key.jks
     ```
   - `key.properties` is gitignored — never commit it or the `.jks` file.
   - Build a signed release AAB for Google Play:
     ```bash
     flutter build appbundle --release
     ```
   - The signed AAB is output to `build/app/outputs/bundle/release/app-release.aab`.

## Push Notifications (Firebase)

The Flutter app uses **Firebase Cloud Messaging (FCM)** on Android and APNs (via Firebase) on iOS for push notifications. Web continues to use the existing web-push system in the Angular frontend, so no Firebase config is needed for the web build.

> **Credentials are not committed to this repository.** Each environment must drop in its own Firebase config files generated from the Firebase console (Project settings → Your apps).

### Android — `google-services.json`

1. In the Firebase console add an Android app with package name matching `android/app/build.gradle.kts` (`applicationId = "co.il.tzmc.tzmc_push"`).
2. Download `google-services.json` and place it at:
   ```
   flutter_app/android/app/google-services.json
   ```
   For local builds the file lives on disk; for CI builds the
   `Flutter Build` GitHub Actions workflow decodes it at build time
   from the **`GOOGLE_SERVICES_JSON_BASE64`** repository secret. Create
   the secret with:
   ```bash
   base64 -w 0 google-services.json | pbcopy   # macOS
   base64 -w 0 google-services.json             # Linux (copy output)
   ```
   then in GitHub: **Settings → Secrets and variables → Actions → New
   repository secret** → name `GOOGLE_SERVICES_JSON_BASE64`, value the
   base64 string. Without this secret the workflow logs a
   `::warning::` and the resulting APK silently has FCM disabled —
   `Firebase.initializeApp()` throws, the permission prompt never
   appears, and no token is registered with the backend.
3. The Google services Gradle plugin is already loaded via a
   `buildscript { classpath("com.google.gms:google-services:...") }` block
   in `android/build.gradle.kts` and conditionally applied in
   `android/app/build.gradle.kts` (it is only applied when
   `google-services.json` is present, so CI/sample builds without the
   credential keep working — they just won't deliver push notifications).
   The plugin is intentionally **not** declared in `settings.gradle.kts`'s
   plugins{} block because Google does not publish a plugin marker for it
   on the Gradle Plugin Portal.
4. `AndroidManifest.xml` already declares `INTERNET`, `WAKE_LOCK`, and
   `POST_NOTIFICATIONS` (Android 13+). The runtime permission prompt is
   triggered by `FirebaseMessaging.requestPermission()` in
   `PushNotificationService.initialize()`. The default FCM notification
   channel meta-data (`com.google.firebase.messaging.default_notification_channel_id`)
   is set to `chat_messages` to match the channel created by
   `flutter_local_notifications`.

### iOS — `GoogleService-Info.plist`

1. In the Firebase console add an iOS app with bundle id matching `ios/Runner.xcodeproj`.
2. Download `GoogleService-Info.plist` and add it to `ios/Runner/` **inside Xcode** (so it is added to the Runner target).
3. For CI builds the `Flutter Build` and `iOS Release Build` GitHub Actions workflows decode it at build time from the **`GOOGLE_SERVICE_INFO_PLIST_BASE64`** repository secret. Create the secret with:
   ```bash
   base64 -i GoogleService-Info.plist | tr -d '\n' | pbcopy   # macOS
   base64 -w0 GoogleService-Info.plist                        # Linux (copy output)
   ```
   then in GitHub: **Settings → Secrets and variables → Actions → New repository secret** → name `GOOGLE_SERVICE_INFO_PLIST_BASE64`, value the base64 string. Without this secret the workflow logs a `::warning::` and the resulting IPA silently has FCM disabled.
4. In Xcode → Runner target → **Signing & Capabilities**:
   - Add **Push Notifications** (this creates `Runner.entitlements` with the `aps-environment` key).
   - Add **Background Modes** and tick **Remote notifications** — note that
     the corresponding `Info.plist` entry is already committed in this repo
     (see `ios/Runner/Info.plist` → `UIBackgroundModes`).
4. Upload your APNs auth key (`.p8`) to Firebase under **Project settings → Cloud Messaging → Apple app configuration**.

### Backend — Firebase **service account** (required to actually deliver pushes)

`google-services.json` and `GoogleService-Info.plist` only authenticate the
*client* app. To actually **send** an FCM/APNs message the Node backend needs
a Firebase **service account** with the `Firebase Cloud Messaging API` scope.

1. In the Firebase console go to **Project settings → Service accounts →
   Generate new private key** (this downloads a `…-firebase-adminsdk-…json`
   file). Keep it secret — anyone with this file can send push notifications
   on behalf of your project.
2. Make it available to the server in **one** of the following ways
   (`backend/services/fcm-sender.js` checks them in this order):
   1. **`FIREBASE_SERVICE_ACCOUNT_BASE64`** — base64-encoded contents of the
      JSON file. Easiest to set as a CI / hosting-provider secret:
      ```bash
      base64 -w 0 firebase-adminsdk.json    # Linux
      base64 -i firebase-adminsdk.json      # macOS
      ```
      then export the value in `.env` (or your hosting provider's secret
      manager) as `FIREBASE_SERVICE_ACCOUNT_BASE64=…`.
   2. **`FIREBASE_SERVICE_ACCOUNT_JSON`** — raw JSON (single line) of the
      service-account file. Useful when secrets are stored as plain JSON.
   3. **`GOOGLE_APPLICATION_CREDENTIALS`** — filesystem path to the JSON
      file. Falls back to the standard Firebase Admin SDK
      `applicationDefault()` credential chain.
3. Restart the Node server. On the first FCM push it logs `[FCM] Skipping
   FCM delivery — Firebase Admin credentials are not configured` once if
   none of the above is set, and continues to deliver web-push
   notifications normally to web subscribers.

> **Without this secret the Flutter app still gets the OS permission
> prompt and still POSTs its FCM token to the Sheet — but the server has
> no credentials to call FCM, so no message is ever delivered to the
> phone.** This is the most common reason "I added google-services.json
> but I still don't get notifications".

### Wiring (already done in code)

- `main.dart` calls `Firebase.initializeApp()` and registers `firebaseMessagingBackgroundHandler` via `FirebaseMessaging.onBackgroundMessage(...)` before `runApp`.
- `chat_shell_screen.dart` initializes `pushNotificationServiceProvider` after the chat store is hydrated; this requests permission, fetches the FCM token and POSTs it to the backend (`/api/device-tokens`).
- `auth_state.dart#logout` calls `unregisterToken()` so the backend stops targeting the device when a user signs out.
- Tapping a notification routes to `MessageScreen` for the relevant `chatId`/`groupId` via the global `rootNavigatorKey`.

## iOS Setup

1. **Info.plist**:
   - Add camera/photo library permissions for attachments
   - Add push notification entitlements

2. **APNs Setup**:
   - Configure APNs key in Apple Developer Console
   - Upload to Firebase

3. **Runner.xcworkspace**:
   - Enable Push Notifications capability
   - Enable Background Modes (Remote notifications)

## Web Setup

The web build is configured to serve from `/fluttertest` path.

**Important:** Use `--pwa-strategy=none` to disable service worker caching. This ensures users always get the latest version when you deploy updates:

```bash
flutter build web --release --base-href /fluttertest/ --pwa-strategy=none
```

Deploy `dist/web/` contents to your server's `/fluttertest` directory.

### Cache Busting

The build is configured without a service worker to prevent aggressive caching. This means:
- Users will always load the latest version after deployment
- No need to manually clear browser cache
- Faster iteration during development and updates

## Screenshot &amp; Screen-Capture Protection

Implemented natively, with no extra Dart dependency, so there is nothing to
enable at runtime — protection is on from the first frame.

| Platform | Enforceable? | What is blocked |
| --- | --- | --- |
| Android | Yes, by the OS | Screenshots are refused ("Can't take screenshot due to security policy"); screen recordings, casting and any other non-secure display render black; the recent-apps preview is blank. |
| iOS | Partially | The app-switcher snapshot and active screen recording / AirPlay mirroring / QuickTime capture are blurred. The physical Power + Volume Up screenshot **cannot** be blocked — iOS exposes no API for it. |
| Web | No | Browsers are sandboxed with no OS-level capture hooks. Print Screen, the Snipping Tool, extensions and OS recorders all work regardless. |

### Android

`MainActivity.onCreate` sets `WindowManager.LayoutParams.FLAG_SECURE`. This is
enforced by the system window manager rather than by app code, so it cannot be
bypassed from within the app.

### iOS

`PrivacyShield` in `ios/Runner/AppDelegate.swift` adds a blurred
`UIVisualEffectView` over the window:

- on `applicationWillResignActive`, before the system captures the snapshot the
  app switcher displays, and
- whenever `UIScreen.capturedDidChangeNotification` reports `isCaptured`, which
  covers screen recording and mirroring for as long as they run.

`SceneDelegate` carries the same hooks. It is dormant today because `Info.plist`
declares no `UIApplicationSceneManifest`, but with scenes enabled the
`UIApplication` lifecycle callbacks stop firing and `AppDelegate.window` becomes
nil, which would otherwise silently disable the shield.

### Web

No obfuscation is attempted. Keyboard-event or window-blur overlays only cover
one of many capture routes, so they add UX cost and a false sense of security
without meaningfully protecting anything. Treat anything rendered in the web
client as capturable.

## Environment Variables

Create a `.env` file (not committed) with:
```
API_BASE_URL=https://www.tzmc.co.il/notify
```

Or use dart-define at build time:
```bash
flutter build apk --dart-define=API_BASE_URL=https://www.tzmc.co.il/notify
```

## Troubleshooting SSL Certificate Issues

If you see errors like:
```
PKIX path building failed: unable to find valid certification path
```

This is typically caused by corporate proxies intercepting HTTPS traffic.

### Solutions:

1. **Use GitHub Actions** (recommended) - builds run in a clean cloud environment

2. **Update Java certificates:**
   ```bash
   # Import your corporate CA certificate
   keytool -import -trustcacerts -file your-ca.cer -alias corporate_ca -keystore "%JAVA_HOME%\lib\security\cacerts"
   ```

3. **Clean and rebuild:**
   ```bash
   flutter clean
   flutter pub get
   flutter build apk --release
   ```

4. **Check proxy settings** - ensure Gradle can access Maven repositories
