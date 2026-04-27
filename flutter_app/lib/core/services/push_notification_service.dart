/// Push notification service for FCM/APNs.
///
/// Handles device token registration, notification display,
/// and push recovery pull logic to handle truncated payloads.
/// On web, push notifications are handled via the existing web-push system.
library;

import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../features/auth/presentation/auth_state.dart';
import '../../features/chat/presentation/message_screen.dart';
import '../../firebase_options.dart';
import '../api/chat_api_service.dart';
import '../navigation/root_navigator.dart';
import '../services/chat_store_service.dart';

// SharedPreferences key used to remember that we've already nagged the user
// to re-enable notifications from the system Settings screen, so we don't
// show the "go to settings" dialog every time the app starts.
const String _kPushSettingsNagShownKey = 'push_settings_nag_shown_v1';

// Platform detection helper
bool get _isNativePlatform {
  if (kIsWeb) return false;
  // On native platforms, check if we're on mobile
  return true;
}

// Platform-specific helpers (only used on native)
String _getPlatformName() {
  if (kIsWeb) return 'web';
  // Use defaultTargetPlatform which works cross-platform
  switch (defaultTargetPlatform) {
    case TargetPlatform.iOS:
      return 'ios';
    case TargetPlatform.android:
      return 'android';
    case TargetPlatform.macOS:
      return 'macos';
    case TargetPlatform.windows:
      return 'windows';
    case TargetPlatform.linux:
      return 'linux';
    default:
      return 'unknown';
  }
}

bool _isIOSPlatform() {
  if (kIsWeb) return false;
  return defaultTargetPlatform == TargetPlatform.iOS;
}

// ---------------------------------------------------------------------------
// Push Notification Service
// ---------------------------------------------------------------------------

class PushNotificationService {
  final ChatApiService _api;
  final Ref _ref;

  FirebaseMessaging? _messaging;
  FlutterLocalNotificationsPlugin? _localNotifications;
  String? _deviceToken;
  String? _registeredForUser;
  // Token fetched from FCM but deferred because [currentUserProvider] was
  // null at the time. Replayed by [registerPendingTokenForUser] once auth
  // completes, so Android devices that init push before auth still get
  // their token registered with the backend.
  String? _pendingToken;
  StreamSubscription? _tokenRefreshSubscription;
  StreamSubscription? _messageSubscription;

  PushNotificationService(this._api, this._ref);

  /// Initialize push notifications.
  ///
  /// Sets up Firebase, the local notifications plugin, FCM listeners, and
  /// the background-launch handler. **Does not** trigger the OS permission
  /// prompt — call [ensurePermissionAndRegister] from the UI layer once a
  /// [BuildContext] is available so we can show a Hebrew rationale dialog
  /// before the system dialog appears (and a "open settings" fallback if
  /// the user has previously denied the permission).
  Future<void> initialize() async {
    try {
      // Firebase is initialized in main() with platform-specific
      // [DefaultFirebaseOptions]. Re-calling initializeApp here is safe
      // (it returns the existing app) but isn't required.
      _messaging = FirebaseMessaging.instance;

      // Initialize local notifications for foreground display on native
      // platforms only. The plugin has no web implementation; on web, the
      // browser's own notification API handles foreground display via the
      // `firebase-messaging-sw.js` service worker.
      if (!kIsWeb) {
        _localNotifications = FlutterLocalNotificationsPlugin();
        await _initializeLocalNotifications();
      }

      // If the user has already granted (or provisionally granted)
      // notification permission in a previous session, register the device
      // token now without showing any dialog. The OS prompt is handled
      // separately by [ensurePermissionAndRegister].
      final settings = await _messaging!.getNotificationSettings();
      if (_isAuthorized(settings.authorizationStatus)) {
        await _getAndRegisterToken();
      }

      // Listen for token refresh
      _tokenRefreshSubscription = _messaging!.onTokenRefresh.listen(_onTokenRefresh);

      // Listen for messages
      _messageSubscription = FirebaseMessaging.onMessage.listen(_onMessage);

      // Handle background message (when app is opened from notification)
      FirebaseMessaging.onMessageOpenedApp.listen(_onMessageOpenedApp);

      // Check if app was opened from a terminated state notification
      final initialMessage = await _messaging!.getInitialMessage();
      if (initialMessage != null) {
        _onMessageOpenedApp(initialMessage);
      }

      debugPrint('[PushNotificationService] Initialized successfully');
    } catch (e) {
      debugPrint('[PushNotificationService] Initialization error: $e');
    }
  }

  /// Ask the user — with a Hebrew rationale dialog — to allow push
  /// notifications, then register the FCM device token on success.
  ///
  /// Behavior by current authorization status:
  ///   * `authorized` / `provisional` → just (re)register the token.
  ///   * `notDetermined` → show an in-app rationale dialog and, if the user
  ///     accepts, trigger the OS permission prompt.
  ///   * `denied` → show a one-time "open Settings" dialog (gated by a
  ///     [SharedPreferences] flag so we don't nag on every launch).
  ///
  /// Safe to call multiple times; safe to call on web (no-op). The
  /// [context] is used only to host dialogs and is captured before any
  /// `await`, so callers should pass a context that belongs to a mounted
  /// widget.
  Future<void> ensurePermissionAndRegister(BuildContext context) async {
    // On native platforms (Android/iOS) we rely on `permission_handler` to
    // determine the *real* permission state and to trigger the system
    // dialog. firebase_messaging's `getNotificationSettings()` is
    // unreliable on Android — it reports `denied` even when the runtime
    // permission has never been requested, which would otherwise cause us
    // to skip the OS prompt entirely and jump straight to the
    // "open Settings" rationale (the exact bug users hit on Android 13+).
    if (!kIsWeb) {
      await _ensurePermissionViaPermissionHandler(context);
      return;
    }

    // Web path — Firebase Messaging is required for browser push.
    if (_messaging == null) {
      debugPrint(
          '[PushNotificationService] FirebaseMessaging not available on web — '
          'check Firebase JS SDK config / firebase_options.');
      return;
    }

    NotificationSettings settings;
    try {
      settings = await _messaging!.getNotificationSettings();
    } catch (e) {
      debugPrint('[PushNotificationService] getNotificationSettings error: $e');
      return;
    }

    final status = settings.authorizationStatus;
    if (_isAuthorized(status)) {
      // User previously granted permission — clear any stale "open
      // settings" nag flag so we'll prompt again if they later revoke
      // and re-deny on a future install.
      await _clearSettingsNagFlag();
      await _getAndRegisterToken();
      return;
    }

    if (status == AuthorizationStatus.notDetermined) {
      if (!context.mounted) return;
      final accepted = await _showRationaleDialog(context);
      if (accepted != true) return;
      await _requestPermissionAndRegister();
      return;
    }

    // status == denied
    await _maybeShowOpenSettingsDialog(context);
  }

  /// Native (Android/iOS) permission flow.
  ///
  /// `permission_handler` correctly distinguishes `denied` (never asked, or
  /// asked once and dismissed) from `permanentlyDenied` (the user picked
  /// "Don't allow" twice on Android 13+ or toggled it off in Settings on
  /// iOS), which `firebase_messaging.getNotificationSettings()` does not.
  /// We use it to gate when we show the OS dialog vs. the "open Settings"
  /// rationale.
  ///
  /// On grant, we still call `FirebaseMessaging.requestPermission()` so the
  /// FCM authorization status is in sync, and then fetch & register the
  /// device token with the backend.
  Future<void> _ensurePermissionViaPermissionHandler(BuildContext context) async {
    PermissionStatus status;
    try {
      status = await Permission.notification.status;
    } catch (e) {
      debugPrint('[PushNotificationService] permission_handler status error: $e');
      return;
    }

    if (status.isGranted || status.isLimited) {
      await _clearSettingsNagFlag();
      // Already granted in a previous session — make sure the FCM token
      // is registered with the backend.
      if (_messaging != null) {
        await _getAndRegisterToken();
      }
      return;
    }

    if (status.isPermanentlyDenied) {
      if (!context.mounted) return;
      await _maybeShowOpenSettingsDialog(context);
      return;
    }

    // denied or restricted → show in-app rationale, then trigger OS prompt.
    if (!context.mounted) return;
    final accepted = await _showRationaleDialog(context);
    if (accepted != true) return;

    PermissionStatus result;
    try {
      result = await Permission.notification.request();
      debugPrint(
          '[PushNotificationService] permission_handler result: $result');
    } catch (e) {
      debugPrint('[PushNotificationService] permission_handler request error: $e');
      return;
    }

    if (result.isGranted || result.isLimited) {
      await _clearSettingsNagFlag();
      // Sync FCM authorization status (iOS uses its own UNUserNotificationCenter
      // bookkeeping) and fetch the FCM token.
      if (_messaging != null) {
        await _requestPermissionAndRegister();
      }
      return;
    }

    if (result.isPermanentlyDenied && context.mounted) {
      await _maybeShowOpenSettingsDialog(context);
    }
  }

  /// Whether the given [AuthorizationStatus] means notifications are
  /// effectively allowed (full grant or iOS provisional grant).
  bool _isAuthorized(AuthorizationStatus status) {
    return status == AuthorizationStatus.authorized ||
        status == AuthorizationStatus.provisional;
  }

  /// Show the Hebrew RTL rationale dialog. Returns true if the user
  /// accepted (and we should trigger the OS prompt), false otherwise.
  Future<bool?> _showRationaleDialog(BuildContext context) {
    return showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => Directionality(
        textDirection: TextDirection.rtl,
        child: AlertDialog(
          title: const Text('הפעלת התראות'),
          content: const Text(
            'כדי לקבל הודעות צ\'אט, עדכוני קריאות שירות והסעות בזמן אמת, '
            'יש לאפשר לאפליקציה לשלוח לך התראות.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('לא עכשיו'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('אפשר התראות'),
            ),
          ],
        ),
      ),
    );
  }

  /// Show — at most once per install — a dialog inviting the user to
  /// re-enable notifications from the system Settings screen.
  Future<void> _maybeShowOpenSettingsDialog(BuildContext context) async {    SharedPreferences prefs;
    try {
      prefs = await SharedPreferences.getInstance();
    } catch (e) {
      debugPrint('[PushNotificationService] SharedPreferences error: $e');
      return;
    }
    if (prefs.getBool(_kPushSettingsNagShownKey) == true) return;
    if (!context.mounted) return;

    final openSettings = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => Directionality(
        textDirection: TextDirection.rtl,
        child: AlertDialog(
          title: const Text('ההתראות מושבתות'),
          content: const Text(
            'התראות חסומות עבור האפליקציה, ולכן לא תקבל הודעות חדשות. '
            'ניתן להפעיל אותן מחדש דרך הגדרות המערכת.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('לא עכשיו'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('פתח הגדרות'),
            ),
          ],
        ),
      ),
    );

    // Persist regardless of the choice — we don't want to nag on every
    // launch even if the user dismissed without opening Settings.
    await prefs.setBool(_kPushSettingsNagShownKey, true);

    if (openSettings == true) {
      try {
        await openAppSettings();
      } catch (e) {
        debugPrint('[PushNotificationService] openAppSettings error: $e');
      }
    }
  }

  /// Trigger the OS permission prompt and, on success, register the FCM
  /// device token with the backend.
  Future<void> _requestPermissionAndRegister() async {
    try {
      final settings = await _messaging!.requestPermission(
        alert: true,
        badge: true,
        sound: true,
        provisional: false,
      );
      debugPrint(
          '[PushNotificationService] Permission status: ${settings.authorizationStatus}');
      if (_isAuthorized(settings.authorizationStatus)) {
        await _getAndRegisterToken();
      }
    } catch (e) {
      debugPrint('[PushNotificationService] requestPermission error: $e');
    }
  }

  Future<void> _initializeLocalNotifications() async {
    const androidSettings = AndroidInitializationSettings('@drawable/ic_notification');
    const iosSettings = DarwinInitializationSettings(
      requestAlertPermission: false,
      requestBadgePermission: false,
      requestSoundPermission: false,
    );

    const initSettings = InitializationSettings(
      android: androidSettings,
      iOS: iosSettings,
    );

    await _localNotifications!.initialize(
      settings: initSettings,
      onDidReceiveNotificationResponse: _onNotificationTapped,
    );
  }

  Future<void> _getAndRegisterToken() async {
    try {
      String? token;

      if (_isIOSPlatform()) {
        // Get APNs token first on iOS
        final apnsToken = await _messaging!.getAPNSToken();
        if (apnsToken == null) {
          debugPrint('[PushNotificationService] APNs token not available yet');
          return;
        }
      }

      if (kIsWeb) {
        // The web FCM SDK requires the project's Web Push certificate
        // (a.k.a. VAPID key). Without it `getToken` typically fails with
        // `messaging/token-subscribe-failed`. The key is configured in
        // [DefaultFirebaseOptions.webVapidKey] — log a clear hint when
        // it's still empty so misconfiguration is easy to diagnose.
        final vapidKey = DefaultFirebaseOptions.webVapidKey;
        if (vapidKey.isEmpty) {
          debugPrint(
              '[PushNotificationService] No web VAPID key configured — '
              'set DefaultFirebaseOptions.webVapidKey from Firebase '
              'Console → Cloud Messaging → Web Push certificates.');
          token = await _messaging!.getToken();
        } else {
          token = await _messaging!.getToken(vapidKey: vapidKey);
        }
      } else {
        token = await _messaging!.getToken();
      }

      if (token != null) {
        await _registerDeviceToken(token);
      }
    } catch (e) {
      debugPrint('[PushNotificationService] Error getting token: $e');
    }
  }

  void _onTokenRefresh(String token) {
    _registerDeviceToken(token);
  }

  Future<void> _registerDeviceToken(String token) async {
    final username = _ref.read(currentUserProvider);
    if (username == null || username.trim().isEmpty) {
      debugPrint(
          '[PushNotificationService] No current user — deferring token registration');
      // Remember the token so we can replay registration once auth
      // completes — without this an Android device whose push init
      // raced ahead of auth would never register its FCM token, and the
      // backend would never deliver pushes to it.
      _pendingToken = token;
      return;
    }

    final normalizedUser = username.trim().toLowerCase();
    // Skip only if the same token is already registered for the same user.
    // Re-register on user switch (logout → re-login as a different
    // account) so the backend routes pushes to the right user.
    if (token == _deviceToken && normalizedUser == _registeredForUser) {
      return;
    }

    try {
      final platform = _getPlatformName();
      await _api.registerDeviceToken(
        username: normalizedUser,
        token: token,
        platform: platform,
      );
      _deviceToken = token;
      _registeredForUser = normalizedUser;
      _pendingToken = null;
      debugPrint('[PushNotificationService] Device token registered for '
          '$normalizedUser: ${token.substring(0, 20)}...');
    } catch (e) {
      debugPrint('[PushNotificationService] Error registering token: $e');
    }
  }

  /// Replay a deferred token registration once the current user is known.
  ///
  /// Called from the chat shell after authentication succeeds so that any
  /// FCM token fetched before the user provider was populated is still
  /// posted to the backend. Safe to call multiple times — does nothing
  /// when there is no pending token or when it's already been registered
  /// for this user.
  Future<void> registerPendingTokenForUser() async {
    final pending = _pendingToken;
    if (pending == null) {
      // No deferred token: try fetching a fresh one in case FCM was ready
      // but we never got around to calling getToken (e.g. permission
      // granted in a previous session).
      if (_messaging != null && _deviceToken == null) {
        await _getAndRegisterToken();
      }
      return;
    }
    await _registerDeviceToken(pending);
  }

  /// Handle foreground message
  void _onMessage(RemoteMessage message) {
    debugPrint('[PushNotificationService] Foreground message: ${message.messageId}');

    // Show local notification
    _showLocalNotification(message);

    // Apply push payload to chat store (also schedules recovery pulls)
    _applyPushPayload(message);
  }

  /// Handle message when app opened from notification
  void _onMessageOpenedApp(RemoteMessage message) {
    debugPrint('[PushNotificationService] Opened from notification: ${message.messageId}');

    // Apply push payload (also schedules recovery pulls)
    _applyPushPayload(message);

    // Navigate to the relevant chat
    _navigateToChat(message);
  }

  /// Handle local notification tap (foreground notifications)
  void _onNotificationTapped(NotificationResponse response) {
    final payload = response.payload;
    if (payload == null) return;

    // Format: "chatId:messageId"
    final parts = payload.split(':');
    if (parts.isEmpty) return;
    final chatId = parts[0];
    if (chatId.isEmpty) return;

    debugPrint('[PushNotificationService] Local notification tapped: $chatId');
    _openChatScreen(chatId);
  }

  /// Returns true for FCM data payloads that should never produce a visible
  /// notification — read-receipts, delete/edit actions, group-update events,
  /// typing indicators, and self-echo messages (skipNotification: true).
  ///
  /// On Android the Firebase SDK coerces every value in `RemoteMessage.data`
  /// to a [String], so booleans like `skipNotification: true` arrive as the
  /// string `'true'`.  We check both to be safe.
  static bool _isSilentPushData(Map<String, dynamic> data) {
    final skip = data['skipNotification'];
    if (skip == true || skip == 'true') return true;

    const silentTypes = {
      'read-receipt',
      'read',
      'delete-action',
      'delete',
      'edit-action',
      'edit',
      'group-update',
      'typing',
    };
    final type = (data['type'] ?? '').toString().trim().toLowerCase();
    return silentTypes.contains(type);
  }

  /// Show local notification for foreground messages
  Future<void> _showLocalNotification(RemoteMessage message) async {
    final notification = message.notification;
    if (notification == null) return;

    // Suppress visual notifications for action / housekeeping payloads
    // (read-receipts, delete/edit actions, self-echo, etc.) even if the
    // server accidentally included a notification field.
    if (_isSilentPushData(Map<String, dynamic>.from(message.data))) return;

    // The flutter_local_notifications plugin has no web implementation.
    // On web the browser already shows a system notification when the
    // service worker (`firebase-messaging-sw.js`) handles the push, so
    // we don't need to do anything here.
    if (kIsWeb || _localNotifications == null) return;

    const androidDetails = AndroidNotificationDetails(
      'chat_messages',
      'Chat Messages',
      channelDescription: 'Notifications for new chat messages',
      importance: Importance.high,
      priority: Priority.high,
      showWhen: true,
      icon: '@drawable/ic_notification',
    );

    const iosDetails = DarwinNotificationDetails(
      presentAlert: true,
      presentBadge: true,
      presentSound: true,
    );

    const details = NotificationDetails(
      android: androidDetails,
      iOS: iosDetails,
    );

    // Extract chat ID from data
    final data = message.data;
    final chatId = data['chatId'] ?? data['groupId'] ?? '';
    final messageId = data['messageId'] ?? '';

    await _localNotifications!.show(
      id: message.hashCode,
      title: notification.title,
      body: notification.body,
      notificationDetails: details,
      payload: '$chatId:$messageId',
    );
  }

  /// Apply push payload to chat store
  void _applyPushPayload(RemoteMessage message) {
    final data = message.data;
    if (data.isEmpty) return;

    debugPrint('[PushNotificationService] Push data: $data');

    try {
      // Cast to Map<String, dynamic> — RemoteMessage.data is Map<String, String>
      // on Android but typed as Map<String, dynamic> in firebase_messaging.
      final dataMap = Map<String, dynamic>.from(data);
      _ref.read(chatStoreProvider.notifier).applyIncomingFromPushPayload(dataMap);
    } catch (e) {
      debugPrint('[PushNotificationService] Error applying push payload: $e');
    }
  }

  /// Navigate to the chat from a notification
  void _navigateToChat(RemoteMessage message) {
    final data = message.data;
    final chatId = (data['chatId'] ?? data['groupId'] ?? data['sender'])?.toString();
    if (chatId == null || chatId.isEmpty) return;
    _openChatScreen(chatId);
  }

  /// Set current chat in the store and push the [MessageScreen] route via the
  /// global [rootNavigatorKey]. This works from background-tap callbacks
  /// where there is no [BuildContext] in scope.
  void _openChatScreen(String chatId) {
    try {
      _ref.read(chatStoreProvider.notifier).setCurrentChat(chatId);
    } catch (e) {
      debugPrint('[PushNotificationService] setCurrentChat error: $e');
    }

    final navigator = rootNavigatorKey.currentState;
    if (navigator == null) {
      debugPrint('[PushNotificationService] Navigator not ready, skipping deep link');
      return;
    }
    navigator.push(
      MaterialPageRoute(builder: (_) => MessageScreen(chatId: chatId)),
    );
  }

  /// Reset the app icon badge to zero.
  ///
  /// Calls the server's `/reset-badge` endpoint (so future push payloads
  /// from APNs/FCM carry badge=0) and cancels all local notifications
  /// (which on iOS also zeroes the home-screen icon badge number).
  Future<void> resetBadge() async {
    final username = _ref.read(currentUserProvider);
    if (username == null || username.trim().isEmpty) return;

    // Tell the server to reset the badge counter for this user.
    try {
      await _api.resetServerBadge(username);
    } catch (e) {
      debugPrint('[PushNotificationService] resetServerBadge error: $e');
    }

    // Clear all local notifications (also resets the iOS app-icon badge).
    try {
      if (!kIsWeb && _localNotifications != null) {
        await _localNotifications!.cancelAll();
      }
    } catch (e) {
      debugPrint('[PushNotificationService] cancelAll error: $e');
    }
  }

  /// Unregister device token (on logout)
  Future<void> unregisterToken() async {
    final token = _deviceToken;
    if (token == null) return;
    final username = _ref.read(currentUserProvider);
    if (username == null || username.trim().isEmpty) {
      _deviceToken = null;
      return;
    }
    try {
      await _api.unregisterDeviceToken(
        username: username,
        token: token,
        platform: _getPlatformName(),
      );
      _deviceToken = null;
    } catch (e) {
      debugPrint('[PushNotificationService] Error unregistering token: $e');
    }
  }

  /// Clear the "open settings" nag flag so users who later grant
  /// permission can be re-prompted in a future session if they revoke
  /// and re-deny.
  Future<void> _clearSettingsNagFlag() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (prefs.getBool(_kPushSettingsNagShownKey) == true) {
        await prefs.remove(_kPushSettingsNagShownKey);
      }
    } catch (_) {
      // best-effort
    }
  }

  /// Clean up
  void dispose() {
    _tokenRefreshSubscription?.cancel();
    _messageSubscription?.cancel();
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

final pushNotificationServiceProvider = Provider<PushNotificationService>((ref) {
  final api = ref.watch(chatApiServiceProvider);
  final service = PushNotificationService(api, ref);
  
  ref.onDispose(() {
    service.dispose();
  });

  return service;
});

// ---------------------------------------------------------------------------
// Background Message Handler
// ---------------------------------------------------------------------------

/// Handle background messages when app is terminated or in background
/// This must be a top-level function
@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  debugPrint('[PushNotificationService] Background message: ${message.messageId}');
  
  // Initialize Firebase if needed (background isolate has its own
  // FirebaseApp registry — pass explicit options so init succeeds even
  // when google-services.json codegen isn't on the classpath).
  await Firebase.initializeApp(
    options: DefaultFirebaseOptions.currentPlatform,
  );
  
  // We can't access providers here, so just log for now
  // The message will be processed when the app opens
}
