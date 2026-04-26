/// Application configuration constants that mirror the Angular frontend's runtime-config.ts
///
/// API endpoints and timeouts are configured to match the existing backend contract.
library;

/// Environment configuration class
class AppConfig {
  const AppConfig._();

  /// Default backend origin (production)
  static const String defaultBackendOrigin = 'https://www.tzmc.co.il';

  /// VAPID public key for web push (not used in mobile, but kept for reference)
  static const String vapidPublicKey =
      'BNgK2Le8hUyXIrFeuHJJsHwjOUkK5y5bf46QH80Ybd1AoQFfQDEanVCfjo9HwqdJwWoD2-2pxxgTRdTasf9YYMk';

  /// Base notify URL path
  static const String notifyPath = '/notify';

  /// Database name for local persistence
  static const String dbName = 'tzmc_push_db';

  /// System chat IDs (reserved names - matches Angular frontend)
  static const List<String> systemChatIds = [
    'ציפי',
    'הזמנת הסעה',
    'מוקד איחוד - קריאות',
    'הסעות',
    'דוברות',
    'בדיקה - דוברות',
  ];
}

/// API endpoints configuration
class ApiEndpoints {
  const ApiEndpoints._();

  // Auth
  static const String session = '/auth/session';
  static const String requestCode = '/auth/session/request-code';
  static const String verifyCode = '/auth/session/verify-code';

  // Contacts & Groups
  static const String contacts = '/contacts';
  static const String groups = '/groups';
  static const String userChatGroups = '/user-chat-groups';
  static const String communityGroupConfigs = '/community-group-configs';

  // Messages
  static const String messages = '/messages';
  static const String messagesLogs = '/messages/logs';
  static const String messagesReceived = '/messages/received';
  static const String messagesReceivedBatch = '/messages/received-batch';
  static const String stream = '/stream';

  // Actions
  static const String reply = '/reply';
  static const String groupUpdate = '/group-update';
  static const String reaction = '/reaction';
  static const String typing = '/typing';
  static const String read = '/read';
  static const String edit = '/edit';
  static const String delete = '/delete';
  static const String upload = '/upload';
  static const String markSeen = '/mark-seen';

  // Device & Push
  static const String registerDevice = '/register-device';
  // Flutter-only FCM token registration endpoints. The Angular frontend
  // continues to use `/register-device` for web-push subscriptions; the
  // mobile app uses these dedicated routes so the two pipelines stay
  // independent on the server.
  static const String registerFlutterFcm = '/flutter/register-fcm';
  static const String unregisterFlutterFcm = '/flutter/unregister-fcm';
  static const String resetBadge = '/reset-badge';
  static const String subscriptions = '/subscriptions';

  // Utilities
  static const String version = '/version';
  static const String log = '/log';

  // HR
  static const String hrSteps = '/hr/steps';
  static const String hrActions = '/hr/actions';

  // Shuttle
  static const String shuttleOrders = '/shuttle/orders';
  static const String shuttleUserOrders = '/shuttle/orders/user';
  static const String shuttleOperationsOrders = '/shuttle/orders/operations';
  static const String shuttleEmployees = '/shuttle/employees';
  static const String shuttleStations = '/shuttle/stations';

  // Helpdesk
  static const String helpdesk = '/helpdesk';
  static const String helpdeskTickets = '/helpdesk/tickets';
  static const String helpdeskUserTickets = '/helpdesk/tickets/user';
  static const String helpdeskMyRole = '/helpdesk/my-role';
  static const String helpdeskHandlers = '/helpdesk/handlers';
  static const String helpdeskLocations = '/helpdesk/locations';
}

/// Network timeouts (matching Angular frontend behavior)
class NetworkTimeouts {
  const NetworkTimeouts._();

  /// Default request timeout
  static const Duration defaultTimeout = Duration(seconds: 10);

  /// Session operations timeout
  static const Duration sessionTimeout = Duration(seconds: 12);

  /// Upload timeout (longer for file uploads)
  static const Duration uploadTimeout = Duration(seconds: 30);

  /// Messages logs timeout (may return large payloads)
  static const Duration logsTimeout = Duration(seconds: 20);

  /// Shuttle orders timeout (Apps Script can be slow)
  static const Duration shuttleTimeout = Duration(seconds: 65);

  /// Default retry backoff
  static const Duration retryBackoff = Duration(milliseconds: 450);
}

/// Realtime transport configuration (matching Angular frontend)
class RealtimeConfig {
  const RealtimeConfig._();

  /// Polling interval when fallback to polling mode
  static const Duration pollInterval = Duration(seconds: 15);

  /// SSE stream retry delay
  static const Duration streamRetryDelay = Duration(seconds: 5);

  /// Socket reconnect retry delay
  static const Duration socketRetryDelay = Duration(milliseconds: 3500);

  /// Delay before falling back from socket to SSE
  static const Duration socketFallbackToSseDelay = Duration(milliseconds: 1800);

  /// Max consecutive socket failures before cooldown
  static const int maxSocketFailuresBeforeCooldown = 3;

  /// Socket cooldown duration after multiple failures
  static const Duration socketFailureCooldown = Duration(minutes: 5);

  /// Socket acknowledgement timeout
  static const Duration socketAckTimeout = Duration(seconds: 6);
}

/// Push recovery configuration (matching Angular frontend)
class PushRecoveryConfig {
  const PushRecoveryConfig._();

  /// Delays for recovery pulls after receiving a push notification
  /// These help recover truncated message bodies
  static const List<Duration> recoveryPullDelays = [
    Duration(milliseconds: 1200),
    Duration(milliseconds: 3600),
  ];

  /// Max push payload size before truncation (bytes)
  static const int maxPushPayloadBytes = 3584;
}
