/// Authentication service and state management.
///
/// Handles login, logout, SMS verification, and session persistence.
library;

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:logger/logger.dart';

import '../../../core/api/chat_api_service.dart';
import '../../../core/models/api_payloads.dart';
import '../../../core/services/chat_store_service.dart';
import '../../../core/services/push_notification_service.dart';
import '../../../core/services/windows_auth_service.dart'
    // On web (dart.library.html is available) the stub is loaded instead,
    // because dart:io is unavailable on that platform.
    if (dart.library.html) '../../../core/services/windows_auth_service_stub.dart';

final _logger = Logger(
  printer: PrettyPrinter(methodCount: 0, errorMethodCount: 5, lineLength: 80),
);

/// Authentication state
sealed class AuthState {
  const AuthState();
}

/// Initial state - checking session
class AuthLoading extends AuthState {
  const AuthLoading();
}

/// User is not authenticated
class AuthUnauthenticated extends AuthState {
  const AuthUnauthenticated();
}

/// Awaiting SMS code verification
class AuthAwaitingCode extends AuthState {
  final String phoneNumber;
  final int expiresInSeconds;

  const AuthAwaitingCode({
    required this.phoneNumber,
    required this.expiresInSeconds,
  });
}

/// Code verified — waiting for the licenser service to finalise the account
/// status on the Subscribe sheet. A progress bar (0–100%) is shown for up to
/// [totalSeconds]; the flow finishes as soon as the status is resolved.
class AuthApproving extends AuthState {
  final String user;
  final String? phone;

  /// Progress of the approval loader in the range 0.0–1.0.
  final double progress;

  /// Total duration of the approval window in seconds (used by the loader to
  /// render a human-readable countdown).
  final int totalSeconds;

  const AuthApproving({
    required this.user,
    this.phone,
    this.progress = 0.0,
    this.totalSeconds = 60,
  });
}

/// User is authenticated
class AuthAuthenticated extends AuthState {
  final String user;

  /// Phone number that was used to authenticate (stored for convenience, e.g.
  /// to pre-fill contact-phone fields).  May be null when restoring an older
  /// persisted session that pre-dates this field.
  final String? phone;

  final bool isRestricted;

  const AuthAuthenticated({required this.user, this.phone, this.isRestricted = false});
}

/// Authentication error
class AuthError extends AuthState {
  final String message;
  final AuthState previousState;

  const AuthError({
    required this.message,
    required this.previousState,
  });
}

/// Auth state provider
final authStateProvider = NotifierProvider<AuthNotifier, AuthState>(() {
  return AuthNotifier();
});

/// Auth notifier for state management
class AuthNotifier extends Notifier<AuthState> {
  late final ChatApiService _apiService;
  final FlutterSecureStorage _secureStorage = const FlutterSecureStorage();

  static const _userKey = 'tzmc_current_user';
  static const _phoneKey = 'tzmc_current_user_phone';

  /// Monotonic counter used to supersede/cancel an in-flight approval loop
  /// (e.g. when the user logs out or resets while the loader is running).
  int _approvalGeneration = 0;

  @override
  AuthState build() {
    _apiService = ref.watch(chatApiServiceProvider);
    _checkExistingSession();
    return const AuthLoading();
  }

  /// Check for existing session on app start
  Future<void> _checkExistingSession() async {
    try {
      // First check secure storage for cached user
      final cachedUser = await _secureStorage.read(key: _userKey);

      // Then verify with server
      final sessionInfo = await _apiService.getSessionInfo();

      if (sessionInfo != null) {
        final sessionUser = sessionInfo.user?.trim().toLowerCase() ?? cachedUser ?? '';
        if (cachedUser != null && cachedUser.trim().toLowerCase() != sessionUser) {
          try {
            await ref.read(chatStoreProvider.notifier).clearAll();
          } catch (e) {
            _logger.w('Error clearing chat cache for switched session user: $e');
          }
        }
        await _secureStorage.write(key: _userKey, value: sessionUser);
        final cachedPhone = await _secureStorage.read(key: _phoneKey);
        state = AuthAuthenticated(
          user: sessionUser,
          phone: cachedPhone,
          isRestricted: sessionInfo.isRestricted ?? false,
        );
        unawaited(_resetBadgeAfterAuth());
        _logger.i('Session restored for user: $sessionUser (isRestricted: ${sessionInfo.isRestricted})');
      } else {
        await _secureStorage.delete(key: _userKey);

        // On Windows desktop, attempt auto-login via the Windows username
        // before falling back to the manual login screen.
        final windowsUser = await tryWindowsAutoLogin(_apiService);
        if (windowsUser != null) {
          await _secureStorage.write(key: _userKey, value: windowsUser);
          state = AuthAuthenticated(user: windowsUser, phone: null, isRestricted: false);
          unawaited(_resetBadgeAfterAuth());
          _logger.i('Windows auto-login succeeded for user: $windowsUser');
        } else {
          state = const AuthUnauthenticated();
          _logger.i('No active session found');
        }
      }
    } catch (e) {
      _logger.e('Error checking session: $e');
      state = const AuthUnauthenticated();
    }
  }

  /// Get current user if authenticated
  String? get currentUser {
    final currentState = state;
    if (currentState is AuthAuthenticated) {
      return currentState.user;
    }
    return null;
  }

  /// Login with phone number
  /// 
  /// Since direct login is disabled on the server, this method now
  /// directly requests an SMS verification code.
  Future<void> login(String phoneNumber) async {
    // Direct login is disabled on the server.
    // Always use the SMS verification code flow.
    await requestCode(phoneNumber);
  }

  /// Request SMS verification code
  Future<void> requestCode(String phoneNumber) async {
    // Guard against rapid duplicate submissions while a request is in flight.
    if (state is AuthLoading) {
      return;
    }

    final previousState = state;
    state = const AuthLoading();

    try {
      final expiresIn = await _apiService.requestSessionCode(phoneNumber);
      state = AuthAwaitingCode(
        phoneNumber: phoneNumber,
        expiresInSeconds: expiresIn,
      );
      _logger.i('SMS code requested for: $phoneNumber, expires in: $expiresIn seconds');
    } on RateLimitException catch (e) {
      state = AuthError(message: e.message, previousState: previousState);
    } on AuthException catch (e) {
      state = AuthError(message: e.message, previousState: previousState);
    } catch (e) {
      state = AuthError(
        message: 'שגיאה בשליחת קוד אימות',
        previousState: previousState,
      );
      _logger.e('Request code error: $e');
    }
  }

  /// Verify SMS code
  Future<void> verifyCode(String code) async {
    final currentState = state;
    if (currentState is! AuthAwaitingCode) {
      state = AuthError(
        message: 'מצב לא תקין לאימות קוד',
        previousState: currentState,
      );
      return;
    }

    final previousState = currentState;
    state = const AuthLoading();

    try {
      final sessionResponse = await _apiService.verifySessionCodeResponse(
        currentState.phoneNumber,
        code,
      );
      final user = sessionResponse.user?.trim().toLowerCase() ?? currentState.phoneNumber;
      try {
        await ref.read(chatStoreProvider.notifier).clearAll();
      } catch (e) {
        _logger.w('Error clearing chat cache after verify-code login: $e');
      }
      await _secureStorage.write(key: _userKey, value: user);
      await _secureStorage.write(key: _phoneKey, value: currentState.phoneNumber);
      _logger.i('Code verification successful for: $user '
          '(initial isRestricted: ${sessionResponse.isRestricted}, '
          'statusPending: ${sessionResponse.statusPending})');

      // Show the "approving your account" loader while the licenser service
      // finalises the Subscribe Status column. This polls GET /auth/session
      // for the live isRestricted/statusPending values and applies the correct
      // UI immediately — without requiring the user to log out and back in.
      await _runApprovalFlow(
        user: user,
        phone: currentState.phoneNumber,
        initialIsRestricted: sessionResponse.isRestricted ?? false,
        initiallyPending: sessionResponse.statusPending ?? true,
      );
    } on AuthException catch (e) {
      state = AuthError(message: e.message, previousState: previousState);
    } catch (e) {
      state = AuthError(
        message: 'שגיאה באימות הקוד',
        previousState: previousState,
      );
      _logger.e('Verify code error: $e');
    }
  }

  /// Drives the post-verification approval loader. Renders a 0–100% progress
  /// bar over [_approvalTotalSeconds] while polling GET /auth/session, and
  /// finalises to [AuthAuthenticated] as soon as the Subscribe Status column is
  /// resolved (statusPending == false) — or when the window elapses, whichever
  /// comes first. The live isRestricted value decides the UI that is applied.
  static const int _approvalTotalSeconds = 60;
  static const int _approvalPollEverySeconds = 3;

  Future<void> _runApprovalFlow({
    required String user,
    required String? phone,
    required bool initialIsRestricted,
    required bool initiallyPending,
  }) async {
    final int generation = ++_approvalGeneration;
    bool isRestricted = initialIsRestricted;
    bool resolved = !initiallyPending;

    // Render the loader immediately at 0%.
    state = AuthApproving(
      user: user,
      phone: phone,
      progress: 0.0,
      totalSeconds: _approvalTotalSeconds,
    );

    // Immediate poll so already-resolved users finish without delay.
    final firstInfo = await _safeGetSessionInfo();
    if (generation != _approvalGeneration) return;
    if (firstInfo != null && (firstInfo.statusPending ?? false) == false) {
      resolved = true;
      isRestricted = firstInfo.isRestricted ?? isRestricted;
    }

    int elapsed = 0;
    while (!resolved && elapsed < _approvalTotalSeconds) {
      await Future<void>.delayed(const Duration(seconds: 1));
      if (generation != _approvalGeneration) return;
      elapsed++;
      state = AuthApproving(
        user: user,
        phone: phone,
        progress: (elapsed / _approvalTotalSeconds).clamp(0.0, 1.0),
        totalSeconds: _approvalTotalSeconds,
      );

      if (elapsed % _approvalPollEverySeconds == 0) {
        final info = await _safeGetSessionInfo();
        if (generation != _approvalGeneration) return;
        if (info != null && (info.statusPending ?? false) == false) {
          resolved = true;
          isRestricted = info.isRestricted ?? isRestricted;
        }
      }
    }

    if (generation != _approvalGeneration) return;

    // Snap the bar to 100% before applying the resolved UI.
    state = AuthApproving(
      user: user,
      phone: phone,
      progress: 1.0,
      totalSeconds: _approvalTotalSeconds,
    );

    state = AuthAuthenticated(
      user: user,
      phone: phone,
      isRestricted: isRestricted,
    );
    unawaited(_resetBadgeAfterAuth());
    _logger.i('Approval flow complete for: $user '
        '(resolved: $resolved, isRestricted: $isRestricted)');
  }

  Future<SessionResponse?> _safeGetSessionInfo() async {
    try {
      return await _apiService.getSessionInfo();
    } catch (e) {
      _logger.w('Approval poll: getSessionInfo failed: $e');
      return null;
    }
  }

  /// Logout
  Future<void> logout() async {
    // Cancel any in-flight approval loader.
    _approvalGeneration++;
    // Unregister the push device token first so the server stops targeting
    // this device for the user that is logging out.
    try {
      await ref.read(pushNotificationServiceProvider).unregisterToken();
    } catch (e) {
      _logger.w('Error unregistering push token: $e');
    }

    // Reset the app-icon badge and server-side badge counter on logout so
    // they start from zero on the next login — without this the old count
    // survives across reinstalls (iOS keychain) and is incorrectly shown
    // as unread when the user signs back in.
    try {
      await ref.read(pushNotificationServiceProvider).resetBadge();
    } catch (e) {
      _logger.w('Error resetting badge on logout: $e');
    }

    try {
      await _apiService.clearSession();
    } catch (e) {
      _logger.w('Error clearing server session: $e');
    }

    // Wipe all local chat data so the next user to log in on this device
    // starts with a completely clean slate and never sees the previous
    // user's contacts, messages, or unread counts.
    try {
      await ref.read(chatStoreProvider.notifier).clearAll();
    } catch (e) {
      _logger.w('Error clearing chat store on logout: $e');
    }

    await _secureStorage.delete(key: _userKey);
    await _secureStorage.delete(key: _phoneKey);
    state = const AuthUnauthenticated();
    _logger.i('User logged out');
  }

  /// Clear error and return to previous state
  void clearError() {
    final currentState = state;
    if (currentState is AuthError) {
      state = currentState.previousState;
    }
  }

  /// Reset to unauthenticated state
  void reset() {
    // Cancel any in-flight approval loader.
    _approvalGeneration++;
    state = const AuthUnauthenticated();
  }

  /// Update the isRestricted status for the authenticated user dynamically
  void updateUserRestrictedStatus(bool isRestricted) {
    final currentState = state;
    if (currentState is AuthAuthenticated) {
      if (currentState.isRestricted != isRestricted) {
        state = AuthAuthenticated(
          user: currentState.user,
          phone: currentState.phone,
          isRestricted: isRestricted,
        );
        _logger.i('Dynamic status updated for user: ${currentState.user} (isRestricted: $isRestricted)');
      }
    }
  }

  Future<void> _resetBadgeAfterAuth() async {
    try {
      await ref.read(pushNotificationServiceProvider).resetBadge();
    } catch (e) {
      _logger.w('Error resetting badge after auth: $e');
    }
  }
}

/// Provider for current user
final currentUserProvider = Provider<String?>((ref) {
  final authState = ref.watch(authStateProvider);
  if (authState is AuthAuthenticated) {
    return authState.user;
  }
  return null;
});

/// Provider for authentication status
final isAuthenticatedProvider = Provider<bool>((ref) {
  final authState = ref.watch(authStateProvider);
  return authState is AuthAuthenticated;
});

/// Provider for checking if current user is restricted
final isUserRestrictedProvider = Provider<bool>((ref) {
  final authState = ref.watch(authStateProvider);
  if (authState is AuthAuthenticated) {
    return authState.isRestricted;
  }
  return false;
});

/// Provider for the current user's phone number (the phone used to log in).
/// Returns null when not authenticated or when the session pre-dates phone
/// persistence.
final currentUserPhoneProvider = Provider<String?>((ref) {
  final authState = ref.watch(authStateProvider);
  if (authState is AuthAuthenticated) {
    return authState.phone;
  }
  return null;
});
