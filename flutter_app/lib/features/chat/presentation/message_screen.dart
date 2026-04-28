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
import 'package:url_launcher/url_launcher.dart';

import '../../../core/models/chat_models.dart';
import '../../../core/services/chat_store_service.dart';
import '../../../core/utils/toast_utils.dart';
import '../../../shared/theme/app_theme.dart';
import '../../../shared/widgets/authenticated_image.dart';
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
            icon: const Icon(Icons.arrow_back),
            onPressed: () {
              ref.read(chatStoreProvider.notifier).setCurrentChat(null);
              Navigator.of(context).pop();
            },
          ),
          title: Row(
            children: [
              GestureDetector(
                onTap: chatInfo.avatarUrl != null
                    ? () => _showAvatarPreview(context, chatInfo.title, chatInfo.avatarUrl!)
                    : null,
                child: AuthenticatedCircleAvatar(
                  url: chatInfo.avatarUrl,
                  radius: 20,
                  fallback: CircleAvatar(
                    radius: 20,
                    backgroundColor: Colors.white24,
                    child: Text(
                      chatInfo.title.isNotEmpty ? chatInfo.title[0].toUpperCase() : '?',
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      chatInfo.title,
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                      overflow: TextOverflow.ellipsis,
                    ),
                    if (chatInfo.subtitle != null)
                      Text(
                        chatInfo.subtitle!,
                        style: TextStyle(
                          fontSize: 12,
                          color: Colors.white.withAlpha((255 * 0.7).round()),
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                  ],
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

  ({String title, String? subtitle, bool isGroup, String? avatarUrl}) _getChatInfo(ChatState state) {
    final group = state.groups[widget.chatId];
    if (group != null) {
      return (
        title: group.name,
        subtitle: '${group.members.length} חברים',
        isGroup: true,
        avatarUrl: null,
      );
    }

    final contact = state.contacts[widget.chatId];
    return (
      title: contact?.displayName ?? widget.chatId,
      subtitle: contact?.info,
      isGroup: false,
      avatarUrl: (contact?.upic?.trim().isNotEmpty ?? false) ? contact!.upic : null,
    );
  }

  Widget _buildEmptyState(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Image.asset(
            'assets/images/logo.png',
            width: 80,
            height: 80,
            color: Theme.of(context).colorScheme.primary.withAlpha((255 * 0.3).round()),
            colorBlendMode: BlendMode.modulate,
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
    final state = ref.read(chatStoreProvider);
    final chatInfo = _getChatInfo(state);
    if (chatInfo.avatarUrl != null) {
      _showAvatarPreview(context, chatInfo.title, chatInfo.avatarUrl!);
    } else {
      showTopToast(context, 'פרטי שיחה - בקרוב');
    }
  }

  void _showAvatarPreview(BuildContext context, String title, String avatarUrl) {
    showDialog(
      context: context,
      barrierColor: Colors.black87,
      builder: (ctx) => Dialog(
        backgroundColor: Colors.transparent,
        insetPadding: const EdgeInsets.all(16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Align(
              alignment: Alignment.topLeft,
              child: IconButton(
                icon: const Icon(Icons.close, color: Colors.white),
                onPressed: () => Navigator.of(ctx).pop(),
              ),
            ),
            ClipRRect(
              borderRadius: BorderRadius.circular(12),
              child: AuthenticatedNetworkImage(
                url: avatarUrl,
                fit: BoxFit.contain,
              ),
            ),
            const SizedBox(height: 12),
            Text(
              title,
              style: const TextStyle(
                color: Colors.white,
                fontSize: 16,
                fontWeight: FontWeight.bold,
              ),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }

  void _showSearch() {
    showTopToast(context, 'חיפוש בשיחה - בקרוב');
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
    showTopToast(context, 'ההודעה הועתקה', duration: const Duration(seconds: 1));
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
// Full-screen image viewer (top-level so _MessageBubble can call it)
// ---------------------------------------------------------------------------

void _showFullScreenImage(BuildContext context, String imageUrl) {
  final size = MediaQuery.of(context).size;
  showDialog<void>(
    context: context,
    barrierDismissible: true,
    barrierColor: Colors.black87,
    builder: (ctx) => Dialog(
      backgroundColor: Colors.transparent,
      insetPadding: EdgeInsets.zero,
      child: Stack(
        children: [
          // Tap outside the image to dismiss
          GestureDetector(
            onTap: () => Navigator.of(ctx).pop(),
            child: const SizedBox.expand(),
          ),
          Center(
            child: InteractiveViewer(
              maxScale: 4,
              child: AuthenticatedNetworkImage(
                url: imageUrl,
                width: size.width,
                height: size.height * 0.85,
                fit: BoxFit.contain,
              ),
            ),
          ),
          Positioned(
            top: MediaQuery.of(ctx).padding.top + 4,
            right: 4,
            child: IconButton(
              onPressed: () => Navigator.of(ctx).pop(),
              icon: const Icon(Icons.close, color: Colors.white, size: 28),
              style: IconButton.styleFrom(backgroundColor: Colors.black38),
            ),
          ),
        ],
      ),
    ),
  );
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
            if (isOutgoing) const SizedBox(width: 8),
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
                        child: GestureDetector(
                          onTap: () =>
                              _showFullScreenImage(context, message.imageUrl!),
                          child: ClipRRect(
                            borderRadius: BorderRadius.circular(8),
                            child: AuthenticatedNetworkImage(
                              url: message.imageUrl!,
                              width: 200,
                              height: 150,
                            ),
                          ),
                        ),
                      ),

                    // File attachment
                    if (message.fileUrl != null && !isDeleted)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: _FileAttachmentButton(url: message.fileUrl!),
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
                      _MessageBody(body: message.body, theme: theme),

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
            if (!isOutgoing) const SizedBox(width: 8),
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

/// Renders a message body. Google Maps links (📍 ...) are shown as a
/// tappable location button; plain text is displayed as-is.
class _MessageBody extends StatelessWidget {
  final String body;
  final ThemeData theme;

  const _MessageBody({required this.body, required this.theme});

  static final _mapsRegex = RegExp(
    r'https?://(www\.)?(maps\.google\.com|google\.com/maps|maps\.app\.goo\.gl)[^\s]*',
    caseSensitive: false,
  );

  @override
  Widget build(BuildContext context) {
    final match = _mapsRegex.firstMatch(body);
    if (match == null) {
      return Text(body, style: theme.textTheme.bodyMedium);
    }

    final mapUrl = match.group(0)!;
    // Text before the URL (e.g. "📍 ")
    final prefix = body.substring(0, match.start).trimRight();
    // Text after the URL
    final suffix = body.substring(match.end).trimLeft();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (prefix.isNotEmpty)
          Text(prefix, style: theme.textTheme.bodyMedium),
        _LocationButton(url: mapUrl),
        if (suffix.isNotEmpty)
          Text(suffix, style: theme.textTheme.bodyMedium),
      ],
    );
  }
}

/// A tappable button that opens a Google Maps URL.
class _LocationButton extends StatelessWidget {
  final String url;

  const _LocationButton({required this.url});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: () async {
        final uri = Uri.tryParse(url);
        if (uri != null) {
          try {
            await launchUrl(uri, mode: LaunchMode.externalApplication);
          } catch (_) {}
        }
      },
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          color: AppColors.primary.withAlpha((255 * 0.1).round()),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(
            color: AppColors.primary.withAlpha((255 * 0.3).round()),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.location_on, color: AppColors.primary, size: 20),
            const SizedBox(width: 6),
            Text(
              'המיקום שלי',
              style: TextStyle(
                color: AppColors.primary,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A tappable file attachment button. Detects PDF files and shows an
/// appropriate icon. Tapping opens the file URL in an external application.
class _FileAttachmentButton extends StatelessWidget {
  final String url;

  const _FileAttachmentButton({required this.url});

  bool get _isPdf => url.toLowerCase().contains('.pdf');

  String get _fileName {
    try {
      final path = Uri.parse(url).pathSegments.last;
      return Uri.decodeComponent(path);
    } catch (_) {
      return 'קובץ מצורף';
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final icon = _isPdf ? Icons.picture_as_pdf : Icons.attach_file;
    final iconColor = _isPdf ? Colors.red.shade700 : AppColors.primary;

    return InkWell(
      onTap: () async {
        final uri = Uri.tryParse(url);
        if (uri != null) {
          try {
            await launchUrl(uri, mode: LaunchMode.externalApplication);
          } catch (_) {}
        }
      },
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          color: iconColor.withAlpha((255 * 0.1).round()),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: iconColor.withAlpha((255 * 0.3).round())),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, color: iconColor, size: 20),
            const SizedBox(width: 6),
            Flexible(
              child: Text(
                _fileName,
                style: TextStyle(
                  color: iconColor,
                  fontWeight: FontWeight.w600,
                  fontSize: 13,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
