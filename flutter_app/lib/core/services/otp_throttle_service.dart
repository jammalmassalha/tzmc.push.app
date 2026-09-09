/// Client-side throttling for outgoing SMS verification codes (OTP).
///
/// The server applies its own per-IP / per-user limits, but a shared NAT or a
/// user tapping "send again" repeatedly still costs real SMS messages. This
/// service enforces, per phone number and persisted across app restarts:
///
///   * at most [kOtpMaxSendsPerWindow] messages within [kOtpWindow]
///     (4 per rolling hour), and
///   * at least [kOtpMinInterval] between two consecutive messages
///     (120 seconds).
///
/// Every failure path degrades to "allowed" so a broken storage backend can
/// never lock a user out of logging in — the server-side limits remain the
/// authoritative protection.
library;

import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Maximum number of verification codes sent to one phone per [kOtpWindow].
const int kOtpMaxSendsPerWindow = 4;

/// Rolling window used for [kOtpMaxSendsPerWindow].
const Duration kOtpWindow = Duration(hours: 1);

/// Minimum delay between two verification codes sent to the same phone.
const Duration kOtpMinInterval = Duration(seconds: 120);

/// SharedPreferences key holding the send history (phone → timestamps).
const String kOtpSendHistoryStorageKey = 'tzmc_otp_send_history_v1';

/// Result of an OTP send check.
class OtpThrottleDecision {
  /// Whether a new code may be requested right now.
  final bool allowed;

  /// How long the caller must wait before a send is allowed again.
  final Duration retryAfter;

  /// Sends still available in the current rolling window.
  final int remainingSends;

  /// True when the hourly quota (not just the 120s gap) is exhausted.
  final bool quotaExhausted;

  const OtpThrottleDecision({
    required this.allowed,
    required this.retryAfter,
    required this.remainingSends,
    required this.quotaExhausted,
  });

  static const OtpThrottleDecision allowedNow = OtpThrottleDecision(
    allowed: true,
    retryAfter: Duration.zero,
    remainingSends: kOtpMaxSendsPerWindow,
    quotaExhausted: false,
  );

  /// Hebrew explanation shown to the user when a send is blocked.
  String get message {
    if (allowed) return '';
    final seconds = retryAfter.inSeconds;
    if (quotaExhausted) {
      final minutes = (seconds / 60).ceil();
      return 'נשלחו $kOtpMaxSendsPerWindow קודי אימות בשעה האחרונה. '
          'ניתן לנסות שוב בעוד $minutes דקות.';
    }
    return 'ניתן לשלוח קוד אימות נוסף בעוד $seconds שניות.';
  }
}

/// Normalizes a phone number so formatting differences map to one bucket.
String normalizeOtpPhone(String phone) {
  final digits = phone.replaceAll(RegExp(r'\D'), '');
  return digits;
}

/// Persisted per-phone OTP send throttle.
class OtpThrottleService {
  /// Injectable clock so tests do not have to wait in real time.
  final DateTime Function() _now;

  OtpThrottleService({DateTime Function()? now})
      : _now = now ?? DateTime.now;

  Future<Map<String, List<int>>> _readHistory() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(kOtpSendHistoryStorageKey);
      if (raw == null || raw.trim().isEmpty) return {};
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return {};
      final result = <String, List<int>>{};
      decoded.forEach((key, value) {
        if (value is! List) return;
        final timestamps = value
            .map((entry) => entry is int ? entry : int.tryParse('$entry'))
            .whereType<int>()
            .toList();
        if (timestamps.isNotEmpty) result['$key'] = timestamps;
      });
      return result;
    } catch (_) {
      return {};
    }
  }

  Future<void> _writeHistory(Map<String, List<int>> history) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (history.isEmpty) {
        await prefs.remove(kOtpSendHistoryStorageKey);
        return;
      }
      await prefs.setString(kOtpSendHistoryStorageKey, jsonEncode(history));
    } catch (_) {
      // Storage unavailable — the server-side limits still apply.
    }
  }

  /// Drops timestamps that fell out of the rolling window.
  Map<String, List<int>> _prune(Map<String, List<int>> history, int nowMs) {
    final cutoff = nowMs - kOtpWindow.inMilliseconds;
    final pruned = <String, List<int>>{};
    history.forEach((phone, timestamps) {
      final kept = timestamps
          .where((timestamp) => timestamp > cutoff && timestamp <= nowMs)
          .toList()
        ..sort();
      if (kept.isNotEmpty) pruned[phone] = kept;
    });
    return pruned;
  }

  /// Returns whether a code may be sent to [phone] right now.
  Future<OtpThrottleDecision> check(String phone) async {
    final key = normalizeOtpPhone(phone);
    if (key.isEmpty) return OtpThrottleDecision.allowedNow;

    final nowMs = _now().millisecondsSinceEpoch;
    final history = _prune(await _readHistory(), nowMs);
    final timestamps = history[key] ?? const <int>[];

    final remaining = kOtpMaxSendsPerWindow - timestamps.length;
    if (remaining <= 0) {
      final oldest = timestamps.first;
      final waitMs = (oldest + kOtpWindow.inMilliseconds) - nowMs;
      return OtpThrottleDecision(
        allowed: false,
        retryAfter: Duration(milliseconds: waitMs > 0 ? waitMs : 0),
        remainingSends: 0,
        quotaExhausted: true,
      );
    }

    if (timestamps.isNotEmpty) {
      final last = timestamps.last;
      final waitMs = (last + kOtpMinInterval.inMilliseconds) - nowMs;
      if (waitMs > 0) {
        return OtpThrottleDecision(
          allowed: false,
          retryAfter: Duration(milliseconds: waitMs),
          remainingSends: remaining,
          quotaExhausted: false,
        );
      }
    }

    return OtpThrottleDecision(
      allowed: true,
      retryAfter: Duration.zero,
      remainingSends: remaining,
      quotaExhausted: false,
    );
  }

  /// Records that a code was just sent to [phone].
  Future<void> recordSend(String phone) async {
    final key = normalizeOtpPhone(phone);
    if (key.isEmpty) return;

    final nowMs = _now().millisecondsSinceEpoch;
    final history = _prune(await _readHistory(), nowMs);
    final timestamps = List<int>.from(history[key] ?? const <int>[])..add(nowMs);
    // Never keep more entries than the quota needs.
    if (timestamps.length > kOtpMaxSendsPerWindow) {
      timestamps.removeRange(0, timestamps.length - kOtpMaxSendsPerWindow);
    }
    history[key] = timestamps;
    await _writeHistory(history);
  }

  /// Clears the stored history (used by tests and after a successful login).
  Future<void> clear(String phone) async {
    final key = normalizeOtpPhone(phone);
    if (key.isEmpty) return;
    final nowMs = _now().millisecondsSinceEpoch;
    final history = _prune(await _readHistory(), nowMs)..remove(key);
    await _writeHistory(history);
  }
}

/// Provider for the OTP throttle service.
final otpThrottleServiceProvider = Provider<OtpThrottleService>((ref) {
  return OtpThrottleService();
});
