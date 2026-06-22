/// Web database connection using WASM-based SQLite via drift_flutter.
///
/// Uses Drift's modern WASM backend (sqlite3.wasm + drift_worker.dart.js)
/// which does NOT require the legacy sql.js library.
///
/// The two web assets must be present in the Flutter `web/` directory before
/// running `flutter build web`.  Copy them from the pub cache after
/// `flutter pub get`:
///
///   PUB_CACHE="${PUB_CACHE:-$HOME/.pub-cache}"
///   # Compile the Drift worker from the drift package source
///   DRIFT_PKG=$(find "$PUB_CACHE/hosted/pub.dev" -maxdepth 1 -name "drift-*" \
///               -type d | sort -V | tail -n 1)
///   dart compile js -O2 -o web/drift_worker.dart.js \
///       "$DRIFT_PKG/web/drift_worker.dart"
///   # Copy sqlite3.wasm (look in sqlite3 or sqlite3_flutter_libs package)
///   SQLITE3_WASM=$(find "$PUB_CACHE/hosted/pub.dev" -name "sqlite3.wasm" \
///                  2>/dev/null | head -n 1)
///   [ -n "$SQLITE3_WASM" ] && cp "$SQLITE3_WASM" web/sqlite3.wasm
///
/// If the WASM files are absent at runtime the first query will fail
/// asynchronously, which chat_store_service.dart catches and handles by
/// falling back to the SharedPreferences-based WebChatStorage.
library;

import 'package:drift/drift.dart';
import 'package:drift_flutter/drift_flutter.dart';

import '../../config/app_config.dart';

/// Opens a database connection for web platforms using the WASM backend.
QueryExecutor openConnection() {
  return driftDatabase(
    name: AppConfig.dbName,
    web: DriftWebOptions(
      sqlite3Wasm: Uri.parse('sqlite3.wasm'),
      driftWorker: Uri.parse('drift_worker.dart.js'),
    ),
  );
}
