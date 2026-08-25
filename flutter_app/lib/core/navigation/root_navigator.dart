/// Global navigator key for navigation from outside the widget tree
/// (notification taps, background message handlers, etc.).
library;

import 'package:flutter/material.dart';

/// Root navigator key wired into [MaterialApp.navigatorKey] in `main.dart`.
final GlobalKey<NavigatorState> rootNavigatorKey = GlobalKey<NavigatorState>();

/// Canonical top-level shell routes. The active URL is the single source of
/// truth for which shell destination is selected.
enum AppShellRoute {
  ticketManager('/helpdesk/manage'),
  helpdesk('/helpdesk'),
  shuttle('/shuttle'),
  groups('/groups'),
  passwordReset('/password-reset'),
  accessibility('/accessibility'),
  admin('/admin'),
  chats('/');

  const AppShellRoute(this.routePath);

  final String routePath;

  static AppShellRoute fromPath(String? rawPath) {
    final path = _normalizeRawPath(rawPath);
    if (path.isEmpty || path == AppRoutes.home) {
      return AppShellRoute.chats;
    }

    for (final route in AppShellRoute.values) {
      if (_matchesRoute(path, route.routePath)) {
        return route;
      }
    }

    return AppShellRoute.chats;
  }

  static bool matchesPath(String? rawPath) {
    final path = _normalizeRawPath(rawPath);
    if (path.isEmpty || path == AppRoutes.home) return true;
    return AppShellRoute.values.any((route) => _matchesRoute(path, route.routePath));
  }

  static bool _matchesRoute(String path, String routePath) {
    if (routePath == AppRoutes.home) {
      return path == AppRoutes.home;
    }
    return path == routePath || path.startsWith('$routePath/');
  }

  static String _normalizeRawPath(String? rawPath) {
    final trimmed = (rawPath ?? '').trim();
    if (trimmed.isEmpty) return '';
    final uri = Uri.tryParse(trimmed);
    return (uri?.path ?? trimmed).trim();
  }
}

/// App-level routes used for Flutter web deep-linking.
class AppRoutes {
  const AppRoutes._();

  static const String login = '/login';
  static const String home = '/';
  static const String groups = '/groups';
  static const String shuttle = '/shuttle';
  static const String helpdesk = '/helpdesk';
  static const String ticketManager = '/helpdesk/manage';
  static const String passwordReset = '/password-reset';
  static const String accessibility = '/accessibility';
  static const String admin = '/admin';

  static String normalizePath(String? rawPath) {
    final path = AppShellRoute._normalizeRawPath(rawPath);
    if (path.isEmpty || path == home) return home;
    if (path == login) return login;
    if (AppShellRoute.matchesPath(path)) {
      return AppShellRoute.fromPath(path).routePath;
    }
    return home;
  }

  static AppShellRoute shellRouteForPath(String? rawPath) {
    return AppShellRoute.fromPath(rawPath);
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
    const fallback = AppRouteRequest(path: AppRoutes.home);
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
