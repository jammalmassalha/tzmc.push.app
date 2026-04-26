/// Chat list screen - displays all active chats.
///
/// Shows both direct messages and group chats sorted by last message time.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../core/models/chat_models.dart';
import '../../../core/services/chat_store_service.dart';
import '../../../shared/theme/app_theme.dart';
import 'message_screen.dart';

/// Chat list widget
class ChatListScreen extends ConsumerWidget {
  const ChatListScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final chatItems = ref.watch(chatListItemsProvider);

    // Match the Angular behavior: render the (possibly empty) list immediately
    // and let the background sync populate it. No full-screen loader on entry.
    if (chatItems.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.chat_bubble_outline,
              size: 80,
              color: Theme.of(context).colorScheme.primary.withAlpha((255 * 0.3).round()),
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
              'התחל שיחה חדשה עם הכפתור למטה',
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
          return _ChatListTile(
            item: item,
            onTap: () => _openChat(context, ref, item),
          );
        },
      ),
    );
  }

  void _openChat(BuildContext context, WidgetRef ref, ChatListItem item) {
    ref.read(chatStoreProvider.notifier).setCurrentChat(item.id);
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (context) => MessageScreen(chatId: item.id),
      ),
    );
  }
}

/// Individual chat list tile
class _ChatListTile extends StatelessWidget {
  final ChatListItem item;
  final VoidCallback onTap;

  const _ChatListTile({
    required this.item,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(
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
          ],
        ),
      ),
    );
  }

  Widget _buildAvatar(BuildContext context) {
    final theme = Theme.of(context);

    if (item.avatarUrl != null && item.avatarUrl!.isNotEmpty) {
      return CircleAvatar(
        radius: 28,
        backgroundImage: NetworkImage(item.avatarUrl!),
      );
    }

    // Default avatar with initials
    final initial = item.title.isNotEmpty ? item.title[0].toUpperCase() : '?';
    final backgroundColor = item.isGroup ? AppColors.groupColor : AppColors.primary;

    return CircleAvatar(
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
  const GroupListScreen({super.key});

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
            onTap: () => _openGroup(context, ref, group),
          );
        },
      ),
    );
  }

  void _openGroup(BuildContext context, WidgetRef ref, ChatGroup group) {
    ref.read(chatStoreProvider.notifier).setCurrentChat(group.id);
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (context) => MessageScreen(chatId: group.id),
      ),
    );
  }
}

/// Group list tile
class _GroupListTile extends StatelessWidget {
  final ChatGroup group;
  final int unread;
  final ChatMessage? lastMessage;
  final VoidCallback onTap;

  const _GroupListTile({
    required this.group,
    required this.unread,
    required this.lastMessage,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(
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
