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

  /// Create session (login)
  Future<String> createSession(String user) async {
    final normalized = user.trim().toLowerCase();
    if (normalized.isEmpty) {
      throw AuthException('מספר טלפון לא תקין');
    }

    final response = await _client.post<Map<String, dynamic>>(
      ApiEndpoints.session,
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
      throw AuthException('נכשל בהתחברות');
    }

    final body = SessionResponse.fromJson(response.data ?? {});
    _client.setCsrfToken(body.csrfToken);

    final sessionUser = body.user?.trim().toLowerCase();
    if (!body.authenticated || (sessionUser?.isEmpty ?? true)) {
      _client.clearCsrfToken();
      throw AuthException('נכשל בהתחברות');
    }

    return sessionUser!;
  }

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
  Future<List<String>> getShuttleEmployees() async {
    final response = await _client.get<Map<String, dynamic>>(
      ApiEndpoints.shuttleEmployees,
      queryParameters: {'_ts': DateTime.now().millisecondsSinceEpoch.toString()},
      retryOptions: const RetryOptions(retries: 2, timeout: Duration(seconds: 12)),
    );

    if (!response.isSuccessful) {
      throw ApiException('Shuttle employees request failed with ${response.statusCode}');
    }

    final data = response.data?['data'] as List?;
    return data?.map((item) => item.toString().trim()).where((s) => s.isNotEmpty).toList() ?? [];
  }

  /// Get shuttle stations
  Future<List<String>> getShuttleStations() async {
    final response = await _client.get<Map<String, dynamic>>(
      ApiEndpoints.shuttleStations,
      queryParameters: {'_ts': DateTime.now().millisecondsSinceEpoch.toString()},
      retryOptions: const RetryOptions(retries: 2, timeout: Duration(seconds: 12)),
    );

    if (!response.isSuccessful) {
      throw ApiException('Shuttle stations request failed with ${response.statusCode}');
    }

    final data = response.data?['data'] as List?;
    return data?.map((item) => item.toString().trim()).where((s) => s.isNotEmpty).toList() ?? [];
  }

  /// Submit shuttle order
  Future<void> submitShuttleOrder(ShuttleOrderSubmitPayload payload) async {
    final response = await _client.post<String>(
      ApiEndpoints.shuttleOrders,
      data: payload.toJson(),
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

  /// Get helpdesk dashboard
  Future<HelpdeskDashboard> getHelpdeskDashboard() async {
    final response = await _client.get<Map<String, dynamic>>(
      ApiEndpoints.helpdeskDashboard,
      retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 10)),
    );

    if (!response.isSuccessful) {
      throw ApiException('Helpdesk dashboard request failed with ${response.statusCode}');
    }

    return HelpdeskDashboard.fromJson(response.data ?? {});
  }

  /// Create helpdesk ticket (internal with payload)
  Future<HelpdeskTicket> _createHelpdeskTicketFromPayload(HelpdeskTicketPayload payload) async {
    final response = await _client.post<Map<String, dynamic>>(
      ApiEndpoints.helpdeskTickets,
      data: payload.toJson(),
      retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 10)),
    );

    if (!response.isSuccessful) {
      throw ApiException('Helpdesk ticket creation failed with ${response.statusCode}');
    }

    return HelpdeskTicket.fromJson(response.data ?? {});
  }

  /// Update helpdesk ticket status
  Future<void> updateHelpdeskTicketStatus(int ticketId, HelpdeskStatus status) async {
    final response = await _client.put(
      '${ApiEndpoints.helpdeskTickets}/$ticketId/status',
      data: {'status': status.toApiValue()},
      retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 10)),
    );

    if (!response.isSuccessful) {
      throw ApiException('Helpdesk ticket status update failed with ${response.statusCode}');
    }
  }

  /// Get helpdesk ticket history
  Future<List<HelpdeskStatusHistoryEntry>> getHelpdeskTicketHistory(int ticketId) async {
    final response = await _client.get<Map<String, dynamic>>(
      '${ApiEndpoints.helpdeskTickets}/$ticketId/history',
      retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 10)),
    );

    if (!response.isSuccessful) {
      throw ApiException('Helpdesk ticket history request failed with ${response.statusCode}');
    }

    final history = (response.data?['history'] as List?) ?? [];
    return history.map((item) => HelpdeskStatusHistoryEntry.fromJson(item as Map<String, dynamic>)).toList();
  }

  /// Get helpdesk ticket notes
  Future<List<HelpdeskNote>> getHelpdeskTicketNotes(int ticketId) async {
    final response = await _client.get<Map<String, dynamic>>(
      '${ApiEndpoints.helpdeskTickets}/$ticketId/notes',
      retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 10)),
    );

    if (!response.isSuccessful) {
      throw ApiException('Helpdesk ticket notes request failed with ${response.statusCode}');
    }

    final notes = (response.data?['notes'] as List?) ?? [];
    return notes.map((item) => HelpdeskNote.fromJson(item as Map<String, dynamic>)).toList();
  }

  /// Add helpdesk ticket note
  Future<HelpdeskNote> addHelpdeskTicketNote(int ticketId, String noteText, {XFile? attachment}) async {
    if (attachment != null) {
      final response = await _client.uploadFile<Map<String, dynamic>>(
        '${ApiEndpoints.helpdeskTickets}/$ticketId/notes',
        file: attachment,
        fieldName: 'attachment',
        additionalFields: {'noteText': noteText},
        retryOptions: const RetryOptions(retries: 1, timeout: NetworkTimeouts.uploadTimeout),
      );

      if (!response.isSuccessful) {
        throw ApiException('Helpdesk note creation failed with ${response.statusCode}');
      }

      return HelpdeskNote.fromJson(response.data ?? {});
    } else {
      final response = await _client.post<Map<String, dynamic>>(
        '${ApiEndpoints.helpdeskTickets}/$ticketId/notes',
        data: {'noteText': noteText},
        retryOptions: const RetryOptions(retries: 1, timeout: Duration(seconds: 10)),
      );

      if (!response.isSuccessful) {
        throw ApiException('Helpdesk note creation failed with ${response.statusCode}');
      }

      return HelpdeskNote.fromJson(response.data ?? {});
    }
  }

  /// Get helpdesk locations for dropdown
  Future<List<String>> getHelpdeskLocations() async {
    final response = await _client.get<Map<String, dynamic>>(
      ApiEndpoints.helpdeskLocations,
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
  Future<List<HelpdeskTicket>> getHelpdeskTickets() async {
    final dashboard = await getHelpdeskDashboard();
    return dashboard.tickets;
  }

  /// Create helpdesk ticket (convenience wrapper with named params)
  Future<HelpdeskTicket> createHelpdeskTicket({
    required String subject,
    required String description,
    required String category,
    required String priority,
    String? location,
    String? phone,
    String? attachmentUrl,
  }) async {
    final payload = HelpdeskTicketPayload(
      subject: subject,
      description: description,
      category: category,
      priority: priority,
      location: location,
      phone: phone,
      attachmentUrl: attachmentUrl,
    );
    return _createHelpdeskTicketFromPayload(payload);
  }

  /// Add helpdesk comment (wrapper)
  Future<void> addHelpdeskComment(String ticketId, String comment) async {
    await addHelpdeskTicketNote(int.parse(ticketId), comment);
  }

  /// Get ticket history (wrapper)
  Future<List<HelpdeskStatusHistory>> getTicketHistory(String ticketId) async {
    final entries = await getHelpdeskTicketHistory(int.parse(ticketId));
    return entries.map((e) => HelpdeskStatusHistory(
      id: e.id,
      oldStatus: e.oldStatus,
      newStatus: e.newStatus,
      changedBy: e.changedBy,
      createdAt: e.createdAt,
    )).toList();
  }

  /// Register device token for push notifications
  Future<void> registerDeviceToken({
    required String token,
    required String platform,
  }) async {
    // Use existing registerDeviceForPush
    // Platform: 'ios' or 'android'
    // For now, just log - backend needs mobile push endpoint
  }

  /// Unregister device token
  Future<void> unregisterDeviceToken(String token) async {
    // Backend needs endpoint for this
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
