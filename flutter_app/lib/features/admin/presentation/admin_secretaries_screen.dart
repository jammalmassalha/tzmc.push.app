/// Admin Department Secretaries Management Screen.
///
/// Accessible only to super-admin user.
/// Allows listing, creating, editing, and deleting department secretaries.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/chat_api_service.dart';
import '../../../core/utils/toast_utils.dart';
import '../../../shared/theme/app_theme.dart';
import '../../auth/presentation/auth_state.dart';

/// Model for a department secretary as returned by the admin API.
class AdminSecretary {
  final int id;
  final String departName;
  final String phoneNumber;
  final int status; // 1 for active, 0 for inactive

  const AdminSecretary({
    required this.id,
    required this.departName,
    required this.phoneNumber,
    required this.status,
  });

  bool get isActive => status == 1;

  factory AdminSecretary.fromMap(Map<String, dynamic> map) {
    final rawId = map['ID'];
    final id = rawId is int ? rawId : int.tryParse(rawId?.toString() ?? '0') ?? 0;

    final rawStatus = map['Status'];
    final status = rawStatus is int ? rawStatus : int.tryParse(rawStatus?.toString() ?? '1') ?? 1;

    return AdminSecretary(
      id: id,
      departName: map['DepartName']?.toString() ?? '',
      phoneNumber: map['PhoneNumber']?.toString() ?? '',
      status: status,
    );
  }

  AdminSecretary copyWith({
    int? id,
    String? departName,
    String? phoneNumber,
    int? status,
  }) {
    return AdminSecretary(
      id: id ?? this.id,
      departName: departName ?? this.departName,
      phoneNumber: phoneNumber ?? this.phoneNumber,
      status: status ?? this.status,
    );
  }
}

/// Admin Secretaries Screen widget
class AdminSecretariesScreen extends ConsumerStatefulWidget {
  const AdminSecretariesScreen({super.key});

  @override
  ConsumerState<AdminSecretariesScreen> createState() => _AdminSecretariesScreenState();
}

class _AdminSecretariesScreenState extends ConsumerState<AdminSecretariesScreen> {
  List<AdminSecretary> _secretaries = [];
  bool _isLoading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadSecretaries());
  }

  String get _user => ref.read(currentUserProvider) ?? '';

  Future<void> _loadSecretaries() async {
    if (!mounted) return;
    setState(() {
      _isLoading = true;
      _error = null;
    });
    try {
      final api = ref.read(chatApiServiceProvider);
      final raw = await api.adminListSecretaries(_user);
      if (!mounted) return;
      setState(() {
        _secretaries = raw.map(AdminSecretary.fromMap).toList();
        _isLoading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString().replaceFirst('ApiException: ', '');
        _isLoading = false;
      });
    }
  }

  Future<void> _toggleActive(AdminSecretary secretary) async {
    final api = ref.read(chatApiServiceProvider);
    try {
      final newStatus = secretary.isActive ? 0 : 1;
      await api.adminUpdateSecretary(
        user: _user,
        id: secretary.id,
        departName: secretary.departName,
        phoneNumber: secretary.phoneNumber,
        status: newStatus,
      );
      if (!mounted) return;
      showTopToast(context, secretary.isActive ? 'המזכירות הושבתה' : 'המזכירות הופעלה');
      await _loadSecretaries();
    } catch (e) {
      if (!mounted) return;
      showTopToast(context, e.toString().replaceFirst('ApiException: ', ''));
    }
  }

  Future<void> _deleteSecretary(AdminSecretary secretary) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => Directionality(
        textDirection: TextDirection.rtl,
        child: AlertDialog(
          title: const Text('מחיקת מזכירות'),
          content: Text('האם למחוק את המזכירות "${secretary.departName}"?\nפעולה זו אינה הפיכה.'),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('ביטול'),
            ),
            TextButton(
              style: TextButton.styleFrom(foregroundColor: Colors.red),
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('מחק'),
            ),
          ],
        ),
      ),
    );
    if (confirmed != true || !mounted) return;

    final api = ref.read(chatApiServiceProvider);
    try {
      await api.adminDeleteSecretary(_user, secretary.id);
      if (!mounted) return;
      showTopToast(context, 'המזכירות נמחקה בהצלחה');
      await _loadSecretaries();
    } catch (e) {
      if (!mounted) return;
      showTopToast(context, e.toString().replaceFirst('ApiException: ', ''));
    }
  }

  Future<void> _openEditDialog({AdminSecretary? existing}) async {
    final result = await showDialog<AdminSecretary>(
      context: context,
      builder: (ctx) => _SecretaryEditDialog(secretary: existing),
    );
    if (result == null || !mounted) return;

    final api = ref.read(chatApiServiceProvider);
    try {
      if (existing == null) {
        await api.adminCreateSecretary(
          user: _user,
          departName: result.departName,
          phoneNumber: result.phoneNumber,
          status: result.status,
        );
        if (!mounted) return;
        showTopToast(context, 'המזכירות נוצרה בהצלחה');
      } else {
        await api.adminUpdateSecretary(
          user: _user,
          id: existing.id,
          departName: result.departName,
          phoneNumber: result.phoneNumber,
          status: result.status,
        );
        if (!mounted) return;
        showTopToast(context, 'המזכירות עודכנה בהצלחה');
      }
      await _loadSecretaries();
    } catch (e) {
      if (!mounted) return;
      showTopToast(context, e.toString().replaceFirst('ApiException: ', ''));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('ניהול מזכירויות מחלקתיות'),
        actions: [
          IconButton(
            tooltip: 'רענן',
            icon: const Icon(Icons.refresh),
            onPressed: _isLoading ? null : _loadSecretaries,
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _openEditDialog,
        icon: const Icon(Icons.add),
        label: const Text('מזכירות חדשה'),
        backgroundColor: AppColors.primary,
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_isLoading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 48, color: Colors.red),
            const SizedBox(height: 12),
            Text(_error!, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            ElevatedButton(onPressed: _loadSecretaries, child: const Text('נסה שוב')),
          ],
        ),
      );
    }
    if (_secretaries.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.contact_phone_outlined, size: 56, color: Colors.grey),
            const SizedBox(height: 12),
            const Text('אין מזכירויות להצגה', style: TextStyle(color: Colors.grey)),
            const SizedBox(height: 12),
            ElevatedButton.icon(
              onPressed: _openEditDialog,
              icon: const Icon(Icons.add),
              label: const Text('הוסף מזכירות'),
            ),
          ],
        ),
      );
    }
    return Directionality(
      textDirection: TextDirection.rtl,
      child: ListView.separated(
        padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 12),
        itemCount: _secretaries.length,
        separatorBuilder: (_, __) => const SizedBox(height: 4),
        itemBuilder: (ctx, i) => _SecretaryTile(
          secretary: _secretaries[i],
          onEdit: () => _openEditDialog(existing: _secretaries[i]),
          onToggleActive: () => _toggleActive(_secretaries[i]),
          onDelete: () => _deleteSecretary(_secretaries[i]),
        ),
      ),
    );
  }
}

class _SecretaryTile extends StatelessWidget {
  final AdminSecretary secretary;
  final VoidCallback onEdit;
  final VoidCallback onToggleActive;
  final VoidCallback onDelete;

  const _SecretaryTile({
    required this.secretary,
    required this.onEdit,
    required this.onToggleActive,
    required this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    final isActive = secretary.isActive;
    return Card(
      elevation: 1,
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        leading: CircleAvatar(
          backgroundColor: isActive ? AppColors.primary : Colors.grey.shade400,
          child: Text(
            secretary.departName.isNotEmpty ? secretary.departName[0] : '?',
            style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold),
          ),
        ),
        title: Text(
          secretary.departName,
          style: TextStyle(
            fontWeight: FontWeight.bold,
            color: isActive ? null : Colors.grey,
            decoration: isActive ? null : TextDecoration.lineThrough,
          ),
        ),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'טלפון: ${secretary.phoneNumber}',
              style: const TextStyle(fontSize: 12),
            ),
            Container(
              margin: const EdgeInsets.only(top: 4),
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: BoxDecoration(
                color: isActive ? Colors.green.shade50 : Colors.red.shade50,
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: isActive ? Colors.green : Colors.red, width: 0.6),
              ),
              child: Text(
                isActive ? 'פעיל' : 'מושבת',
                style: TextStyle(
                  fontSize: 11,
                  color: isActive ? Colors.green.shade700 : Colors.red.shade700,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
        trailing: PopupMenuButton<_SecretaryAction>(
          onSelected: (action) {
            switch (action) {
              case _SecretaryAction.edit:
                onEdit();
              case _SecretaryAction.toggle:
                onToggleActive();
              case _SecretaryAction.delete:
                onDelete();
            }
          },
          itemBuilder: (_) => [
            const PopupMenuItem(
              value: _SecretaryAction.edit,
              child: ListTile(
                leading: Icon(Icons.edit_outlined),
                title: Text('ערוך'),
              ),
            ),
            PopupMenuItem(
              value: _SecretaryAction.toggle,
              child: ListTile(
                leading: Icon(isActive ? Icons.block_outlined : Icons.check_circle_outline),
                title: Text(isActive ? 'השבת' : 'הפעל'),
              ),
            ),
            const PopupMenuItem(
              value: _SecretaryAction.delete,
              child: ListTile(
                leading: Icon(Icons.delete_outline, color: Colors.red),
                title: Text('מחק', style: TextStyle(color: Colors.red)),
              ),
            ),
          ],
        ),
        onTap: onEdit,
      ),
    );
  }
}

enum _SecretaryAction { edit, toggle, delete }

/// Dialog for creating or editing a department secretary.
class _SecretaryEditDialog extends StatefulWidget {
  final AdminSecretary? secretary;

  const _SecretaryEditDialog({this.secretary});

  @override
  State<_SecretaryEditDialog> createState() => _SecretaryEditDialogState();
}

class _SecretaryEditDialogState extends State<_SecretaryEditDialog> {
  late final TextEditingController _departNameCtrl;
  late final TextEditingController _phoneNumberCtrl;
  late bool _isActive;

  bool get _isEdit => widget.secretary != null;

  @override
  void initState() {
    super.initState();
    final s = widget.secretary;
    _departNameCtrl = TextEditingController(text: s?.departName ?? '');
    _phoneNumberCtrl = TextEditingController(text: s?.phoneNumber ?? '');
    _isActive = s?.isActive ?? true;
  }

  @override
  void dispose() {
    _departNameCtrl.dispose();
    _phoneNumberCtrl.dispose();
    super.dispose();
  }

  void _submit() {
    final dname = _departNameCtrl.text.trim();
    final phone = _phoneNumberCtrl.text.trim();
    if (dname.isEmpty || phone.isEmpty) return;

    Navigator.of(context).pop(
      AdminSecretary(
        id: widget.secretary?.id ?? 0,
        departName: dname,
        phoneNumber: phone,
        status: _isActive ? 1 : 0,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Directionality(
      textDirection: TextDirection.rtl,
      child: AlertDialog(
        title: Text(_isEdit ? 'עריכת מזכירות' : 'מזכירות חדשה'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextField(
                controller: _departNameCtrl,
                decoration: const InputDecoration(
                  labelText: 'שם המחלקה',
                  hintText: 'לדוגמה: מחלקת ילדים',
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _phoneNumberCtrl,
                decoration: const InputDecoration(
                  labelText: 'מספר טלפון',
                  hintText: 'לדוגמה: 0546799693',
                ),
                keyboardType: TextInputType.phone,
              ),
              if (_isEdit) ...[
                const SizedBox(height: 12),
                SwitchListTile(
                  title: const Text('מזכירות פעילה'),
                  value: _isActive,
                  onChanged: (v) => setState(() => _isActive = v),
                  contentPadding: EdgeInsets.zero,
                ),
              ],
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('ביטול'),
          ),
          ElevatedButton(
            onPressed: () {
              if (_departNameCtrl.text.trim().isEmpty || _phoneNumberCtrl.text.trim().isEmpty) {
                return;
              }
              _submit();
            },
            child: Text(_isEdit ? 'שמור' : 'צור'),
          ),
        ],
      ),
    );
  }
}
