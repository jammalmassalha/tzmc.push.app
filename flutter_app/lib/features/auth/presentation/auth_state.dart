/// Authentication service and state management.
///
/// Handles login, logout, SMS verification, and session persistence.
library;

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:logger/logger.dart';

import '../../../core/api/chat_api_service.dart';
import '../../../core/services/push_notification_service.dart';

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

/// User is authenticated
class AuthAuthenticated extends AuthState {
  final String user;

  /// Phone number that was used to authenticate (stored for convenience, e.g.
  /// to pre-fill contact-phone fields).  May be null when restoring an older
  /// persisted session that pre-dates this field.
  final String? phone;

  const AuthAuthenticated({required this.user, this.phone});
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
      final sessionUser = await _apiService.getSessionUser();

      if (sessionUser != null) {
        await _secureStorage.write(key: _userKey, value: sessionUser);
        final cachedPhone = await _secureStorage.read(key: _phoneKey);
        state = AuthAuthenticated(user: sessionUser, phone: cachedPhone);
        _logger.i('Session restored for user: $sessionUser');
      } else {
        await _secureStorage.delete(key: _userKey);
        state = const AuthUnauthenticated();
        _logger.i('No active session found');
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
      final user = await _apiService.verifySessionCode(
        currentState.phoneNumber,
        code,
      );
      await _secureStorage.write(key: _userKey, value: user);
      await _secureStorage.write(key: _phoneKey, value: currentState.phoneNumber);
      state = AuthAuthenticated(user: user, phone: currentState.phoneNumber);
      _logger.i('Code verification successful for: $user');
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

  /// Logout
  Future<void> logout() async {
    // Unregister the push device token first so the server stops targeting
    // this device for the user that is logging out.
    try {
      await ref.read(pushNotificationServiceProvider).unregisterToken();
    } catch (e) {
      _logger.w('Error unregistering push token: $e');
    }

    try {
      await _apiService.clearSession();
    } catch (e) {
      _logger.w('Error clearing server session: $e');
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
    state = const AuthUnauthenticated();
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
