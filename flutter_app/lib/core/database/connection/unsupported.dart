/// Unsupported platform stub for database connection.
///
/// This file is used when the platform is not recognized.
library;

import 'package:drift/drift.dart';

/// Throws an error for unsupported platforms.
QueryExecutor openConnection() {
  throw UnsupportedError(
    'This platform is not supported for the chat database. '
    'Supported platforms: iOS, Android, Web, Windows, macOS, Linux.',
  );
}
