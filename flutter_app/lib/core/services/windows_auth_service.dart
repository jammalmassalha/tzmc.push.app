/// Windows desktop auto-login service.
///
/// Reads the Windows logged-in username from the environment, calls the
/// `/auth/session/windows-login` backend endpoint, and returns the matched
/// user identifier — no SMS or phone-entry required.
library;

import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';

import '../api/chat_api_service.dart';
import '../config/app_config.dart';

/// Attempts to auto-login using the Windows `USERNAME` environment variable.
///
/// Returns the authenticated user identifier on success, or `null` when:
/// - Not running on Windows,
/// - The `WINDOWS_APP_SERVER_TOKEN` dart-define was not set at build time,
/// - The Windows username is not registered in column O of the Subscribe sheet.
Future<String?> tryWindowsAutoLogin(ChatApiService apiService) async {
  // Only run on the Windows desktop platform (not web, not other OS).
  if (kIsWeb || !Platform.isWindows) return null;

  const appToken = AppConfig.windowsAppToken;
  if (appToken.isEmpty) {
    debugPrint('[WindowsAuth] WINDOWS_APP_SERVER_TOKEN not configured — skipping auto-login');
    return null;
  }

  final windowsUser = Platform.environment['USERNAME'] ?? '';
  if (windowsUser.isEmpty) {
    debugPrint('[WindowsAuth] USERNAME environment variable is empty — skipping auto-login');
    return null;
  }

  debugPrint('[WindowsAuth] Attempting auto-login for Windows user: $windowsUser');
  final user = await apiService.windowsAutoLogin(windowsUser, appToken);
  if (user != null) {
    debugPrint('[WindowsAuth] Auto-login succeeded: $user');
  } else {
    debugPrint('[WindowsAuth] Auto-login failed or user not registered');
  }
  return user;
}
