/// Global navigator key for navigation from outside the widget tree
/// (notification taps, background message handlers, etc.).
library;

import 'package:flutter/material.dart';

/// Root navigator key wired into [MaterialApp.navigatorKey] in `main.dart`.
final GlobalKey<NavigatorState> rootNavigatorKey = GlobalKey<NavigatorState>();
