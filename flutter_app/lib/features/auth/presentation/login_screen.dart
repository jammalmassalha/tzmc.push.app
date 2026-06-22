/// Login screen with phone number input and SMS verification.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/utils/toast_utils.dart';
import 'auth_state.dart';

/// Login screen widget
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _phoneController = TextEditingController();
  final _codeController = TextEditingController();
  final _phoneFocusNode = FocusNode();
  final _codeFocusNode = FocusNode();
  
  // Countdown timer for SMS resend cooldown (120 seconds)
  static const int _resendCooldownSeconds = 120;
  int _resendCountdown = 0;
  Timer? _resendTimer;

  // Set true while a verify-code request is in flight. The server holds the
  // request open for up to ~45 s while it waits for an external service to
  // finalise the user's Status, so we keep the SMS code UI visible and show
  // a "please wait" hint instead of dropping the user back to the phone
  // input screen with just a spinner.
  bool _isVerifyingCode = false;
  // Remember the phone number associated with the in-flight verification so
  // we can keep rendering the correct "code sent to <phone>" copy even
  // though the global auth state is briefly AuthLoading during the wait.
  String? _verifyingPhoneNumber;

  // Set true while a request-code call is in flight so that the login screen
  // can show the "verifying your data" message instead of just a plain spinner
  // while the server performs the licenser check (up to ~45 s for restricted users).
  bool _isRequestingCode = false;

  @override
  void dispose() {
    _phoneController.dispose();
    _codeController.dispose();
    _phoneFocusNode.dispose();
    _codeFocusNode.dispose();
    _resendTimer?.cancel();
    super.dispose();
  }
  
  void _startResendCooldown() {
    _resendCountdown = _resendCooldownSeconds;
    _resendTimer?.cancel();
    _resendTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (_resendCountdown > 0) {
        setState(() {
          _resendCountdown--;
        });
      } else {
        timer.cancel();
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authStateProvider);
    final isLoading = authState is AuthLoading;
    // Keep the SMS code UI visible while a verify-code request is in flight
    // (which transitions the global auth state to AuthLoading) so the user
    // sees the loader + "please wait" hint instead of bouncing back to the
    // phone input screen.
    final awaitingCode = authState is AuthAwaitingCode || _isVerifyingCode;
    final awaitingPhoneNumber = authState is AuthAwaitingCode
        ? authState.phoneNumber
        : _verifyingPhoneNumber ?? '';
    final error = authState is AuthError ? authState.message : null;

    // Clear the local verifying flag once the auth flow has resolved (either
    // back to AuthAwaitingCode on error/clearError or forward to
    // AuthAuthenticated on success).
    if (_isVerifyingCode && !isLoading) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _isVerifyingCode) {
          setState(() {
            _isVerifyingCode = false;
            _verifyingPhoneNumber = null;
          });
        }
      });
    }

    // Clear the requesting-code flag once the server responds (the state moves
    // to AuthAwaitingCode on success or AuthError on failure).
    if (_isRequestingCode && !isLoading) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _isRequestingCode) {
          setState(() {
            _isRequestingCode = false;
          });
        }
      });
    }

    // Show error snackbar
    if (error != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        showTopToast(
          context,
          error,
          backgroundColor: Theme.of(context).colorScheme.error,
        );
        ref.read(authStateProvider.notifier).clearError();
      });
    }

    return Scaffold(
      body: SafeArea(
        child: Directionality(
          textDirection: TextDirection.rtl,
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const SizedBox(height: 48),

                // Logo
                Center(
                  child: Image.asset(
                    'assets/images/logo.png',
                    width: 120,
                    height: 120,
                  ),
                ),

                const SizedBox(height: 24),

                // Title
                Text(
                  'מרכז רפואי צפון',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.displaySmall?.copyWith(
                        fontWeight: FontWeight.bold,
                        color: Theme.of(context).colorScheme.primary,
                      ),
                ),

                const SizedBox(height: 8),

                Text(
                  'התחברות',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.titleLarge?.copyWith(
                        color: Theme.of(context).colorScheme.onSurface.withAlpha((255 * 0.7).round()),
                      ),
                ),

                const SizedBox(height: 48),

                // Phone number input
                if (!awaitingCode) ...[
                  Text(
                    'מספר טלפון',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    controller: _phoneController,
                    focusNode: _phoneFocusNode,
                    keyboardType: TextInputType.phone,
                    textDirection: TextDirection.ltr,
                    textAlign: TextAlign.left,
                    enabled: !isLoading,
                    inputFormatters: [
                      FilteringTextInputFormatter.digitsOnly,
                      LengthLimitingTextInputFormatter(10),
                    ],
                    decoration: const InputDecoration(
                      hintText: '05X-XXX-XXXX',
                      prefixIcon: Icon(Icons.phone),
                    ),
                    onSubmitted: (_) => _handleLogin(),
                  ),

                  const SizedBox(height: 24),

                  // Login button
                  ElevatedButton(
                    onPressed: isLoading ? null : _handleLogin,
                    child: isLoading
                        ? const SizedBox(
                            height: 20,
                            width: 20,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                            ),
                          )
                        : const Text('התחברות'),
                  ),

                  // While the server checks the employment DB before dispatching
                  // the SMS (up to ~45 s for restricted users), let the user know
                  // their details are being verified so they don't think the app froze.
                  if (isLoading && _isRequestingCode) ...[
                    const SizedBox(height: 12),
                    Text(
                      'מאמתים את פרטיך, אנא המתן...',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                            color: Theme.of(context).colorScheme.onSurface.withAlpha((255 * 0.7).round()),
                          ),
                    ),
                  ],
                ],

                // SMS code input
                if (awaitingCode) ...[
                  Text(
                    'קוד אימות',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'נשלח קוד אימות ל-$awaitingPhoneNumber',
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: Theme.of(context).colorScheme.onSurface.withAlpha((255 * 0.6).round()),
                        ),
                  ),
                  const SizedBox(height: 16),
                  TextField(
                    controller: _codeController,
                    focusNode: _codeFocusNode,
                    keyboardType: TextInputType.number,
                    textDirection: TextDirection.ltr,
                    textAlign: TextAlign.center,
                    enabled: !isLoading,
                    style: const TextStyle(
                      fontSize: 24,
                      letterSpacing: 8,
                      fontWeight: FontWeight.bold,
                    ),
                    inputFormatters: [
                      FilteringTextInputFormatter.digitsOnly,
                      LengthLimitingTextInputFormatter(6),
                    ],
                    decoration: const InputDecoration(
                      hintText: '••••••',
                      prefixIcon: Icon(Icons.lock),
                    ),
                    onSubmitted: (_) => _handleVerifyCode(),
                  ),

                  const SizedBox(height: 24),

                  // Verify button
                  ElevatedButton(
                    onPressed: isLoading ? null : _handleVerifyCode,
                    child: isLoading
                        ? const SizedBox(
                            height: 20,
                            width: 20,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                            ),
                          )
                        : const Text('אימות'),
                  ),

                  // While the server is finalising the login (after the SMS
                  // code is matched it polls an external service for up to
                  // ~45 s to set the user's final Status), surface a clear
                  // "please wait" hint so the user understands the spinner.
                  if (isLoading && _isVerifyingCode) ...[
                    const SizedBox(height: 12),
                    Text(
                      'מאמת את הקוד ומשלים את ההתחברות, נא להמתין עד דקה...',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                            color: Theme.of(context).colorScheme.onSurface.withAlpha((255 * 0.7).round()),
                          ),
                    ),
                  ],

                  const SizedBox(height: 16),

                  // Back button
                  TextButton(
                    onPressed: isLoading
                        ? null
                        : () {
                            _codeController.clear();
                            ref.read(authStateProvider.notifier).reset();
                          },
                    child: const Text('חזרה'),
                  ),

                  // Resend code
                  TextButton(
                    onPressed: isLoading || _resendCountdown > 0
                        ? null
                        : () {
                            ref.read(authStateProvider.notifier).requestCode(awaitingPhoneNumber);
                            _startResendCooldown();
                          },
                    child: _resendCountdown > 0
                        ? Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const SizedBox(
                                height: 16,
                                width: 16,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              ),
                              const SizedBox(width: 8),
                              Text('שלח קוד שוב ($_resendCountdown שניות)'),
                            ],
                          )
                        : const Text('שלח קוד שוב'),
                  ),
                ],

                const SizedBox(height: 48),
              ],
            ),
          ),
        ),
      ),
    );
  }

  void _handleLogin() {
    final phone = _phoneController.text.trim();
    if (phone.isEmpty) {
      showTopToast(context, 'יש להזין מספר טלפון');
      return;
    }

    setState(() {
      _isRequestingCode = true;
    });
    ref.read(authStateProvider.notifier).login(phone);
    _startResendCooldown();
  }

  void _handleVerifyCode() {
    final code = _codeController.text.trim();
    if (code.length != 6) {
      showTopToast(context, 'יש להזין קוד בן 6 ספרות');
      return;
    }

    final authState = ref.read(authStateProvider);
    final phoneNumber = authState is AuthAwaitingCode ? authState.phoneNumber : null;
    setState(() {
      _isVerifyingCode = true;
      _verifyingPhoneNumber = phoneNumber;
    });
    ref.read(authStateProvider.notifier).verifyCode(code);
  }
}
