/// Login screen with phone number input and SMS verification.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

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
    final awaitingCode = authState is AuthAwaitingCode;
    final error = authState is AuthError ? authState.message : null;

    // Show error snackbar
    if (error != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(error, textDirection: TextDirection.rtl),
            backgroundColor: Theme.of(context).colorScheme.error,
            action: SnackBarAction(
              label: 'סגור',
              textColor: Colors.white,
              onPressed: () {
                ref.read(authStateProvider.notifier).clearError();
              },
            ),
          ),
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
                ],

                // SMS code input
                if (awaitingCode) ...[
                  Text(
                    'קוד אימות',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'נשלח קוד אימות ל-${authState.phoneNumber}',
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
                            ref.read(authStateProvider.notifier).requestCode(authState.phoneNumber);
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
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('יש להזין מספר טלפון', textDirection: TextDirection.rtl),
        ),
      );
      return;
    }

    ref.read(authStateProvider.notifier).login(phone);
    _startResendCooldown();
  }

  void _handleVerifyCode() {
    final code = _codeController.text.trim();
    if (code.length != 6) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('יש להזין קוד בן 6 ספרות', textDirection: TextDirection.rtl),
        ),
      );
      return;
    }

    ref.read(authStateProvider.notifier).verifyCode(code);
  }
}
