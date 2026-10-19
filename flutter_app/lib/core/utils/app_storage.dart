library;

import 'dart:io';

import 'package:path_provider/path_provider.dart';

Future<Directory> resolveWritableAppDirectory({
  String? subdirectory,
}) async {
  final candidates = <Future<Directory> Function()>[
    getApplicationDocumentsDirectory,
    getApplicationSupportDirectory,
    getTemporaryDirectory,
  ];

  for (final candidate in candidates) {
    try {
      final base = await candidate();
      final directory = subdirectory == null || subdirectory.isEmpty
          ? base
          : Directory('${base.path}/$subdirectory');
      if (!await directory.exists()) {
        await directory.create(recursive: true);
      }
      return directory;
    } catch (_) {
      // Try the next writable location.
    }
  }

  final fallback = subdirectory == null || subdirectory.isEmpty
      ? Directory.systemTemp
      : Directory('${Directory.systemTemp.path}/$subdirectory');
  if (!await fallback.exists()) {
    await fallback.create(recursive: true);
  }
  return fallback;
}
