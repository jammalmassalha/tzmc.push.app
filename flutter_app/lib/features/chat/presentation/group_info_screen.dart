/// Group info / settings screen.
///
/// Shows group name, member list and management actions.
/// Admins may: rename the group, add members, remove any member.
/// All members may leave the group.
library;

import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/models/chat_models.dart';
import '../../../core/services/chat_store_service.dart';
import '../../../shared/theme/app_theme.dart';
import '../../../shared/widgets/authenticated_image.dart';

/// Push this screen via Navigator when the user taps the group header.
class GroupInfoScreen extends ConsumerStatefulWidget {
  final String groupId;

  const GroupInfoScreen({super.key, required this.groupId});

  @override
  ConsumerState<GroupInfoScreen> createState() => _GroupInfoScreenState();
}

class _GroupInfoScreenState extends ConsumerState<GroupInfoScreen> {
  bool _renaming = false;
  late final TextEditingController _nameController;

  @override
  void initState() {
    super.initState();
    _nameController = TextEditingController();
  }

  @override
  void dispose() {
    _nameController.dispose();
    super.dispose();
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  ChatGroup? _group(ChatState state) => state.groups[widget.groupId];

  bool _isAdmin(ChatGroup group) {
    return ref.read(chatStoreProvider.notifier).isGroupAdmin(widget.groupId);
  }

  String _initial(String name) =>
      name.isNotEmpty ? name[0].toUpperCase() : '?';

  // ── actions ────────────────────────────────────────────────────────────────

  void _startRename(ChatGroup group) {
    _nameController.text = group.name;
    setState(() => _renaming = true);
  }

  Future<void> _submitRename() async {
    final newName = _nameController.text.trim();
    setState(() => _renaming = false);
    if (newName.length < 2) {
      _showSnack('שם הקבוצה חייב להכיל לפחות 2 תווים');
      return;
    }
    await ref
        .read(chatStoreProvider.notifier)
        .renameGroup(widget.groupId, newName);
  }

  void _cancelRename() => setState(() => _renaming = false);

  Future<void> _addMembers() async {
    final state = ref.read(chatStoreProvider);
    final group = _group(state);
    if (group == null) return;

    final picked = await _showMemberPicker(
      context: context,
      existingMembers: group.members,
      contacts: state.contacts.values.toList(),
      currentUser: ref.read(chatStoreProvider.notifier).currentUser ?? '',
    );
    if (picked == null || picked.isEmpty) return;
    await ref
        .read(chatStoreProvider.notifier)
        .addGroupMembers(widget.groupId, picked);
  }

  Future<void> _removeMember(String member, ChatGroup group) async {
    final me = ref.read(chatStoreProvider.notifier).currentUser ?? '';
    // Prevent removing the last admin
    final admins = (group.admins ?? const <String>[])
        .map((a) => a.trim().toLowerCase())
        .toList();
    if (admins.length == 1 && admins.first == member) {
      _showSnack('לא ניתן להסיר את המנהל האחרון');
      return;
    }
    final contact = ref.read(chatStoreProvider).contacts[member];
    final displayName = contact?.displayName ?? member;
    final confirmed = await _confirm(
      'הסרת משתתף',
      'להסיר את $displayName מהקבוצה?',
    );
    if (confirmed != true) return;
    await ref
        .read(chatStoreProvider.notifier)
        .removeGroupMember(widget.groupId, member);
  }

  Future<void> _leave(ChatGroup group) async {
    final confirmed = await _confirm(
      'יציאה מהקבוצה',
      'האם אתה בטוח שברצונך לצאת מהקבוצה?',
    );
    if (confirmed != true) return;
    await ref.read(chatStoreProvider.notifier).leaveGroup(widget.groupId);
    if (mounted) Navigator.of(context).popUntil((r) => r.isFirst);
  }

  Future<bool?> _confirm(String title, String content) {
    return showDialog<bool>(
      context: context,
      builder: (ctx) => Directionality(
        textDirection: ui.TextDirection.rtl,
        child: AlertDialog(
          title: Text(title),
          content: Text(content),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('ביטול'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('אישור'),
            ),
          ],
        ),
      ),
    );
  }

  void _showSnack(String msg) {
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(msg)));
  }

  // ── build ───────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(chatStoreProvider);
    final group = _group(state);

    if (group == null) {
      return Directionality(
        textDirection: ui.TextDirection.rtl,
        child: Scaffold(
          appBar: AppBar(title: const Text('פרטי קבוצה')),
          body: const Center(child: Text('הקבוצה לא נמצאה')),
        ),
      );
    }

    final isAdmin = _isAdmin(group);
    final me = ref.read(chatStoreProvider.notifier).currentUser ?? '';

    return Directionality(
      textDirection: ui.TextDirection.rtl,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('פרטי קבוצה'),
          actions: [
            if (isAdmin)
              IconButton(
                icon: const Icon(Icons.edit),
                tooltip: 'שנה שם קבוצה',
                onPressed: () => _startRename(group),
              ),
          ],
        ),
        body: ListView(
          children: [
            // ── Group header ──────────────────────────────────────────────
            _GroupHeader(
              group: group,
              isAdmin: isAdmin,
              renaming: _renaming,
              nameController: _nameController,
              onStartRename: () => _startRename(group),
              onSubmitRename: _submitRename,
              onCancelRename: _cancelRename,
            ),
            const Divider(height: 1),

            // ── Members section ───────────────────────────────────────────
            Padding(
              padding:
                  const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              child: Row(
                children: [
                  Text(
                    '${group.members.length} משתתפים',
                    style: Theme.of(context).textTheme.titleSmall?.copyWith(
                          fontWeight: FontWeight.bold,
                        ),
                  ),
                  const Spacer(),
                  if (isAdmin)
                    TextButton.icon(
                      onPressed: _addMembers,
                      icon: const Icon(Icons.person_add, size: 18),
                      label: const Text('הוסף'),
                    ),
                ],
              ),
            ),
            ...group.members.map((member) {
              final contact = state.contacts[member];
              final displayName = contact?.displayName ?? member;
              final info = contact?.info ?? '';
              final avatarUrl =
                  (contact?.upic?.trim().isNotEmpty ?? false)
                      ? contact!.upic
                      : null;
              final adminList = (group.admins ?? const <String>[])
                  .map((a) => a.trim().toLowerCase())
                  .toList();
              final isMemberAdmin = adminList.contains(member) ||
                  group.createdBy.trim().toLowerCase() == member;
              final isMe = member == me;

              return ListTile(
                leading: avatarUrl != null
                    ? AuthenticatedCircleAvatar(url: avatarUrl, radius: 22)
                    : CircleAvatar(
                        radius: 22,
                        backgroundColor: AppColors.primary,
                        child: Text(
                          _initial(displayName),
                          style: const TextStyle(
                            color: Colors.white,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ),
                title: Text(
                  isMe ? '$displayName (אתה)' : displayName,
                  style: const TextStyle(fontWeight: FontWeight.w500),
                ),
                subtitle: info.isNotEmpty ? Text(info) : null,
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (isMemberAdmin)
                      Padding(
                        padding: const EdgeInsets.only(left: 4),
                        child: Chip(
                          label: const Text('מנהל'),
                          padding: EdgeInsets.zero,
                          labelPadding:
                              const EdgeInsets.symmetric(horizontal: 6),
                          visualDensity: VisualDensity.compact,
                          backgroundColor:
                              AppColors.primary.withAlpha(30),
                          labelStyle: TextStyle(
                            color: AppColors.primary,
                            fontSize: 11,
                          ),
                        ),
                      ),
                    if (isAdmin && !isMe)
                      IconButton(
                        icon: Icon(
                          Icons.remove_circle_outline,
                          color: Theme.of(context).colorScheme.error,
                          size: 20,
                        ),
                        tooltip: 'הסר משתתף',
                        onPressed: () => _removeMember(member, group),
                      ),
                  ],
                ),
              );
            }),

            const SizedBox(height: 16),
            const Divider(height: 1),

            // ── Leave group ───────────────────────────────────────────────
            ListTile(
              leading: Icon(
                Icons.exit_to_app,
                color: Theme.of(context).colorScheme.error,
              ),
              title: Text(
                'יציאה מהקבוצה',
                style: TextStyle(
                  color: Theme.of(context).colorScheme.error,
                  fontWeight: FontWeight.w500,
                ),
              ),
              onTap: () => _leave(group),
            ),
            const SizedBox(height: 24),
          ],
        ),
      ),
    );
  }
}

// ── Group header widget ────────────────────────────────────────────────────────

class _GroupHeader extends StatelessWidget {
  final ChatGroup group;
  final bool isAdmin;
  final bool renaming;
  final TextEditingController nameController;
  final VoidCallback onStartRename;
  final VoidCallback onSubmitRename;
  final VoidCallback onCancelRename;

  const _GroupHeader({
    required this.group,
    required this.isAdmin,
    required this.renaming,
    required this.nameController,
    required this.onStartRename,
    required this.onSubmitRename,
    required this.onCancelRename,
  });

  @override
  Widget build(BuildContext context) {
    final initial =
        group.name.isNotEmpty ? group.name[0].toUpperCase() : '?';

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 16),
      child: Column(
        children: [
          CircleAvatar(
            radius: 40,
            backgroundColor: AppColors.primary,
            child: Text(
              initial,
              style: const TextStyle(
                color: Colors.white,
                fontSize: 28,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
          const SizedBox(height: 16),
          if (renaming)
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: nameController,
                    textDirection: ui.TextDirection.rtl,
                    autofocus: true,
                    decoration: const InputDecoration(
                      labelText: 'שם הקבוצה',
                      border: OutlineInputBorder(),
                      isDense: true,
                    ),
                    onSubmitted: (_) => onSubmitRename(),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton(
                  icon: const Icon(Icons.check),
                  onPressed: onSubmitRename,
                  tooltip: 'שמור',
                ),
                IconButton(
                  icon: const Icon(Icons.close),
                  onPressed: onCancelRename,
                  tooltip: 'ביטול',
                ),
              ],
            )
          else
            GestureDetector(
              onTap: isAdmin ? onStartRename : null,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    group.name,
                    style: const TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  if (isAdmin) ...[
                    const SizedBox(width: 6),
                    const Icon(Icons.edit, size: 16, color: Colors.grey),
                  ],
                ],
              ),
            ),
          if (group.type == GroupType.community) ...[
            const SizedBox(height: 6),
            Chip(
              label: const Text('קבוצת קהילה'),
              backgroundColor: AppColors.primary.withAlpha(20),
              labelStyle: TextStyle(color: AppColors.primary, fontSize: 12),
              visualDensity: VisualDensity.compact,
            ),
          ],
        ],
      ),
    );
  }
}

// ── Member picker dialog ───────────────────────────────────────────────────────

Future<List<String>?> _showMemberPicker({
  required BuildContext context,
  required List<String> existingMembers,
  required List<Contact> contacts,
  required String currentUser,
}) {
  return showDialog<List<String>>(
    context: context,
    builder: (_) => _MemberPickerDialog(
      existingMembers: existingMembers,
      contacts: contacts,
      currentUser: currentUser,
    ),
  );
}

class _MemberPickerDialog extends StatefulWidget {
  final List<String> existingMembers;
  final List<Contact> contacts;
  final String currentUser;

  const _MemberPickerDialog({
    required this.existingMembers,
    required this.contacts,
    required this.currentUser,
  });

  @override
  State<_MemberPickerDialog> createState() => _MemberPickerDialogState();
}

class _MemberPickerDialogState extends State<_MemberPickerDialog> {
  final _searchController = TextEditingController();
  final Set<String> _selected = {};
  String _query = '';

  @override
  void initState() {
    super.initState();
    _searchController.addListener(
      () => setState(() => _query = _searchController.text.trim().toLowerCase()),
    );
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final available = widget.contacts.where((c) {
      if (c.username == widget.currentUser) return false;
      if (widget.existingMembers.contains(c.username)) return false;
      if (_query.isEmpty) return true;
      return c.displayName.toLowerCase().contains(_query) ||
          c.username.toLowerCase().contains(_query) ||
          (c.info ?? '').toLowerCase().contains(_query);
    }).toList()
      ..sort((a, b) => a.displayName.compareTo(b.displayName));

    return Directionality(
      textDirection: ui.TextDirection.rtl,
      child: Dialog(
        child: ConstrainedBox(
          constraints:
              const BoxConstraints(maxWidth: 480, maxHeight: 600),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                child: Row(
                  children: [
                    const Expanded(
                      child: Text(
                        'הוספת משתתפים',
                        style: TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                    IconButton(
                      icon: const Icon(Icons.close),
                      onPressed: () => Navigator.of(context).pop(),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: TextField(
                  controller: _searchController,
                  textDirection: ui.TextDirection.rtl,
                  decoration: const InputDecoration(
                    hintText: 'חיפוש אנשי קשר',
                    prefixIcon: Icon(Icons.search),
                    border: OutlineInputBorder(),
                    isDense: true,
                  ),
                ),
              ),
              const SizedBox(height: 8),
              if (_selected.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Text('${_selected.length} נבחרו',
                      style: Theme.of(context).textTheme.bodySmall),
                ),
              const Divider(height: 1),
              Expanded(
                child: available.isEmpty
                    ? const Center(
                        child: Padding(
                          padding: EdgeInsets.all(24),
                          child: Text('אין אנשי קשר להוסיף'),
                        ),
                      )
                    : ListView.builder(
                        itemCount: available.length,
                        itemBuilder: (context, index) {
                          final c = available[index];
                          final sel = _selected.contains(c.username);
                          return CheckboxListTile(
                            value: sel,
                            controlAffinity:
                                ListTileControlAffinity.trailing,
                            onChanged: (v) => setState(() {
                              if (v == true) {
                                _selected.add(c.username);
                              } else {
                                _selected.remove(c.username);
                              }
                            }),
                            secondary: CircleAvatar(
                              backgroundColor: AppColors.primary,
                              child: Text(
                                c.displayName.isNotEmpty
                                    ? c.displayName[0].toUpperCase()
                                    : '?',
                                style: const TextStyle(
                                  color: Colors.white,
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                            ),
                            title: Text(c.displayName),
                            subtitle: c.info != null && c.info!.isNotEmpty
                                ? Text(c.info!,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis)
                                : null,
                          );
                        },
                      ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    TextButton(
                      onPressed: () => Navigator.of(context).pop(),
                      child: const Text('ביטול'),
                    ),
                    const SizedBox(width: 8),
                    FilledButton.icon(
                      onPressed: _selected.isEmpty
                          ? null
                          : () =>
                              Navigator.of(context).pop(_selected.toList()),
                      icon: const Icon(Icons.person_add),
                      label: const Text('הוסף'),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
