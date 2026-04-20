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
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/chat_api_service.dart';
import '../services/chat_store_service.dart';

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
// Constants
// ---------------------------------------------------------------------------

/// Push recovery pull delays (matching Angular frontend)
const List<int> _pushRecoveryPullDelaysMs = [1200, 3600];

// ---------------------------------------------------------------------------
// Push Notification Service
// ---------------------------------------------------------------------------

class PushNotificationService {
  final ChatApiService _api;
  final Ref _ref;

  FirebaseMessaging? _messaging;
  FlutterLocalNotificationsPlugin? _localNotifications;
  String? _deviceToken;
  StreamSubscription? _tokenRefreshSubscription;
  StreamSubscription? _messageSubscription;

  PushNotificationService(this._api, this._ref);

  /// Initialize push notifications
  Future<void> initialize() async {
    if (kIsWeb) {
      // Web uses the existing web-push system
      return;
    }

    try {
      // Initialize Firebase
      await Firebase.initializeApp();
      _messaging = FirebaseMessaging.instance;

      // Initialize local notifications for foreground display
      _localNotifications = FlutterLocalNotificationsPlugin();
      await _initializeLocalNotifications();

      // Request permission
      await _requestPermission();

      // Get and register token
      await _getAndRegisterToken();

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

  Future<void> _initializeLocalNotifications() async {
    const androidSettings = AndroidInitializationSettings('@mipmap/ic_launcher');
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

  Future<void> _requestPermission() async {
    final settings = await _messaging!.requestPermission(
      alert: true,
      badge: true,
      sound: true,
      provisional: false,
    );

    debugPrint('[PushNotificationService] Permission status: ${settings.authorizationStatus}');
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

      token = await _messaging!.getToken();
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
    if (token == _deviceToken) return; // Already registered

    try {
      final platform = _getPlatformName();
      await _api.registerDeviceToken(token: token, platform: platform);
      _deviceToken = token;
      debugPrint('[PushNotificationService] Device token registered: ${token.substring(0, 20)}...');
    } catch (e) {
      debugPrint('[PushNotificationService] Error registering token: $e');
    }
  }

  /// Handle foreground message
  void _onMessage(RemoteMessage message) {
    debugPrint('[PushNotificationService] Foreground message: ${message.messageId}');

    // Show local notification
    _showLocalNotification(message);

    // Apply push payload to chat store
    _applyPushPayload(message);

    // Schedule recovery pulls for truncated content
    _schedulePushRecoveryPulls();
  }

  /// Handle message when app opened from notification
  void _onMessageOpenedApp(RemoteMessage message) {
    debugPrint('[PushNotificationService] Opened from notification: ${message.messageId}');

    // Apply push payload
    _applyPushPayload(message);

    // Schedule recovery pulls
    _schedulePushRecoveryPulls();

    // Navigate to the relevant chat
    _navigateToChat(message);
  }

  /// Handle local notification tap
  void _onNotificationTapped(NotificationResponse response) {
    final payload = response.payload;
    if (payload != null) {
      // Parse payload and navigate
      // Format: "chatId:messageId"
      final parts = payload.split(':');
      if (parts.length >= 2) {
        final chatId = parts[0];
        // TODO: Navigate to chat using a navigation service
        debugPrint('[PushNotificationService] Navigate to chat: $chatId');
      }
    }
  }

  /// Show local notification for foreground messages
  Future<void> _showLocalNotification(RemoteMessage message) async {
    final notification = message.notification;
    if (notification == null) return;

    const androidDetails = AndroidNotificationDetails(
      'chat_messages',
      'Chat Messages',
      channelDescription: 'Notifications for new chat messages',
      importance: Importance.high,
      priority: Priority.high,
      showWhen: true,
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

    // The push payload contains truncated message data
    // The chat store will apply it and schedule recovery pulls
    // to fetch the full message content
    debugPrint('[PushNotificationService] Push data: $data');

    // TODO: Parse push payload and apply to chat store
    // This requires access to the ChatStoreNotifier
  }

  /// Schedule push recovery pulls to fetch full message content
  void _schedulePushRecoveryPulls() {
    // Schedule delayed pulls to recover truncated content
    // This matches the Angular frontend behavior
    for (final delayMs in _pushRecoveryPullDelaysMs) {
      Future.delayed(Duration(milliseconds: delayMs), () {
        try {
          _ref.read(chatStoreProvider.notifier).pullMessages();
        } catch (e) {
          debugPrint('[PushNotificationService] Recovery pull error: $e');
        }
      });
    }
  }

  /// Navigate to the chat from a notification
  void _navigateToChat(RemoteMessage message) {
    final data = message.data;
    final chatId = data['chatId'] ?? data['groupId'];
    if (chatId == null) return;

    // Set current chat in store
    try {
      _ref.read(chatStoreProvider.notifier).setCurrentChat(chatId);
    } catch (e) {
      debugPrint('[PushNotificationService] Navigation error: $e');
    }
  }

  /// Unregister device token (on logout)
  Future<void> unregisterToken() async {
    if (_deviceToken != null) {
      try {
        await _api.unregisterDeviceToken(_deviceToken!);
        _deviceToken = null;
      } catch (e) {
        debugPrint('[PushNotificationService] Error unregistering token: $e');
      }
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
  
  // Initialize Firebase if needed
  await Firebase.initializeApp();
  
  // We can't access providers here, so just log for now
  // The message will be processed when the app opens
}
