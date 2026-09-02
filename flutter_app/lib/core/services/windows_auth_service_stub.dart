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
  debugPrint('[WindowsSSO] [1/5] No existing session — attempting silent Windows SSO (web).');
  try {
    final user = await apiService.windowsSsoLogin();
    if (user != null) {
      debugPrint('[WindowsSSO] [5/5] Web SSO succeeded: $user');
    } else {
      debugPrint('[WindowsSSO] [5/5] Web SSO did not authenticate — showing the SMS login screen.');
    }
    return user;
  } catch (e) {
    // Never block the login flow — fall through to the SMS screen.
    debugPrint('[WindowsSSO] [5/5] Web SSO unavailable: $e — showing the SMS login screen.');
    return null;
  }
}
