/// Cookie setup for native (mobile/desktop) platforms.
///
/// Uses [PersistCookieJar] backed by a file on disk so that the session
/// cookie issued by the backend survives app restarts. Without this the
/// user has to log in again every time the app process is killed.
library;

import 'package:cookie_jar/cookie_jar.dart';
import 'package:dio/dio.dart';
import 'package:dio_cookie_manager/dio_cookie_manager.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

Future<Future<void> Function()> configureCookieJar(Dio dio) async {
  final dir = await getApplicationDocumentsDirectory();
  final cookieDir = p.join(dir.path, '.cookies');
  final jar = PersistCookieJar(
    ignoreExpires: false,
    storage: FileStorage(cookieDir),
  );
  dio.interceptors.add(CookieManager(jar));
  return () async {
    await jar.deleteAll();
  };
}
