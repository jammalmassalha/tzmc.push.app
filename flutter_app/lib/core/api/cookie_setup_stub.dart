/// Stub for cookie setup — replaced via conditional import on each platform.
library;

import 'package:dio/dio.dart';

/// Configure Dio with cookie persistence appropriate for the current platform.
///
/// Returns a function that clears persisted cookies (logout helper). The
/// returned future resolves when setup is complete.
Future<Future<void> Function()> configureCookieJar(Dio dio) async {
  // Default no-op implementation. Real implementations are provided via
  // conditional imports for IO and web.
  return () async {};
}
