/// Admin Community Group Management Screen.
///
/// Accessible only to super-admin user (0546799693).
/// Allows creating, editing, enabling/disabling and deleting community groups
/// such as אקרדיטציה and דוברות.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/chat_api_service.dart';
import '../../../core/utils/toast_utils.dart';
import '../../../shared/theme/app_theme.dart';
import '../../auth/presentation/auth_state.dart';

/// Model for a community group as returned by the admin API.
class AdminCommunityGroup {
  final String groupId;
  final String groupName;
  final List<String> members;
  final List<String> writers;
  final bool isEnabled;

  const AdminCommunityGroup({
    required this.groupId,
    required this.groupName,
    required this.members,
    required this.writers,
    required this.isEnabled,
  });

  factory AdminCommunityGroup.fromMap(Map<String, dynamic> map) {
    List<String> _toStringList(dynamic v) {
      if (v is List) return v.map((e) => e.toString()).toList();
      if (v is String && v.isNotEmpty) return v.split(',').map((e) => e.trim()).where((e) => e.isNotEmpty).toList();
      return [];
    }

    return AdminCommunityGroup(
      groupId: map['groupId']?.toString() ?? '',
      groupName: map['groupName']?.toString() ?? '',
      members: _toStringList(map['members']),
      writers: _toStringList(map['writers']),
      isEnabled: map['isEnabled'] != false && map['isEnabled'] != 0 &&
          map['isEnabled'] != 'false' && map['isEnabled'] != '0',
    );
  }

  AdminCommunityGroup copyWith({
    String? groupId,
    String? groupName,
    List<String>? members,
    List<String>? writers,
    bool? isEnabled,
  }) {
    return AdminCommunityGroup(
      groupId: groupId ?? this.groupId,
      groupName: groupName ?? this.groupName,
      members: members ?? this.members,
      writers: writers ?? this.writers,
      isEnabled: isEnabled ?? this.isEnabled,
    );
  }
}

/// Admin Groups Screen widget
class AdminGroupsScreen extends ConsumerStatefulWidget {
  const AdminGroupsScreen({super.key});

  @override
  ConsumerState<AdminGroupsScreen> createState() => _AdminGroupsScreenState();
}

class _AdminGroupsScreenState extends ConsumerState<AdminGroupsScreen> {
  List<AdminCommunityGroup> _groups = [];
  bool _isLoading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadGroups());
  }

  String get _user => ref.read(currentUserProvider) ?? '';

  Future<void> _loadGroups() async {
    if (!mounted) return;
    setState(() {
      _isLoading = true;
      _error = null;
    });
    try {
      final api = ref.read(chatApiServiceProvider);
      final raw = await api.adminListCommunityGroups(_user);
      if (!mounted) return;
      setState(() {
        _groups = raw.map(AdminCommunityGroup.fromMap).toList();
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

  Future<void> _toggleEnabled(AdminCommunityGroup group) async {
    final api = ref.read(chatApiServiceProvider);
    try {
      if (group.isEnabled) {
        await api.adminDisableCommunityGroup(_user, group.groupId);
      } else {
        await api.adminEnableCommunityGroup(_user, group.groupId);
      }
      if (!mounted) return;
      showTopToast(context, group.isEnabled ? 'הקבוצה הושבתה' : 'הקבוצה הופעלה');
      await _loadGroups();
    } catch (e) {
      if (!mounted) return;
      showTopToast(context, e.toString().replaceFirst('ApiException: ', ''));
    }
  }

  Future<void> _deleteGroup(AdminCommunityGroup group) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => Directionality(
        textDirection: TextDirection.rtl,
        child: AlertDialog(
          title: const Text('מחיקת קבוצה'),
          content: Text('האם למחוק את הקבוצה "${group.groupName}"?\nפעולה זו אינה הפיכה.'),
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
      await api.adminDeleteCommunityGroup(_user, group.groupId);
      if (!mounted) return;
      showTopToast(context, 'הקבוצה נמחקה');
      await _loadGroups();
    } catch (e) {
      if (!mounted) return;
      showTopToast(context, e.toString().replaceFirst('ApiException: ', ''));
    }
  }

  Future<void> _openEditDialog({AdminCommunityGroup? existing}) async {
    final result = await showDialog<AdminCommunityGroup>(
      context: context,
      builder: (ctx) => _GroupEditDialog(group: existing),
    );
    if (result == null || !mounted) return;

    final api = ref.read(chatApiServiceProvider);
    try {
      if (existing == null) {
        await api.adminCreateCommunityGroup(
          user: _user,
          groupId: result.groupId,
          groupName: result.groupName,
          members: result.members,
          writers: result.writers,
        );
        if (!mounted) return;
        showTopToast(context, 'הקבוצה נוצרה');
      } else {
        await api.adminUpdateCommunityGroup(
          user: _user,
          groupId: result.groupId,
          groupName: result.groupName,
          members: result.members,
          writers: result.writers,
          isEnabled: result.isEnabled,
        );
        if (!mounted) return;
        showTopToast(context, 'הקבוצה עודכנה');
      }
      await _loadGroups();
    } catch (e) {
      if (!mounted) return;
      showTopToast(context, e.toString().replaceFirst('ApiException: ', ''));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('ניהול קבוצות קהילה'),
        actions: [
          IconButton(
            tooltip: 'רענן',
            icon: const Icon(Icons.refresh),
            onPressed: _isLoading ? null : _loadGroups,
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _openEditDialog(),
        icon: const Icon(Icons.add),
        label: const Text('קבוצה חדשה'),
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
            ElevatedButton(onPressed: _loadGroups, child: const Text('נסה שוב')),
          ],
        ),
      );
    }
    if (_groups.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.group_outlined, size: 56, color: Colors.grey),
            const SizedBox(height: 12),
            const Text('אין קבוצות קהילה', style: TextStyle(color: Colors.grey)),
            const SizedBox(height: 12),
            ElevatedButton.icon(
              onPressed: () => _openEditDialog(),
              icon: const Icon(Icons.add),
              label: const Text('צור קבוצה'),
            ),
          ],
        ),
      );
    }
    return Directionality(
      textDirection: TextDirection.rtl,
      child: ListView.separated(
        padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 12),
        itemCount: _groups.length,
        separatorBuilder: (_, __) => const SizedBox(height: 4),
        itemBuilder: (ctx, i) => _GroupTile(
          group: _groups[i],
          onEdit: () => _openEditDialog(existing: _groups[i]),
          onToggleEnabled: () => _toggleEnabled(_groups[i]),
          onDelete: () => _deleteGroup(_groups[i]),
        ),
      ),
    );
  }
}

class _GroupTile extends StatelessWidget {
  final AdminCommunityGroup group;
  final VoidCallback onEdit;
  final VoidCallback onToggleEnabled;
  final VoidCallback onDelete;

  const _GroupTile({
    required this.group,
    required this.onEdit,
    required this.onToggleEnabled,
    required this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    final isEnabled = group.isEnabled;
    return Card(
      elevation: 1,
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        leading: CircleAvatar(
          backgroundColor: isEnabled ? AppColors.primary : Colors.grey.shade400,
          child: Text(
            group.groupName.isNotEmpty ? group.groupName[0] : '?',
            style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold),
          ),
        ),
        title: Text(
          group.groupName,
          style: TextStyle(
            fontWeight: FontWeight.bold,
            color: isEnabled ? null : Colors.grey,
            decoration: isEnabled ? null : TextDecoration.lineThrough,
          ),
        ),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (group.members.isNotEmpty)
              Text(
                'חברים: ${group.members.join(', ')}',
                style: const TextStyle(fontSize: 12),
                overflow: TextOverflow.ellipsis,
                maxLines: 1,
              ),
            if (group.writers.isNotEmpty)
              Text(
                'כותבים: ${group.writers.join(', ')}',
                style: const TextStyle(fontSize: 12),
                overflow: TextOverflow.ellipsis,
                maxLines: 1,
              ),
            Container(
              margin: const EdgeInsets.only(top: 4),
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: BoxDecoration(
                color: isEnabled ? Colors.green.shade50 : Colors.red.shade50,
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: isEnabled ? Colors.green : Colors.red, width: 0.6),
              ),
              child: Text(
                isEnabled ? 'פעיל' : 'מושבת',
                style: TextStyle(
                  fontSize: 11,
                  color: isEnabled ? Colors.green.shade700 : Colors.red.shade700,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
        trailing: PopupMenuButton<_GroupAction>(
          onSelected: (action) {
            switch (action) {
              case _GroupAction.edit:
                onEdit();
              case _GroupAction.toggle:
                onToggleEnabled();
              case _GroupAction.delete:
                onDelete();
            }
          },
          itemBuilder: (_) => [
            const PopupMenuItem(value: _GroupAction.edit, child: ListTile(leading: Icon(Icons.edit_outlined), title: Text('ערוך'))),
            PopupMenuItem(
              value: _GroupAction.toggle,
              child: ListTile(
                leading: Icon(isEnabled ? Icons.block_outlined : Icons.check_circle_outline),
                title: Text(isEnabled ? 'השבת' : 'הפעל'),
              ),
            ),
            const PopupMenuItem(
              value: _GroupAction.delete,
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

enum _GroupAction { edit, toggle, delete }

/// Dialog for creating or editing a community group.
class _GroupEditDialog extends StatefulWidget {
  final AdminCommunityGroup? group;

  const _GroupEditDialog({this.group});

  @override
  State<_GroupEditDialog> createState() => _GroupEditDialogState();
}

class _GroupEditDialogState extends State<_GroupEditDialog> {
  late final TextEditingController _idCtrl;
  late final TextEditingController _nameCtrl;
  late final TextEditingController _membersCtrl;
  late final TextEditingController _writersCtrl;
  late bool _isEnabled;

  bool get _isEdit => widget.group != null;

  @override
  void initState() {
    super.initState();
    final g = widget.group;
    _idCtrl = TextEditingController(text: g?.groupId ?? '');
    _nameCtrl = TextEditingController(text: g?.groupName ?? '');
    _membersCtrl = TextEditingController(text: g?.members.join(', ') ?? '');
    _writersCtrl = TextEditingController(text: g?.writers.join(', ') ?? '');
    _isEnabled = g?.isEnabled ?? true;
  }

  @override
  void dispose() {
    _idCtrl.dispose();
    _nameCtrl.dispose();
    _membersCtrl.dispose();
    _writersCtrl.dispose();
    super.dispose();
  }

  List<String> _parsePhones(String raw) {
    return raw
        .split(RegExp(r'[,\n;]+'))
        .map((e) => e.trim())
        .where((e) => e.isNotEmpty)
        .toList();
  }

  void _submit() {
    final gid = _idCtrl.text.trim();
    final gname = _nameCtrl.text.trim();
    if (gid.isEmpty || gname.isEmpty) return;

    Navigator.of(context).pop(
      AdminCommunityGroup(
        groupId: gid,
        groupName: gname,
        members: _parsePhones(_membersCtrl.text),
        writers: _parsePhones(_writersCtrl.text),
        isEnabled: _isEnabled,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Directionality(
      textDirection: TextDirection.rtl,
      child: AlertDialog(
        title: Text(_isEdit ? 'עריכת קבוצה' : 'קבוצה חדשה'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextField(
                controller: _idCtrl,
                enabled: !_isEdit,
                decoration: InputDecoration(
                  labelText: 'מזהה קבוצה (groupId)',
                  hintText: 'לדוגמה: אקרדיטציה',
                  helperText: _isEdit ? 'לא ניתן לשנות מזהה קיים' : null,
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _nameCtrl,
                decoration: const InputDecoration(
                  labelText: 'שם הקבוצה',
                  hintText: 'לדוגמה: אקרדיטציה',
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _membersCtrl,
                maxLines: 3,
                decoration: const InputDecoration(
                  labelText: 'חברים (מספרי טלפון, מופרדים בפסיק)',
                  hintText: '0546799693, 0550000001',
                  alignLabelWithHint: true,
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _writersCtrl,
                maxLines: 3,
                decoration: const InputDecoration(
                  labelText: 'כותבים (מספרי טלפון, מופרדים בפסיק)',
                  hintText: '0546799693',
                  alignLabelWithHint: true,
                ),
              ),
              if (_isEdit) ...[
                const SizedBox(height: 12),
                SwitchListTile(
                  title: const Text('קבוצה פעילה'),
                  value: _isEnabled,
                  onChanged: (v) => setState(() => _isEnabled = v),
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
              if (_idCtrl.text.trim().isEmpty || _nameCtrl.text.trim().isEmpty) {
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
