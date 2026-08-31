/// Stable per-install device identifier.
///
/// The backend stamps `originDeviceId` onto the self-echo it sends to the
/// sender's other sessions (see `processReplyPayload` in `server.js`).  A
/// client that knows its own id can therefore recognise — and skip — the echo
/// of a message it just sent itself, instead of re-running the full
/// apply/dedup/persist pipeline for a bubble that is already on screen.
///
/// Dedup by `messageId` in `ChatStoreService._applyIncomingMessage` already
/// guarantees correctness; this is a cheap short-circuit and a diagnostic
/// handle, so every failure path degrades to "no device id" rather than
/// throwing.
library;

import 'dart:math';

import 'package:shared_preferences/shared_preferences.dart';

/// SharedPreferences key holding the generated identifier.
///
/// Deliberately distinct from the Angular client's
/// `modern-chat-delivery-device-id`: the two run in separate storages and a
/// shared key would only be confusing.
const String kDeviceIdStorageKey = 'tzmc_device_id_v1';

String _generateDeviceId() {
  final random = Random.secure();
  final suffix = List<int>.generate(8, (_) => random.nextInt(256))
      .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
      .join();
  return 'dev_${DateTime.now().millisecondsSinceEpoch}_$suffix';
}

String? _cachedDeviceId;

/// Returns the persisted device id, generating and storing one on first use.
///
/// Returns an empty string when SharedPreferences is unavailable, in which
/// case callers simply omit the id from their payloads.
Future<String> ensureDeviceId() async {
  final cached = _cachedDeviceId;
  if (cached != null) return cached;

  try {
    final prefs = await SharedPreferences.getInstance();
    final stored = (prefs.getString(kDeviceIdStorageKey) ?? '').trim();
    if (stored.isNotEmpty) {
      _cachedDeviceId = stored;
      return stored;
    }
    final generated = _generateDeviceId();
    await prefs.setString(kDeviceIdStorageKey, generated);
    _cachedDeviceId = generated;
    return generated;
  } catch (_) {
    // Storage unavailable — callers treat '' as "no device id".
    return '';
  }
}

/// The device id if [ensureDeviceId] has already resolved one, else `''`.
///
/// Synchronous so it can be used inside hot paths (socket packet handlers)
/// without awaiting.
String get cachedDeviceId => _cachedDeviceId ?? '';
