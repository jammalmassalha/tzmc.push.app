/// Web database connection using WASM-based SQLite via drift_flutter.
///
/// Uses Drift's modern WASM backend (sqlite3.wasm + drift_worker.dart.js)
/// which does NOT require the legacy sql.js library.  Run
/// `dart run drift_flutter:setup` once to copy the WASM assets to the
/// `web/` directory, then `flutter build web` will include them.
///
/// If the WASM runtime is unavailable the first query will throw, which
/// chat_store_service.dart catches and falls back to the SharedPreferences-
/// based WebChatStorage.
library;

import 'package:drift/drift.dart';
import 'package:drift_flutter/drift_flutter.dart';

import '../../config/app_config.dart';

/// Opens a database connection for web platforms using the WASM backend.
QueryExecutor openConnection() {
  return driftDatabase(name: AppConfig.dbName);
}
