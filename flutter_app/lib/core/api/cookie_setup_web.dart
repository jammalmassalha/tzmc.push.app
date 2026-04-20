/// Cookie setup for the web platform.
///
/// On the web the browser already persists cookies for us; we only need to
/// instruct Dio to send credentials (cookies) along with cross-origin
/// requests so that the backend session cookie is included on every call.
library;

import 'package:dio/browser.dart';
import 'package:dio/dio.dart';

Future<Future<void> Function()> configureCookieJar(Dio dio) async {
  final adapter = BrowserHttpClientAdapter()..withCredentials = true;
  dio.httpClientAdapter = adapter;
  // The browser owns cookie storage; logout on the server clears the cookie
  // via Set-Cookie, so there is nothing for us to wipe locally.
  return () async {};
}
