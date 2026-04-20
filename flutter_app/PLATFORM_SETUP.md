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

## Push Notifications (Firebase)

The Flutter app uses **Firebase Cloud Messaging (FCM)** on Android and APNs (via Firebase) on iOS for push notifications. Web continues to use the existing web-push system in the Angular frontend, so no Firebase config is needed for the web build.

> **Credentials are not committed to this repository.** Each environment must drop in its own Firebase config files generated from the Firebase console (Project settings → Your apps).

### Android — `google-services.json`

1. In the Firebase console add an Android app with package name matching `android/app/build.gradle` (`applicationId`).
2. Download `google-services.json` and place it at:
   ```
   flutter_app/android/app/google-services.json
   ```
3. Make sure the Google services Gradle plugin is applied:
   - `android/build.gradle` (project) — buildscript classpath:
     ```
     classpath 'com.google.gms:google-services:4.4.2'
     ```
   - `android/app/build.gradle` (app) — bottom of file:
     ```
     apply plugin: 'com.google.gms.google-services'
     ```
4. `AndroidManifest.xml` already needs `INTERNET`; on Android 13+ add `POST_NOTIFICATIONS` (the `permission_handler` package is already in `pubspec.yaml`).

### iOS — `GoogleService-Info.plist`

1. In the Firebase console add an iOS app with bundle id matching `ios/Runner.xcodeproj`.
2. Download `GoogleService-Info.plist` and add it to `ios/Runner/` **inside Xcode** (so it is added to the Runner target).
3. In Xcode → Runner target → **Signing & Capabilities**:
   - Add **Push Notifications**
   - Add **Background Modes** and tick **Remote notifications**
4. The corresponding `Info.plist` entry (added automatically when you tick the box):
   ```xml
   <key>UIBackgroundModes</key>
   <array>
       <string>remote-notification</string>
   </array>
   ```
5. Upload your APNs auth key (`.p8`) to Firebase under **Project settings → Cloud Messaging → Apple app configuration**.

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
