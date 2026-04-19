/// Message screen - displays messages in a chat conversation.
///
/// Shows message bubbles with support for text, images, reactions,
/// replies, and edit/delete status.
library;

import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../core/models/chat_models.dart';
import '../../../core/services/chat_store_service.dart';
import '../../../shared/theme/app_theme.dart';
import 'message_composer.dart';

/// Message screen widget
class MessageScreen extends ConsumerStatefulWidget {
  final String chatId;

  const MessageScreen({super.key, required this.chatId});

  @override
  ConsumerState<MessageScreen> createState() => _MessageScreenState();
}

class _MessageScreenState extends ConsumerState<MessageScreen> {
  final _scrollController = ScrollController();
  MessageReference? _replyTo;
  ChatMessage? _editingMessage;

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(chatStoreProvider);
    final messages = state.messagesByChat[widget.chatId] ?? [];
    final chatInfo = _getChatInfo(state);

    return Directionality(
      textDirection: ui.TextDirection.rtl,
      child: Scaffold(
        appBar: AppBar(
          leading: IconButton(
            icon: const Icon(Icons.arrow_forward),
            onPressed: () {
              ref.read(chatStoreProvider.notifier).setCurrentChat(null);
              Navigator.of(context).pop();
            },
          ),
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                chatInfo.title,
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
              ),
              if (chatInfo.subtitle != null)
                Text(
                  chatInfo.subtitle!,
                  style: TextStyle(
                    fontSize: 12,
                    color: Colors.white.withAlpha((255 * 0.7).round()),
                  ),
                ),
            ],
          ),
          actions: [
            PopupMenuButton<String>(
              icon: const Icon(Icons.more_vert),
              onSelected: _handleMenuAction,
              itemBuilder: (context) => [
                const PopupMenuItem(
                  value: 'info',
                  child: Row(
                    children: [
                      Icon(Icons.info_outline, size: 20),
                      SizedBox(width: 12),
                      Text('פרטים'),
                    ],
                  ),
                ),
                const PopupMenuItem(
                  value: 'search',
                  child: Row(
                    children: [
                      Icon(Icons.search, size: 20),
                      SizedBox(width: 12),
                      Text('חיפוש'),
                    ],
                  ),
                ),
              ],
            ),
          ],
        ),
        body: Column(
          children: [
            // Messages list
            Expanded(
              child: messages.isEmpty
                  ? _buildEmptyState(context)
                  : ListView.builder(
                      controller: _scrollController,
                      reverse: true,
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 16),
                      itemCount: messages.length,
                      itemBuilder: (context, index) {
                        final message = messages[index];
                        final previousMessage = index < messages.length - 1 ? messages[index + 1] : null;
                        final showDateHeader = _shouldShowDateHeader(message, previousMessage);

                        return Column(
                          children: [
                            if (showDateHeader) _buildDateHeader(context, message.timestamp),
                            _MessageBubble(
                              message: message,
                              isGroup: chatInfo.isGroup,
                              onReply: () => setState(() => _replyTo = MessageReference(
                                    messageId: message.messageId,
                                    sender: message.sender,
                                    senderDisplayName: message.senderDisplayName,
                                    body: message.body,
                                    imageUrl: message.imageUrl,
                                  )),
                              onReact: (emoji) => _handleReaction(message, emoji),
                              onEdit: message.direction == MessageDirection.outgoing
                                  ? () => setState(() => _editingMessage = message)
                                  : null,
                              onDelete: message.direction == MessageDirection.outgoing
                                  ? () => _handleDelete(message)
                                  : null,
                              onCopy: () => _handleCopy(message),
                            ),
                          ],
                        );
                      },
                    ),
            ),

            // Reply preview
            if (_replyTo != null)
              _ReplyPreview(
                replyTo: _replyTo!,
                onCancel: () => setState(() => _replyTo = null),
              ),

            // Edit preview
            if (_editingMessage != null)
              _EditPreview(
                message: _editingMessage!,
                onCancel: () => setState(() => _editingMessage = null),
              ),

            // Message composer
            MessageComposer(
              chatId: widget.chatId,
              isGroup: chatInfo.isGroup,
              replyTo: _replyTo,
              editingMessage: _editingMessage,
              onMessageSent: () {
                setState(() {
                  _replyTo = null;
                  _editingMessage = null;
                });
                _scrollToBottom();
              },
            ),
          ],
        ),
      ),
    );
  }

  ({String title, String? subtitle, bool isGroup}) _getChatInfo(ChatState state) {
    final group = state.groups[widget.chatId];
    if (group != null) {
      return (
        title: group.name,
        subtitle: '${group.members.length} חברים',
        isGroup: true,
      );
    }

    final contact = state.contacts[widget.chatId];
    return (
      title: contact?.displayName ?? widget.chatId,
      subtitle: contact?.info,
      isGroup: false,
    );
  }

  Widget _buildEmptyState(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.chat_bubble_outline,
            size: 64,
            color: Theme.of(context).colorScheme.primary.withAlpha((255 * 0.3).round()),
          ),
          const SizedBox(height: 16),
          Text(
            'אין הודעות עדיין',
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  color: Theme.of(context).colorScheme.onSurface.withAlpha((255 * 0.6).round()),
                ),
          ),
          const SizedBox(height: 8),
          Text(
            'שלח הודעה ראשונה!',
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: Theme.of(context).colorScheme.onSurface.withAlpha((255 * 0.4).round()),
                ),
          ),
        ],
      ),
    );
  }

  bool _shouldShowDateHeader(ChatMessage current, ChatMessage? previous) {
    if (previous == null) return true;

    final currentDate = DateTime.fromMillisecondsSinceEpoch(current.timestamp);
    final previousDate = DateTime.fromMillisecondsSinceEpoch(previous.timestamp);

    return currentDate.year != previousDate.year ||
        currentDate.month != previousDate.month ||
        currentDate.day != previousDate.day;
  }

  Widget _buildDateHeader(BuildContext context, int timestamp) {
    final date = DateTime.fromMillisecondsSinceEpoch(timestamp);
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final yesterday = today.subtract(const Duration(days: 1));
    final messageDate = DateTime(date.year, date.month, date.day);

    String dateText;
    if (messageDate == today) {
      dateText = 'היום';
    } else if (messageDate == yesterday) {
      dateText = 'אתמול';
    } else {
      dateText = DateFormat.yMMMMd('he').format(date);
    }

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 16),
      child: Center(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(16),
          ),
          child: Text(
            dateText,
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ),
      ),
    );
  }

  void _handleMenuAction(String action) {
    switch (action) {
      case 'info':
        _showChatInfo();
        break;
      case 'search':
        _showSearch();
        break;
    }
  }

  void _showChatInfo() {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('פרטי שיחה - בקרוב')),
    );
  }

  void _showSearch() {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('חיפוש בשיחה - בקרוב')),
    );
  }

  void _handleReaction(ChatMessage message, String emoji) {
    // Check if user already reacted with this emoji
    final existingReaction = message.reactions?.firstWhere(
      (r) => r.emoji == emoji,
      orElse: () => const MessageReaction(emoji: '', reactor: ''),
    );

    if (existingReaction?.emoji == emoji) {
      ref.read(chatStoreProvider.notifier).removeReaction(message.messageId, emoji);
    } else {
      ref.read(chatStoreProvider.notifier).addReaction(message.messageId, emoji);
    }
  }

  void _handleDelete(ChatMessage message) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('מחיקת הודעה', textDirection: ui.TextDirection.rtl),
        content: const Text('האם אתה בטוח שברצונך למחוק הודעה זו?', textDirection: ui.TextDirection.rtl),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('ביטול'),
          ),
          TextButton(
            onPressed: () {
              Navigator.of(context).pop();
              ref.read(chatStoreProvider.notifier).deleteMessage(message.messageId);
            },
            style: TextButton.styleFrom(foregroundColor: Theme.of(context).colorScheme.error),
            child: const Text('מחק'),
          ),
        ],
      ),
    );
  }

  void _handleCopy(ChatMessage message) {
    Clipboard.setData(ClipboardData(text: message.body));
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('ההודעה הועתקה'), duration: Duration(seconds: 1)),
    );
  }

  void _scrollToBottom() {
    if (_scrollController.hasClients) {
      _scrollController.animateTo(
        0,
        duration: const Duration(milliseconds: 300),
        curve: Curves.easeOut,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Message Bubble
// ---------------------------------------------------------------------------

class _MessageBubble extends StatelessWidget {
  final ChatMessage message;
  final bool isGroup;
  final VoidCallback onReply;
  final void Function(String emoji) onReact;
  final VoidCallback? onEdit;
  final VoidCallback? onDelete;
  final VoidCallback onCopy;

  const _MessageBubble({
    required this.message,
    required this.isGroup,
    required this.onReply,
    required this.onReact,
    this.onEdit,
    this.onDelete,
    required this.onCopy,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isOutgoing = message.direction == MessageDirection.outgoing;
    final isDeleted = message.deletedAt != null;

    return GestureDetector(
      onLongPress: () => _showMessageActions(context),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(
          mainAxisAlignment: isOutgoing ? MainAxisAlignment.start : MainAxisAlignment.end,
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            if (isOutgoing) const SizedBox(width: 48),
            Flexible(
              child: Container(
                constraints: BoxConstraints(
                  maxWidth: MediaQuery.of(context).size.width * 0.75,
                ),
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                decoration: BoxDecoration(
                  color: isOutgoing
                      ? AppColors.outgoingBubble
                      : AppColors.incomingBubble,
                  borderRadius: BorderRadius.only(
                    topLeft: const Radius.circular(16),
                    topRight: const Radius.circular(16),
                    bottomLeft: Radius.circular(isOutgoing ? 4 : 16),
                    bottomRight: Radius.circular(isOutgoing ? 16 : 4),
                  ),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Sender name (for groups)
                    if (isGroup && !isOutgoing && message.senderDisplayName != null)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 4),
                        child: Text(
                          message.senderDisplayName!,
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.bold,
                            color: _getSenderColor(message.sender),
                          ),
                        ),
                      ),

                    // Reply reference
                    if (message.replyTo != null) _buildReplyReference(context),

                    // Forwarded indicator
                    if (message.forwarded)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 4),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              Icons.forward,
                              size: 14,
                              color: theme.colorScheme.onSurface.withAlpha((255 * 0.5).round()),
                            ),
                            const SizedBox(width: 4),
                            Text(
                              'הועבר',
                              style: theme.textTheme.bodySmall?.copyWith(
                                fontStyle: FontStyle.italic,
                                color: theme.colorScheme.onSurface.withAlpha((255 * 0.5).round()),
                              ),
                            ),
                          ],
                        ),
                      ),

                    // Image
                    if (message.imageUrl != null && !isDeleted)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(8),
                          child: Image.network(
                            message.imageUrl!,
                            fit: BoxFit.cover,
                            errorBuilder: (_, __, ___) => Container(
                              width: 200,
                              height: 150,
                              color: Colors.grey[300],
                              child: const Icon(Icons.broken_image, size: 48),
                            ),
                          ),
                        ),
                      ),

                    // File attachment
                    if (message.fileUrl != null && !isDeleted)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(Icons.attach_file, size: 20),
                            const SizedBox(width: 8),
                            const Text('קובץ מצורף'),
                          ],
                        ),
                      ),

                    // Message body
                    if (isDeleted)
                      Text(
                        '🗑️ הודעה זו נמחקה',
                        style: theme.textTheme.bodyMedium?.copyWith(
                          fontStyle: FontStyle.italic,
                          color: theme.colorScheme.onSurface.withAlpha((255 * 0.5).round()),
                        ),
                      )
                    else
                      Text(
                        message.body,
                        style: theme.textTheme.bodyMedium,
                      ),

                    const SizedBox(height: 4),

                    // Timestamp, edited, and status
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          DateFormat.Hm('he').format(
                            DateTime.fromMillisecondsSinceEpoch(message.timestamp),
                          ),
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.onSurface.withAlpha((255 * 0.5).round()),
                          ),
                        ),
                        if (message.editedAt != null) ...[
                          const SizedBox(width: 4),
                          Text(
                            '(נערך)',
                            style: theme.textTheme.bodySmall?.copyWith(
                              fontStyle: FontStyle.italic,
                              color: theme.colorScheme.onSurface.withAlpha((255 * 0.5).round()),
                            ),
                          ),
                        ],
                        if (isOutgoing) ...[
                          const SizedBox(width: 4),
                          _buildStatusIcon(message.deliveryStatus),
                        ],
                      ],
                    ),

                    // Reactions
                    if (message.reactions != null && message.reactions!.isNotEmpty)
                      _buildReactions(context),
                  ],
                ),
              ),
            ),
            if (!isOutgoing) const SizedBox(width: 48),
          ],
        ),
      ),
    );
  }

  Widget _buildReplyReference(BuildContext context) {
    final replyTo = message.replyTo!;
    final theme = Theme.of(context);

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest.withAlpha((255 * 0.5).round()),
        borderRadius: BorderRadius.circular(8),
        border: Border(
          right: BorderSide(
            color: AppColors.primary,
            width: 3,
          ),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            replyTo.senderDisplayName ?? replyTo.sender,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.bold,
              color: AppColors.primary,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            replyTo.imageUrl != null
                ? '📷 תמונה'
                : (replyTo.body ?? '').length > 50
                    ? '${replyTo.body!.substring(0, 50)}...'
                    : (replyTo.body ?? ''),
            style: theme.textTheme.bodySmall,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
    );
  }

  Widget _buildStatusIcon(DeliveryStatus status) {
    IconData icon;
    Color color;

    switch (status) {
      case DeliveryStatus.pending:
        icon = Icons.schedule;
        color = Colors.grey;
        break;
      case DeliveryStatus.sent:
      case DeliveryStatus.queued:
        icon = Icons.check;
        color = Colors.grey;
        break;
      case DeliveryStatus.delivered:
        icon = Icons.done_all;
        color = Colors.grey;
        break;
      case DeliveryStatus.read:
        icon = Icons.done_all;
        color = AppColors.primary;
        break;
      case DeliveryStatus.failed:
        icon = Icons.error_outline;
        color = Colors.red;
        break;
    }

    return Icon(icon, size: 14, color: color);
  }

  Widget _buildReactions(BuildContext context) {
    final reactions = message.reactions!;
    final reactionCounts = <String, int>{};

    for (final reaction in reactions) {
      reactionCounts[reaction.emoji] = (reactionCounts[reaction.emoji] ?? 0) + 1;
    }

    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Wrap(
        spacing: 4,
        runSpacing: 4,
        children: reactionCounts.entries.map((entry) {
          return Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Text(
              '${entry.key} ${entry.value}',
              style: const TextStyle(fontSize: 12),
            ),
          );
        }).toList(),
      ),
    );
  }

  Color _getSenderColor(String sender) {
    // Generate consistent color based on sender name
    final hash = sender.hashCode;
    final colors = [
      Colors.blue,
      Colors.green,
      Colors.orange,
      Colors.purple,
      Colors.teal,
      Colors.pink,
      Colors.indigo,
      Colors.amber,
    ];
    return colors[hash.abs() % colors.length];
  }

  void _showMessageActions(BuildContext context) {
    showModalBottomSheet(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.reply),
              title: const Text('הגב'),
              onTap: () {
                Navigator.of(context).pop();
                onReply();
              },
            ),
            ListTile(
              leading: const Icon(Icons.emoji_emotions_outlined),
              title: const Text('הגב באימוג\'י'),
              onTap: () {
                Navigator.of(context).pop();
                _showEmojiPicker(context);
              },
            ),
            ListTile(
              leading: const Icon(Icons.copy),
              title: const Text('העתק'),
              onTap: () {
                Navigator.of(context).pop();
                onCopy();
              },
            ),
            if (onEdit != null)
              ListTile(
                leading: const Icon(Icons.edit),
                title: const Text('ערוך'),
                onTap: () {
                  Navigator.of(context).pop();
                  onEdit!();
                },
              ),
            if (onDelete != null)
              ListTile(
                leading: Icon(Icons.delete, color: Theme.of(context).colorScheme.error),
                title: Text('מחק', style: TextStyle(color: Theme.of(context).colorScheme.error)),
                onTap: () {
                  Navigator.of(context).pop();
                  onDelete!();
                },
              ),
          ],
        ),
      ),
    );
  }

  void _showEmojiPicker(BuildContext context) {
    final commonEmojis = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '👏'];

    showModalBottomSheet(
      context: context,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Wrap(
            spacing: 16,
            runSpacing: 16,
            alignment: WrapAlignment.center,
            children: commonEmojis.map((emoji) {
              return InkWell(
                onTap: () {
                  Navigator.of(context).pop();
                  onReact(emoji);
                },
                child: Text(emoji, style: const TextStyle(fontSize: 32)),
              );
            }).toList(),
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Reply Preview
// ---------------------------------------------------------------------------

class _ReplyPreview extends StatelessWidget {
  final MessageReference replyTo;
  final VoidCallback onCancel;

  const _ReplyPreview({
    required this.replyTo,
    required this.onCancel,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        border: Border(
          top: BorderSide(color: theme.dividerColor),
        ),
      ),
      child: Row(
        children: [
          Container(
            width: 3,
            height: 40,
            color: AppColors.primary,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  'מגיב ל: ${replyTo.senderDisplayName ?? replyTo.sender}',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.bold,
                    color: AppColors.primary,
                  ),
                ),
                Text(
                  replyTo.body ?? '📷 תמונה',
                  style: theme.textTheme.bodySmall,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          IconButton(
            icon: const Icon(Icons.close, size: 20),
            onPressed: onCancel,
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Edit Preview
// ---------------------------------------------------------------------------

class _EditPreview extends StatelessWidget {
  final ChatMessage message;
  final VoidCallback onCancel;

  const _EditPreview({
    required this.message,
    required this.onCancel,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        border: Border(
          top: BorderSide(color: theme.dividerColor),
        ),
      ),
      child: Row(
        children: [
          Icon(Icons.edit, size: 20, color: AppColors.primary),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  'עריכת הודעה',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.bold,
                    color: AppColors.primary,
                  ),
                ),
                Text(
                  message.body,
                  style: theme.textTheme.bodySmall,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          IconButton(
            icon: const Icon(Icons.close, size: 20),
            onPressed: onCancel,
          ),
        ],
      ),
    );
  }
}
