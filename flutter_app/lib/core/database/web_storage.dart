/// Web-only persistence fallback using shared_preferences (localStorage).
///
/// Used when the Drift SQLite WASM backend is unavailable (i.e. the
/// `sqlite3.wasm` / `drift_worker.dart.js` files are not served from the
/// Flutter web root).  Data is serialised as a single JSON blob and stored
/// under a versioned key in `window.localStorage` via `shared_preferences`.
///
/// Limits: localStorage is typically capped at ~5 MB.  To stay within budget
/// we keep at most [_maxMessagesPerChat] messages per conversation.
library;

import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../models/chat_models.dart';

/// Maximum number of messages to keep per chat in the localStorage snapshot.
const int _maxMessagesPerChat = 200;

/// localStorage key for the serialised state blob.
const String _stateKey = 'tzmc_chat_state_v1';

/// A lightweight persistence layer backed by `shared_preferences` (localStorage
/// on Flutter web).  All methods are static and best-effort: errors are caught
/// and swallowed so that callers never see a failure.
class WebChatStorage {
  const WebChatStorage._();

  /// Restore previously persisted state.  Returns `null` when no data is
  /// available or when deserialization fails.
  static Future<PersistedChatState?> getPersistedState() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final json = prefs.getString(_stateKey);
      if (json == null || json.isEmpty) return null;

      final data = jsonDecode(json) as Map<String, dynamic>;

      final contacts = (data['contacts'] as List?)
              ?.map((c) => Contact.fromJson(c as Map<String, dynamic>))
              .toList() ??
          <Contact>[];

      final groups = (data['groups'] as List?)
              ?.map((g) => ChatGroup.fromJson(g as Map<String, dynamic>))
              .toList() ??
          <ChatGroup>[];

      final unreadByChat = (data['unreadByChat'] as Map<String, dynamic>?)
              ?.map((k, v) => MapEntry(k, (v as num).toInt())) ??
          <String, int>{};

      final messages = (data['messages'] as List?)
              ?.map((m) => ChatMessage.fromJson(m as Map<String, dynamic>))
              .toList() ??
          <ChatMessage>[];

      return PersistedChatState(
        contacts: contacts,
        groups: groups,
        unreadByChat: unreadByChat,
        messages: messages,
      );
    } catch (_) {
      return null;
    }
  }

  /// Serialise [state] to JSON and write it to localStorage.
  ///
  /// Messages are capped at [_maxMessagesPerChat] per chat (most recent kept)
  /// to avoid hitting the localStorage size limit.
  static Future<void> persistState(PersistedChatState state) async {
    try {
      // Collect messages, capping per chat.
      final msgsByChat = <String, List<ChatMessage>>{};
      for (final msg in state.messages) {
        (msgsByChat[msg.chatId] ??= []).add(msg);
      }
      final limitedMessages = <ChatMessage>[];
      for (final msgs in msgsByChat.values) {
        msgs.sort((a, b) => b.timestamp.compareTo(a.timestamp));
        limitedMessages.addAll(msgs.take(_maxMessagesPerChat));
      }

      final data = {
        'contacts': state.contacts.map((c) => c.toJson()).toList(),
        'groups': state.groups.map((g) => g.toJson()).toList(),
        'unreadByChat': state.unreadByChat,
        'messages': limitedMessages.map((m) => m.toJson()).toList(),
      };

      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_stateKey, jsonEncode(data));
    } catch (_) {
      // Best-effort: failure is non-fatal.
    }
  }

  /// Remove all persisted data from localStorage.
  static Future<void> clear() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_stateKey);
    } catch (_) {
      // Ignore.
    }
  }
}
