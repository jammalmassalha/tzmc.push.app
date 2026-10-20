/// Native database connection for mobile/desktop platforms.
///
/// Uses sqlite3 via FFI for native SQLite performance.
library;

import 'dart:io';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:path/path.dart' as p;

import '../../config/app_config.dart';
import '../../utils/app_storage.dart';

/// Opens a database connection for native platforms (iOS, Android, desktop).
QueryExecutor openConnection() {
  return LazyDatabase(() async {
    try {
      final dbFolder = await resolveWritableAppDirectory(subdirectory: 'db');
      final file = File(p.join(dbFolder.path, '${AppConfig.dbName}.sqlite'));
      return NativeDatabase.createInBackground(file);
    } catch (e) {
      // Keep the app alive even if the sandbox path is temporarily unavailable.
      return NativeDatabase.memory();
    }
  });
}
