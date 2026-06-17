/// Web stub for windows_auth_service.dart.
///
/// On the web platform there is no Windows username — auto-login always returns null.
library;

import '../api/chat_api_service.dart';

/// Always returns null on web.
Future<String?> tryWindowsAutoLogin(ChatApiService apiService) async => null;
