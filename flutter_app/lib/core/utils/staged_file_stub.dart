import 'dart:typed_data';

Future<Uint8List> readStagedFile(String path) =>
    Future.error(UnsupportedError('Local staged files are unavailable on web'));

Future<void> deleteStagedFile(String path) async {}
