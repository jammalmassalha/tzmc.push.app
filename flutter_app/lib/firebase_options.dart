/// Firebase platform-specific configuration.
///
/// Mirrors the file produced by `flutterfire configure`, but written by
/// hand because the project keeps the FlutterFire CLI out of the build
/// pipeline (CI builds do not have access to the Firebase auth flow).
///
/// Values come from the **public** Firebase client config of the
/// `tzmc-notifications` project. These identifiers are designed by Google
/// to ship inside client apps — security is enforced server-side via
/// Firebase Security Rules and the FCM service account on the backend.
library;

import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart'
    show defaultTargetPlatform, kIsWeb, TargetPlatform;

/// Default [FirebaseOptions] for use with the current platform.
class DefaultFirebaseOptions {
  static FirebaseOptions get currentPlatform {
    if (kIsWeb) {
      return web;
    }
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return android;
      case TargetPlatform.iOS:
        // iOS pulls FirebaseOptions automatically from
        // ios/Runner/GoogleService-Info.plist when present, but supplying
        // them explicitly keeps Firebase.initializeApp() from throwing if
        // the plist is missing during development.
        return ios;
      case TargetPlatform.macOS:
        return ios;
      default:
        throw UnsupportedError(
          'DefaultFirebaseOptions are not configured for $defaultTargetPlatform',
        );
    }
  }

  /// Web app — values come from the Firebase console
  /// (Project settings → General → Your apps → Web app).
  static const FirebaseOptions web = FirebaseOptions(
    apiKey: 'AIzaSyByLOP_-v5oK-iiSEJ8ydXRpRko22-tRro',
    appId: '1:917008922776:web:f02334911e7180bcf0f8ed',
    messagingSenderId: '917008922776',
    projectId: 'tzmc-notifications',
    authDomain: 'tzmc-notifications.firebaseapp.com',
    storageBucket: 'tzmc-notifications.firebasestorage.app',
    measurementId: 'G-8FLBFBWH6Y',
  );

  /// Android app — mirrors `android/app/google-services.json`.
  static const FirebaseOptions android = FirebaseOptions(
    apiKey: 'AIzaSyBox1xwugoj-E0dtDdvYDVy_TLJxNJ7SLU',
    appId: '1:917008922776:android:088fe0f07d02f97ef0f8ed',
    messagingSenderId: '917008922776',
    projectId: 'tzmc-notifications',
    storageBucket: 'tzmc-notifications.firebasestorage.app',
  );

  /// iOS app — placeholder. Replace `iosBundleId` and `appId` once the
  /// iOS Firebase app has been registered and `GoogleService-Info.plist`
  /// has been generated.
  static const FirebaseOptions ios = FirebaseOptions(
    apiKey: 'AIzaSyBox1xwugoj-E0dtDdvYDVy_TLJxNJ7SLU',
    appId: '1:917008922776:ios:088fe0f07d02f97ef0f8ed',
    messagingSenderId: '917008922776',
    projectId: 'tzmc-notifications',
    storageBucket: 'tzmc-notifications.firebasestorage.app',
    iosBundleId: 'co.il.tzmc.tzmcPush',
  );

  /// **Web Push certificate (VAPID key)** for FCM JS SDK
  /// `getToken({ vapidKey })`.
  ///
  /// Generated in Firebase Console →
  /// **Project settings → Cloud Messaging → Web configuration → Web Push
  /// certificates → Generate key pair** (the value is the long base64-url
  /// string under "Key pair").
  ///
  /// If left empty, the FCM web SDK will still attempt to fetch a token
  /// using the project default sender, but on most browsers that fails
  /// with `messaging/token-subscribe-failed`. Fill this in once the key
  /// has been generated.
  static const String webVapidKey =
      'BBpulzeMd9-R0MAR0DmT7jQ4i-uC912kFK7lFvl93R4PLe-nag4fq8bBm7e56AO4k3kbL6ly6aXMuxC8HhumHDM';
}
