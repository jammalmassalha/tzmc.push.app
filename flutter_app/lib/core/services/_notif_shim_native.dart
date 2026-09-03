/// Native (non-web) implementation of flutter_local_notifications helpers.
///
/// Imported via a `dart.library.io` conditional import so that dart2js / the
/// CFE never sees this file on web builds, avoiding the zero-arg stub
/// conflict with the real plugin API.
///
/// flutter_local_notifications 22 converted `initialize` and `show` to
/// all-named parameters; the shim keeps the positional signature its callers
/// use and adapts here.

import 'package:flutter_local_notifications/flutter_local_notifications.dart';

Future<void> callInitialize(
  FlutterLocalNotificationsPlugin plugin,
  InitializationSettings settings, {
  DidReceiveNotificationResponseCallback? onTapped,
}) async {
  await plugin.initialize(
    settings: settings,
    onDidReceiveNotificationResponse: onTapped,
  );
}

Future<void> callShow(
  FlutterLocalNotificationsPlugin plugin,
  int id,
  String? title,
  String? body,
  NotificationDetails? details, {
  String? payload,
}) async {
  await plugin.show(
    id: id,
    title: title,
    body: body,
    notificationDetails: details,
    payload: payload,
  );
}
