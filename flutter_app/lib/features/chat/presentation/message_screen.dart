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
import 'group_info_screen.dart';
import 'message_composer.dart';

/// Message screen widget
class MessageScreen extends ConsumerStatefulWidget {
  final String chatId;

  /// Number of unread messages at the time the screen was opened.
  /// When > 0 the list will be scrolled so the first unread message
  /// is visible at the bottom of the viewport, allowing the user to
  /// start reading from where they left off.
  final int initialUnreadCount;

  const MessageScreen({super.key, required this.chatId, this.initialUnreadCount = 0});

  @override
  ConsumerState<MessageScreen> createState() => _MessageScreenState();
}

class _MessageScreenState extends ConsumerState<MessageScreen> {
  late final ScrollController _scrollController;
  MessageReference? _replyTo;
  ChatMessage? _editingMessage;

  // Search state
  bool _searchActive = false;
  String _searchQuery = '';
  late final TextEditingController _searchController;
  late final FocusNode _searchFocus;

  /// Whether the user has scrolled up far enough that the scroll-to-bottom
  /// button should be visible. Updated by the scroll listener.
  bool _showScrollButton = false;

  /// Pixels from the bottom (offset 0 in a reversed list) that must be
  /// exceeded before the scroll-to-bottom button appears.  Mirrors Angular's
  /// `scrollBottomThresholdPx = 44`.
  static const double _scrollBottomThreshold = 44.0;

  /// The date label currently shown in the floating date badge at the top of
  /// the messages area (e.g. "היום", "אתמול", "01/05/2025").
  /// Mirrors Angular's `stickyMessageDateLabel` / `messages-sticky-date`.
  String? _stickyDate;

  /// Latest snapshot of the visible message list, kept in sync inside [build]
  /// so the scroll listener can compute the floating date without BuildContext.
  List<ChatMessage> _currentMessages = [];

  /// Key placed on the "unread messages" divider so we can scroll to it
  /// precisely once the list has been laid out.
  final _unreadDividerKey = GlobalKey();

  /// Approximate height of one message item (bubble + padding).
  /// Represents a typical single-line text bubble: ~48 px content + 24 px
  /// vertical padding.  Used both for estimating the initial scroll offset
  /// when there are unread messages and for the floating date calculation.
  static const double _estimatedItemHeight = 72.0;

  @override
  void initState() {
    super.initState();
    final unread = widget.initialUnreadCount;
    // Start the scroll near the boundary so the divider is in the initial
    // render window and `ensureVisible` can work on it.
    final estimatedOffset = unread > 0 ? (unread * _estimatedItemHeight) : 0.0;
    _scrollController = ScrollController(initialScrollOffset: estimatedOffset);
    _searchController = TextEditingController();
    _searchFocus = FocusNode();
    _searchController.addListener(() {
      setState(() => _searchQuery = _searchController.text.trim().toLowerCase());
    });

    // Listen for scroll position changes to show/hide the scroll-to-bottom
    // button and update the floating date badge.
    _scrollController.addListener(_onScrollChanged);

    if (unread > 0) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToFirstUnread());
    }

    // Seed the floating date badge on first layout.
    WidgetsBinding.instance.addPostFrameCallback((_) => _updateStickyDate());
  }

  /// Updates [_showScrollButton] and [_stickyDate] whenever the scroll
  /// position changes.
  /// Because the list is `reverse: true`, offset 0 is the bottom (newest
  /// messages). The button appears when the user has scrolled more than
  /// [_scrollBottomThreshold] pixels away from the bottom.
  void _onScrollChanged() {
    final shouldShow = _scrollController.hasClients &&
        _scrollController.offset > _scrollBottomThreshold;
    if (shouldShow != _showScrollButton) {
      setState(() => _showScrollButton = shouldShow);
    }
    _updateStickyDate();
  }

  /// Computes and stores the floating date label for the topmost visible
  /// message.  In a `reverse: true` ListView the topmost visible item has a
  /// reversed-list index of ≈ (offset + viewportHeight) / estimatedItemHeight.
  void _updateStickyDate() {
    // No need to update while search is active — the badge is hidden.
    if (_searchActive) return;
    if (!_scrollController.hasClients || _currentMessages.isEmpty) {
      if (_stickyDate != null) setState(() => _stickyDate = null);
      return;
    }
    final position = _scrollController.position;
    final offset = position.pixels;
    final viewport = position.viewportDimension;

    // Approximate reversed-list index of the message at the top of the viewport.
    final topReversedIdx =
        ((offset + viewport) / _estimatedItemHeight).floor()
            .clamp(0, _currentMessages.length - 1);

    final date = _formatStickyDate(_currentMessages[topReversedIdx].timestamp);
    if (date != _stickyDate) {
      setState(() => _stickyDate = date);
    }
  }

  /// Returns a short human-readable date string for the floating date badge.
  /// Mirrors Angular's `formatMessageDateBadge`.
  String _formatStickyDate(int timestamp) {
    final date = DateTime.fromMillisecondsSinceEpoch(timestamp);
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final yesterday = today.subtract(const Duration(days: 1));
    final messageDay = DateTime(date.year, date.month, date.day);
    if (messageDay == today) return 'היום';
    if (messageDay == yesterday) return 'אתמול';
    return DateFormat('dd/MM/yyyy').format(date);
  }

  void _scrollToFirstUnread() {
    final ctx = _unreadDividerKey.currentContext;
    if (ctx == null) return;
    Scrollable.ensureVisible(
      ctx,
      alignment: 1.0, // place the divider at the bottom of the viewport
      duration: const Duration(milliseconds: 300),
      curve: Curves.easeOut,
    );
  }

  @override
  void dispose() {
    _scrollController.removeListener(_onScrollChanged);
    _scrollController.dispose();
    _searchController.dispose();
    _searchFocus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(chatStoreProvider);
    final allMessages = state.messagesByChat[widget.chatId] ?? [];
    final chatInfo = _getChatInfo(state);

    // Filter messages when search is active
    final messages = (_searchActive && _searchQuery.isNotEmpty)
        ? allMessages
            .where((m) =>
                (m.body ?? '').toLowerCase().contains(_searchQuery))
            .toList()
        : allMessages;

    // Keep _currentMessages in sync so the scroll listener can access the
    // latest message list for floating-date computation.
    _currentMessages = messages;

    return Directionality(
      textDirection: ui.TextDirection.rtl,
      child: Scaffold(
        appBar: _searchActive
            ? AppBar(
                leading: IconButton(
                  icon: const Icon(Icons.arrow_back),
                  onPressed: _closeSearch,
                ),
                title: TextField(
                  controller: _searchController,
                  focusNode: _searchFocus,
                  textDirection: ui.TextDirection.rtl,
                  style: const TextStyle(color: Colors.white),
                  cursorColor: Colors.white,
                  decoration: InputDecoration(
                    hintText: 'חיפוש בשיחה...',
                    hintStyle:
                        TextStyle(color: Colors.white.withAlpha(178)),
                    border: InputBorder.none,
                  ),
                ),
                actions: [
                  if (_searchQuery.isNotEmpty)
                    IconButton(
                      icon: const Icon(Icons.close),
                      onPressed: () {
                        _searchController.clear();
                        setState(() => _searchQuery = '');
                      },
                    ),
                ],
              )
            : AppBar(
                leading: IconButton(
                  icon: const Icon(Icons.arrow_back),
                  onPressed: () {
                    ref.read(chatStoreProvider.notifier).setCurrentChat(null);
                    Navigator.of(context).pop();
                  },
                ),
                title: GestureDetector(
                  onTap: chatInfo.isGroup
                      ? () => _openGroupInfo()
                      : (chatInfo.avatarUrl != null
                          ? () => _showAvatarPreview(
                              context, chatInfo.title, chatInfo.avatarUrl!)
                          : null),
                  child: Row(
                    children: [
                      AuthenticatedCircleAvatar(
                        url: chatInfo.avatarUrl,
                        radius: 20,
                        fallback: CircleAvatar(
                          radius: 20,
                          backgroundColor: Colors.white24,
                          child: Text(
                            chatInfo.title.isNotEmpty
                                ? chatInfo.title[0].toUpperCase()
                                : '?',
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 16,
                              fontWeight: FontWeight.bold,
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
                              style: const TextStyle(
                                  fontSize: 16, fontWeight: FontWeight.bold),
                              overflow: TextOverflow.ellipsis,
                            ),
                            if (chatInfo.subtitle != null)
                              Text(
                                chatInfo.subtitle!,
                                style: TextStyle(
                                  fontSize: 12,
                                  color:
                                      Colors.white.withAlpha((255 * 0.7).round()),
                                ),
                                overflow: TextOverflow.ellipsis,
                              ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                actions: [
                  IconButton(
                    icon: const Icon(Icons.search),
                    tooltip: 'חיפוש',
                    onPressed: _openSearch,
                  ),
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
                    ],
                  ),
                ],
              ),
        body: Column(
          children: [
            // Messages list + scroll-to-bottom FAB
            Expanded(
              child: Stack(
                children: [
                  // ── Message list ──────────────────────────────────────────
                  messages.isEmpty
                   ? (_searchActive && _searchQuery.isNotEmpty
                       ? _buildSearchEmpty(context)
                       : _buildEmptyState(context))
                   : ListView.builder(
                       controller: _scrollController,
                       reverse: true,
                       padding: const EdgeInsets.symmetric(
                           horizontal: 8, vertical: 16),
                       // +1 for the optional unread divider slot (only when not searching)
                       itemCount: messages.length +
                           (!_searchActive && widget.initialUnreadCount > 0
                               ? 1
                               : 0),
                       itemBuilder: (context, index) {
                         // With reverse: true, index 0 = newest message (bottom).
                         // The unread divider sits just below the first unread message,
                         // i.e. at position `initialUnreadCount` in the reversed list
                         // (between last-read and first-unread).
                         final unread =
                             !_searchActive ? widget.initialUnreadCount : 0;
                         if (unread > 0 && index == unread) {
                           return _buildUnreadDivider(context);
                         }

                         // Shift the message index down by 1 after the divider slot.
                         final msgIndex =
                             (unread > 0 && index > unread) ? index - 1 : index;
                         if (msgIndex >= messages.length) {
                           return const SizedBox.shrink();
                         }

                         final message = messages[msgIndex];
                         final previousMessage = msgIndex < messages.length - 1
                             ? messages[msgIndex + 1]
                             : null;
                         final showDateHeader =
                             _shouldShowDateHeader(message, previousMessage);

                         // Resolve a non-null sender label for group bubbles.
                         // Older messages or edge-case payloads may arrive
                         // without `senderDisplayName`; fall back to contacts
                         // and finally to the raw sender username so the
                         // user can always tell who sent the message in a
                         // group (matches what the FCM notification shows).
                         String? resolvedSenderLabel;
                         if (chatInfo.isGroup &&
                             message.direction !=
                                 MessageDirection.outgoing) {
                           final senderId = message.sender.trim();
                           final senderIsGroupId = senderId.toLowerCase() ==
                               widget.chatId.trim().toLowerCase();
                           final fromName =
                               (message.senderDisplayName ?? '').trim();
                           final fromContact = (state.contacts[senderId]
                                       ?.displayName ??
                                   '')
                               .trim();
                           if (fromName.isNotEmpty) {
                             resolvedSenderLabel = fromName;
                           } else if (fromContact.isNotEmpty) {
                             resolvedSenderLabel = fromContact;
                           } else if (!senderIsGroupId &&
                               senderId.isNotEmpty) {
                             resolvedSenderLabel = senderId;
                           }
                         }

                         return Column(
                           children: [
                             if (showDateHeader)
                               _buildDateHeader(context, message.timestamp),
                             _MessageBubble(
                               message: message,
                               isGroup: chatInfo.isGroup,
                               resolvedSenderLabel: resolvedSenderLabel,
                               searchQuery:
                                   _searchActive ? _searchQuery : null,
                               onReply: () => setState(
                                   () => _replyTo = MessageReference(
                                         messageId: message.messageId,
                                         sender: message.sender,
                                         senderDisplayName:
                                             message.senderDisplayName,
                                         body: message.body,
                                         imageUrl: message.imageUrl,
                                       )),
                               onReact: (emoji) =>
                                   _handleReaction(message, emoji),
                               onEdit:
                                   message.direction == MessageDirection.outgoing
                                       ? () => setState(
                                           () => _editingMessage = message)
                                       : null,
                               onDelete:
                                   message.direction == MessageDirection.outgoing
                                       ? () => _handleDelete(message)
                                       : null,
                               onCopy: () => _handleCopy(message),
                               onForward: () => _handleForward(message),
                             ),
                           ],
                         );
                       },
                     ),

                  // ── Scroll-to-bottom button ───────────────────────────────
                  // Shown when the user has scrolled up (offset > threshold).
                  // Mirrors Angular's `scroll-bottom-btn`.
                  if (!_searchActive)
                    Positioned(
                      bottom: 12,
                      left: 12,
                      child: AnimatedOpacity(
                        opacity: _showScrollButton ? 1.0 : 0.0,
                        duration: const Duration(milliseconds: 200),
                        child: IgnorePointer(
                          ignoring: !_showScrollButton,
                          child: FloatingActionButton.small(
                            heroTag: 'scrollToBottom_${widget.chatId}',
                            onPressed: _scrollToBottom,
                            tooltip: 'גלול להודעה האחרונה',
                            backgroundColor:
                                Theme.of(context).colorScheme.primaryContainer,
                            foregroundColor:
                                Theme.of(context).colorScheme.onPrimaryContainer,
                            elevation: 2,
                            child: const Icon(Icons.keyboard_arrow_down),
                          ),
                        ),
                      ),
                    ),

                  // ── Floating date badge ───────────────────────────────────
                  // Shows the date of the topmost visible message, mirroring
                  // Angular's `messages-sticky-date` chip.
                  if (!_searchActive && _stickyDate != null && messages.isNotEmpty)
                    Positioned(
                      top: 8,
                      left: 0,
                      right: 0,
                      child: Center(
                        child: AnimatedOpacity(
                          opacity: 1.0,
                          duration: const Duration(milliseconds: 200),
                          child: Container(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 12, vertical: 6),
                            decoration: BoxDecoration(
                              color: Theme.of(context)
                                  .colorScheme
                                  .surfaceContainerHighest
                                  .withAlpha(230),
                              borderRadius: BorderRadius.circular(16),
                              boxShadow: [
                                BoxShadow(
                                  color: Colors.black.withAlpha(25),
                                  blurRadius: 4,
                                  offset: const Offset(0, 1),
                                ),
                              ],
                            ),
                            child: Text(
                              _stickyDate!,
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),

            // Reply preview (hidden while searching)
            if (!_searchActive && _replyTo != null)
              _ReplyPreview(
                replyTo: _replyTo!,
                onCancel: () => setState(() => _replyTo = null),
              ),

            // Edit preview (hidden while searching)
            if (!_searchActive && _editingMessage != null)
              _EditPreview(
                message: _editingMessage!,
                onCancel: () => setState(() => _editingMessage = null),
              ),

            // Typing indicator (hidden while searching)
            if (!_searchActive)
              _TypingIndicatorRow(
                chatId: widget.chatId,
                state: state,
              ),

            // Message composer (hidden while searching)
            if (!_searchActive)
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

  Widget _buildUnreadDivider(BuildContext context) {
    return Padding(
      key: _unreadDividerKey,
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          const Expanded(child: Divider()),
          const SizedBox(width: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            decoration: BoxDecoration(
              color: const Color(0xFF1976D2).withAlpha((255 * 0.15).round()),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Text(
              '${widget.initialUnreadCount} הודעות שלא נקראו',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: const Color(0xFF1976D2),
                    fontWeight: FontWeight.w600,
                  ),
            ),
          ),
          const SizedBox(width: 8),
          const Expanded(child: Divider()),
        ],
      ),
    );
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
    }
  }

  void _showChatInfo() {
    final state = ref.read(chatStoreProvider);
    final chatInfo = _getChatInfo(state);
    if (chatInfo.isGroup) {
      _openGroupInfo();
    } else if (chatInfo.avatarUrl != null) {
      _showAvatarPreview(context, chatInfo.title, chatInfo.avatarUrl!);
    } else {
      showTopToast(context, 'פרטי שיחה - בקרוב');
    }
  }

  void _openGroupInfo() {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => GroupInfoScreen(groupId: widget.chatId),
      ),
    );
  }

  void _openSearch() {
    setState(() {
      _searchActive = true;
      _searchQuery = '';
    });
    WidgetsBinding.instance
        .addPostFrameCallback((_) => _searchFocus.requestFocus());
  }

  void _closeSearch() {
    _searchController.clear();
    setState(() {
      _searchActive = false;
      _searchQuery = '';
    });
  }

  Widget _buildSearchEmpty(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.search_off,
            size: 60,
            color: Theme.of(context)
                .colorScheme
                .onSurface
                .withAlpha((255 * 0.3).round()),
          ),
          const SizedBox(height: 12),
          Text(
            'לא נמצאו הודעות עבור "$_searchQuery"',
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: Theme.of(context)
                      .colorScheme
                      .onSurface
                      .withAlpha((255 * 0.5).round()),
                ),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
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

  void _handleForward(ChatMessage message) {
    final state = ref.read(chatStoreProvider);
    final contacts = state.contacts.values.toList()
      ..sort((a, b) => a.displayName.compareTo(b.displayName));

    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) => _ForwardContactPicker(
        contacts: contacts,
        onContactSelected: (contact) async {
          Navigator.of(ctx).pop();
          final senderName = state.contacts[message.sender]?.displayName ??
              ref.read(chatStoreProvider.notifier).getDisplayName(message.sender);
          try {
            await ref.read(chatStoreProvider.notifier).sendDirectMessage(
              recipient: contact.username,
              body: message.body,
              imageUrl: message.imageUrl,
              fileUrl: message.fileUrl,
              forwarded: true,
              forwardedFrom: message.sender,
              forwardedFromName: senderName,
            );
            if (mounted) {
              showTopToast(context, 'ההודעה הועברה ל${contact.displayName}');
            }
          } catch (_) {
            if (mounted) {
              showTopToast(context, 'שגיאה בהעברת ההודעה');
            }
          }
        },
      ),
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
  final String? resolvedSenderLabel;
  final String? searchQuery;
  final VoidCallback onReply;
  final void Function(String emoji) onReact;
  final VoidCallback? onEdit;
  final VoidCallback? onDelete;
  final VoidCallback onCopy;
  final VoidCallback onForward;

  const _MessageBubble({
    required this.message,
    required this.isGroup,
    this.resolvedSenderLabel,
    this.searchQuery,
    required this.onReply,
    required this.onReact,
    this.onEdit,
    this.onDelete,
    required this.onCopy,
    required this.onForward,
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
                    if (isGroup &&
                        !isOutgoing &&
                        (resolvedSenderLabel ?? message.senderDisplayName) !=
                            null &&
                        (resolvedSenderLabel ?? message.senderDisplayName!)
                            .trim()
                            .isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 4),
                        child: Text(
                          resolvedSenderLabel ?? message.senderDisplayName!,
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
                      _MessageBody(body: message.body, theme: theme, searchQuery: searchQuery),

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
            ListTile(
              leading: const Icon(Icons.forward),
              title: const Text('העבר'),
              onTap: () {
                Navigator.of(context).pop();
                onForward();
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

/// Shows a "…is typing" bubble below the message list.
/// Only visible when another user in this chat is actively typing.
class _TypingIndicatorRow extends StatelessWidget {
  final String chatId;
  final ChatState state;

  const _TypingIndicatorRow({required this.chatId, required this.state});

  @override
  Widget build(BuildContext context) {
    final typingSet = state.typingByChatId[chatId] ?? const <String>{};
    if (typingSet.isEmpty) return const SizedBox.shrink();

    // Resolve display names for the typing users.
    String label;
    if (typingSet.length == 1) {
      final username = typingSet.first;
      final displayName =
          state.contacts[username]?.displayName ?? username;
      label = '$displayName מקליד/ה...';
    } else {
      label = 'כמה אנשים מקלידים...';
    }

    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      child: Row(
        children: [
          // Animated three-dot indicator
          _DotsAnimation(),
          const SizedBox(width: 8),
          Text(
            label,
            style: theme.textTheme.bodySmall?.copyWith(
              fontStyle: FontStyle.italic,
              color: theme.colorScheme.onSurface.withAlpha((255 * 0.6).round()),
            ),
          ),
        ],
      ),
    );
  }
}

/// Three animated dots used as the typing indicator.
class _DotsAnimation extends StatefulWidget {
  const _DotsAnimation();

  @override
  State<_DotsAnimation> createState() => _DotsAnimationState();
}

class _DotsAnimationState extends State<_DotsAnimation>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 900),
    )..repeat();
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context)
        .colorScheme
        .onSurface
        .withAlpha((255 * 0.5).round());
    return AnimatedBuilder(
      animation: _ctrl,
      builder: (_, __) {
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: List.generate(3, (i) {
            final delay = i / 3;
            final phase = ((_ctrl.value - delay) % 1.0 + 1.0) % 1.0;
            final scale = 0.6 + 0.4 * (phase < 0.5 ? phase * 2 : (1 - phase) * 2);
            return Container(
              margin: const EdgeInsets.symmetric(horizontal: 2),
              width: 6,
              height: 6,
              decoration: BoxDecoration(
                color: color,
                shape: BoxShape.circle,
              ),
              transform: Matrix4.identity()..scale(scale),
            );
          }),
        );
      },
    );
  }
}


class _MessageBody extends StatelessWidget {
  final String body;
  final ThemeData theme;
  final String? searchQuery;

  const _MessageBody(
      {required this.body, required this.theme, this.searchQuery});

  static final _mapsRegex = RegExp(
    r'https?://(www\.)?(maps\.google\.com|google\.com/maps|maps\.app\.goo\.gl)[^\s]*',
    caseSensitive: false,
  );

  /// Build a [TextSpan] with search-term highlights.
  InlineSpan _buildHighlightedSpan(String text, TextStyle base) {
    final q = searchQuery;
    if (q == null || q.isEmpty) return TextSpan(text: text, style: base);

    final lower = text.toLowerCase();
    final spans = <InlineSpan>[];
    int start = 0;
    int idx;
    while ((idx = lower.indexOf(q, start)) != -1) {
      if (idx > start) {
        spans.add(TextSpan(text: text.substring(start, idx), style: base));
      }
      spans.add(TextSpan(
        text: text.substring(idx, idx + q.length),
        style: base.copyWith(
          backgroundColor: Colors.yellow.shade600,
          color: Colors.black,
          fontWeight: FontWeight.bold,
        ),
      ));
      start = idx + q.length;
    }
    if (start < text.length) {
      spans.add(TextSpan(text: text.substring(start), style: base));
    }
    return TextSpan(children: spans);
  }

  @override
  Widget build(BuildContext context) {
    final base = theme.textTheme.bodyMedium ?? const TextStyle();
    final match = _mapsRegex.firstMatch(body);
    if (match == null) {
      return RichText(
        text: TextSpan(children: [_buildHighlightedSpan(body, base)]),
      );
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
          RichText(
              text: TextSpan(
                  children: [_buildHighlightedSpan(prefix, base)])),
        _LocationButton(url: mapUrl),
        if (suffix.isNotEmpty)
          RichText(
              text: TextSpan(
                  children: [_buildHighlightedSpan(suffix, base)])),
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


// ---------------------------------------------------------------------------
// Forward contact picker
// ---------------------------------------------------------------------------

class _ForwardContactPicker extends StatefulWidget {
  final List<Contact> contacts;
  final void Function(Contact contact) onContactSelected;

  const _ForwardContactPicker({
    required this.contacts,
    required this.onContactSelected,
  });

  @override
  State<_ForwardContactPicker> createState() => _ForwardContactPickerState();
}

class _ForwardContactPickerState extends State<_ForwardContactPicker> {
  String _query = '';

  List<Contact> get _filtered {
    if (_query.isEmpty) return widget.contacts;
    final q = _query.toLowerCase();
    return widget.contacts
        .where((c) =>
            c.displayName.toLowerCase().contains(q) ||
            c.username.toLowerCase().contains(q))
        .toList();
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _filtered;
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.6,
      maxChildSize: 0.9,
      minChildSize: 0.4,
      builder: (_, scrollController) => Column(
        children: [
          const SizedBox(height: 12),
          Container(
            width: 40,
            height: 4,
            decoration: BoxDecoration(
              color: Colors.grey[400],
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          const SizedBox(height: 12),
          const Text(
            'העבר הודעה',
            style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
            textDirection: ui.TextDirection.rtl,
          ),
          const SizedBox(height: 8),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: TextField(
              autofocus: false,
              textDirection: ui.TextDirection.rtl,
              decoration: const InputDecoration(
                hintText: 'חפש איש קשר...',
                prefixIcon: Icon(Icons.search),
                border: OutlineInputBorder(),
                isDense: true,
                contentPadding:
                    EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              ),
              onChanged: (v) => setState(() => _query = v),
            ),
          ),
          const SizedBox(height: 8),
          Expanded(
            child: filtered.isEmpty
                ? const Center(child: Text('לא נמצאו אנשי קשר'))
                : ListView.builder(
                    controller: scrollController,
                    itemCount: filtered.length,
                    itemBuilder: (_, i) {
                      final contact = filtered[i];
                      return ListTile(
                        leading: CircleAvatar(
                          child: Text(
                            contact.displayName.isNotEmpty
                                ? contact.displayName[0].toUpperCase()
                                : '?',
                          ),
                        ),
                        title: Text(
                          contact.displayName,
                          textDirection: ui.TextDirection.rtl,
                        ),
                        subtitle: contact.info != null
                            ? Text(contact.info!,
                                textDirection: ui.TextDirection.rtl)
                            : null,
                        onTap: () => widget.onContactSelected(contact),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}
