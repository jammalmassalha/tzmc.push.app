/// New chat dialog — searchable contact picker.
///
/// Mirrors the Angular `NewChatDialogComponent`
/// (frontend/src/app/features/chat/dialogs/new-chat-dialog.component.ts):
/// excludes the current user from the list, supports filtering by
/// displayName / username / info / phone, returns the selected contact's
/// username so the caller can call `ChatStoreNotifier.startDirectChat`.
library;

import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/models/chat_models.dart';
import '../../../core/services/chat_store_service.dart';
import '../../../shared/theme/app_theme.dart';

/// Show the new-chat dialog. Returns the selected contact's username,
/// or `null` if the user cancelled.
Future<String?> showNewChatDialog(BuildContext context) {
  return showDialog<String>(
    context: context,
    builder: (_) => const _NewChatDialog(),
  );
}

class _NewChatDialog extends ConsumerStatefulWidget {
  const _NewChatDialog();

  @override
  ConsumerState<_NewChatDialog> createState() => _NewChatDialogState();
}

class _NewChatDialogState extends ConsumerState<_NewChatDialog> {
  final _searchController = TextEditingController();
  String _query = '';

  @override
  void initState() {
    super.initState();
    _searchController.addListener(() {
      setState(() => _query = _searchController.text.trim().toLowerCase());
    });
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
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
          constraints: const BoxConstraints(maxWidth: 460, maxHeight: 600),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                child: Row(
                  children: [
                    const Expanded(
                      child: Text(
                        'צ\'אט חדש',
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
                child: TextField(
                  controller: _searchController,
                  textDirection: ui.TextDirection.rtl,
                  decoration: const InputDecoration(
                    hintText: 'חיפוש איש קשר',
                    prefixIcon: Icon(Icons.search),
                    border: OutlineInputBorder(),
                    isDense: true,
                  ),
                ),
              ),
              const SizedBox(height: 8),
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
                          return _ContactTile(
                            contact: contact,
                            onTap: () =>
                                Navigator.of(context).pop(contact.username),
                          );
                        },
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ContactTile extends StatelessWidget {
  final Contact contact;
  final VoidCallback onTap;

  const _ContactTile({required this.contact, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final initial =
        contact.displayName.isNotEmpty ? contact.displayName[0].toUpperCase() : '?';
    return ListTile(
      onTap: onTap,
      leading: contact.upic != null && contact.upic!.isNotEmpty
          ? CircleAvatar(backgroundImage: NetworkImage(contact.upic!))
          : CircleAvatar(
              backgroundColor: AppColors.primary,
              child: Text(initial,
                  style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
            ),
      title: Text(contact.displayName,
          style: theme.textTheme.bodyLarge),
      subtitle: contact.info != null && contact.info!.isNotEmpty
          ? Text(contact.info!,
              style: theme.textTheme.bodySmall,
              maxLines: 1,
              overflow: TextOverflow.ellipsis)
          : null,
    );
  }
}
