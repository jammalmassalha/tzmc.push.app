/// Secretary Bot Screen
///
/// A Hebrew-language chat-bot UI that guides restricted users through a
/// 4-step identification flow before they can chat with the department
/// secretary: ID → Name → Gender (radio) → Date of Birth (date picker).
///
/// When the user opens the screen for the first time the bot sends an
/// automatic greeting and immediately presents step 1.  After every valid
/// answer the next step is shown.  A "Restart" button allows the user to
/// discard progress and begin again.  On completion the data is submitted to
/// the server via the `/api/secretary-bot/submit` endpoint.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart' hide TextDirection;

import '../../../core/api/chat_api_service.dart';
import '../../../features/auth/presentation/auth_state.dart';
import '../../../shared/theme/app_theme.dart';

// ---------------------------------------------------------------------------
// Bot step enumeration
// ---------------------------------------------------------------------------

enum _BotStep {
  loading,   // Initial load: fetching server-side session state
  greeting,  // Greeting shown; waiting to show step 1
  enterId,
  enterName,
  enterGender,
  enterDob,
  submitting,
  done,
  error,
}

// ---------------------------------------------------------------------------
// Chat bubble model
// ---------------------------------------------------------------------------

class _ChatBubble {
  final String text;
  final bool isBot;

  const _ChatBubble({required this.text, required this.isBot});
}

// ---------------------------------------------------------------------------
// Screen widget
// ---------------------------------------------------------------------------

class SecretaryBotScreen extends ConsumerStatefulWidget {
  const SecretaryBotScreen({super.key});

  @override
  ConsumerState<SecretaryBotScreen> createState() => _SecretaryBotScreenState();
}

class _SecretaryBotScreenState extends ConsumerState<SecretaryBotScreen> {
  _BotStep _step = _BotStep.loading;
  final List<_ChatBubble> _messages = [];
  final TextEditingController _inputCtrl = TextEditingController();
  final ScrollController _scrollCtrl = ScrollController();
  bool _isLoading = false;

  // Collected answers
  String? _answerId;
  String? _answerName;
  String? _answerGender;
  DateTime? _answerDob;

  // Gender options (Hebrew)
  static const String _genderMale = 'זכר';
  static const String _genderFemale = 'נקבה';

  static const String _kDatePattern = 'dd.MM.yyyy';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _initBot());
  }

  @override
  void dispose() {
    _inputCtrl.dispose();
    _scrollCtrl.dispose();
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

  String? get _currentUser => ref.read(currentUserProvider);

  // ---------------------------------------------------------------------------
  // Init: load server-side session state (resume if partially completed)
  // ---------------------------------------------------------------------------

  Future<void> _initBot() async {
    final user = _currentUser;
    if (user == null) {
      _startGreeting();
      return;
    }
    try {
      final api = ref.read(chatApiServiceProvider);
      final session = await api.getSecretaryBotStatus(user);
      if (!mounted) return;
      final step = (session['step'] as String? ?? '').trim();
      if (step == 'completed') {
        // Already completed — show done state
        _addMessage('שלום! הפרטים שלך כבר נשמרו. תוכל לשוחח עם המזכירות בחופשיות.', isBot: true);
        setState(() => _step = _BotStep.done);
      } else {
        _startGreeting();
      }
    } catch (_) {
      if (!mounted) return;
      _startGreeting();
    }
  }

  void _startGreeting() {
    _addMessage(
      'שלום! לפני שנתחיל בשיחה עם המזכירות, נשמח אם תענה על מספר שאלות קצרות לזיהוי.',
      isBot: true,
    );
    Future.delayed(const Duration(milliseconds: 600), () {
      if (!mounted) return;
      _addMessage('אנא הזן תעודת זהות:', isBot: true);
      setState(() => _step = _BotStep.enterId);
    });
  }

  // ---------------------------------------------------------------------------
  // Step handlers
  // ---------------------------------------------------------------------------

  void _onSubmitId() {
    final value = _inputCtrl.text.trim();
    if (value.isEmpty) return;
    _addMessage(value, isBot: false);
    _inputCtrl.clear();
    _answerId = value;
    _addMessage('תודה. אנא הזן שם מלא:', isBot: true);
    setState(() => _step = _BotStep.enterName);
  }

  void _onSubmitName() {
    final value = _inputCtrl.text.trim();
    if (value.isEmpty) return;
    _addMessage(value, isBot: false);
    _inputCtrl.clear();
    _answerName = value;
    _addMessage('תודה. אנא בחר מגדר:', isBot: true);
    setState(() => _step = _BotStep.enterGender);
  }

  void _onSelectGender(String gender) {
    _answerGender = gender;
    _addMessage(gender, isBot: false);
    _addMessage('תודה. אנא בחר תאריך לידה:', isBot: true);
    setState(() => _step = _BotStep.enterDob);
  }

  Future<void> _onPickDob() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: DateTime(now.year - 30, now.month, now.day),
      firstDate: DateTime(1900),
      lastDate: DateTime.now(),
      locale: const Locale('he'),
      helpText: 'בחר תאריך לידה',
      cancelText: 'ביטול',
      confirmText: 'אישור',
    );
    if (picked == null || !mounted) return;
    _answerDob = picked;
    final formatted = DateFormat(_kDatePattern).format(picked);
    _addMessage(formatted, isBot: false);
    await _submitAll(formatted);
  }

  Future<void> _submitAll(String dobFormatted) async {
    final user = _currentUser;
    if (user == null) {
      _addMessage('פג תוקף ההתחברות. נא להתחבר מחדש ולנסות שוב.', isBot: true);
      return;
    }
    setState(() {
      _step = _BotStep.submitting;
      _isLoading = true;
    });
    _addMessage('שולח את הפרטים...', isBot: true);
    try {
      final api = ref.read(chatApiServiceProvider);
      await api.submitSecretaryBot(
        user: user,
        id: _answerId!,
        name: _answerName!,
        gender: _answerGender!,
        dob: dobFormatted,
      );
      if (!mounted) return;
      setState(() {
        _step = _BotStep.done;
        _isLoading = false;
      });
      _addMessage(
        'תודה רבה! הפרטים שלך הועברו למזכירות המחלקה. כעת תוכל לשוחח איתנו בחופשיות.',
        isBot: true,
      );
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _step = _BotStep.error;
        _isLoading = false;
      });
      _addMessage('שגיאה בשליחת הפרטים. נסה שנית.', isBot: true);
    }
  }

  Future<void> _onRestart() async {
    final user = _currentUser;
    if (user != null) {
      try {
        final api = ref.read(chatApiServiceProvider);
        await api.resetSecretaryBot(user);
      } catch (_) {
        // Best-effort: proceed with UI reset regardless
      }
    }
    setState(() {
      _step = _BotStep.loading;
      _messages.clear();
      _inputCtrl.clear();
      _answerId = null;
      _answerName = null;
      _answerGender = null;
      _answerDob = null;
      _isLoading = false;
    });
    _startGreeting();
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
          Expanded(
            child: _step == _BotStep.loading
                ? const Center(child: CircularProgressIndicator())
                : ListView.builder(
                    controller: _scrollCtrl,
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    itemCount: _messages.length,
                    itemBuilder: (context, i) => _buildBubble(_messages[i]),
                  ),
          ),
          _buildBottomArea(),
        ],
      ),
    );
  }

  Widget _buildBubble(_ChatBubble bubble) {
    final isBot = bubble.isBot;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Align(
        alignment: isBot
            ? AlignmentDirectional.centerStart
            : AlignmentDirectional.centerEnd,
        child: Container(
          constraints: BoxConstraints(
            maxWidth: MediaQuery.sizeOf(context).width * 0.78,
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
            if (_step == _BotStep.enterId)
              _buildTextInput(
                hint: 'תעודת זהות',
                keyboardType: TextInputType.number,
                onSubmit: _onSubmitId,
              ),
            if (_step == _BotStep.enterName)
              _buildTextInput(
                hint: 'שם מלא',
                onSubmit: _onSubmitName,
              ),
            if (_step == _BotStep.enterGender) _buildGenderSelector(),
            if (_step == _BotStep.enterDob) _buildDobPicker(),
            if (_step == _BotStep.submitting) _buildSubmittingIndicator(),
            if (_step == _BotStep.done || _step == _BotStep.error)
              _buildRestartButton(),
          ],
        ),
      ),
    );
  }

  Widget _buildTextInput({
    required String hint,
    TextInputType keyboardType = TextInputType.text,
    required VoidCallback onSubmit,
  }) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: _inputCtrl,
              keyboardType: keyboardType,
              textInputAction: TextInputAction.send,
              enabled: !_isLoading,
              onSubmitted: (_) => onSubmit(),
              decoration: InputDecoration(
                hintText: hint,
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 12,
                ),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(24),
                ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          IconButton(
            onPressed: onSubmit,
            tooltip: 'שלח',
            icon: const Icon(Icons.send),
            color: AppColors.primary,
          ),
          _buildRestartIconButton(),
        ],
      ),
    );
  }

  Widget _buildGenderSelector() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Row(
        children: [
          Expanded(
            child: _GenderOptionButton(
              label: _genderMale,
              icon: Icons.male,
              onTap: () => _onSelectGender(_genderMale),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: _GenderOptionButton(
              label: _genderFemale,
              icon: Icons.female,
              onTap: () => _onSelectGender(_genderFemale),
            ),
          ),
          const SizedBox(width: 8),
          _buildRestartIconButton(),
        ],
      ),
    );
  }

  Widget _buildDobPicker() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Row(
        children: [
          Expanded(
            child: OutlinedButton.icon(
              onPressed: _isLoading ? null : _onPickDob,
              icon: const Icon(Icons.calendar_today_outlined),
              label: Text(
                _answerDob != null
                    ? DateFormat(_kDatePattern).format(_answerDob!)
                    : 'בחר תאריך לידה',
              ),
              style: OutlinedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
            ),
          ),
          const SizedBox(width: 8),
          _buildRestartIconButton(),
        ],
      ),
    );
  }

  Widget _buildSubmittingIndicator() {
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
          Text('שולח פרטים...', style: TextStyle(fontSize: 14)),
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
          onPressed: _onRestart,
          icon: const Icon(Icons.refresh),
          label: const Text('התחל מחדש'),
          style: OutlinedButton.styleFrom(
            padding: const EdgeInsets.symmetric(vertical: 14),
            foregroundColor: AppColors.textSecondary,
          ),
        ),
      ),
    );
  }

  Widget _buildRestartIconButton() {
    return IconButton(
      icon: const Icon(Icons.refresh),
      tooltip: 'התחל מחדש',
      onPressed: _isLoading ? null : _onRestart,
      color: AppColors.textSecondary,
    );
  }
}

// ---------------------------------------------------------------------------
// Gender option button widget
// ---------------------------------------------------------------------------

class _GenderOptionButton extends StatelessWidget {
  final String label;
  final IconData icon;
  final VoidCallback onTap;

  const _GenderOptionButton({
    required this.label,
    required this.icon,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 14),
        decoration: BoxDecoration(
          border: Border.all(color: AppColors.primary.withAlpha(180)),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, color: AppColors.primary, size: 28),
            const SizedBox(height: 6),
            Text(
              label,
              style: const TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w600,
                color: AppColors.primary,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
