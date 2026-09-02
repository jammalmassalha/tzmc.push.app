/// Web implementation of `windows_auth_service.dart`.
///
/// The browser sandbox exposes no API for the OS login name, so the username
/// can only come from the server: a reverse proxy in front of the backend
/// terminates the Integrated Windows Authentication (Negotiate) handshake and
/// tells the backend who the caller is. This file therefore just asks the
/// backend whether it recognises the current connection.
///
/// The attempt is silent by design. Users off the corporate network, on BYOD
/// machines, or in browsers that do not participate in Negotiate will always
/// end up here, so any failure must fall through quietly to the SMS login
/// screen rather than surface an error.
library;

import 'package:flutter/foundation.dart';

import '../api/chat_api_service.dart';

/// Attempts a silent Windows SSO login via the reverse proxy.
///
/// Returns the authenticated user identifier on success, or `null` when SSO is
/// not configured, the browser did not authenticate, or the Windows account is
/// not registered in column O of the Subscribe sheet.
Future<String?> tryWindowsAutoLogin(ChatApiService apiService) async {
  try {
    final user = await apiService.windowsSsoLogin();
    if (user != null) {
      debugPrint('[WindowsAuth] Web SSO succeeded: $user');
    }
    return user;
  } catch (e) {
    // Never block the login flow — fall through to the SMS screen.
    debugPrint('[WindowsAuth] Web SSO unavailable: $e');
    return null;
  }
}
