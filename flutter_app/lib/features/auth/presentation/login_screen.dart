/// Login screen with phone number input and SMS verification.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/services/otp_throttle_service.dart';
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

  // Countdown until another verification SMS may be requested. The authoritative
  // state lives in OtpThrottleService (max 4 SMS per phone per hour, at least
  // 120 s apart, persisted across restarts); this mirror only drives the UI.
  int _resendCountdown = 0;
  bool _quotaExhausted = false;
  Timer? _resendTimer;
  String _throttledPhone = '';

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

  @override
  void initState() {
    super.initState();
    _phoneController.addListener(_handlePhoneChanged);
    unawaited(_syncThrottleState());
  }

  @override
  void dispose() {
    _phoneController.removeListener(_handlePhoneChanged);
    _phoneController.dispose();
    _codeController.dispose();
    _phoneFocusNode.dispose();
    _codeFocusNode.dispose();
    _resendTimer?.cancel();
    super.dispose();
  }

  void _handlePhoneChanged() {
    final phone = normalizeOtpPhone(_phoneController.text);
    if (phone == _throttledPhone) return;
    unawaited(_syncThrottleState());
  }

  /// Reads the persisted throttle state for the phone currently in play and
  /// starts (or clears) the countdown that disables the send button.
  Future<void> _syncThrottleState() async {
    final phone = _activePhoneNumber();
    final decision = await ref.read(otpThrottleServiceProvider).check(phone);
    if (!mounted) return;
    setState(() {
      _throttledPhone = normalizeOtpPhone(phone);
      _quotaExhausted = decision.quotaExhausted;
      _resendCountdown = decision.allowed ? 0 : decision.retryAfter.inSeconds + 1;
    });
    _restartCountdownTimer();
  }

  void _restartCountdownTimer() {
    _resendTimer?.cancel();
    if (_resendCountdown <= 0) return;
    _resendTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      if (_resendCountdown > 1) {
        setState(() => _resendCountdown--);
        return;
      }
      timer.cancel();
      // Re-read the persisted state instead of trusting the local tick: the
      // hourly quota may still block sending even though the 120s gap elapsed.
      unawaited(_syncThrottleState());
    });
  }

  /// The phone number the throttle applies to: the one awaiting a code when a
  /// verification is in progress, otherwise whatever is typed in the field.
  String _activePhoneNumber() {
    final authState = ref.read(authStateProvider);
    if (authState is AuthAwaitingCode) return authState.phoneNumber;
    if (_verifyingPhoneNumber != null) return _verifyingPhoneNumber!;
    return _phoneController.text.trim();
  }

  /// Human readable remaining wait, e.g. `95 שניות` or `12 דקות`.
  String get _throttleWaitLabel {
    if (_resendCountdown >= 120) {
      return '${(_resendCountdown / 60).ceil()} דקות';
    }
    return '$_resendCountdown שניות';
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

                  // Login button — disabled while a code was recently sent to
                  // this number or the hourly SMS quota is exhausted.
                  ElevatedButton(
                    onPressed: (isLoading || _resendCountdown > 0) ? null : _handleLogin,
                    child: isLoading
                        ? const SizedBox(
                            height: 20,
                            width: 20,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                            ),
                          )
                        : Text(
                            _resendCountdown > 0
                                ? 'ניתן לשלוח שוב בעוד $_throttleWaitLabel'
                                : 'התחברות',
                          ),
                  ),

                  if (_resendCountdown > 0) ...[
                    const SizedBox(height: 12),
                    Text(
                      _quotaExhausted
                          ? 'נשלחו $kOtpMaxSendsPerWindow קודי אימות בשעה האחרונה. '
                              'ניתן לנסות שוב בעוד $_throttleWaitLabel.'
                          : 'קוד אימות כבר נשלח למספר זה. ניתן לשלוח קוד נוסף בעוד $_throttleWaitLabel.',
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
                    // Lock the input the instant a verification is submitted,
                    // before the global auth state flips to AuthLoading.
                    enabled: !isLoading && !_isVerifyingCode,
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
                    onPressed: (isLoading || _isVerifyingCode) ? null : _handleVerifyCode,
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

                  // Resend code — blocked until the 120s gap elapsed and the
                  // hourly quota still has room.
                  TextButton(
                    onPressed: isLoading || _resendCountdown > 0
                        ? null
                        : () => _handleResendCode(awaitingPhoneNumber),
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
                              Text('שלח קוד שוב ($_throttleWaitLabel)'),
                            ],
                          )
                        : const Text('שלח קוד שוב'),
                  ),

                  if (_quotaExhausted && _resendCountdown > 0) ...[
                    const SizedBox(height: 8),
                    Text(
                      'נשלחו $kOtpMaxSendsPerWindow קודי אימות בשעה האחרונה.',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                            color: Theme.of(context).colorScheme.onSurface.withAlpha((255 * 0.7).round()),
                          ),
                    ),
                  ],
                ],

                const SizedBox(height: 48),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _handleLogin() async {
    final phone = _phoneController.text.trim();
    if (phone.isEmpty) {
      showTopToast(context, 'יש להזין מספר טלפון');
      return;
    }

    await ref.read(authStateProvider.notifier).login(phone);
    // Re-read the persisted history so the countdown reflects the send that
    // just happened (or the throttle that rejected it).
    await _syncThrottleState();
  }

  Future<void> _handleResendCode(String phoneNumber) async {
    await ref.read(authStateProvider.notifier).requestCode(phoneNumber);
    await _syncThrottleState();
  }

  void _handleVerifyCode() {
    // Strict submission lock: the keyboard "done" action and the submit
    // button can both fire for the same code entry. A second concurrent
    // verify request would race the first one on the server (the code is
    // single-use) and surface as an "operation aborted"/invalid-code error,
    // so only ever allow one in-flight verification.
    if (_isVerifyingCode || ref.read(authStateProvider) is AuthLoading) {
      return;
    }

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
