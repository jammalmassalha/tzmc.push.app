/// Chat shell screen - main chat interface.
///
/// This is the main screen shown after authentication,
/// containing the chat list, message view, and navigation.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/realtime/realtime_transport_service.dart';
import '../../../core/services/chat_store_service.dart';
import '../../../core/services/push_notification_service.dart';
import '../../auth/presentation/auth_state.dart';
import '../../helpdesk/presentation/helpdesk_screen.dart';
import '../../shuttle/presentation/shuttle_screen.dart';
import '../../../shared/theme/app_theme.dart';
import 'chat_list_screen.dart';
import 'create_group_dialog.dart';
import 'message_screen.dart';
import 'new_chat_dialog.dart';

/// Main tab enumeration
enum MainTab { chats, groups, shuttle, helpdesk, settings }

/// Chat shell screen widget
class ChatShellScreen extends ConsumerStatefulWidget {
  const ChatShellScreen({super.key});

  @override
  ConsumerState<ChatShellScreen> createState() => _ChatShellScreenState();
}

class _ChatShellScreenState extends ConsumerState<ChatShellScreen> {
  MainTab _currentTab = MainTab.chats;
  final _pageController = PageController();

  @override
  void initState() {
    super.initState();
    _initializeServices();
  }

  void _initializeServices() {
    final user = ref.read(currentUserProvider);
    if (user == null) return;

    // Initialize realtime transport.
    final transport = ref.read(realtimeTransportServiceProvider);
    transport.connect(user, isNetworkReachable: () => true);

    // Kick off chat store initialization but do not block push notification
    // setup on it. ChatStoreNotifier.initialize() can throw (e.g. on web
    // while drift/sqlite-wasm warms up, or when the message-recovery
    // network call fails); previously the .then() chain was the only path
    // that triggered the notification permission prompt, so a single
    // chat-store hiccup would silently suppress the browser's permission
    // dialog forever on the web build.
    unawaited(
      ref
          .read(chatStoreProvider.notifier)
          .initialize(user)
          .catchError((Object e, StackTrace st) {
        debugPrint('[ChatShellScreen] chatStore.initialize error: $e');
      }),
    );

    // Initialize push notifications and request permission independently of
    // chat store init. ensurePermissionAndRegister() shows a Hebrew
    // rationale dialog before the OS / browser prompt, so wait one frame
    // to make sure [context] is mounted.
    unawaited(_initializePushNotifications());
  }

  Future<void> _initializePushNotifications() async {
    try {
      await ref.read(pushNotificationServiceProvider).initialize();
    } catch (e) {
      debugPrint('[ChatShellScreen] pushNotificationService.initialize error: $e');
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final push = ref.read(pushNotificationServiceProvider);
      push.ensurePermissionAndRegister(context);
      // Replay any FCM token that was fetched before the auth user was
      // available (race on Android during cold-start / re-login).
      unawaited(push.registerPendingTokenForUser());
    });
  }

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final user = ref.watch(currentUserProvider);

    return Directionality(
      textDirection: TextDirection.rtl,
      child: Scaffold(
        appBar: AppBar(
          title: Text(_getTabTitle(_currentTab)),
          actions: [
            // Connection status indicator
            Consumer(
              builder: (context, ref, _) {
                final transport = ref.watch(realtimeTransportServiceProvider);
                return Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  child: Tooltip(
                    message: transport.transportLabel,
                    child: Icon(
                      _getConnectionIcon(transport.transportMode),
                      size: 20,
                      color: _getConnectionColor(transport.transportMode),
                    ),
                  ),
                );
              },
            ),
            // Settings menu
            PopupMenuButton<String>(
              icon: const Icon(Icons.more_vert),
              onSelected: (value) {
                switch (value) {
                  case 'logout':
                    _handleLogout();
                    break;
                  case 'refresh':
                    _handleRefresh();
                    break;
                }
              },
              itemBuilder: (context) => [
                PopupMenuItem(
                  value: 'refresh',
                  child: Row(
                    children: [
                      const Icon(Icons.refresh, size: 20),
                      const SizedBox(width: 12),
                      const Text('רענון'),
                    ],
                  ),
                ),
                const PopupMenuDivider(),
                PopupMenuItem(
                  value: 'logout',
                  child: Row(
                    children: [
                      Icon(Icons.logout, size: 20, color: Theme.of(context).colorScheme.error),
                      const SizedBox(width: 12),
                      Text('התנתקות', style: TextStyle(color: Theme.of(context).colorScheme.error)),
                    ],
                  ),
                ),
              ],
            ),
          ],
        ),
        body: PageView(
          controller: _pageController,
          onPageChanged: (index) {
            setState(() {
              _currentTab = MainTab.values[index];
            });
          },
          children: [
            _buildChatsTab(),
            _buildGroupsTab(),
            _buildShuttleTab(),
            _buildHelpdeskTab(),
            _buildSettingsTab(),
          ],
        ),
        bottomNavigationBar: BottomNavigationBar(
          currentIndex: _currentTab.index,
          onTap: (index) {
            setState(() {
              _currentTab = MainTab.values[index];
            });
            _pageController.animateToPage(
              index,
              duration: const Duration(milliseconds: 300),
              curve: Curves.easeInOut,
            );
          },
          items: const [
            BottomNavigationBarItem(
              icon: Icon(Icons.chat_bubble_outline),
              activeIcon: Icon(Icons.chat_bubble),
              label: 'צ\'אטים',
            ),
            BottomNavigationBarItem(
              icon: Icon(Icons.group_outlined),
              activeIcon: Icon(Icons.group),
              label: 'קבוצות',
            ),
            BottomNavigationBarItem(
              icon: Icon(Icons.directions_bus_outlined),
              activeIcon: Icon(Icons.directions_bus),
              label: 'הסעות',
            ),
            BottomNavigationBarItem(
              icon: Icon(Icons.support_agent_outlined),
              activeIcon: Icon(Icons.support_agent),
              label: 'תמיכה',
            ),
            BottomNavigationBarItem(
              icon: Icon(Icons.settings_outlined),
              activeIcon: Icon(Icons.settings),
              label: 'הגדרות',
            ),
          ],
        ),
        floatingActionButton: _currentTab == MainTab.chats || _currentTab == MainTab.groups
            ? FloatingActionButton(
                onPressed: _handleNewChat,
                child: const Icon(Icons.add),
              )
            : null,
      ),
    );
  }

  Widget _buildChatsTab() {
    return const ChatListScreen();
  }

  Widget _buildGroupsTab() {
    return const GroupListScreen();
  }

  Widget _buildShuttleTab() {
    return const ShuttleScreen();
  }

  Widget _buildHelpdeskTab() {
    return const HelpdeskScreen();
  }

  Widget _buildSettingsTab() {
    final user = ref.watch(currentUserProvider);
    return _SettingsPlaceholder(user: user);
  }

  String _getTabTitle(MainTab tab) {
    switch (tab) {
      case MainTab.chats:
        return 'צ\'אטים';
      case MainTab.groups:
        return 'קבוצות';
      case MainTab.shuttle:
        return 'הסעות';
      case MainTab.helpdesk:
        return 'תמיכה';
      case MainTab.settings:
        return 'הגדרות';
    }
  }

  IconData _getConnectionIcon(RealtimeTransportMode mode) {
    switch (mode) {
      case RealtimeTransportMode.socket:
        return Icons.wifi;
      case RealtimeTransportMode.sse:
        return Icons.sync;
      case RealtimeTransportMode.polling:
        return Icons.sync_problem;
    }
  }

  Color _getConnectionColor(RealtimeTransportMode mode) {
    switch (mode) {
      case RealtimeTransportMode.socket:
        return AppColors.success;
      case RealtimeTransportMode.sse:
        return AppColors.warning;
      case RealtimeTransportMode.polling:
        return Colors.white70;
    }
  }

  void _handleNewChat() {
    // Bottom sheet that mirrors the Angular FAB menu: choose between starting
    // a new direct chat (NewChatDialog) or creating a group (CreateGroupDialog).
    final isGroupTab = _currentTab == MainTab.groups;
    showModalBottomSheet<void>(
      context: context,
      builder: (sheetContext) {
        return Directionality(
          textDirection: TextDirection.rtl,
          child: SafeArea(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (!isGroupTab)
                  ListTile(
                    leading: const Icon(Icons.chat_bubble_outline),
                    title: const Text('צ\'אט חדש'),
                    onTap: () {
                      Navigator.of(sheetContext).pop();
                      _openNewChatDialog();
                    },
                  ),
                ListTile(
                  leading: const Icon(Icons.group_add_outlined),
                  title: const Text('קבוצה חדשה'),
                  onTap: () {
                    Navigator.of(sheetContext).pop();
                    _openCreateGroupDialog();
                  },
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Future<void> _openNewChatDialog() async {
    final username = await showNewChatDialog(context);
    if (username == null || !mounted) return;
    final notifier = ref.read(chatStoreProvider.notifier);
    final chatId = notifier.startDirectChat(username);
    if (chatId.isEmpty || !mounted) return;
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => MessageScreen(chatId: chatId),
      ),
    );
  }

  Future<void> _openCreateGroupDialog() async {
    final result = await showCreateGroupDialog(context);
    if (result == null || !mounted) return;
    final notifier = ref.read(chatStoreProvider.notifier);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final group = await notifier.createGroup(
        name: result.name,
        members: result.members,
        type: result.type,
      );
      if (!mounted) return;
      messenger.showSnackBar(
        const SnackBar(content: Text('הקבוצה נוצרה')),
      );
      Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => MessageScreen(chatId: group.id),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(content: Text(e.toString().replaceFirst('Exception: ', ''))),
      );
    }
  }

  void _handleRefresh() {
    final user = ref.read(currentUserProvider);
    if (user != null) {
      final transport = ref.read(realtimeTransportServiceProvider);
      transport.disconnect();
      transport.connect(user, isNetworkReachable: () => true);
    }
  }

  void _handleLogout() {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('התנתקות', textDirection: TextDirection.rtl),
        content: const Text('האם אתה בטוח שברצונך להתנתק?', textDirection: TextDirection.rtl),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('ביטול'),
          ),
          TextButton(
            onPressed: () {
              Navigator.of(context).pop();
              ref.read(authStateProvider.notifier).logout();
            },
            style: TextButton.styleFrom(foregroundColor: Theme.of(context).colorScheme.error),
            child: const Text('התנתק'),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Settings Placeholder (still using placeholder for now)
// ---------------------------------------------------------------------------

class _SettingsPlaceholder extends StatelessWidget {
  final String? user;

  const _SettingsPlaceholder({this.user});

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                CircleAvatar(
                  radius: 30,
                  backgroundColor: Theme.of(context).colorScheme.primary,
                  child: Text(
                    user?.isNotEmpty == true ? user![0].toUpperCase() : '?',
                    style: const TextStyle(
                      fontSize: 24,
                      fontWeight: FontWeight.bold,
                      color: Colors.white,
                    ),
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        user ?? 'משתמש',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'מחובר',
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                              color: AppColors.success,
                            ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),
        const ListTile(
          leading: Icon(Icons.notifications_outlined),
          title: Text('התראות'),
          subtitle: Text('הגדרות התראות push'),
          trailing: Icon(Icons.chevron_left),
        ),
        const Divider(),
        const ListTile(
          leading: Icon(Icons.palette_outlined),
          title: Text('מראה'),
          subtitle: Text('ערכת נושא ועיצוב'),
          trailing: Icon(Icons.chevron_left),
        ),
        const Divider(),
        const ListTile(
          leading: Icon(Icons.info_outline),
          title: Text('אודות'),
          subtitle: Text('גרסה 1.0.0'),
          trailing: Icon(Icons.chevron_left),
        ),
      ],
    );
  }
}
