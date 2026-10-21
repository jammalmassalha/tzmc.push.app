/// Blank "waiting for approval" home page.
///
/// Users whose `Subscribe.Staus` is still `0` (surfaced to the client as
/// `isRestricted`) are authenticated but not yet approved. They must not see
/// any chat content — no chat list, no community/global groups and no way to
/// start a new chat or group — until an administrator flips their status to
/// `1`.
///
/// The screen re-checks the session status periodically (and on demand) so the
/// real shell appears automatically once the account is approved, without the
/// user having to restart the app. The realtime transport also pushes status
/// changes, so approval is usually reflected within a second.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/chat_api_service.dart';
import '../../auth/presentation/auth_state.dart';

/// How often the pending screen polls the server for a status change.
const Duration kPendingApprovalPollInterval = Duration(seconds: 20);

/// Home page shown while the account is pending approval (Status 0).
class PendingApprovalScreen extends ConsumerStatefulWidget {
  const PendingApprovalScreen({super.key});

  @override
  ConsumerState<PendingApprovalScreen> createState() =>
      _PendingApprovalScreenState();
}

class _PendingApprovalScreenState extends ConsumerState<PendingApprovalScreen> {
  Timer? _pollTimer;
  bool _isChecking = false;

  @override
  void initState() {
    super.initState();
    _pollTimer = Timer.periodic(
      kPendingApprovalPollInterval,
      (_) => unawaited(_refreshStatus(showFeedback: false)),
    );
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  Future<void> _refreshStatus({required bool showFeedback}) async {
    if (_isChecking) return;
    if (showFeedback) setState(() => _isChecking = true);
    try {
      final session = await ref.read(chatApiServiceProvider).getSessionInfo();
      if (session != null) {
        ref
            .read(authStateProvider.notifier)
            .updateUserRestrictedStatus(session.isRestricted ?? false);
      }
    } catch (_) {
      // Offline / transient failure — the next tick retries.
    } finally {
      if (mounted && showFeedback) setState(() => _isChecking = false);
    }
  }

  Future<void> _handleLogout() async {
    await ref.read(authStateProvider.notifier).logout();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Directionality(
      textDirection: TextDirection.rtl,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('מרכז רפואי צפון'),
          actions: [
            IconButton(
              tooltip: 'התנתקות',
              onPressed: _handleLogout,
              icon: const Icon(Icons.logout),
            ),
          ],
        ),
        body: SafeArea(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      Icons.hourglass_empty,
                      size: 72,
                      color: theme.colorScheme.primary,
                    ),
                    const SizedBox(height: 24),
                    Text(
                      'החשבון ממתין לאישור',
                      textAlign: TextAlign.center,
                      style: theme.textTheme.titleLarge
                          ?.copyWith(fontWeight: FontWeight.bold),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      'החשבון שלך נוצר אך טרם אושר על ידי מנהל המערכת. '
                      'לאחר האישור התוכן ייפתח באופן אוטומטי.',
                      textAlign: TextAlign.center,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: theme.colorScheme.onSurface
                            .withAlpha((255 * 0.7).round()),
                      ),
                    ),
                    const SizedBox(height: 24),
                    OutlinedButton.icon(
                      onPressed: _isChecking
                          ? null
                          : () => unawaited(_refreshStatus(showFeedback: true)),
                      icon: _isChecking
                          ? const SizedBox(
                              height: 16,
                              width: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.refresh),
                      label: const Text('בדיקת סטטוס'),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
