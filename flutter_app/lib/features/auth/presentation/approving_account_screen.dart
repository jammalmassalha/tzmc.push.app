/// Approval loader shown after the SMS code is verified.
///
/// While the licenser service finalises the account status on the Subscribe
/// sheet, this screen shows a 0–100% progress bar with a reassuring message.
/// The driving logic lives in [AuthNotifier]; this widget only renders the
/// current [AuthApproving] progress and finishes as soon as the auth state
/// transitions to [AuthAuthenticated].
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'auth_state.dart';

/// Full-screen "approving your account" loader with a progress bar.
class ApprovingAccountScreen extends ConsumerWidget {
  const ApprovingAccountScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final authState = ref.watch(authStateProvider);
    final double progress =
        authState is AuthApproving ? authState.progress.clamp(0.0, 1.0) : 0.0;
    final int percent = (progress * 100).round();

    return Scaffold(
      backgroundColor: Theme.of(context).colorScheme.primary,
      body: SafeArea(
        child: Directionality(
          textDirection: TextDirection.rtl,
          child: Center(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 32),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  // App logo
                  Container(
                    width: 120,
                    height: 120,
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(24),
                    ),
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Image.asset(
                        'assets/images/logo.png',
                        fit: BoxFit.contain,
                      ),
                    ),
                  ),
                  const SizedBox(height: 32),
                  const Text(
                    'מאשרים את החשבון שלך',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 24,
                      fontWeight: FontWeight.bold,
                      color: Colors.white,
                    ),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    'אנא המתן בזמן שאנו מאמתים את ההרשאות שלך ומכינים את הממשק המתאים עבורך...',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 15,
                      height: 1.4,
                      color: Colors.white.withAlpha((255 * 0.85).round()),
                    ),
                  ),
                  const SizedBox(height: 40),

                  // Smoothly animated progress bar that follows the notifier's
                  // progress value. TweenAnimationBuilder interpolates between
                  // successive 1-second progress updates for a fluid 0→100% fill.
                  TweenAnimationBuilder<double>(
                    tween: Tween<double>(begin: 0.0, end: progress),
                    duration: const Duration(milliseconds: 600),
                    curve: Curves.easeOut,
                    builder: (context, value, _) {
                      return Column(
                        children: [
                          ClipRRect(
                            borderRadius: BorderRadius.circular(8),
                            child: LinearProgressIndicator(
                              value: value,
                              minHeight: 12,
                              backgroundColor:
                                  Colors.white.withAlpha((255 * 0.25).round()),
                              valueColor:
                                  const AlwaysStoppedAnimation<Color>(Colors.white),
                            ),
                          ),
                          const SizedBox(height: 12),
                          Text(
                            '$percent%',
                            style: const TextStyle(
                              fontSize: 18,
                              fontWeight: FontWeight.bold,
                              color: Colors.white,
                            ),
                          ),
                        ],
                      );
                    },
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
