/// AI Agent initialization screen shown once right after a successful OTP
/// login.
///
/// While an animated "AI agent" orb pulses and typewriter status logs play,
/// the screen performs the real post-login initialization work in parallel —
/// pre-warming the local Drift/SQLite database, registering the FCM push
/// token, restoring + syncing the chat store, and connecting the realtime
/// transport — so that [ChatShellScreen] renders instantly when the
/// animation finishes.
library;

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/database/chat_database.dart';
import '../../../core/realtime/realtime_transport_service.dart';
import '../../../core/services/chat_store_service.dart';
import '../../../core/services/push_notification_service.dart';
import 'auth_state.dart';

/// Typing speed per character (~25ms as per the design spec).
const _kTypeCharInterval = Duration(milliseconds: 25);

/// Pause between one completed step and the next one starting to type.
const _kStepPause = Duration(milliseconds: 400);

class AiInitializationScreen extends ConsumerStatefulWidget {
  /// Called once every step (animation + background work) has completed.
  /// The parent swaps this screen for the main shell.
  final VoidCallback onCompleted;

  const AiInitializationScreen({super.key, required this.onCompleted});

  @override
  ConsumerState<AiInitializationScreen> createState() =>
      _AiInitializationScreenState();
}

class _AiInitializationScreenState extends ConsumerState<AiInitializationScreen>
    with TickerProviderStateMixin {
  late final AnimationController _pulseController;
  late final Animation<double> _pulseAnimation;
  late final AnimationController _ringController;
  late final AnimationController _cursorController;

  static const List<String> _steps = [
    'מאמת פרופיל משתמש ומפתח אבטחה...',
    'מאתחל מסד נתונים מקומי ומטמון מהיר...',
    'מסנכרן היסטוריית שיחות והודעות...',
    'סוכן ה-AI מוכן. מעביר לממשק הראשי...',
  ];

  /// Target progress after each step completes.
  static const List<double> _stepProgress = [0.25, 0.6, 0.9, 1.0];

  String _displayedText = '';
  double _progress = 0.05;
  Timer? _typewriterTimer;
  bool _completed = false;

  /// The real background initialization, kicked off in parallel with the
  /// typing animation on the very first frame.
  late final Future<void> _backgroundWork;

  @override
  void initState() {
    super.initState();
    _initOrbAnimations();
    _backgroundWork = _runBackgroundInitialization();
    unawaited(_runScript());
  }

  void _initOrbAnimations() {
    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1800),
    )..repeat(reverse: true);
    _pulseAnimation = Tween<double>(begin: 0.95, end: 1.05).animate(
      CurvedAnimation(parent: _pulseController, curve: Curves.easeInOut),
    );
    _ringController = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 6),
    )..repeat();
    _cursorController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 500),
    )..repeat(reverse: true);
  }

  // ---------------------------------------------------------------------
  // Background task orchestration (parallel with the animation)
  // ---------------------------------------------------------------------

  Future<void> _runBackgroundInitialization() async {
    final user = ref.read(currentUserProvider);

    // Step A: pre-warm (open + migrate) the local Drift/SQLite database with
    // a cheap query so the chat store's cache restore below is instant.
    try {
      await ref.read(chatDatabaseProvider).getLatestMessageTimestamp();
    } catch (e) {
      debugPrint('[AiInit] DB pre-warm failed (non-fatal): $e');
    }

    if (user == null) return;

    // Step B (parallel): realtime transport, push registration, and the
    // cache-first chat store initialization (restores the local snapshot and
    // fires the server delta sync in the background).
    await Future.wait<void>([
      Future<void>(() {
        try {
          ref
              .read(realtimeTransportServiceProvider)
              .connect(user, isNetworkReachable: () => true);
        } catch (e) {
          debugPrint('[AiInit] transport connect failed (non-fatal): $e');
        }
      }),
      () async {
        try {
          final push = ref.read(pushNotificationServiceProvider);
          await push.initialize();
          await push.registerPendingTokenForUser();
        } catch (e) {
          debugPrint('[AiInit] push init failed (non-fatal): $e');
        }
      }(),
      () async {
        try {
          await ref.read(chatStoreProvider.notifier).initialize(user);
        } catch (e) {
          debugPrint('[AiInit] chat store init failed (non-fatal): $e');
        }
      }(),
    ]);
  }

  // ---------------------------------------------------------------------
  // Typewriter script
  // ---------------------------------------------------------------------

  Future<void> _runScript() async {
    for (var i = 0; i < _steps.length; i++) {
      if (!mounted) return;
      // Before announcing "ready", make sure the background work has really
      // finished so ChatShellScreen renders instantly from warm caches.
      if (i == _steps.length - 1) {
        try {
          await _backgroundWork;
        } catch (_) {}
      }
      await _typeStepText(_steps[i]);
      if (!mounted) return;
      setState(() => _progress = _stepProgress[i]);
      await Future.delayed(_kStepPause);
    }

    if (!mounted || _completed) return;
    _completed = true;
    widget.onCompleted();
  }

  Future<void> _typeStepText(String fullText) {
    final completer = Completer<void>();
    _typewriterTimer?.cancel();
    _displayedText = '';
    var charIndex = 0;

    _typewriterTimer = Timer.periodic(_kTypeCharInterval, (timer) {
      if (!mounted) {
        timer.cancel();
        if (!completer.isCompleted) completer.complete();
        return;
      }
      if (charIndex < fullText.length) {
        setState(() => _displayedText = fullText.substring(0, charIndex + 1));
        charIndex++;
      } else {
        timer.cancel();
        if (!completer.isCompleted) completer.complete();
      }
    });

    return completer.future;
  }

  @override
  void dispose() {
    _typewriterTimer?.cancel();
    _pulseController.dispose();
    _ringController.dispose();
    _cursorController.dispose();
    super.dispose();
  }

  // ---------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final primaryColor = theme.colorScheme.primary;

    return Scaffold(
      backgroundColor: theme.colorScheme.surface,
      body: Container(
        // Subtle ambient radial gradient over the deep surface background.
        decoration: BoxDecoration(
          gradient: RadialGradient(
            center: Alignment.center,
            radius: 1.1,
            colors: [
              primaryColor.withValues(alpha: 0.08),
              theme.colorScheme.surface,
            ],
          ),
        ),
        child: SafeArea(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 32.0),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  // Glowing pulsing AI agent orb with a rotating outer ring.
                  SizedBox(
                    width: 160,
                    height: 160,
                    child: Stack(
                      alignment: Alignment.center,
                      children: [
                        AnimatedBuilder(
                          animation: _ringController,
                          builder: (context, _) => CustomPaint(
                            size: const Size(160, 160),
                            painter: _RotatingRingPainter(
                              rotation: _ringController.value * 2 * math.pi,
                              color: primaryColor,
                            ),
                          ),
                        ),
                        ScaleTransition(
                          scale: _pulseAnimation,
                          child: Container(
                            width: 110,
                            height: 110,
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              gradient: LinearGradient(
                                colors: [
                                  primaryColor.withValues(alpha: 0.85),
                                  primaryColor.withValues(alpha: 0.35),
                                ],
                                begin: Alignment.topLeft,
                                end: Alignment.bottomRight,
                              ),
                              boxShadow: [
                                BoxShadow(
                                  color: primaryColor.withValues(alpha: 0.35),
                                  blurRadius: 36,
                                  spreadRadius: 8,
                                ),
                              ],
                            ),
                            child: Center(
                              child: Icon(
                                Icons.auto_awesome,
                                size: 48,
                                color: theme.colorScheme.onPrimary,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 48),

                  // Typewriter status text with blinking cursor.
                  SizedBox(
                    height: 60,
                    child: Directionality(
                      textDirection: TextDirection.rtl,
                      child: AnimatedBuilder(
                        animation: _cursorController,
                        builder: (context, _) => Text.rich(
                          TextSpan(
                            text: _displayedText,
                            children: [
                              TextSpan(
                                text: ' ▍',
                                style: TextStyle(
                                  color: primaryColor.withValues(
                                    alpha: _cursorController.value,
                                  ),
                                ),
                              ),
                            ],
                          ),
                          textAlign: TextAlign.center,
                          style: theme.textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.w600,
                            letterSpacing: 0.2,
                            height: 1.4,
                            color: theme.colorScheme.onSurface,
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 24),

                  // Smooth rounded progress bar.
                  ClipRRect(
                    borderRadius: BorderRadius.circular(8),
                    child: SizedBox(
                      width: 220,
                      height: 4,
                      child: TweenAnimationBuilder<double>(
                        duration: const Duration(milliseconds: 300),
                        curve: Curves.easeInOut,
                        tween: Tween<double>(begin: 0.0, end: _progress),
                        builder: (context, value, _) => LinearProgressIndicator(
                          value: value,
                          backgroundColor:
                              theme.colorScheme.surfaceContainerHighest,
                          valueColor:
                              AlwaysStoppedAnimation<Color>(primaryColor),
                        ),
                      ),
                    ),
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

/// Paints a thin rotating arc ring around the orb.
class _RotatingRingPainter extends CustomPainter {
  final double rotation;
  final Color color;

  const _RotatingRingPainter({required this.rotation, required this.color});

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = size.width / 2 - 4;
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2
      ..strokeCap = StrokeCap.round;

    // Two opposing arcs with a soft gradient sweep.
    for (var i = 0; i < 2; i++) {
      final start = rotation + i * math.pi;
      paint.shader = SweepGradient(
        startAngle: start,
        endAngle: start + math.pi * 0.9,
        colors: [
          color.withValues(alpha: 0.0),
          color.withValues(alpha: 0.6),
        ],
        transform: GradientRotation(start),
      ).createShader(Rect.fromCircle(center: center, radius: radius));
      canvas.drawArc(
        Rect.fromCircle(center: center, radius: radius),
        start,
        math.pi * 0.75,
        false,
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(_RotatingRingPainter oldDelegate) =>
      oldDelegate.rotation != rotation || oldDelegate.color != color;
}
