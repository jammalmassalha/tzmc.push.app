/// Native database connection for mobile/desktop platforms.
///
/// Uses sqlite3 via FFI for native SQLite performance.
library;

import 'dart:io';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:path_provider/path_provider.dart';
import 'package:path/path.dart' as p;

import '../../config/app_config.dart';

/// Opens a database connection for native platforms (iOS, Android, desktop).
QueryExecutor openConnection() {
  return LazyDatabase(() async {
    final dbFolder = await getApplicationDocumentsDirectory();
    final file = File(p.join(dbFolder.path, '${AppConfig.dbName}.sqlite'));
    return NativeDatabase.createInBackground(file);
  });
}
