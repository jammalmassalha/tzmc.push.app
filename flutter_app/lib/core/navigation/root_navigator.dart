/// Global navigator key for navigation from outside the widget tree
/// (notification taps, background message handlers, etc.).
library;

import 'package:flutter/material.dart';

/// Root navigator key wired into [MaterialApp.navigatorKey] in `main.dart`.
final GlobalKey<NavigatorState> rootNavigatorKey = GlobalKey<NavigatorState>();

/// App-level routes used for Flutter web deep-linking.
class AppRoutes {
  const AppRoutes._();

  static const String home = '/';
  static const String login = '/login';
  static const String helpdesk = '/helpdesk';

  static String normalizePath(String? rawPath) {
    final path = (rawPath ?? '').trim();
    if (path.isEmpty || path == '/') return home;
    if (path == login || path == helpdesk) return path;
    return home;
  }

  static String topLevelPathForHelpdeskTab(bool isHelpdeskTab) {
    return isHelpdeskTab ? helpdesk : home;
  }

  static String loginWithRedirect(String targetPath) {
    final normalized = normalizePath(targetPath);
    if (normalized == home) return login;
    return Uri(path: login, queryParameters: {'redirect': normalized}).toString();
  }
}

/// Parsed route payload (path + optional redirect target query).
class AppRouteRequest {
  final String path;
  final String? redirectPath;

  const AppRouteRequest({
    required this.path,
    this.redirectPath,
  });

  factory AppRouteRequest.fromName(String? routeName) {
    final fallback = const AppRouteRequest(path: AppRoutes.home);
    if (routeName == null || routeName.trim().isEmpty) {
      return fallback;
    }
    final uri = Uri.tryParse(routeName);
    if (uri == null) return fallback;
    final path = AppRoutes.normalizePath(uri.path);
    final redirectPath = AppRoutes.normalizePath(uri.queryParameters['redirect']);
    return AppRouteRequest(path: path, redirectPath: redirectPath);
  }
}
