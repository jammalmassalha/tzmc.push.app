/// Chat API service - mirrors the Angular ChatApiService
///
/// Provides all API methods for authentication, contacts, groups,
/// messages, and other chat-related operations.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/app_config.dart';
import '../models/api_payloads.dart';
import '../models/chat_models.dart';
import '../models/helpdesk_models.dart';
import '../utils/xfile.dart';
import 'http_client.dart';

/// Chat API service provider
final chatApiServiceProvider = Provider<ChatApiService>((ref) {
  final httpClient = ref.watch(httpClientProvider);
  return ChatApiService(httpClient);
});

/// Chat API service implementation
class ChatApiService {
  final HttpClient _client;

  ChatApiService(this._client);

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  /// Get current session user
  Future<String?> getSessionUser() async {
    try {
      final response = await _client.get<Map<String, dynamic>>(
        ApiEndpoints.session,
        retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 8)),
      );

      if (!response.isSuccessful) {
        _client.clearCsrfToken();
        return null;
      }

      final body = SessionResponse.fromJson(response.data ?? {});
      _client.setCsrfToken(body.csrfToken);

      final user = body.user?.trim().toLowerCase();
      if (!body.authenticated) {
        _client.clearCsrfToken();
        return null;
      }

      return body.authenticated && (user?.isNotEmpty ?? false) ? user : null;
    } catch (e) {
      _client.clearCsrfToken();
      return null;
    }
  }

  // NOTE: Direct login (createSession) has been removed because it is disabled on the server.
  // All login flows must use the SMS verification code flow via requestSessionCode() and verifySessionCode().

  /// Request SMS verification code
  Future<int> requestSessionCode(String user) async {
    final normalized = user.trim().toLowerCase();
    if (normalized.isEmpty) {
      throw AuthException('מספר טלפון לא תקין');
    }

    final response = await _client.post<Map<String, dynamic>>(
      ApiEndpoints.requestCode,
      data: {'user': normalized},
      retryOptions: const RetryOptions(retries: 1, timeout: NetworkTimeouts.sessionTimeout),
    );

    if (!response.isSuccessful) {
      final body = response.data;
      final message = (body?['message'] ?? body?['error'] ?? '').toString().trim();

      if (response.statusCode == 400) {
        throw AuthException('מספר טלפון לא תקין');
      } else if (response.statusCode == 403) {
        throw AuthException('המשתמש אינו מורשה');
      } else if (response.statusCode == 429) {
        final retryAfter = body?['retryAfterSeconds'] as int?;
        throw RateLimitException('יותר מדי ניסיונות. נסה שוב בעוד $retryAfter שניות', retryAfter);
      } else if (message.isNotEmpty) {
        throw AuthException(message);
      }
      throw AuthException('שליחת קוד אימות נכשלה');
    }

    final body = SessionResponse.fromJson(response.data ?? {});
    final expiresInSeconds = body.expiresInSeconds ?? 300;
    return expiresInSeconds > 0 ? expiresInSeconds : 300;
  }

  /// Verify SMS code
  Future<String> verifySessionCode(String user, String code) async {
    final normalized = user.trim().toLowerCase();
    final normalizedCode = code.trim();

    if (normalized.isEmpty) {
      throw AuthException('מספר טלפון לא תקין');
    }
    if (!RegExp(r'^\d{6}$').hasMatch(normalizedCode)) {
      throw AuthException('יש להזין קוד אימות בן 6 ספרות');
    }

    final response = await _client.post<Map<String, dynamic>>(
      ApiEndpoints.verifyCode,
      data: {'user': normalized, 'code': normalizedCode},
      retryOptions: const RetryOptions(retries: 1, timeout: NetworkTimeouts.sessionTimeout),
    );

    if (!response.isSuccessful) {
      final body = response.data;
      final message = (body?['message'] ?? body?['error'] ?? '').toString().trim();

      if (response.statusCode == 400) {
        throw AuthException('קוד אימות לא תקין');
      } else if (response.statusCode == 401) {
        throw AuthException('קוד האימות שגוי או פג תוקף');
      } else if (response.statusCode == 403) {
        throw AuthException('המשתמש אינו מורשה');
      } else if (response.statusCode == 429) {
        final retryAfter = body?['retryAfterSeconds'] as int?;
        throw RateLimitException('יותר מדי ניסיונות. נסה שוב בעוד $retryAfter שניות', retryAfter);
      } else if (message.isNotEmpty) {
        throw AuthException(message);
      }
      throw AuthException('אימות הקוד נכשל');
    }

    final body = SessionResponse.fromJson(response.data ?? {});
    _client.setCsrfToken(body.csrfToken);

    final sessionUser = body.user?.trim().toLowerCase();
    if (!body.authenticated || (sessionUser?.isEmpty ?? true)) {
      _client.clearCsrfToken();
      throw AuthException('אימות הקוד נכשל');
    }

    return sessionUser!;
  }

  /// Clear session (logout)
  Future<void> clearSession() async {
    await _client.delete(
      ApiEndpoints.session,
      retryOptions: const RetryOptions(retries: 0, timeout: Duration(seconds: 8)),
    );
    _client.clearCsrfToken();
    await _client.clearCookies();
  }

  // ---------------------------------------------------------------------------
  // Contacts & Groups
  // ---------------------------------------------------------------------------

  /// Get contacts list
  Future<List<Contact>> getContacts({String? user}) async {
    final normalizedUser = user?.trim() ?? '';

    // Try multiple URL patterns for compatibility
    final queryParams = normalizedUser.isNotEmpty ? {'user': normalizedUser} : null;

    final response = await _client.get<Map<String, dynamic>>(
      ApiEndpoints.contacts,
      queryParameters: queryParams,
      retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 10)),
    );

    if (!response.isSuccessful) {
      throw ApiException('Contacts request failed with ${response.statusCode}');
    }

    final users = (response.data?['users'] as List?) ?? [];
    final seen = <String>{};

    return users
        .map((item) => Contact.fromJson(item as Map<String, dynamic>))
        .where((contact) {
          final key = contact.username.toLowerCase();
          if (key.isEmpty || contact.displayName.isEmpty || seen.contains(key)) {
            return false;
          }
          seen.add(key);
          return true;
        })
        .toList();
  }

  /// Get groups list
  Future<List<ChatGroup>> getGroups({String? user}) async {
    final normalizedUser = user?.trim().toLowerCase() ?? '';
    final queryParams = normalizedUser.isNotEmpty ? {'user': normalizedUser} : null;

    final response = await _client.get<Map<String, dynamic>>(
      ApiEndpoints.groups,
      queryParameters: queryParams,
      retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 10)),
    );

    if (!response.isSuccessful) {
      throw ApiException('Groups request failed with ${response.statusCode}');
    }

    final groups = (response.data?['groups'] as List?) ?? [];
    return groups
        .map((item) => ChatGroup.fromJson(item as Map<String, dynamic>))
        .where((group) => group.id.isNotEmpty && group.name.isNotEmpty)
        .toList();
  }

  /// Get user chat groups
  Future<List<ChatGroup>> getUserChatGroups() async {
    try {
      final response = await _client.get<Map<String, dynamic>>(
        ApiEndpoints.userChatGroups,
        retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 10)),
      );

      if (!response.isSuccessful) return [];

      final groups = (response.data?['groups'] as List?) ?? [];
      return groups
          .map((item) => ChatGroup.fromJson(item as Map<String, dynamic>))
          .where((group) => group.id.isNotEmpty && group.name.isNotEmpty)
          .toList();
    } catch (_) {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  /// Poll messages
  Future<List<IncomingServerMessage>> pollMessages({String? user}) async {
    final normalizedUser = user?.trim().toLowerCase() ?? '';
    final queryParams = normalizedUser.isNotEmpty ? {'user': normalizedUser} : null;

    final response = await _client.get<Map<String, dynamic>>(
      ApiEndpoints.messages,
      queryParameters: queryParams,
      retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 10)),
    );

    if (!response.isSuccessful) {
      throw ApiException('Messages request failed with ${response.statusCode}');
    }

    final messages = (response.data?['messages'] as List?) ?? [];
    return messages.map((item) => IncomingServerMessage.fromJson(item as Map<String, dynamic>)).toList();
  }

  /// Get messages from logs (for gap analysis / history sync)
  Future<List<IncomingServerMessage>> getMessagesFromLogs({
    required String user,
    int limit = 1000,
    int offset = 0,
    int since = 0,
  }) async {
    final normalizedUser = user.trim().toLowerCase();
    if (normalizedUser.isEmpty) return [];

    final safeLimit = limit.clamp(1, 200000);
    final safeOffset = offset.clamp(0, 1000000);

    final response = await _client.get<Map<String, dynamic>>(
      ApiEndpoints.messagesLogs,
      queryParameters: {
        'user': normalizedUser,
        'excludeSystem': '1',
        'limit': safeLimit.toString(),
        'offset': safeOffset.toString(),
        'since': since.toString(),
        '_ts': DateTime.now().millisecondsSinceEpoch.toString(),
      },
      retryOptions: const RetryOptions(retries: 1, timeout: NetworkTimeouts.logsTimeout),
    );

    if (!response.isSuccessful) {
      throw ApiException('Logs request failed: ${response.statusCode}');
    }

    final messages = (response.data?['messages'] as List?) ?? [];
    return messages.map((item) => IncomingServerMessage.fromJson(item as Map<String, dynamic>)).toList();
  }

  /// Report message received
  Future<void> reportMessageReceived(String msgId, int receivedAt) async {
    final safeMsgId = msgId.trim();
    if (safeMsgId.isEmpty || receivedAt <= 0) return;

    await _client.post(
      ApiEndpoints.messagesReceived,
      data: {'msgId': safeMsgId, 'receivedAt': receivedAt},
      retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 10)),
    );
  }

  /// Report messages received (batch)
  Future<void> reportMessagesReceivedBatch(List<({String msgId, int receivedAt})> entries) async {
    final validEntries = entries
        .where((e) => e.msgId.trim().isNotEmpty && e.receivedAt > 0)
        .map((e) => {'msgId': e.msgId.trim(), 'receivedAt': e.receivedAt})
        .toList();

    if (validEntries.isEmpty) return;

    await _client.post(
      ApiEndpoints.messagesReceivedBatch,
      data: {'entries': validEntries},
      retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 15)),
    );
  }

  // ---------------------------------------------------------------------------
  // Message Actions
  // ---------------------------------------------------------------------------

  /// Send direct message
  Future<void> sendDirectMessage(ReplyPayload payload) async {
    final response = await _client.post(
      ApiEndpoints.reply,
      data: payload.toJson(),
      retryOptions: const RetryOptions(retries: 2, timeout: Duration(seconds: 10)),
    );

    if (!response.isSuccessful) {
      throw ApiException('Message send failed with ${response.statusCode}');
    }
  }

  /// Send group update
  Future<void> sendGroupUpdate(GroupUpdatePayload payload) async {
    final response = await _client.post(
      ApiEndpoints.groupUpdate,
      data: payload.toJson(),
      retryOptions: const RetryOptions(retries: 2, timeout: Duration(seconds: 10)),
    );

    if (!response.isSuccessful) {
      throw ApiException('Group update failed with ${response.statusCode}');
    }
  }

  /// Send reaction
  Future<void> sendReaction(ReactionPayload payload) async {
    final response = await _client.post(
      ApiEndpoints.reaction,
      data: payload.toJson(),
      retryOptions: const RetryOptions(retries: 2, timeout: Duration(seconds: 10)),
    );

    if (!response.isSuccessful) {
      throw ApiException('Reaction update failed with ${response.statusCode}');
    }
  }

  /// Send typing state
  Future<void> sendTypingState(TypingPayload payload) async {
    final response = await _client.post(
      ApiEndpoints.typing,
      data: payload.toJson(),
      retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 4)),
    );

    if (!response.isSuccessful) {
      throw ApiException('Typing update failed with ${response.statusCode}');
    }
  }

  /// Send read receipt
  Future<void> sendReadReceipt(ReadReceiptPayload payload) async {
    final response = await _client.post(
      ApiEndpoints.read,
      data: payload.toJson(),
      retryOptions: const RetryOptions(retries: 2, timeout: Duration(seconds: 10)),
    );

    if (!response.isSuccessful) {
      throw ApiException('Read receipt failed with ${response.statusCode}');
    }
  }

  /// Edit message
  Future<void> editMessageForEveryone(EditMessagePayload payload) async {
    final response = await _client.post(
      ApiEndpoints.edit,
      data: payload.toJson(),
      retryOptions: const RetryOptions(retries: 2, timeout: Duration(seconds: 10)),
    );

    if (!response.isSuccessful) {
      throw ApiException('Edit message failed with ${response.statusCode}');
    }
  }

  /// Delete message
  Future<void> deleteMessageForEveryone(DeleteMessagePayload payload) async {
    final response = await _client.post(
      ApiEndpoints.delete,
      data: payload.toJson(),
      retryOptions: const RetryOptions(retries: 2, timeout: Duration(seconds: 10)),
    );

    if (!response.isSuccessful) {
      throw ApiException('Delete message failed with ${response.statusCode}');
    }
  }

  /// Mark messages as seen
  Future<int> markMessagesSeen(String user, String chatId) async {
    final normalized = user.trim().toLowerCase();

    final response = await _client.post<Map<String, dynamic>>(
      ApiEndpoints.markSeen,
      data: {
        'user': normalized,
        'chatId': chatId.trim().toLowerCase(),
      },
      retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 8)),
    );

    return (response.data?['marked'] as int?) ?? 0;
  }

  // ---------------------------------------------------------------------------
  // File Upload
  // ---------------------------------------------------------------------------

  /// Upload file (cross-platform)
  Future<UploadResponse> uploadFile(XFile file, {XFile? thumbnail}) async {
    final response = await _client.uploadFile<Map<String, dynamic>>(
      ApiEndpoints.upload,
      file: file,
      thumbnail: thumbnail,
      retryOptions: const RetryOptions(retries: 2, timeout: NetworkTimeouts.uploadTimeout),
    );

    if (!response.isSuccessful) {
      throw ApiException('Upload failed with ${response.statusCode}');
    }

    return UploadResponse.fromJson(response.data ?? {});
  }

  // ---------------------------------------------------------------------------
  // Device Registration
  // ---------------------------------------------------------------------------

  /// Register device for push notifications
  Future<void> registerDevice({
    required String user,
    required String? fcmToken,
    required String deviceType,
    required String platform,
    String action = 'subscribe',
  }) async {
    final payload = {
      'username': user.toLowerCase(),
      'fcmToken': fcmToken,
      'deviceType': deviceType,
      'action': action,
      'platform': platform,
    };

    await _client.post(
      ApiEndpoints.registerDevice,
      data: payload,
      retryOptions: const RetryOptions(retries: 2, timeout: Duration(seconds: 12)),
    );
  }

  /// Reset server badge
  Future<void> resetServerBadge(String user) async {
    final normalized = user.trim().toLowerCase();
    if (normalized.isEmpty) return;

    await _client.post(
      ApiEndpoints.resetBadge,
      data: {'user': normalized},
      retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 8)),
    );
  }

  // ---------------------------------------------------------------------------
  // Version & Misc
  // ---------------------------------------------------------------------------

  /// Get server version
  Future<({String version, List<String> notes})> getVersion() async {
    final response = await _client.get<Map<String, dynamic>>(
      ApiEndpoints.version,
      queryParameters: {'t': DateTime.now().millisecondsSinceEpoch.toString()},
      retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 8)),
    );

    if (!response.isSuccessful) {
      throw ApiException('Version check failed with ${response.statusCode}');
    }

    final body = response.data ?? {};
    return (
      version: (body['version'] ?? '').toString(),
      notes: ((body['notes'] ?? body['releaseNotes']) as List?)?.cast<String>() ?? [],
    );
  }

  /// Send client log
  Future<void> sendClientLog(String event, Map<String, dynamic> payload, {String? user}) async {
    final safeEvent = event.trim();
    if (safeEvent.isEmpty) return;

    await _client.post(
      ApiEndpoints.log,
      data: {
        'event': safeEvent,
        'payload': payload,
        if (user != null) 'user': user.trim(),
        'timestamp': DateTime.now().millisecondsSinceEpoch,
      },
      retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 8)),
    );
  }

  // ---------------------------------------------------------------------------
  // Shuttle
  // ---------------------------------------------------------------------------

  /// Get shuttle employees
  /// 
  /// [user] is required for backend authorization when session cookies are not available.
  Future<List<String>> getShuttleEmployees(String user) async {
    final normalizedUser = user.trim();
    if (normalizedUser.isEmpty) {
      throw ApiException('User is required for shuttle employees request');
    }
    
    final response = await _client.get<Map<String, dynamic>>(
      ApiEndpoints.shuttleEmployees,
      queryParameters: {
        'user': normalizedUser,
        '_ts': DateTime.now().millisecondsSinceEpoch.toString(),
      },
      retryOptions: const RetryOptions(retries: 2, timeout: Duration(seconds: 12)),
    );

    if (!response.isSuccessful) {
      throw ApiException('Shuttle employees request failed with ${response.statusCode}');
    }

    final data = response.data?['data'] as List?;
    return data?.map((item) => item.toString().trim()).where((s) => s.isNotEmpty).toList() ?? [];
  }

  /// Get shuttle stations
  /// 
  /// [user] is required for backend authorization when session cookies are not available.
  Future<List<String>> getShuttleStations(String user) async {
    final normalizedUser = user.trim();
    if (normalizedUser.isEmpty) {
      throw ApiException('User is required for shuttle stations request');
    }
    
    final response = await _client.get<Map<String, dynamic>>(
      ApiEndpoints.shuttleStations,
      queryParameters: {
        'user': normalizedUser,
        '_ts': DateTime.now().millisecondsSinceEpoch.toString(),
      },
      retryOptions: const RetryOptions(retries: 2, timeout: Duration(seconds: 12)),
    );

    if (!response.isSuccessful) {
      throw ApiException('Shuttle stations request failed with ${response.statusCode}');
    }

    final data = response.data?['data'] as List?;
    return data?.map((item) => item.toString().trim()).where((s) => s.isNotEmpty).toList() ?? [];
  }

  /// Submit shuttle order
  ///
  /// [user] is required for backend authorization when session cookies are not available.
  Future<void> submitShuttleOrder(ShuttleOrderSubmitPayload payload, String user) async {
    final normalizedUser = user.trim();
    if (normalizedUser.isEmpty) {
      throw ApiException('User is required for shuttle order submission');
    }

    final response = await _client.post<String>(
      ApiEndpoints.shuttleOrders,
      data: payload.toJson(),
      queryParameters: {'user': normalizedUser},
      retryOptions: const RetryOptions(retries: 2, timeout: Duration(seconds: 12)),
    );

    if (!response.isSuccessful) {
      throw ApiException('Shuttle submit failed with ${response.statusCode}');
    }

    // Validate response body
    final bodyText = (response.data ?? '').trim().toLowerCase();
    if (bodyText.isEmpty) {
      throw ApiException('Shuttle submit returned empty response');
    }

    if (bodyText == 'success' ||
        bodyText == '"success"' ||
        bodyText == 'ok' ||
        bodyText == '"ok"' ||
        bodyText.startsWith('updated-existing-')) {
      return;
    }

    // Check for HTML/login page
    if (bodyText.contains('<html') || bodyText.contains('accounts.google.com')) {
      throw ApiException('Shuttle submit was not authorized by Apps Script deployment');
    }
  }

  /// Get shuttle user orders
  Future<List<ShuttleUserOrderPayload>> getShuttleUserOrders(String user) async {
    final normalizedUser = user.trim();
    if (normalizedUser.isEmpty) return [];

    final response = await _client.get<Map<String, dynamic>>(
      ApiEndpoints.shuttleUserOrders,
      queryParameters: {
        'user': normalizedUser,
        'force': '1',
        '_ts': DateTime.now().millisecondsSinceEpoch.toString(),
      },
      retryOptions: const RetryOptions(retries: 1, timeout: NetworkTimeouts.shuttleTimeout),
    );

    if (!response.isSuccessful) {
      throw ApiException('Shuttle user orders request failed with ${response.statusCode}');
    }

    final orders = (response.data?['orders'] as List?) ?? [];
    return orders.map((item) => ShuttleUserOrderPayload.fromJson(item as Map<String, dynamic>)).toList();
  }

  // ---------------------------------------------------------------------------
  // Helpdesk
  // ---------------------------------------------------------------------------

  /// Get helpdesk user tickets (dashboard)
  /// 
  /// [user] is required for backend authorization when session cookies are not available.
  Future<HelpdeskDashboard> getHelpdeskDashboard(String user) async {
    final normalizedUser = user.trim();
    if (normalizedUser.isEmpty) {
      throw ApiException('User is required for helpdesk dashboard request');
    }
    
    final response = await _client.get<Map<String, dynamic>>(
      ApiEndpoints.helpdeskUserTickets,
      queryParameters: {'user': normalizedUser},
      retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 15)),
    );

    if (!response.isSuccessful) {
      throw ApiException('Helpdesk tickets request failed with ${response.statusCode}');
    }

    final data = response.data ?? {};
    // Backend returns result, ongoing, past, assigned
    if (data['result'] != 'success') {
      throw ApiException(data['message']?.toString() ?? 'שגיאה בטעינת הקריאות');
    }

    return HelpdeskDashboard.fromJson(data);
  }

  /// Create helpdesk ticket (internal with payload)
  /// 
  /// [user] is required for backend authorization when session cookies are not available.
  Future<HelpdeskTicket> _createHelpdeskTicketFromPayload(HelpdeskTicketPayload payload, String user) async {
    final normalizedUser = user.trim();
    if (normalizedUser.isEmpty) {
      throw ApiException('User is required for helpdesk ticket creation');
    }
    
    final response = await _client.post<Map<String, dynamic>>(
      ApiEndpoints.helpdeskTickets,
      data: {...payload.toJson(), 'user': normalizedUser},
      retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 10)),
    );

    final body = response.data ?? {};
    
    // Check for HTTP-level failure first
    if (!response.isSuccessful) {
      // Extract error message from response body if available
      final errorMessage = body['message'] as String? ?? 'שגיאה ביצירת הקריאה';
      throw ApiException(errorMessage);
    }
    
    // Check for application-level error (result != 'success')
    if (body['result'] == 'error') {
      final errorMessage = body['message'] as String? ?? 'שגיאה ביצירת הקריאה';
      throw ApiException(errorMessage);
    }

    // Extract ticket from response (backend returns { result: 'success', ticket: {...} })
    final ticketData = body['ticket'] as Map<String, dynamic>? ?? body;
    return HelpdeskTicket.fromJson(ticketData);
  }

  /// Update helpdesk ticket status
  /// 
  /// [user] is required for backend authorization when session cookies are not available.
  Future<void> updateHelpdeskTicketStatus(int ticketId, HelpdeskStatus status, String user) async {
    final normalizedUser = user.trim();
    if (normalizedUser.isEmpty) {
      throw ApiException('User is required for helpdesk ticket status update');
    }
    
    final response = await _client.put<Map<String, dynamic>>(
      '${ApiEndpoints.helpdeskTickets}/$ticketId/status',
      data: {'status': status.toApiValue(), 'user': normalizedUser},
      retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 10)),
    );

    final body = response.data ?? {};
    
    if (!response.isSuccessful) {
      final errorMessage = body['message'] as String? ?? 'שגיאה בעדכון סטטוס הקריאה';
      throw ApiException(errorMessage);
    }
    
    if (body['result'] == 'error') {
      final errorMessage = body['message'] as String? ?? 'שגיאה בעדכון סטטוס הקריאה';
      throw ApiException(errorMessage);
    }
  }

  /// Get helpdesk ticket history
  /// 
  /// [user] is required for backend authorization when session cookies are not available.
  Future<List<HelpdeskStatusHistoryEntry>> getHelpdeskTicketHistory(int ticketId, String user) async {
    final normalizedUser = user.trim();
    if (normalizedUser.isEmpty) {
      throw ApiException('User is required for helpdesk ticket history request');
    }
    
    final response = await _client.get<Map<String, dynamic>>(
      '${ApiEndpoints.helpdeskTickets}/$ticketId/history',
      queryParameters: {'user': normalizedUser},
      retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 10)),
    );

    final body = response.data ?? {};
    
    if (!response.isSuccessful) {
      final errorMessage = body['message'] as String? ?? 'שגיאה בטעינת היסטוריית הקריאה';
      throw ApiException(errorMessage);
    }
    
    if (body['result'] == 'error') {
      final errorMessage = body['message'] as String? ?? 'שגיאה בטעינת היסטוריית הקריאה';
      throw ApiException(errorMessage);
    }

    final history = (body['history'] as List?) ?? [];
    return history.map((item) => HelpdeskStatusHistoryEntry.fromJson(item as Map<String, dynamic>)).toList();
  }

  /// Get helpdesk ticket notes
  /// 
  /// [user] is required for backend authorization when session cookies are not available.
  Future<List<HelpdeskNote>> getHelpdeskTicketNotes(int ticketId, String user) async {
    final normalizedUser = user.trim();
    if (normalizedUser.isEmpty) {
      throw ApiException('User is required for helpdesk ticket notes request');
    }
    
    final response = await _client.get<Map<String, dynamic>>(
      '${ApiEndpoints.helpdeskTickets}/$ticketId/notes',
      queryParameters: {'user': normalizedUser},
      retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 10)),
    );

    final body = response.data ?? {};
    
    if (!response.isSuccessful) {
      final errorMessage = body['message'] as String? ?? 'שגיאה בטעינת תגובות הקריאה';
      throw ApiException(errorMessage);
    }
    
    if (body['result'] == 'error') {
      final errorMessage = body['message'] as String? ?? 'שגיאה בטעינת תגובות הקריאה';
      throw ApiException(errorMessage);
    }

    final notes = (body['notes'] as List?) ?? [];
    return notes.map((item) => HelpdeskNote.fromJson(item as Map<String, dynamic>)).toList();
  }

  /// Add helpdesk ticket note
  /// 
  /// [user] is required for backend authorization when session cookies are not available.
  Future<HelpdeskNote> addHelpdeskTicketNote(int ticketId, String noteText, String user, {XFile? attachment}) async {
    final normalizedUser = user.trim();
    if (normalizedUser.isEmpty) {
      throw ApiException('User is required for helpdesk note creation');
    }
    
    if (attachment != null) {
      final response = await _client.uploadFile<Map<String, dynamic>>(
        '${ApiEndpoints.helpdeskTickets}/$ticketId/notes',
        file: attachment,
        fieldName: 'attachment',
        additionalFields: {'note_text': noteText, 'user': normalizedUser},
        retryOptions: const RetryOptions(retries: 1, timeout: NetworkTimeouts.uploadTimeout),
      );

      final body = response.data ?? {};
      
      if (!response.isSuccessful) {
        final errorMessage = body['message'] as String? ?? 'שגיאה בהוספת תגובה';
        throw ApiException(errorMessage);
      }
      
      if (body['result'] == 'error') {
        final errorMessage = body['message'] as String? ?? 'שגיאה בהוספת תגובה';
        throw ApiException(errorMessage);
      }

      final noteData = body['note'] as Map<String, dynamic>? ?? body;
      return HelpdeskNote.fromJson(noteData);
    } else {
      final response = await _client.post<Map<String, dynamic>>(
        '${ApiEndpoints.helpdeskTickets}/$ticketId/notes',
        data: {'note_text': noteText, 'user': normalizedUser},
        retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 10)),
      );

      final body = response.data ?? {};
      
      if (!response.isSuccessful) {
        final errorMessage = body['message'] as String? ?? 'שגיאה בהוספת תגובה';
        throw ApiException(errorMessage);
      }
      
      if (body['result'] == 'error') {
        final errorMessage = body['message'] as String? ?? 'שגיאה בהוספת תגובה';
        throw ApiException(errorMessage);
      }

      final noteData = body['note'] as Map<String, dynamic>? ?? body;
      return HelpdeskNote.fromJson(noteData);
    }
  }

  /// Get helpdesk locations for dropdown
  /// 
  /// [user] is required for backend authorization when session cookies are not available.
  Future<List<String>> getHelpdeskLocations(String user) async {
    final normalizedUser = user.trim();
    if (normalizedUser.isEmpty) {
      throw ApiException('User is required for helpdesk locations request');
    }
    
    final response = await _client.get<Map<String, dynamic>>(
      ApiEndpoints.helpdeskLocations,
      queryParameters: {'user': normalizedUser},
      retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 10)),
    );

    if (!response.isSuccessful) {
      throw ApiException('Helpdesk locations request failed with ${response.statusCode}');
    }

    final locations = response.data?['locations'] as List?;
    return locations?.map((e) => e.toString()).toList() ?? [];
  }

  /// Upload helpdesk attachment (cross-platform)
  Future<String> uploadHelpdeskAttachment(XFile file) async {
    final response = await _client.uploadFile<Map<String, dynamic>>(
      ApiEndpoints.upload,
      file: file,
      fieldName: 'file',
      retryOptions: const RetryOptions(retries: 2, timeout: NetworkTimeouts.uploadTimeout),
    );

    if (!response.isSuccessful) {
      throw ApiException('Helpdesk attachment upload failed with ${response.statusCode}');
    }

    final url = response.data?['url'] as String? ?? response.data?['fileUrl'] as String?;
    if (url == null || url.isEmpty) {
      throw ApiException('No URL returned from upload');
    }
    return url;
  }

  // ---------------------------------------------------------------------------
  // Convenience Methods (for Flutter screens)
  // ---------------------------------------------------------------------------

  /// Get shuttle routes (wrapper for compatibility)
  Future<List<Map<String, dynamic>>> getShuttleRoutes() async {
    // This would need a backend endpoint - for now return empty
    // The shuttle feature in this app uses a different flow
    return [];
  }

  /// Get shuttle user bookings
  Future<List<Map<String, dynamic>>> getShuttleUserBookings() async {
    // This would need a backend endpoint - for now return empty
    return [];
  }

  /// Book shuttle
  Future<void> bookShuttle({
    required String routeId,
    required String date,
    required int passengers,
  }) async {
    // Use existing submitShuttleOrder when implemented
    throw UnimplementedError('Use submitShuttleOrder instead');
  }

  /// Cancel shuttle booking
  Future<void> cancelShuttleBooking(String bookingId) async {
    // This would need a backend endpoint
    throw UnimplementedError('Backend endpoint needed');
  }

  /// Get helpdesk tickets (convenience wrapper)
  /// 
  /// [user] is required for backend authorization when session cookies are not available.
  Future<List<HelpdeskTicket>> getHelpdeskTickets(String user) async {
    final dashboard = await getHelpdeskDashboard(user);
    return dashboard.tickets;
  }

  /// Create helpdesk ticket (convenience wrapper with named params)
  /// 
  /// [user] is required for backend authorization when session cookies are not available.
  Future<HelpdeskTicket> createHelpdeskTicket({
    required String user,
    required String subject,
    required String description,
    required HelpdeskDepartment department,
    required String priority,
    String? location,
    String? phone,
    String? attachmentUrl,
  }) async {
    final payload = HelpdeskTicketPayload(
      subject: subject,
      description: description,
      department: department,
      priority: priority,
      location: location,
      phone: phone,
      attachmentUrl: attachmentUrl,
    );
    return _createHelpdeskTicketFromPayload(payload, user);
  }

  /// Add helpdesk comment (wrapper)
  /// 
  /// [user] is required for backend authorization when session cookies are not available.
  Future<void> addHelpdeskComment(String ticketId, String comment, String user) async {
    await addHelpdeskTicketNote(int.parse(ticketId), comment, user);
  }

  /// Get ticket history (wrapper)
  /// 
  /// [user] is required for backend authorization when session cookies are not available.
  Future<List<HelpdeskStatusHistory>> getTicketHistory(String ticketId, String user) async {
    final entries = await getHelpdeskTicketHistory(int.parse(ticketId), user);
    return entries.map((e) => HelpdeskStatusHistory(
      id: e.id,
      oldStatus: e.oldStatus,
      newStatus: e.newStatus,
      changedBy: e.changedBy,
      createdAt: e.createdAt,
    )).toList();
  }

  /// Register an FCM (Android) / APNs (iOS) device push token with the
  /// backend so the server can deliver pushes to this device via Firebase
  /// Admin.
  ///
  /// Uses the Flutter-only endpoint `/flutter/register-fcm`. The Angular
  /// frontend continues to use `/register-device` for web-push subscriptions
  /// — the two pipelines are independent on the server.
  Future<void> registerDeviceToken({
    required String username,
    required String token,
    required String platform,
  }) async {
    final normalizedUser = username.trim().toLowerCase();
    if (normalizedUser.isEmpty || token.isEmpty) return;

    final payload = <String, dynamic>{
      'username': normalizedUser,
      'fcmToken': token,
      'platform': _normalizeRegisterDevicePlatform(platform),
    };

    await _client.post(
      ApiEndpoints.registerFlutterFcm,
      data: payload,
      retryOptions: const RetryOptions(retries: 2, timeout: Duration(seconds: 12)),
    );
  }

  /// Unregister an FCM/APNs device token (called on logout).
  Future<void> unregisterDeviceToken({
    required String username,
    required String token,
    required String platform,
  }) async {
    final normalizedUser = username.trim().toLowerCase();
    if (normalizedUser.isEmpty || token.isEmpty) return;

    final payload = <String, dynamic>{
      'username': normalizedUser,
      'fcmToken': token,
      'platform': _normalizeRegisterDevicePlatform(platform),
    };

    await _client.post(
      ApiEndpoints.unregisterFlutterFcm,
      data: payload,
      retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 8)),
    );
  }

  /// Normalize the Flutter platform name to the values the backend
  /// expects ('android', 'ios').
  String _normalizeRegisterDevicePlatform(String platform) {
    switch (platform.toLowerCase()) {
      case 'android':
        return 'android';
      case 'ios':
        return 'ios';
      default:
        return platform.toLowerCase();
    }
  }

  // ---------------------------------------------------------------------------
  // Convenience Methods for ChatStoreService
  // ---------------------------------------------------------------------------

  /// Get messages since a timestamp (wrapper for getMessagesFromLogs)
  Future<List<ChatMessage>> getMessagesSince(int timestamp) async {
    // Get current user from session - for now, return empty list
    // This needs the user context to work properly
    // The ChatStoreService should call getMessagesFromLogs directly with user
    return [];
  }

  /// Send direct message with named parameters (wrapper for sendDirectMessage)
  ///
  /// [sender] is the currently signed-in user — it MUST match the session
  /// cookie or the backend's `requireAuthorizedUser` middleware returns 403.
  /// [recipient] is the other party in the 1:1 conversation and is sent as
  /// `originalSender` (matching the Angular client's payload shape).
  ///
  /// [messageId] should be the same id used for the optimistic local insertion
  /// so that the socket/SSE echo from the server dedupes against the local
  /// bubble instead of producing a duplicate "incoming from me" message.
  Future<void> sendDirectMessageWithParams({
    required String sender,
    required String senderName,
    required String recipient,
    required String body,
    String? imageUrl,
    String? fileUrl,
    String? replyToMessageId,
    String? messageId,
  }) async {
    final id = messageId ??
        '${DateTime.now().millisecondsSinceEpoch}-${DateTime.now().microsecond}';
    final payload = ReplyPayload(
      user: sender,
      senderName: senderName,
      reply: body,
      imageUrl: imageUrl,
      fileUrl: fileUrl,
      originalSender: recipient,
      messageId: id,
      replyToMessageId: replyToMessageId,
    );
    await sendDirectMessage(payload);
  }

  /// Send group message (wrapper using ReplyPayload with group fields)
  ///
  /// [sender] is the currently signed-in user (matches session). [recipients]
  /// is the full group member list; the caller should also pass
  /// [membersToNotify] excluding [sender] so the server doesn't fan out a
  /// notification back to the author.
  ///
  /// [messageId] should be the same id used for the optimistic local insertion
  /// so that the socket/SSE echo dedupes against the local bubble.
  Future<void> sendGroupMessage({
    required String sender,
    required String senderName,
    required String groupId,
    required String groupName,
    required List<String> recipients,
    required List<String> membersToNotify,
    required String body,
    String? groupCreatedBy,
    List<String>? groupAdmins,
    int? groupUpdatedAt,
    GroupType? groupType,
    String? imageUrl,
    String? fileUrl,
    String? replyToMessageId,
    String? messageId,
  }) async {
    final id = messageId ??
        '${DateTime.now().millisecondsSinceEpoch}-${DateTime.now().microsecond}';
    final originalSender = membersToNotify.isNotEmpty
        ? membersToNotify.first
        : (recipients.isNotEmpty ? recipients.first : groupId);
    final payload = ReplyPayload(
      user: sender,
      senderName: senderName,
      reply: body,
      imageUrl: imageUrl,
      fileUrl: fileUrl,
      originalSender: originalSender,
      messageId: id,
      groupId: groupId,
      groupName: groupName,
      groupMembers: recipients,
      groupCreatedBy: groupCreatedBy,
      groupAdmins: groupAdmins,
      groupUpdatedAt: groupUpdatedAt,
      groupType: groupType,
      groupSenderName: senderName,
      membersToNotify: membersToNotify,
      replyToMessageId: replyToMessageId,
    );
    await sendDirectMessage(payload);
  }

  /// Add reaction to a message
  Future<void> addReaction(String messageId, String emoji) async {
    final payload = ReactionPayload(
      targetMessageId: messageId,
      emoji: emoji,
      reactor: 'me', // Will be set by server
      reactorName: 'me', // Will be set by server
    );
    await sendReaction(payload);
  }

  /// Remove reaction from a message
  Future<void> removeReaction(String messageId, String emoji) async {
    // Removing a reaction uses the same endpoint with empty emoji or special action
    final payload = ReactionPayload(
      targetMessageId: messageId,
      emoji: '', // Empty to remove
      reactor: 'me',
      reactorName: 'me',
    );
    await sendReaction(payload);
  }

  /// Edit a message
  Future<void> editMessage(String messageId, String newBody) async {
    final payload = EditMessagePayload(
      sender: 'me', // Will be set by server
      messageId: messageId,
      body: newBody,
      editedAt: DateTime.now().millisecondsSinceEpoch,
    );
    await editMessageForEveryone(payload);
  }

  /// Delete a message
  Future<void> deleteMessage(String messageId) async {
    final payload = DeleteMessagePayload(
      sender: 'me', // Will be set by server
      messageId: messageId,
      deletedAt: DateTime.now().millisecondsSinceEpoch,
    );
    await deleteMessageForEveryone(payload);
  }

  /// Mark messages as read
  Future<void> markMessagesAsRead(String chatId, List<String> messageIds) async {
    // Need sender info from the messages
    final payload = ReadReceiptPayload(
      reader: 'me', // Will be set by server
      sender: chatId, // The chat/sender we're marking as read
      messageIds: messageIds,
      readAt: DateTime.now().millisecondsSinceEpoch,
    );
    await sendReadReceipt(payload);
  }
}

/// Base API exception
class ApiException implements Exception {
  final String message;
  ApiException(this.message);

  @override
  String toString() => 'ApiException: $message';
}

/// Authentication exception
class AuthException extends ApiException {
  AuthException(super.message);

  @override
  String toString() => 'AuthException: $message';
}

/// Rate limit exception
class RateLimitException extends AuthException {
  final int? retryAfterSeconds;
  RateLimitException(super.message, this.retryAfterSeconds);

  @override
  String toString() => 'RateLimitException: $message (retry after: $retryAfterSeconds seconds)';
}

/// Exception for when direct login is disabled - redirect to SMS verification flow
class LegacyLoginDisabledException extends AuthException {
  LegacyLoginDisabledException() : super('יש להשתמש באימות SMS לכניסה');

  @override
  String toString() => 'LegacyLoginDisabledException: Direct login is disabled. Use SMS verification code flow.';
}
