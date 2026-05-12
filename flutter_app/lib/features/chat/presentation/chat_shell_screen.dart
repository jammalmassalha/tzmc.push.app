/// Chat shell screen - main chat interface.
///
/// This is the main screen shown after authentication,
/// containing the chat list, message view, and navigation.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/chat_api_service.dart';
import '../../../core/realtime/realtime_transport_service.dart';
import '../../../core/services/chat_store_service.dart';
import '../../../core/services/push_notification_service.dart';
import '../../auth/presentation/auth_state.dart';
import '../../helpdesk/presentation/helpdesk_screen.dart';
import '../../shuttle/presentation/shuttle_screen.dart';
import '../../../core/utils/toast_utils.dart';
import '../../../shared/theme/app_theme.dart';
import 'chat_list_screen.dart';
import 'create_group_dialog.dart';
import 'message_screen.dart';
import 'new_chat_dialog.dart';

/// Main tab enumeration
enum MainTab { chats, groups, shuttle, helpdesk, ticketManager, settings }

const List<String> _kHelpdeskAllowedUsers = [
  '0546799693',
  '0550000001',
  '0505203520',
];
final RegExp _kShuttlePhoneRegex = RegExp(r'05\d{8}');

/// Chat shell screen widget
class ChatShellScreen extends ConsumerStatefulWidget {
  const ChatShellScreen({super.key});

  @override
  ConsumerState<ChatShellScreen> createState() => _ChatShellScreenState();
}

class _ChatShellScreenState extends ConsumerState<ChatShellScreen>
    with WidgetsBindingObserver {
  MainTab _currentTab = MainTab.chats;
  final _pageController = PageController();
  bool _canAccessShuttle = false;
  bool _canAccessTicketManager = false;
  List<MainTab> _visibleTabs = [
    MainTab.chats,
    MainTab.groups,
    MainTab.helpdesk,
    MainTab.settings,
  ];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _initializeServices();
    unawaited(_refreshTabPermissions());
  }

  /// Called when the app returns to the foreground.
  ///
  /// Pulls any messages that arrived while the app was backgrounded so the
  /// chat is up-to-date.  The OS notification tray and app-icon badge are
  /// intentionally **not** cleared here — notifications stay visible on the
  /// device until the user dismisses them manually.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(_handleAppResumed());
      unawaited(_refreshTabPermissions());
    }
  }

  Future<void> _handleAppResumed() async {
    // Pull missed messages so the chat list reflects whatever arrived while
    // the app was backgrounded.
    final user = ref.read(currentUserProvider);
    if (user != null) {
      // Reconnect the realtime transport in case socket/SSE dropped while the
      // app was in the background. Auto-reconnect is disabled in socket.io so
      // we need to trigger it explicitly on every resume.
      ref.read(realtimeTransportServiceProvider).reconnectIfNeeded(user);

      try {
        await ref
            .read(chatStoreProvider.notifier)
            .recoverMissedMessages(force: true);
      } catch (e, st) {
        debugPrint('[ChatShellScreen] recoverMissedMessages on resume failed: $e\n$st');
      }

      try {
        await ref
            .read(pushNotificationServiceProvider)
            .registerPendingTokenForUser();
      } catch (e, st) {
        debugPrint(
          '[ChatShellScreen] push token registration on resume failed: $e\n$st',
        );
      }
    }
  }

  void _initializeServices() {
    final user = ref.read(currentUserProvider);
    if (user == null) return;

    // Initialize realtime transport.
    final transport = ref.read(realtimeTransportServiceProvider);
    transport.connect(user, isNetworkReachable: () => true);

    // Kick off chat store initialization.  The OS notification tray and
    // app-icon badge are intentionally not cleared here — notifications
    // stay visible on the device until the user dismisses them manually.
    unawaited(_initializeChatStore(user));

    // Initialize push notifications and request permission independently of
    // chat store init. ensurePermissionAndRegister() shows a Hebrew
    // rationale dialog before the OS / browser prompt, so wait one frame
    // to make sure [context] is mounted.
    unawaited(_initializePushNotifications());
  }

  /// Initializes the chat store.  Notification tray / app-icon badge
  /// clearing was removed — notifications stay visible until the user
  /// dismisses them manually.
  Future<void> _initializeChatStore(String user) async {
    try {
      await ref.read(chatStoreProvider.notifier).initialize(user);
    } catch (e, st) {
      debugPrint('[ChatShellScreen] chatStore.initialize error: $e\n$st');
    }
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
    WidgetsBinding.instance.removeObserver(this);
    _pageController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final chatState = ref.watch(chatStoreProvider);

    return Directionality(
      textDirection: TextDirection.rtl,
      child: Stack(
        children: [
          Scaffold(
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
                      case 'fullsync':
                        _handleFullSync();
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
                    PopupMenuItem(
                      value: 'fullsync',
                      child: Row(
                        children: [
                          const Icon(Icons.sync, size: 20),
                          const SizedBox(width: 12),
                          const Text('סנכרון הודעות'),
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
                if (index < 0 || index >= _visibleTabs.length) return;
                setState(() {
                  _currentTab = _visibleTabs[index];
                });
              },
              children: _visibleTabs.map(_buildTabBody).toList(),
            ),
            bottomNavigationBar: BottomNavigationBar(
              currentIndex: _visibleTabs.indexOf(_currentTab),
              onTap: (index) {
                if (index < 0 || index >= _visibleTabs.length) return;
                setState(() {
                  _currentTab = _visibleTabs[index];
                });
                _pageController.animateToPage(
                  index,
                  duration: const Duration(milliseconds: 300),
                  curve: Curves.easeInOut,
                );
              },
              items: _visibleTabs.map(_buildNavItem).toList(),
            ),
            floatingActionButton: _currentTab == MainTab.chats || _currentTab == MainTab.groups
                ? FloatingActionButton(
                    onPressed: _handleNewChat,
                    child: const Icon(Icons.add),
                  )
                : null,
          ),

          // Full-sync progress overlay — mirrors Angular's sync-loader-backdrop.
          if (chatState.isSyncing)
            Positioned.fill(
              child: ColoredBox(
                color: Colors.black.withAlpha((255 * 0.55).round()),
                child: Center(
                  child: Card(
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16),
                    ),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 32,
                        vertical: 28,
                      ),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const CircularProgressIndicator(),
                          const SizedBox(height: 16),
                          const Text(
                            'מסנכרן הודעות...',
                            style: TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            '${chatState.syncProgressPercent}%',
                            style: const TextStyle(fontSize: 14),
                          ),
                          const SizedBox(height: 8),
                          SizedBox(
                            width: 220,
                            child: LinearProgressIndicator(
                              value: chatState.syncProgressPercent / 100,
                              minHeight: 6,
                              borderRadius: BorderRadius.circular(3),
                            ),
                          ),
                          if (chatState.syncProgressLabel.isNotEmpty) ...[
                            const SizedBox(height: 8),
                            Text(
                              chatState.syncProgressLabel,
                              style: const TextStyle(
                                fontSize: 12,
                                color: Colors.grey,
                              ),
                              textAlign: TextAlign.center,
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildChatsTab() {
    return const ChatListScreen();
  }

  Widget _buildTabBody(MainTab tab) {
    switch (tab) {
      case MainTab.chats:
        return _buildChatsTab();
      case MainTab.groups:
        return _buildGroupsTab();
      case MainTab.shuttle:
        return _buildShuttleTab();
      case MainTab.helpdesk:
        return _buildHelpdeskTab();
      case MainTab.ticketManager:
        return _buildTicketManagerTab();
      case MainTab.settings:
        return _buildSettingsTab();
    }
  }

  BottomNavigationBarItem _buildNavItem(MainTab tab) {
    switch (tab) {
      case MainTab.chats:
        return const BottomNavigationBarItem(
          icon: Icon(Icons.chat_bubble_outline),
          activeIcon: Icon(Icons.chat_bubble),
          label: 'צ\'אטים',
        );
      case MainTab.groups:
        return const BottomNavigationBarItem(
          icon: Icon(Icons.group_outlined),
          activeIcon: Icon(Icons.group),
          label: 'קבוצות',
        );
      case MainTab.shuttle:
        return const BottomNavigationBarItem(
          icon: Icon(Icons.directions_bus_outlined),
          activeIcon: Icon(Icons.directions_bus),
          label: 'הסעות',
        );
      case MainTab.helpdesk:
        return const BottomNavigationBarItem(
          icon: Icon(Icons.support_agent_outlined),
          activeIcon: Icon(Icons.support_agent),
          label: 'מוקד איחוד',
        );
      case MainTab.ticketManager:
        return const BottomNavigationBarItem(
          icon: Icon(Icons.manage_accounts_outlined),
          activeIcon: Icon(Icons.manage_accounts),
          label: 'מנהל קריאות',
        );
      case MainTab.settings:
        return const BottomNavigationBarItem(
          icon: Icon(Icons.settings_outlined),
          activeIcon: Icon(Icons.settings),
          label: 'הגדרות',
        );
    }
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

  Widget _buildTicketManagerTab() {
    return const TicketManagerScreen();
  }

  Widget _buildSettingsTab() {
    final user = ref.watch(currentUserProvider);
    return _SettingsPlaceholder(user: user);
  }

  void _recomputeVisibleTabs() {
    final tabs = <MainTab>[
      MainTab.chats,
      MainTab.groups,
      if (_canAccessShuttle) MainTab.shuttle,
      MainTab.helpdesk,
      if (_canAccessTicketManager) MainTab.ticketManager,
      MainTab.settings,
    ];
    _visibleTabs = tabs;
  }

  Future<void> _refreshTabPermissions() async {
    final user = ref.read(currentUserProvider);
    if (user == null) {
      if (!mounted) return;
      setState(() {
        _canAccessShuttle = false;
        _canAccessTicketManager = false;
        _recomputeVisibleTabs();
        if (!_visibleTabs.contains(_currentTab)) {
          _currentTab = _visibleTabs.first;
        }
      });
      _syncPageToCurrentTab();
      return;
    }
    final normalizedUser = _normalizeUser(user);

    final canAccessTicketManager = _kHelpdeskAllowedUsers
        .map(_normalizeUser)
        .contains(normalizedUser);

    bool canAccessShuttle = false;
    try {
      final api = ref.read(chatApiServiceProvider);
      final employees = await api.getShuttleEmployees(user!);
      if (employees.isNotEmpty) {
        canAccessShuttle = _isUserAllowedForShuttle(normalizedUser, employees);
      }
    } catch (_) {
      canAccessShuttle = false;
    }

    if (!mounted) return;
    setState(() {
      _canAccessShuttle = canAccessShuttle;
      _canAccessTicketManager = canAccessTicketManager;
      _recomputeVisibleTabs();
      if (!_visibleTabs.contains(_currentTab)) {
        _currentTab = _visibleTabs.first;
      }
    });
    _syncPageToCurrentTab();
  }

  bool _isUserAllowedForShuttle(String normalizedUser, List<String> employees) {
    final userPhone = _extractShuttlePhone(normalizedUser);
    for (final entry in employees) {
      final normalizedEntry = _normalizeUser(entry);
      if (normalizedEntry == normalizedUser) {
        return true;
      }
      if (userPhone.isNotEmpty && _extractShuttlePhone(normalizedEntry) == userPhone) {
        return true;
      }
    }
    return false;
  }

  String _normalizeUser(String value) => value.trim().toLowerCase();

  String _extractShuttlePhone(String value) {
    final match = _kShuttlePhoneRegex.firstMatch(value);
    return match?.group(0) ?? '';
  }

  void _syncPageToCurrentTab() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_pageController.hasClients) return;
      final targetIndex = _visibleTabs.indexOf(_currentTab);
      if (targetIndex < 0) return;
      final currentPage = _pageController.page?.round() ?? 0;
      if (currentPage != targetIndex) {
        _pageController.jumpToPage(targetIndex);
      }
    });
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
        return 'מוקד איחוד';
      case MainTab.ticketManager:
        return 'מנהל קריאות';
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
    try {
      final group = await notifier.createGroup(
        name: result.name,
        members: result.members,
        type: result.type,
      );
      if (!mounted) return;
      showTopToast(context, 'הקבוצה נוצרה');
      Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => MessageScreen(chatId: group.id),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      showTopToast(context, e.toString().replaceFirst('Exception: ', ''));
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

  Future<void> _handleFullSync() async {
    try {
      await ref.read(chatStoreProvider.notifier).forceSyncAllMessagesAndClearCache();
      if (!mounted) return;
      showTopToast(context, 'סנכרון מלא הושלם.', duration: const Duration(seconds: 2));
    } catch (e) {
      if (!mounted) return;
      String message;
      if (e is Exception) {
        message = e.toString().replaceFirst('Exception: ', '');
      } else {
        final raw = e.toString().trim();
        message = raw.isNotEmpty ? raw : 'הסנכרון נכשל. נסה שוב.';
      }
      showTopToast(context, message, duration: const Duration(seconds: 3));
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
