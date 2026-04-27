/// Top-positioned toast utility.
///
/// Use [showTopToast] when you have a valid [BuildContext] at the call site.
/// Use [showTopToastOnOverlay] when you need to pre-capture the overlay before
/// an async gap (analogous to pre-capturing ScaffoldMessenger).
library;

import 'dart:ui' as ui;

import 'package:flutter/material.dart';

/// Shows a toast at the **top** of the screen with a dismiss button.
///
/// The toast auto-dismisses after [duration] (default 3 s).
void showTopToast(
  BuildContext context,
  String message, {
  Color? backgroundColor,
  Duration duration = const Duration(seconds: 3),
}) {
  _showOnOverlay(
    Overlay.of(context, rootOverlay: true),
    message,
    backgroundColor: backgroundColor,
    duration: duration,
  );
}

/// Variant that accepts a pre-captured [OverlayState], for use after async gaps.
///
/// ```dart
/// final overlay = Overlay.of(context, rootOverlay: true);
/// await someAsyncOperation();
/// showTopToastOnOverlay(overlay, 'Done');
/// ```
void showTopToastOnOverlay(
  OverlayState overlay,
  String message, {
  Color? backgroundColor,
  Duration duration = const Duration(seconds: 3),
}) {
  _showOnOverlay(overlay, message,
      backgroundColor: backgroundColor, duration: duration);
}

void _showOnOverlay(
  OverlayState overlay,
  String message, {
  Color? backgroundColor,
  Duration duration = const Duration(seconds: 3),
}) {
  late OverlayEntry entry;
  bool dismissed = false;

  void dismiss() {
    if (!dismissed) {
      dismissed = true;
      entry.remove();
    }
  }

  entry = OverlayEntry(
    builder: (_) => _TopToast(
      message: message,
      backgroundColor: backgroundColor,
      onDismiss: dismiss,
    ),
  );

  overlay.insert(entry);
  Future.delayed(duration, dismiss);
}

class _TopToast extends StatelessWidget {
  final String message;
  final Color? backgroundColor;
  final VoidCallback onDismiss;

  const _TopToast({
    required this.message,
    this.backgroundColor,
    required this.onDismiss,
  });

  @override
  Widget build(BuildContext context) {
    final bg = backgroundColor ?? Colors.black87;
    return SafeArea(
      child: Align(
        alignment: Alignment.topCenter,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Material(
            color: bg,
            borderRadius: BorderRadius.circular(8),
            elevation: 6,
            child: Padding(
              padding:
                  const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  Flexible(
                    child: Text(
                      message,
                      style: const TextStyle(color: Colors.white),
                      textDirection: ui.TextDirection.rtl,
                    ),
                  ),
                  const SizedBox(width: 8),
                  GestureDetector(
                    onTap: onDismiss,
                    child: const Icon(Icons.close,
                        color: Colors.white, size: 18),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
