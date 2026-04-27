/// Create-group dialog — name, type and member multi-select.
///
/// Mirrors the Angular `CreateGroupDialogComponent`
/// (frontend/src/app/features/chat/dialogs/create-group-dialog.component.ts):
/// requires a non-empty name and at least one selected member, optional
/// `community` toggle. Returns a `CreateGroupResult` to the caller; the
/// caller is responsible for calling `ChatStoreNotifier.createGroup`.
library;

import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/models/chat_models.dart';
import '../../../core/services/chat_store_service.dart';
import '../../../shared/theme/app_theme.dart';

/// Result returned from the create-group dialog.
class CreateGroupResult {
  final String name;
  final GroupType type;
  final List<String> members;

  const CreateGroupResult({
    required this.name,
    required this.type,
    required this.members,
  });
}

/// Show the create-group dialog. Returns a [CreateGroupResult] or `null` if
/// the user cancelled.
Future<CreateGroupResult?> showCreateGroupDialog(BuildContext context) {
  return showDialog<CreateGroupResult>(
    context: context,
    builder: (_) => const _CreateGroupDialog(),
  );
}

class _CreateGroupDialog extends ConsumerStatefulWidget {
  const _CreateGroupDialog();

  @override
  ConsumerState<_CreateGroupDialog> createState() => _CreateGroupDialogState();
}

class _CreateGroupDialogState extends ConsumerState<_CreateGroupDialog> {
  final _nameController = TextEditingController();
  final _searchController = TextEditingController();
  final Set<String> _selected = <String>{};
  GroupType _type = GroupType.group;
  String _query = '';
  String? _errorText;

  @override
  void initState() {
    super.initState();
    _searchController.addListener(() {
      setState(() => _query = _searchController.text.trim().toLowerCase());
    });
  }

  @override
  void dispose() {
    _nameController.dispose();
    _searchController.dispose();
    super.dispose();
  }

  void _toggle(String username, bool? checked) {
    setState(() {
      if (checked == true) {
        _selected.add(username);
      } else {
        _selected.remove(username);
      }
      if (_selected.isNotEmpty) _errorText = null;
    });
  }

  void _submit() {
    final name = _nameController.text.trim();
    if (name.length < 2) {
      setState(() => _errorText = 'יש להזין שם של 2 תווים לפחות');
      return;
    }
    if (_selected.isEmpty) {
      setState(() => _errorText = 'יש לבחור לפחות משתתף אחד');
      return;
    }
    Navigator.of(context).pop(CreateGroupResult(
      name: name,
      type: _type,
      members: _selected.toList(),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(chatStoreProvider);
    final me = ref.read(chatStoreProvider.notifier).currentUser;

    final contacts = state.contacts.values.where((c) {
      if (me != null && c.username.trim().toLowerCase() == me) return false;
      if (_query.isEmpty) return true;
      final info = (c.info ?? '').toLowerCase();
      final phone = (c.phone ?? '').toLowerCase();
      return c.displayName.toLowerCase().contains(_query) ||
          c.username.toLowerCase().contains(_query) ||
          info.contains(_query) ||
          phone.contains(_query);
    }).toList()
      ..sort((a, b) => a.displayName.compareTo(b.displayName));

    return Directionality(
      textDirection: ui.TextDirection.rtl,
      child: Dialog(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520, maxHeight: 700),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                child: Row(
                  children: [
                    const Expanded(
                      child: Text(
                        'יצירת קבוצה חדשה',
                        style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
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
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    TextField(
                      controller: _nameController,
                      textDirection: ui.TextDirection.rtl,
                      decoration: const InputDecoration(
                        labelText: 'שם הקבוצה',
                        border: OutlineInputBorder(),
                        isDense: true,
                      ),
                    ),
                    const SizedBox(height: 12),
                    DropdownButtonFormField<GroupType>(
                      value: _type,
                      decoration: const InputDecoration(
                        labelText: 'סוג קבוצה',
                        border: OutlineInputBorder(),
                        isDense: true,
                      ),
                      items: const [
                        DropdownMenuItem(
                          value: GroupType.group,
                          child: Text('קבוצה רגילה — כל המשתתפים יכולים לשלוח'),
                        ),
                        DropdownMenuItem(
                          value: GroupType.community,
                          child: Text('קבוצת קהילה — רק מנהלים שולחים'),
                        ),
                      ],
                      onChanged: (value) {
                        if (value != null) setState(() => _type = value);
                      },
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _searchController,
                      textDirection: ui.TextDirection.rtl,
                      decoration: const InputDecoration(
                        hintText: 'חיפוש משתתפים',
                        prefixIcon: Icon(Icons.search),
                        border: OutlineInputBorder(),
                        isDense: true,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text('${_selected.length} משתתפים נבחרו',
                        style: Theme.of(context).textTheme.bodySmall),
                  ],
                ),
              ),
              const Divider(height: 1),
              Expanded(
                child: contacts.isEmpty
                    ? const Center(
                        child: Padding(
                          padding: EdgeInsets.all(24),
                          child: Text('לא נמצאו אנשי קשר'),
                        ),
                      )
                    : ListView.builder(
                        itemCount: contacts.length,
                        itemBuilder: (context, index) {
                          final contact = contacts[index];
                          final selected = _selected.contains(contact.username);
                          final initial = contact.displayName.isNotEmpty
                              ? contact.displayName[0].toUpperCase()
                              : '?';
                          return CheckboxListTile(
                            value: selected,
                            onChanged: (v) => _toggle(contact.username, v),
                            controlAffinity: ListTileControlAffinity.trailing,
                            secondary: contact.upic != null && contact.upic!.isNotEmpty
                                ? CircleAvatar(
                                    backgroundImage: NetworkImage(contact.upic!))
                                : CircleAvatar(
                                    backgroundColor: AppColors.primary,
                                    child: Text(initial,
                                        style: const TextStyle(
                                            color: Colors.white,
                                            fontWeight: FontWeight.bold)),
                                  ),
                            title: Text(contact.displayName),
                            subtitle: contact.info != null && contact.info!.isNotEmpty
                                ? Text(contact.info!,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis)
                                : null,
                          );
                        },
                      ),
              ),
              if (_errorText != null)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                  child: Text(_errorText!,
                      style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                          fontSize: 12)),
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
                      onPressed: _submit,
                      icon: const Icon(Icons.group_add),
                      label: const Text('צור קבוצה'),
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
