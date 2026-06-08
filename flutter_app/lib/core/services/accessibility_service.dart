library;

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

const double kAccessibilityMinTextScale = 1.0;
const double kAccessibilityMaxTextScale = 1.6;
const double kAccessibilityDefaultTextScale = 1.15;

class AccessibilitySettings {
  final bool enabled;
  final double textScaleFactor;

  const AccessibilitySettings({
    this.enabled = false,
    this.textScaleFactor = kAccessibilityDefaultTextScale,
  });

  double get effectiveTextScaleFactor => enabled ? textScaleFactor : 1.0;

  AccessibilitySettings copyWith({
    bool? enabled,
    double? textScaleFactor,
  }) {
    return AccessibilitySettings(
      enabled: enabled ?? this.enabled,
      textScaleFactor: textScaleFactor ?? this.textScaleFactor,
    );
  }
}

final accessibilitySettingsProvider =
    NotifierProvider<AccessibilitySettingsNotifier, AccessibilitySettings>(
  AccessibilitySettingsNotifier.new,
);

class AccessibilitySettingsNotifier extends Notifier<AccessibilitySettings> {
  static const _enabledKey = 'tzmc_accessibility_enabled';
  static const _textScaleFactorKey = 'tzmc_accessibility_text_scale';

  @override
  AccessibilitySettings build() {
    unawaited(_load());
    return const AccessibilitySettings();
  }

  Future<void> _load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final enabled = prefs.getBool(_enabledKey) ?? false;
      final textScale =
          prefs.getDouble(_textScaleFactorKey) ?? kAccessibilityDefaultTextScale;
      state = state.copyWith(
        enabled: enabled,
        textScaleFactor: textScale
            .clamp(kAccessibilityMinTextScale, kAccessibilityMaxTextScale)
            .toDouble(),
      );
    } catch (_) {
      // Keep defaults when local persistence is unavailable.
    }
  }

  Future<void> setEnabled(bool value) async {
    state = state.copyWith(enabled: value);
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(_enabledKey, value);
    } catch (_) {}
  }

  Future<void> setTextScaleFactor(double value) async {
    final normalized = value
        .clamp(kAccessibilityMinTextScale, kAccessibilityMaxTextScale)
        .toDouble();
    state = state.copyWith(textScaleFactor: normalized);
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setDouble(_textScaleFactorKey, normalized);
    } catch (_) {}
  }
}
