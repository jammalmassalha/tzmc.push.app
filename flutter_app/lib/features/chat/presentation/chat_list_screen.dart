/// Chat list screen - displays all active chats.
///
/// Shows both direct messages and group chats sorted by last message time.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart' hide TextDirection;
import 'package:url_launcher/url_launcher.dart';

import '../../../core/models/chat_models.dart';
import '../../../core/services/chat_store_service.dart';
import '../../../core/utils/toast_utils.dart';
import '../../../shared/theme/app_theme.dart';
import '../../../shared/widgets/authenticated_image.dart';
import 'message_screen.dart';

const Color _kSelectedChatTileColor = Color(0xFFE3F2FD); // blue-50 tint matching AppColors.primary
const Color _kHoverChatTileColor = AppColors.background;   // #F5F5F5
const Color _kPressedChatTileColor = AppColors.divider;    // #E0E0E0

/// Chat list widget
class ChatListScreen extends ConsumerWidget {
  final ValueChanged<ChatListItem>? onChatSelected;
  final String? selectedChatId;

  const ChatListScreen({
    super.key,
    this.onChatSelected,
    this.selectedChatId,
  });

  Contact? _findContact(ChatState state, String value) {
    final normalized = value.trim().toLowerCase();
    if (normalized.isEmpty) return null;
    for (final entry in state.contacts.entries) {
      final contact = entry.value;
      if (entry.key.trim().toLowerCase() == normalized ||
          contact.username.trim().toLowerCase() == normalized ||
          (contact.phone?.trim().toLowerCase() == normalized) ||
          contact.displayName.trim().toLowerCase() == normalized) {
        return contact;
      }
    }
    return null;
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(chatStoreProvider);
    final chatItems = state.chatListItems;
    final isLoading = state.isLoading;

    // While the store is initializing (fetching contacts + recovering messages),
    // show a spinner rather than the "no chats yet" empty state so the user
    // knows data is being loaded.
    if (chatItems.isEmpty && isLoading) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const CircularProgressIndicator(),
            const SizedBox(height: 16),
            Text(
              'טוען שיחות...',
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: Theme.of(context).colorScheme.onSurface.withAlpha((255 * 0.6).round()),
                  ),
            ),
          ],
        ),
      );
    }

    // Match the Angular behavior: render the (possibly empty) list immediately
    // and let the background sync populate it. No full-screen loader on entry.
    if (chatItems.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Image.asset(
              'assets/images/logo.png',
              width: 96,
              height: 96,
              color: Theme.of(context).colorScheme.primary.withAlpha((255 * 0.3).round()),
              colorBlendMode: BlendMode.modulate,
            ),
            const SizedBox(height: 16),
            Text(
              'אין שיחות עדיין',
              style: Theme.of(context).textTheme.titleLarge?.copyWith(
                    color: Theme.of(context).colorScheme.onSurface.withAlpha((255 * 0.6).round()),
                  ),
            ),
            const SizedBox(height: 8),
            Text(
              'התחל שיחה חדשה מהאייקון בסרגל העליון',
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: Theme.of(context).colorScheme.onSurface.withAlpha((255 * 0.4).round()),
                  ),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: () async {
        await ref.read(chatStoreProvider.notifier).recoverMissedMessages(force: true);
      },
      child: ListView.builder(
        itemCount: chatItems.length,
        itemBuilder: (context, index) {
          final item = chatItems[index];
          final contact = item.isGroup ? null : _findContact(state, item.id);
          final phone = (item.phone ?? contact?.phone ?? '').trim();
          return _ChatListTile(
            item: item,
            isSelected: selectedChatId == item.id,
            onTap: () => _openChat(context, ref, item),
            onCall: phone.isNotEmpty
                ? () => _callUser(context, phone)
                : null,
            onDelete: () => _deleteChat(context, ref, item),
          );
        },
      ),
    );
  }

  void _openChat(BuildContext context, WidgetRef ref, ChatListItem item) {
    final unreadCount = item.unread;
    ref.read(chatStoreProvider.notifier).setCurrentChat(item.id);
    if (onChatSelected != null) {
      onChatSelected!(item);
      return;
    }
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (context) => MessageScreen(chatId: item.id, initialUnreadCount: unreadCount),
      ),
    );
  }

  Future<void> _callUser(BuildContext context, String phone) async {
    final uri = Uri(scheme: 'tel', path: phone.trim());
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri);
      return;
    }
    if (context.mounted) {
      showTopToast(context, 'לא ניתן להתחיל שיחה');
    }
  }

  Future<void> _deleteChat(BuildContext context, WidgetRef ref, ChatListItem item) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('מחיקת שיחה', textDirection: TextDirection.rtl),
        content: Text(
          'האם למחוק את השיחה עם "${item.title}"?',
          textDirection: TextDirection.rtl,
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('ביטול'),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text(
              'מחק',
              style: TextStyle(color: Theme.of(ctx).colorScheme.error),
            ),
          ),
        ],
      ),
    );
    if (confirmed != true || !context.mounted) return;
    final deleted = await ref.read(chatStoreProvider.notifier).deleteChat(item.id);
    if (context.mounted) {
      showTopToast(context, deleted ? 'השיחה נמחקה' : 'לא ניתן למחוק את השיחה');
    }
  }
}

/// Individual chat list tile
class _ChatListTile extends StatelessWidget {
  final ChatListItem item;
  final bool isSelected;
  final VoidCallback onTap;
  final VoidCallback? onCall;
  final VoidCallback? onDelete;

  const _ChatListTile({
    required this.item,
    required this.isSelected,
    required this.onTap,
    this.onCall,
    this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(
          color: isSelected ? _kSelectedChatTileColor : Colors.transparent,
          borderRadius: BorderRadius.circular(14),
          border: Border(
            bottom: BorderSide(
              color: theme.dividerColor.withAlpha((255 * 0.3).round()),
              width: 0.5,
            ),
          ),
        ),
        child: Row(
          children: [
            // Avatar
            _buildAvatar(context),
            const SizedBox(width: 12),

            // Content
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Title and time row
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          item.title,
                          style: theme.textTheme.titleMedium?.copyWith(
                            fontWeight: item.unread > 0 ? FontWeight.bold : FontWeight.w500,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        _formatTimestamp(item.lastTimestamp),
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: item.unread > 0
                              ? AppColors.primary
                              : theme.colorScheme.onSurface.withAlpha((255 * 0.5).round()),
                          fontWeight: item.unread > 0 ? FontWeight.bold : FontWeight.normal,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),

                  // Subtitle and unread badge row
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          item.subtitle,
                          style: theme.textTheme.bodyMedium?.copyWith(
                            color: theme.colorScheme.onSurface.withAlpha((255 * 0.6).round()),
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      if (item.unread > 0) ...[
                        const SizedBox(width: 8),
                        _buildUnreadBadge(context),
                      ],
                    ],
                  ),
                ],
              ),
            ),
            if (onCall != null || onDelete != null)
              PopupMenuButton<String>(
                icon: const Icon(Icons.more_vert),
                onSelected: (value) {
                  switch (value) {
                    case 'call':
                      onCall?.call();
                      break;
                    case 'delete':
                      onDelete?.call();
                      break;
                  }
                },
                itemBuilder: (context) => [
                  if (onCall != null)
                    const PopupMenuItem(
                      value: 'call',
                      child: Row(
                        children: [
                          Icon(Icons.call, size: 20),
                          SizedBox(width: 12),
                          Text('התקשר'),
                        ],
                      ),
                    ),
                  if (onDelete != null)
                    PopupMenuItem(
                      value: 'delete',
                      child: Row(
                        children: [
                          Icon(
                            Icons.delete_outline,
                            size: 20,
                            color: Theme.of(context).colorScheme.error,
                          ),
                          const SizedBox(width: 12),
                          Text(
                            'מחק שיחה',
                            style: TextStyle(
                              color: Theme.of(context).colorScheme.error,
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
          ],
        ),
      ),
      overlayColor: WidgetStateProperty.resolveWith((states) {
        if (states.contains(WidgetState.pressed)) {
          return _kPressedChatTileColor;
        }
        if (states.contains(WidgetState.hovered)) {
          return _kHoverChatTileColor;
        }
        return null;
      }),
    );
  }

  Widget _buildAvatar(BuildContext context) {
    final initial = item.title.isNotEmpty ? item.title[0].toUpperCase() : '?';
    final backgroundColor = item.isGroup ? AppColors.groupColor : AppColors.primary;

    final fallback = CircleAvatar(
      radius: 28,
      backgroundColor: backgroundColor,
      child: item.isGroup
          ? const Icon(Icons.group, color: Colors.white, size: 24)
          : Text(
              initial,
              style: const TextStyle(
                color: Colors.white,
                fontSize: 20,
                fontWeight: FontWeight.bold,
              ),
            ),
    );

    if (item.avatarUrl != null && item.avatarUrl!.isNotEmpty) {
      return AuthenticatedCircleAvatar(
        url: item.avatarUrl,
        radius: 28,
        fallback: fallback,
      );
    }

    return fallback;
  }

  Widget _buildUnreadBadge(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: AppColors.primary,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        item.unread > 99 ? '99+' : item.unread.toString(),
        style: const TextStyle(
          color: Colors.white,
          fontSize: 12,
          fontWeight: FontWeight.bold,
        ),
      ),
    );
  }

  String _formatTimestamp(int timestamp) {
    final date = DateTime.fromMillisecondsSinceEpoch(timestamp);
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final yesterday = today.subtract(const Duration(days: 1));
    final messageDate = DateTime(date.year, date.month, date.day);

    if (messageDate == today) {
      return DateFormat.Hm('he').format(date);
    } else if (messageDate == yesterday) {
      return 'אתמול';
    } else if (now.difference(date).inDays < 7) {
      return DateFormat.EEEE('he').format(date);
    } else {
      return DateFormat.yMd('he').format(date);
    }
  }
}

/// Groups list widget (similar to chat list but shows only groups)
class GroupListScreen extends ConsumerWidget {
  final void Function(ChatGroup group, int unread)? onGroupSelected;
  final String? selectedChatId;

  const GroupListScreen({
    super.key,
    this.onGroupSelected,
    this.selectedChatId,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(chatStoreProvider);
    final groups = state.groups.values.toList();

    // Match the Angular behavior: render the (possibly empty) list immediately
    // and let the background sync populate it. No full-screen loader on entry.
    if (groups.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.group_outlined,
              size: 80,
              color: Theme.of(context).colorScheme.primary.withAlpha((255 * 0.3).round()),
            ),
            const SizedBox(height: 16),
            Text(
              'אין קבוצות',
              style: Theme.of(context).textTheme.titleLarge?.copyWith(
                    color: Theme.of(context).colorScheme.onSurface.withAlpha((255 * 0.6).round()),
                  ),
            ),
            const SizedBox(height: 8),
            Text(
              'תצורף לקבוצות על ידי מנהלים',
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: Theme.of(context).colorScheme.onSurface.withAlpha((255 * 0.4).round()),
                  ),
            ),
          ],
        ),
      );
    }

    // Sort groups by last message time
    final sortedGroups = groups.toList()
      ..sort((a, b) {
        final aMessages = state.messagesByChat[a.id] ?? [];
        final bMessages = state.messagesByChat[b.id] ?? [];
        final aTime = aMessages.isNotEmpty ? aMessages.first.timestamp : a.updatedAt;
        final bTime = bMessages.isNotEmpty ? bMessages.first.timestamp : b.updatedAt;
        return bTime.compareTo(aTime);
      });

    return RefreshIndicator(
      onRefresh: () async {
        await ref.read(chatStoreProvider.notifier).recoverMissedMessages(force: true);
      },
      child: ListView.builder(
        itemCount: sortedGroups.length,
        itemBuilder: (context, index) {
          final group = sortedGroups[index];
          return _GroupListTile(
            group: group,
            unread: state.unreadByChat[group.id] ?? 0,
            lastMessage: (state.messagesByChat[group.id] ?? []).firstOrNull,
            isSelected: selectedChatId == group.id,
            onTap: () => _openGroup(context, ref, group),
          );
        },
      ),
    );
  }

  void _openGroup(BuildContext context, WidgetRef ref, ChatGroup group) {
    final unreadCount = ref.read(chatStoreProvider).unreadByChat[group.id] ?? 0;
    ref.read(chatStoreProvider.notifier).setCurrentChat(group.id);
    if (onGroupSelected != null) {
      onGroupSelected!(group, unreadCount);
      return;
    }
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (context) => MessageScreen(chatId: group.id, initialUnreadCount: unreadCount),
      ),
    );
  }
}

/// Group list tile
class _GroupListTile extends StatelessWidget {
  final ChatGroup group;
  final int unread;
  final ChatMessage? lastMessage;
  final bool isSelected;
  final VoidCallback onTap;

  const _GroupListTile({
    required this.group,
    required this.unread,
    required this.lastMessage,
    required this.isSelected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      overlayColor: WidgetStateProperty.resolveWith((states) {
        if (states.contains(WidgetState.hovered)) {
          return _kHoverChatTileColor;
        }
        if (states.contains(WidgetState.pressed)) {
          return _kPressedChatTileColor;
        }
        return null;
      }),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(
          color: isSelected ? _kSelectedChatTileColor : Colors.transparent,
          borderRadius: BorderRadius.circular(14),
          border: Border(
            bottom: BorderSide(
              color: theme.dividerColor.withAlpha((255 * 0.3).round()),
              width: 0.5,
            ),
          ),
        ),
        child: Row(
          children: [
            // Avatar
            CircleAvatar(
              radius: 28,
              backgroundColor: group.type == GroupType.community
                  ? AppColors.communityColor
                  : AppColors.groupColor,
              child: Icon(
                group.type == GroupType.community ? Icons.public : Icons.group,
                color: Colors.white,
                size: 24,
              ),
            ),
            const SizedBox(width: 12),

            // Content
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Title row
                  Row(
                    children: [
                      if (group.type == GroupType.community)
                        Padding(
                          padding: const EdgeInsets.only(left: 4),
                          child: Icon(
                            Icons.public,
                            size: 14,
                            color: AppColors.communityColor,
                          ),
                        ),
                      Expanded(
                        child: Text(
                          group.name,
                          style: theme.textTheme.titleMedium?.copyWith(
                            fontWeight: unread > 0 ? FontWeight.bold : FontWeight.w500,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      if (lastMessage != null) ...[
                        const SizedBox(width: 8),
                        Text(
                          _formatTimestamp(lastMessage!.timestamp),
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: unread > 0
                                ? AppColors.primary
                                : theme.colorScheme.onSurface.withAlpha((255 * 0.5).round()),
                          ),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 4),

                  // Members count and last message
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          lastMessage != null
                              ? '${lastMessage!.senderDisplayName ?? lastMessage!.sender}: ${_getMessagePreview(lastMessage!)}'
                              : '${group.members.length} חברים',
                          style: theme.textTheme.bodyMedium?.copyWith(
                            color: theme.colorScheme.onSurface.withAlpha((255 * 0.6).round()),
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      if (unread > 0) ...[
                        const SizedBox(width: 8),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                          decoration: BoxDecoration(
                            color: AppColors.primary,
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: Text(
                            unread > 99 ? '99+' : unread.toString(),
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 12,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _getMessagePreview(ChatMessage message) {
    if (message.deletedAt != null) return '🗑️ הודעה נמחקה';
    if (message.imageUrl != null) return '📷 תמונה';
    if (message.fileUrl != null) return '📎 קובץ';
    final body = message.body.trim();
    return body.length > 30 ? '${body.substring(0, 30)}...' : body;
  }

  String _formatTimestamp(int timestamp) {
    final date = DateTime.fromMillisecondsSinceEpoch(timestamp);
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final yesterday = today.subtract(const Duration(days: 1));
    final messageDate = DateTime(date.year, date.month, date.day);

    if (messageDate == today) {
      return DateFormat.Hm('he').format(date);
    } else if (messageDate == yesterday) {
      return 'אתמול';
    } else if (now.difference(date).inDays < 7) {
      return DateFormat.EEEE('he').format(date);
    } else {
      return DateFormat.yMd('he').format(date);
    }
  }
}
