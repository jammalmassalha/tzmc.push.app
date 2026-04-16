/// Web database connection using IndexedDB.
///
/// Uses Drift's web support with sql.js for browser storage.
/// This provides SQLite-compatible storage in the browser.
library;

import 'package:drift/drift.dart';
import 'package:drift/web.dart';

import '../../config/app_config.dart';

/// Opens a database connection for web platforms using IndexedDB.
QueryExecutor openConnection() {
  return WebDatabase.withStorage(
    DriftWebStorage.indexedDb(AppConfig.dbName),
  );
}
