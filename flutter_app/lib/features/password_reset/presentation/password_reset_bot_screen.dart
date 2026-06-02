/// Password Reset Bot Screen
///
/// A Hebrew-language chat-bot UI that guides the user through a
/// Windows password reset flow, mobile (iOS / Android) only.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/chat_api_service.dart';
import '../../../features/auth/presentation/auth_state.dart';
import '../../../shared/theme/app_theme.dart';

/// State of the password-reset conversation.
enum _BotStep {
  idle,
  confirmReset,
  enterBirthYear,
  enterPassword,
  polling,
  done,
}

/// A single chat bubble in the conversation log.
class _ChatBubble {
  final String text;
  final bool isBot;

  const _ChatBubble({required this.text, required this.isBot});
}

/// Password reset bot screen widget.
class PasswordResetBotScreen extends ConsumerStatefulWidget {
  const PasswordResetBotScreen({super.key});

  @override
  ConsumerState<PasswordResetBotScreen> createState() =>
      _PasswordResetBotScreenState();
}

class _PasswordResetBotScreenState
    extends ConsumerState<PasswordResetBotScreen> {
  _BotStep _step = _BotStep.idle;
  final List<_ChatBubble> _messages = [];
  final TextEditingController _inputCtrl = TextEditingController();
  final ScrollController _scrollCtrl = ScrollController();
  bool _isLoading = false;
  String? _lastSubmitError;
  Timer? _pollTimer;
  int _pollCount = 0;
  static const int _maxPollAttempts = 60; // 60 attempts × 5 seconds = 5 minutes

  @override
  void dispose() {
    _inputCtrl.dispose();
    _scrollCtrl.dispose();
    _pollTimer?.cancel();
    super.dispose();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  void _addMessage(String text, {required bool isBot}) {
    setState(() {
      _messages.add(_ChatBubble(text: text, isBot: isBot));
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollCtrl.hasClients) {
        _scrollCtrl.animateTo(
          _scrollCtrl.position.maxScrollExtent,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      }
    });
  }

  void _reset() {
    _pollTimer?.cancel();
    _pollTimer = null;
    setState(() {
      _step = _BotStep.idle;
      _messages.clear();
      _inputCtrl.clear();
      _isLoading = false;
      _lastSubmitError = null;
      _pollCount = 0;
    });
  }

  String? get _currentUser => ref.read(currentUserProvider);

  // ---------------------------------------------------------------------------
  // Flow handlers
  // ---------------------------------------------------------------------------

  void _onStartPressed() {
    setState(() => _step = _BotStep.confirmReset);
    _addMessage(
      'שלום! אני הבוט של מחלקת מחשוב.\n'
      'האם אתה בטוח שברצונך לאפס את סיסמת Windows שלך?',
      isBot: true,
    );
  }

  void _onConfirmYes() {
    setState(() => _step = _BotStep.enterBirthYear);
    _addMessage('כן', isBot: false);
    _addMessage('אנא הזן את שנת הלידה שלך (4 ספרות):', isBot: true);
  }

  void _onConfirmNo() {
    _addMessage('לא', isBot: false);
    _addMessage('בסדר, הפעולה בוטלה. ניתן להתחיל מחדש בכל עת.', isBot: true);
    setState(() => _step = _BotStep.idle);
  }

  Future<void> _onSubmitBirthYear() async {
    FocusScope.of(context).unfocus();
    final year = _inputCtrl.text.trim();
    if (year.isEmpty) {
      _addMessage('יש להזין שנת לידה לפני השליחה.', isBot: true);
      return;
    }
    final user = _currentUser;
    if (user == null) {
      _addMessage('פג תוקף ההתחברות. נא להתחבר מחדש ולנסות שוב.', isBot: true);
      return;
    }

    _addMessage(year, isBot: false);
    _inputCtrl.clear();
    setState(() => _isLoading = true);

    try {
      final api = ref.read(chatApiServiceProvider);
      final result = await api.verifyBirthYear(user, year);
      if (!mounted) return;

      if (result.verified) {
        setState(() {
          _step = _BotStep.enterPassword;
          _isLoading = false;
          _lastSubmitError = null;
        });
        _addMessage('מה תהיה הסיסמה החדשה שלך?', isBot: true);
        _addMessage(
          'הסיסמה חייבת לכלול:\n'
          '• לפחות 8 תווים\n'
          '• לפחות אות גדולה אחת (A-Z)\n'
          '• לפחות אות קטנה אחת (a-z)\n'
          '• לפחות ספרה אחת (0-9)\n'
          '• לפחות תו מיוחד אחד (!, @, #, \$, % וכד\')',
          isBot: true,
        );
      } else {
        setState(() => _isLoading = false);
        _addMessage(
          result.message.isNotEmpty ? result.message : 'שנת הלידה שגויה, נסה שנית.',
          isBot: true,
        );
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _isLoading = false);
      _addMessage('אירעה שגיאה, נסה שנית.', isBot: true);
    }
  }

  /// Returns a list of Hebrew error messages for every unmet password rule.
  /// An empty list means the password is valid.
  List<({String label, bool passed})> _passwordChecks(String password) {
    return [
      (label: 'לפחות 8 תווים', passed: password.length >= 8),
      (label: 'לפחות אות גדולה אחת (A-Z)', passed: password.contains(RegExp(r'[A-Z]'))),
      (label: 'לפחות אות קטנה אחת (a-z)', passed: password.contains(RegExp(r'[a-z]'))),
      (label: 'לפחות ספרה אחת (0-9)', passed: password.contains(RegExp(r'[0-9]'))),
      (label: 'לפחות תו מיוחד אחד (!, @, #, \$, % וכד\')', passed: password.contains(RegExp(r'[^A-Za-z0-9]'))),
    ];
  }

  List<String> _validatePassword(String password) {
    return _passwordChecks(password)
        .where((rule) => !rule.passed)
        .map((rule) => '• חסר: ${rule.label}')
        .toList();
  }

  Future<void> _onSubmitPassword() async {
    FocusScope.of(context).unfocus();
    final password = _inputCtrl.text.trim();
    if (password.isEmpty) {
      _addMessage('יש להזין סיסמה חדשה לפני השליחה.', isBot: true);
      return;
    }
    final user = _currentUser;
    if (user == null) {
      _addMessage('פג תוקף ההתחברות. נא להתחבר מחדש ולנסות שוב.', isBot: true);
      return;
    }

    // Validate password requirements before submitting
    final errors = _validatePassword(password);
    if (errors.isNotEmpty) {
      _addMessage(password, isBot: false);
      _inputCtrl.clear();
      setState(() => _lastSubmitError = 'הסיסמה אינה עומדת בדרישות.');
      _addMessage(
        'הסיסמה אינה עומדת בדרישות. יש לתקן את הבאים:\n${errors.join('\n')}',
        isBot: true,
      );
      return;
    }

    try {
      _addMessage(password, isBot: false);
      _inputCtrl.clear();
      setState(() {
        _step = _BotStep.polling;
        _isLoading = true;
        _lastSubmitError = null;
      });
      _addMessage('הבקשה בטיפול, אנא המתן...', isBot: true);

      final api = ref.read(chatApiServiceProvider);
      // Success is defined by the submit request completing without an API
      // error; some server responses intentionally omit a requestId, and the
      // follow-up status polling is keyed by the authenticated user.
      await api.submitPasswordReset(user, password);
      if (!mounted) return;
      setState(() => _isLoading = false);
      _startPolling(user);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _step = _BotStep.enterPassword;
        _isLoading = false;
        _lastSubmitError = e.message;
      });
      _addMessage(e.message, isBot: true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _step = _BotStep.enterPassword;
        _isLoading = false;
        _lastSubmitError = e.toString();
      });
      _addMessage('שגיאה בשליחת הבקשה: $e', isBot: true);
    }
  }

  void _startPolling(String user) {
    _pollCount = 0;
    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(const Duration(seconds: 5), (_) async {
      _pollCount++;
      if (_pollCount > _maxPollAttempts) {
        _pollTimer?.cancel();
        _pollTimer = null;
        if (!mounted) return;
        setState(() => _step = _BotStep.done);
        _addMessage(
          'לא התקבלה תגובה מהשרת בזמן הצפוי. אנא פנה למחלקת מחשוב.',
          isBot: true,
        );
        return;
      }
      try {
        final api = ref.read(chatApiServiceProvider);
        final response = await api.getPasswordResetStatus(user);
        if (!mounted) return;
        if (response != null && response.isNotEmpty) {
          _pollTimer?.cancel();
          _pollTimer = null;
          setState(() => _step = _BotStep.done);
          _addMessage(response, isBot: true);
        }
      } catch (_) {
        // Keep polling silently
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Build
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    return Directionality(
      textDirection: TextDirection.rtl,
      child: Column(
        children: [
          // Chat message list
          Expanded(
            child: _messages.isEmpty
                ? _buildEmptyState()
                : ListView.builder(
                    controller: _scrollCtrl,
                    padding: const EdgeInsets.symmetric(
                        horizontal: 12, vertical: 8),
                    itemCount: _messages.length,
                    itemBuilder: (context, index) =>
                        _buildBubble(_messages[index]),
                  ),
          ),

          // Bottom interaction area
          _buildBottomArea(),
        ],
      ),
    );
  }

  Widget _buildEmptyState() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 80,
              height: 80,
              decoration: BoxDecoration(
                color: AppColors.primary.withAlpha(20),
                shape: BoxShape.circle,
              ),
              child: const Icon(
                Icons.lock_reset_outlined,
                size: 40,
                color: AppColors.primary,
              ),
            ),
            const SizedBox(height: 20),
            const Text(
              'איפוס סיסמת Windows',
              style: TextStyle(
                fontSize: 20,
                fontWeight: FontWeight.bold,
                color: AppColors.textPrimary,
              ),
            ),
            const SizedBox(height: 10),
            const Text(
              'לחץ על הכפתור כדי להתחיל',
              style: TextStyle(
                fontSize: 14,
                color: AppColors.textSecondary,
              ),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildBubble(_ChatBubble bubble) {
    final isBot = bubble.isBot;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Align(
        alignment: isBot ? AlignmentDirectional.centerStart : AlignmentDirectional.centerEnd,
        child: Container(
          constraints: BoxConstraints(
            maxWidth: MediaQuery.sizeOf(context).width * 0.75,
          ),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            color: isBot ? Colors.white : AppColors.primary,
            borderRadius: BorderRadiusDirectional.only(
              topStart: const Radius.circular(16),
              topEnd: const Radius.circular(16),
              bottomEnd: isBot ? const Radius.circular(16) : Radius.zero,
              bottomStart: isBot ? Radius.zero : const Radius.circular(16),
            ),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withAlpha(20),
                blurRadius: 4,
                offset: const Offset(0, 2),
              ),
            ],
          ),
          child: Text(
            bubble.text,
            style: TextStyle(
              fontSize: 15,
              color: isBot ? AppColors.textPrimary : Colors.white,
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildBottomArea() {
    return Container(
      color: Colors.white,
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Divider(height: 1),
            if (_step == _BotStep.idle) _buildStartButton(),
            if (_step == _BotStep.confirmReset) _buildConfirmButtons(),
            if (_step == _BotStep.enterBirthYear) _buildTextInput(
              hint: 'שנת לידה (לדוגמה: 1985)',
              keyboardType: TextInputType.number,
              onSubmit: _onSubmitBirthYear,
            ),
            if (_step == _BotStep.enterPassword) _buildTextInput(
              hint: 'הזן סיסמה חדשה',
              textDirection: TextDirection.ltr,
              textAlign: TextAlign.left,
              onSubmit: _onSubmitPassword,
              onChanged: (_) => setState(() => _lastSubmitError = null),
            ),
            if (_step == _BotStep.enterPassword) _buildPasswordRequirements(),
            if (_step == _BotStep.polling) _buildPollingIndicator(),
            if (_step == _BotStep.done) _buildRestartButton(),
          ],
        ),
      ),
    );
  }

  Widget _buildStartButton() {
    return Padding(
      padding: const EdgeInsets.all(16),
      child: SizedBox(
        width: double.infinity,
        child: ElevatedButton.icon(
          onPressed: _onStartPressed,
          icon: const Icon(Icons.lock_reset_outlined),
          label: const Text('התחל איפוס סיסמת Windows'),
          style: ElevatedButton.styleFrom(
            padding: const EdgeInsets.symmetric(vertical: 14),
            textStyle: const TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.bold,
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildConfirmButtons() {
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Row(
        children: [
          Expanded(
            child: OutlinedButton(
              onPressed: _onConfirmNo,
              style: OutlinedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 14),
                foregroundColor: AppColors.textSecondary,
              ),
              child: const Text('לא'),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: ElevatedButton(
              onPressed: _onConfirmYes,
              style: ElevatedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
              child: const Text('כן'),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildTextInput({
    required String hint,
    bool obscureText = false,
    TextInputType keyboardType = TextInputType.text,
    TextDirection? textDirection,
    TextAlign textAlign = TextAlign.start,
    required VoidCallback onSubmit,
    ValueChanged<String>? onChanged,
  }) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: _inputCtrl,
              obscureText: obscureText,
              keyboardType: keyboardType,
              textDirection: textDirection,
              textAlign: textAlign,
              textInputAction: TextInputAction.send,
              enabled: !_isLoading,
              onSubmitted: (_) => onSubmit(),
              onChanged: onChanged,
              decoration: InputDecoration(
                hintText: hint,
                contentPadding: const EdgeInsets.symmetric(
                    horizontal: 16, vertical: 12),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(24),
                ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          _isLoading
              ? const Padding(
                  padding: EdgeInsets.all(12),
                  child: SizedBox(
                    width: 24,
                    height: 24,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                )
              : IconButton(
                  onPressed: onSubmit,
                  tooltip: _buildSendTooltipMessage(),
                  icon: const Icon(Icons.send),
                  color: AppColors.primary,
                ),
        ],
      ),
    );
  }

  Widget _buildPasswordRequirements() {
    final checks = _passwordChecks(_inputCtrl.text);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final check in checks)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Row(
                children: [
                  Icon(
                    check.passed ? Icons.check_circle : Icons.cancel,
                    size: 16,
                    color: check.passed ? Colors.green : Colors.red,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      check.label,
                      style: TextStyle(
                        fontSize: 12,
                        color: check.passed ? Colors.green : AppColors.textSecondary,
                      ),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  String _buildSendTooltipMessage() {
    if (_lastSubmitError != null && _lastSubmitError!.trim().isNotEmpty) {
      return _lastSubmitError!;
    }
    if (_step == _BotStep.enterPassword) {
      final missing = _validatePassword(_inputCtrl.text.trim());
      if (missing.isNotEmpty) {
        return 'לפני השליחה יש להשלים:\n${missing.join('\n')}';
      }
    }
    return 'שליחה';
  }

  Widget _buildPollingIndicator() {
    return const Padding(
      padding: EdgeInsets.all(16),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          SizedBox(width: 12),
          Text(
            'ממתין לתגובה מהשרת...',
            style: TextStyle(
              color: AppColors.textSecondary,
              fontSize: 14,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildRestartButton() {
    return Padding(
      padding: const EdgeInsets.all(16),
      child: SizedBox(
        width: double.infinity,
        child: OutlinedButton.icon(
          onPressed: _reset,
          icon: const Icon(Icons.refresh),
          label: const Text('התחל מחדש'),
          style: OutlinedButton.styleFrom(
            padding: const EdgeInsets.symmetric(vertical: 14),
          ),
        ),
      ),
    );
  }
}
