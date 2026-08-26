/// Web stub for flutter_local_notifications calls.
///
/// flutter_local_notifications 19.x has no web platform entry, so Flutter
/// 3.38+ generates a zero-arg web stub for its plugin class that conflicts
/// with the real positional-arg API at compile time.  By placing all calls
/// behind a conditional import we prevent dart2js / the CFE from
/// type-checking them on web builds at all.
///
/// On web, push notifications are handled by the service-worker
/// (firebase-messaging-sw.js), so these are deliberate no-ops.

Future<void> callInitialize(
  Object? plugin,
  Object? settings, {
  Function(Object?)? onTapped,
}) async {}

Future<void> callShow(
  Object? plugin,
  int id,
  String? title,
  String? body,
  Object? details, {
  String? payload,
}) async {}
