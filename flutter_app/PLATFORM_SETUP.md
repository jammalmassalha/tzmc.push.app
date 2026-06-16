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
