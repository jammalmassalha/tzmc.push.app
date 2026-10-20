/// Cookie setup for native (mobile/desktop) platforms.
///
/// Uses [PersistCookieJar] backed by a file on disk so that the session
/// cookie issued by the backend survives app restarts. Without this the
/// user has to log in again every time the app process is killed.
library;

import 'package:cookie_jar/cookie_jar.dart';
import 'package:dio/dio.dart';
import 'package:dio_cookie_manager/dio_cookie_manager.dart';

import '../utils/app_storage.dart';

Future<Future<void> Function()> configureCookieJar(Dio dio) async {
  final dir = await resolveWritableAppDirectory(subdirectory: '.cookies');
  final jar = PersistCookieJar(
    ignoreExpires: false,
    storage: FileStorage(dir.path),
  );
  dio.interceptors.add(CookieManager(jar));
  return () async {
    await jar.deleteAll();
  };
}
