/// Cookie setup for the web platform.
///
/// On the web the browser already persists cookies for us; we only need to
/// instruct Dio to send credentials (cookies) along with cross-origin
/// requests so that the backend session cookie is included on every call.
///
/// **Important:** For this to work, the backend must respond with the
/// Access-Control-Allow-Credentials: true header on all responses.
/// If this header is missing, the browser will refuse to include the cookie
/// in cross-origin requests and will cancel the request.
///
/// See CORS_DEPLOYMENT_GUIDE.md for deployment and troubleshooting instructions.
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
