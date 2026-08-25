/// Chat shell screen - main chat interface.
///
/// This is the main screen shown after authentication,
/// containing the chat list, message view, and navigation.
library;

import 'dart:async';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/config/environment.dart';
import '../../../core/api/chat_api_service.dart';
import '../../../core/navigation/root_navigator.dart';
import '../../../core/realtime/realtime_transport_service.dart';
import '../../../core/services/accessibility_service.dart';
import '../../../core/services/chat_store_service.dart';
import '../../../core/services/push_notification_service.dart';
import '../../auth/presentation/auth_state.dart';
import '../../helpdesk/presentation/helpdesk_screen.dart';
import '../../password_reset/presentation/password_reset_bot_screen.dart';
import '../../shuttle/presentation/shuttle_screen.dart';
import '../../admin/presentation/admin_groups_screen.dart';
import '../../admin/presentation/admin_secretaries_screen.dart';
import '../../accreditation_agent/presentation/accreditation_agent_screen.dart';
import '../../../core/utils/toast_utils.dart';
import '../../../shared/theme/app_theme.dart';
import 'chat_list_screen.dart';
import 'create_group_dialog.dart';
import 'message_screen.dart';
import 'new_chat_dialog.dart';

/// Main tab enumeration
enum MainTab {
  chats,
  groups,
  shuttle,
  helpdesk,
  ticketManager,
  passwordReset,
  accessibility,
  settings,
  adminGroups
}

const List<String> _kHelpdeskAllowedUsers = [
  '0546799693',
  '0550000001',
  '0505203520',
];
final Set<String> _kHelpdeskAllowedUsersNormalized =
    _kHelpdeskAllowedUsers.map((value) => value.trim().toLowerCase()).toSet();

/// Super-admin users who have access to the Admin Groups management tab.
const List<String> _kSuperAdminUsers = ['0546799693'];
final Set<String> _kSuperAdminUsersNormalized =
    _kSuperAdminUsers.map((value) => value.trim().toLowerCase()).toSet();

final RegExp _kShuttlePhoneRegex = RegExp(r'05\d{8}');
const double _kDesktopShellBreakpoint = 1100;

/// Chat shell screen widget
class ChatShellScreen extends ConsumerStatefulWidget {
  /// Optional path to navigate to on first render (e.g. `/helpdesk`).
  final String? initialPath;

  const ChatShellScreen({super.key, this.initialPath});

  @override
  ConsumerState<ChatShellScreen> createState() => _ChatShellScreenState();
}

class _ChatShellScreenState extends ConsumerState<ChatShellScreen>
    with WidgetsBindingObserver {
  MainTab _currentTab = MainTab.chats;
  final _pageController = PageController();
  bool _canAccessShuttle = false;
  bool _canAccessTicketManager = false;
  bool _canAccessAdminGroups = false;
  List<MainTab> _visibleTabs = [
    MainTab.chats,
    MainTab.groups,
    MainTab.helpdesk,
  ];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _currentTab = _tabForPath(widget.initialPath);
    _initializeServices();
    unawaited(_refreshTabPermissions());
  }

  /// Called when the app returns to the foreground.
  ///
  /// Pulls any messages that arrived while the app was backgrounded so the
  /// chat is up-to-date.  All pending notifications are cleared from the OS
  /// notification tray and the app-icon badge is reset to zero.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(_handleAppResumed());
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

      // Reset the app-icon badge now that the user has opened the app.
      try {
        await ref.read(pushNotificationServiceProvider).resetBadge();
      } catch (e, st) {
        debugPrint('[ChatShellScreen] resetBadge on resume failed: $e\n$st');
      }
    }
  }

  void _initializeServices() {
    final user = ref.read(currentUserProvider);
    if (user == null) return;

    // Initialize realtime transport.
    final transport = ref.read(realtimeTransportServiceProvider);
    transport.connect(user, isNetworkReachable: () => true);

    // Kick off chat store initialization.
    unawaited(_initializeChatStore(user));

    // Initialize push notifications and request permission independently of
    // chat store init. ensurePermissionAndRegister() shows a Hebrew
    // rationale dialog before the OS / browser prompt, so wait one frame
    // to make sure [context] is mounted.
    unawaited(_initializePushNotifications());
  }

  /// Initializes the chat store and resets the app-icon badge.
  Future<void> _initializeChatStore(String user) async {
    try {
      await ref.read(chatStoreProvider.notifier).initialize(user);
    } catch (e, st) {
      debugPrint('[ChatShellScreen] chatStore.initialize error: $e\n$st');
    }
    // Reset the app-icon badge on cold start now that the user is in the app.
    try {
      await ref.read(pushNotificationServiceProvider).resetBadge();
    } catch (e, st) {
      debugPrint('[ChatShellScreen] resetBadge on startup failed: $e\n$st');
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
    // Watch restricted flag so the sidebar rebuilds if the user's restriction
    // status changes while the shell is visible.
    ref.watch(isUserRestrictedProvider);

    final isDesktopWeb =
        kIsWeb && MediaQuery.sizeOf(context).width >= _kDesktopShellBreakpoint;

    return Directionality(
      textDirection: TextDirection.rtl,
      child: Stack(
        children: [
          isDesktopWeb
              ? _buildDesktopScaffold(chatState, _currentTab)
              : _buildMobileScaffold(_currentTab),

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

  Scaffold _buildMobileScaffold(MainTab currentTab) {
    return Scaffold(
      appBar: _buildAppBar(currentTab),
      body: PageView(
        controller: _pageController,
        onPageChanged: (index) {
          if (index < 0 || index >= _visibleTabs.length) return;
          final nextTab = _visibleTabs[index];
          if (nextTab == _currentTab) return;
          _selectTab(nextTab);
        },
        children: _visibleTabs.map(_buildTabBody).toList(),
      ),
      bottomNavigationBar: _visibleTabs.length < 2
        ? null
        : BottomNavigationBar(
            currentIndex: () {
              final idx = _visibleTabs.indexOf(currentTab);
              return idx < 0 ? 0 : idx;
            }(),
            onTap: (index) {
              if (index < 0 || index >= _visibleTabs.length) return;
              final nextTab = _visibleTabs[index];
              _selectTab(nextTab);
            },
            items: _visibleTabs.map(_buildNavItem).toList(),
          ),
    );
  }

  Scaffold _buildDesktopScaffold(ChatState chatState, MainTab currentTab) {
    return Scaffold(
      appBar: _buildAppBar(currentTab),
      body: Container(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [
              AppColors.primaryDark,
              AppColors.background,
              AppColors.background,
            ],
            stops: [0, 0.18, 1],
          ),
        ),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 1580),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Container(
                clipBehavior: Clip.antiAlias,
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(22),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withAlpha(28),
                      blurRadius: 32,
                      offset: const Offset(0, 14),
                    ),
                  ],
                ),
                child: Row(
                  children: [
                    if (_visibleTabs.length >= 2) ...[
                      _buildDesktopNavigationRail(currentTab),
                      Container(width: 1, color: AppColors.divider),
                    ],
                    Expanded(
                      child: _isChatSplitTab(currentTab)
                          ? _buildDesktopChatLayout(chatState, currentTab)
                          : _buildDesktopContentCard(_buildTabBody(currentTab)),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  PreferredSizeWidget _buildAppBar(MainTab currentTab) {
    final isRestricted = ref.watch(isUserRestrictedProvider);
    return AppBar(
      title: Text(_getTabTitle(currentTab)),
      leading: (!isRestricted && (currentTab == MainTab.chats || currentTab == MainTab.groups))
          ? Padding(
              padding: const EdgeInsetsDirectional.only(start: 4),
              child: Semantics(
                button: true,
                label: currentTab == MainTab.groups
                    ? 'פתח אפשרויות ליצירת קבוצה חדשה'
                    : 'פתח אפשרויות להתחלת שיחה חדשה',
                child: IconButton(
                  tooltip: currentTab == MainTab.groups ? 'קבוצה חדשה' : 'שיחה חדשה',
                  onPressed: _handleNewChat,
                  icon: Icon(
                    currentTab == MainTab.groups
                        ? Icons.group_add_outlined
                        : Icons.add_comment_outlined,
                  ),
                ),
              ),
            )
          : null,
      actions: [
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
              case 'settings':
                _handleOpenSettings();
                break;
              case 'accreditation':
                _handleOpenAccreditationAgent();
                break;
              case 'secretaries_admin':
                _handleOpenSecretariesAdmin();
                break;
            }
          },
          itemBuilder: (context) => [
            const PopupMenuItem(
              value: 'refresh',
              child: Row(
                children: [
                  Icon(Icons.refresh, size: 20),
                  SizedBox(width: 12),
                  Text('רענון'),
                ],
              ),
            ),
            const PopupMenuItem(
              value: 'fullsync',
              child: Row(
                children: [
                  Icon(Icons.sync, size: 20),
                  SizedBox(width: 12),
                  Text('סנכרון הודעות'),
                ],
              ),
            ),
            const PopupMenuItem(
              value: 'settings',
              child: Row(
                children: [
                  Icon(Icons.settings_outlined, size: 20),
                  SizedBox(width: 12),
                  Text('הגדרות'),
                ],
              ),
            ),
            const PopupMenuItem(
              value: 'accreditation',
              child: Row(
                children: [
                  Icon(Icons.auto_awesome_outlined, size: 20),
                  SizedBox(width: 12),
                  Text('סוכן אקרדיטציה'),
                ],
              ),
            ),
            if (_canAccessAdminGroups)
              const PopupMenuItem(
                value: 'secretaries_admin',
                child: Row(
                  children: [
                    Icon(Icons.settings_phone, size: 20),
                    SizedBox(width: 12),
                    Text('ניהול מזכירויות מחלקתיות'),
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
    );
  }

  Widget _buildDesktopNavigationRail(MainTab currentTab) {
    return NavigationRail(
      extended: false,
      minWidth: 84,
      selectedIndex: () {
        final idx = _visibleTabs.indexOf(currentTab);
        return idx < 0 ? 0 : idx;
      }(),
      groupAlignment: -1,
      backgroundColor: AppColors.background,
      indicatorColor: AppColors.primaryLight.withAlpha(60),
      leading: Padding(
        padding: const EdgeInsets.only(top: 12),
        child: Column(
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: AppColors.primary,
                borderRadius: BorderRadius.circular(14),
              ),
              child: IconButton(
                tooltip: 'שיחה חדשה',
                onPressed: (currentTab == MainTab.chats || currentTab == MainTab.groups)
                    ? _handleNewChat
                    : null,
                icon: const Icon(Icons.add_comment_outlined, color: Colors.white),
              ),
            ),
            const SizedBox(height: 18),
          ],
        ),
      ),
      onDestinationSelected: (index) {
        if (index < 0 || index >= _visibleTabs.length) return;
        final nextTab = _visibleTabs[index];
        _selectTab(nextTab);
      },
      destinations: _visibleTabs
          .map(
            (tab) => NavigationRailDestination(
              icon: Icon(_navIcon(tab)),
              selectedIcon: Icon(_navActiveIcon(tab)),
              label: Text(_buildNavItem(tab).label ?? _getTabTitle(tab)),
            ),
          )
          .toList(),
    );
  }

  bool _isChatSplitTab(MainTab tab) =>
      tab == MainTab.chats || tab == MainTab.groups;

  IconData _navIcon(MainTab tab) {
    switch (tab) {
      case MainTab.chats:
        return Icons.chat_bubble_outline;
      case MainTab.groups:
        return Icons.group_outlined;
      case MainTab.shuttle:
        return Icons.directions_bus_outlined;
      case MainTab.helpdesk:
        return Icons.support_agent_outlined;
      case MainTab.ticketManager:
        return Icons.manage_accounts_outlined;
      case MainTab.passwordReset:
        return Icons.lock_reset_outlined;
      case MainTab.accessibility:
        return Icons.accessibility_new_outlined;
      case MainTab.settings:
        return Icons.settings_outlined;
      case MainTab.adminGroups:
        return Icons.admin_panel_settings_outlined;
    }
  }

  IconData _navActiveIcon(MainTab tab) {
    switch (tab) {
      case MainTab.chats:
        return Icons.chat_bubble;
      case MainTab.groups:
        return Icons.group;
      case MainTab.shuttle:
        return Icons.directions_bus;
      case MainTab.helpdesk:
        return Icons.support_agent;
      case MainTab.ticketManager:
        return Icons.manage_accounts;
      case MainTab.passwordReset:
        return Icons.lock_reset;
      case MainTab.accessibility:
        return Icons.accessibility_new;
      case MainTab.settings:
        return Icons.settings;
      case MainTab.adminGroups:
        return Icons.admin_panel_settings;
    }
  }

  Widget _buildDesktopChatLayout(ChatState chatState, MainTab currentTab) {
    final currentChatId = chatState.currentChatId;

    return Row(
      children: [
        SizedBox(
          width: 420,
          child: Container(
            color: AppColors.background,
            child: Column(
              children: [
                _buildDesktopPaneHeader(currentTab),
                Expanded(child: _buildDesktopListPane(currentChatId, currentTab)),
              ],
            ),
          ),
        ),
        Container(width: 1, color: AppColors.divider),
        Expanded(
          child: currentChatId == null
              ? _buildDesktopConversationPlaceholder()
              : MessageScreen(
                  chatId: currentChatId,
                  embedded: true,
                  onExit: () => ref.read(chatStoreProvider.notifier).setCurrentChat(null),
                ),
        ),
      ],
    );
  }

  Widget _buildDesktopPaneHeader(MainTab currentTab) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 16),
      decoration: const BoxDecoration(
        color: AppColors.background,
        border: Border(
          bottom: BorderSide(color: AppColors.divider),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            _getTabTitle(currentTab),
            style: const TextStyle(
              fontSize: 20,
              fontWeight: FontWeight.w700,
              color: AppColors.textPrimary,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            currentTab == MainTab.groups
                ? 'בחר קבוצה כדי להמשיך את השיחה'
                : 'בחר שיחה כדי לפתוח את חלון ההודעות',
            style: const TextStyle(
              fontSize: 13,
              color: AppColors.textSecondary,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildDesktopListPane(String? currentChatId, MainTab currentTab) {
    switch (currentTab) {
      case MainTab.chats:
        return ChatListScreen(
          selectedChatId: currentChatId,
          onChatSelected: (_) {},
        );
      case MainTab.groups:
        return GroupListScreen(
          selectedChatId: currentChatId,
          onGroupSelected: (_, __) {},
        );
      default:
        return _buildTabBody(currentTab);
    }
  }

  Widget _buildDesktopContentCard(Widget child) {
    return Container(
      color: AppColors.background,
      padding: const EdgeInsets.all(20),
      child: Container(
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(18),
        ),
        child: child,
      ),
    );
  }

  Widget _buildDesktopConversationPlaceholder() {
    return Container(
      color: AppColors.background,
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 132,
              height: 132,
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(30),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withAlpha(18),
                    blurRadius: 24,
                    offset: const Offset(0, 10),
                  ),
                ],
              ),
              child: const Icon(
                Icons.forum_outlined,
                size: 68,
                color: AppColors.textSecondary,
              ),
            ),
            const SizedBox(height: 24),
            const Text(
              'ברוכים הבאים',
              style: TextStyle(
                fontSize: 28,
                fontWeight: FontWeight.w700,
                color: AppColors.textPrimary,
              ),
            ),
            const SizedBox(height: 10),
            const Text(
              'בחר שיחה מהרשימה כדי לפתוח את חלון ההודעות',
              style: TextStyle(
                fontSize: 15,
                color: AppColors.textSecondary,
              ),
            ),
          ],
        ),
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
      case MainTab.passwordReset:
        return _buildPasswordResetTab();
      case MainTab.accessibility:
        return _buildAccessibilityTab();
      case MainTab.settings:
        return _buildSettingsTab();
      case MainTab.adminGroups:
        return _buildAdminGroupsTab();
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
      case MainTab.passwordReset:
        return const BottomNavigationBarItem(
          icon: Icon(Icons.lock_reset_outlined),
          activeIcon: Icon(Icons.lock_reset),
          label: 'איפוס סיסמה',
        );
      case MainTab.accessibility:
        return const BottomNavigationBarItem(
          icon: Icon(Icons.accessibility_new_outlined),
          activeIcon: Icon(Icons.accessibility_new),
          label: 'נגישות',
        );
      case MainTab.settings:
        return const BottomNavigationBarItem(
          icon: Icon(Icons.settings_outlined),
          activeIcon: Icon(Icons.settings),
          label: 'הגדרות',
        );
      case MainTab.adminGroups:
        return const BottomNavigationBarItem(
          icon: Icon(Icons.admin_panel_settings_outlined),
          activeIcon: Icon(Icons.admin_panel_settings),
          label: 'ניהול קבוצות',
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

  Widget _buildPasswordResetTab() {
    return const PasswordResetBotScreen();
  }

  Widget _buildAdminGroupsTab() {
    return const AdminGroupsScreen();
  }

  Widget _buildAccessibilityTab() {
    return const _AccessibilitySettingsScreen();
  }

  Widget _buildSettingsTab() {
    final user = ref.watch(currentUserProvider);
    return _SettingsPlaceholder(user: user);
  }

  void _recomputeVisibleTabs() {
    final isRestricted = ref.read(isUserRestrictedProvider);
    if (isRestricted) {
      _visibleTabs = [MainTab.chats];
      return;
    }

    final tabs = <MainTab>[
      MainTab.chats,
      MainTab.groups,
      if (_canAccessShuttle) MainTab.shuttle,
      MainTab.helpdesk,
      if (_canAccessTicketManager) MainTab.ticketManager,
      if (!kIsWeb) MainTab.passwordReset,
      MainTab.accessibility,
      if (_canAccessAdminGroups) MainTab.adminGroups,
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
        _canAccessAdminGroups = false;
        _recomputeVisibleTabs();
        if (!_visibleTabs.contains(_currentTab)) {
          _currentTab = _visibleTabs.first;
        }
      });
      _syncPageToCurrentTab();
      return;
    }
    final normalizedUser = _normalizeUser(user);

    final canAccessTicketManager =
        _kHelpdeskAllowedUsersNormalized.contains(normalizedUser);

    final canAccessAdminGroups =
        _kSuperAdminUsersNormalized.contains(normalizedUser);

    bool canAccessShuttle = false;
    try {
      final api = ref.read(chatApiServiceProvider);
      final employees = await api.getShuttleEmployees(user);
      if (employees.isNotEmpty) {
        canAccessShuttle = _isUserAllowedForShuttle(normalizedUser, employees);
      }
    } catch (e, st) {
      debugPrint('[ChatShellScreen] shuttle permission check failed: $e\n$st');
      canAccessShuttle = false;
    }

    if (!mounted) return;
    setState(() {
      _canAccessShuttle = canAccessShuttle;
      _canAccessTicketManager = canAccessTicketManager;
      _canAccessAdminGroups = canAccessAdminGroups;
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

  void _syncPageToCurrentTab({bool animate = false}) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_pageController.hasClients) return;
      final targetIndex = _visibleTabs.indexOf(_currentTab);
      if (targetIndex < 0) return;
      final currentPage = _pageController.page?.round() ?? 0;
      if (currentPage != targetIndex) {
        if (animate) {
          _pageController.animateToPage(
            targetIndex,
            duration: const Duration(milliseconds: 300),
            curve: Curves.easeInOut,
          );
        } else {
          _pageController.jumpToPage(targetIndex);
        }
      }
    });
  }

  MainTab _tabForPath(String? path) {
    switch (AppRoutes.shellRouteForPath(path)) {
      case AppShellRoute.chats:
        return MainTab.chats;
      case AppShellRoute.groups:
        return MainTab.groups;
      case AppShellRoute.shuttle:
        return MainTab.shuttle;
      case AppShellRoute.helpdesk:
        return MainTab.helpdesk;
      case AppShellRoute.ticketManager:
        return MainTab.ticketManager;
      case AppShellRoute.passwordReset:
        return MainTab.passwordReset;
      case AppShellRoute.accessibility:
        return MainTab.accessibility;
      case AppShellRoute.admin:
        return MainTab.adminGroups;
    }
  }

  String _pathForTab(MainTab tab) {
    switch (tab) {
      case MainTab.chats:
        return AppRoutes.home;
      case MainTab.groups:
        return AppRoutes.groups;
      case MainTab.shuttle:
        return AppRoutes.shuttle;
      case MainTab.helpdesk:
        return AppRoutes.helpdesk;
      case MainTab.ticketManager:
        return AppRoutes.ticketManager;
      case MainTab.passwordReset:
        return AppRoutes.passwordReset;
      case MainTab.accessibility:
        return AppRoutes.accessibility;
      case MainTab.settings:
        return AppRoutes.home;
      case MainTab.adminGroups:
        return AppRoutes.admin;
    }
  }

  void _selectTab(MainTab nextTab) {
    if (!_visibleTabs.contains(nextTab)) return;
    if (nextTab != _currentTab) {
      setState(() {
        _currentTab = nextTab;
      });
    }
    _syncPageToCurrentTab(animate: true);
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
      case MainTab.passwordReset:
        return 'איפוס סיסמת Windows';
      case MainTab.accessibility:
        return 'נגישות';
      case MainTab.settings:
        return 'הגדרות';
      case MainTab.adminGroups:
        return 'ניהול קבוצות';
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
    final isRestricted = ref.read(isUserRestrictedProvider);
    if (isRestricted) return;

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

  void _handleOpenSettings() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (context) => Directionality(
          textDirection: TextDirection.rtl,
          child: Scaffold(
            appBar: AppBar(title: const Text('הגדרות')),
            body: _SettingsPlaceholder(user: ref.read(currentUserProvider)),
          ),
        ),
      ),
    );
  }

  void _handleOpenAccreditationAgent() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => const AccreditationAgentScreen(),
      ),
    );
  }

  void _handleOpenSecretariesAdmin() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => const AdminSecretariesScreen(),
      ),
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

class _SettingsPlaceholder extends ConsumerWidget {
  final String? user;

  const _SettingsPlaceholder({this.user});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final accessibility = ref.watch(accessibilitySettingsProvider);
    final accessibilityNotifier = ref.read(accessibilitySettingsProvider.notifier);

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
        ListTile(
          leading: const Icon(Icons.accessibility_new_outlined),
          title: const Text('נגישות'),
          subtitle: Text(
            accessibility.enabled
                ? 'פעיל (גודל טקסט ${accessibility.textScaleFactor.toStringAsFixed(2)}x)'
                : 'כבוי',
          ),
          trailing: Switch.adaptive(
            value: accessibility.enabled,
            onChanged: accessibilityNotifier.setEnabled,
          ),
        ),
        const Divider(),
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

class _AccessibilitySettingsScreen extends ConsumerWidget {
  const _AccessibilitySettingsScreen();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(accessibilitySettingsProvider);
    final notifier = ref.read(accessibilitySettingsProvider.notifier);
    final textScale = settings.textScaleFactor;

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Icon(Icons.accessibility_new),
                    const SizedBox(width: 8),
                    Text(
                      'מצב נגישות',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const Spacer(),
                    Switch.adaptive(
                      value: settings.enabled,
                      onChanged: notifier.setEnabled,
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Text(
                  settings.enabled
                      ? 'מצב נגישות פעיל בכל האפליקציה'
                      : 'הפעל כדי להחיל הגדרות נגישות בכל האפליקציה',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 12),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'גודל טקסט',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 6),
                Text(
                  '${textScale.toStringAsFixed(2)}x',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                Slider(
                  min: kAccessibilityMinTextScale,
                  max: kAccessibilityMaxTextScale,
                  divisions: 6,
                  value: textScale,
                  onChanged: settings.enabled
                      ? notifier.setTextScaleFactor
                      : null,
                ),
                const SizedBox(height: 4),
                Text(
                  'טקסט לדוגמה לנגישות: האפליקציה מתאימה את גודל הטקסט בכל המסכים.',
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}
