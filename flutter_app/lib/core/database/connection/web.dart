/// Web database connection using IndexedDB.
///
/// Uses Drift's web support with IndexedDB for browser storage.
library;

import 'package:drift/drift.dart';
import 'package:drift/wasm.dart';

import '../../config/app_config.dart';

/// Opens a database connection for web platforms using IndexedDB.
QueryExecutor openConnection() {
  return DatabaseConnection.delayed(Future(() async {
    final result = await WasmDatabase.open(
      databaseName: AppConfig.dbName,
      sqlite3Uri: Uri.parse('sqlite3.wasm'),
      driftWorkerUri: Uri.parse('drift_worker.js'),
    );

    if (result.missingFeatures.isNotEmpty) {
      // Some features might be missing in older browsers
      // Log but continue - basic functionality should work
      print('Missing web database features: ${result.missingFeatures}');
    }

    return result.resolvedExecutor;
  }));
}
