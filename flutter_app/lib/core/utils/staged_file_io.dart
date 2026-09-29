import 'dart:io';
import 'dart:typed_data';

Future<Uint8List> readStagedFile(String path) => File(path).readAsBytes();

Future<void> deleteStagedFile(String path) async {
  final file = File(path);
  if (await file.exists()) await file.delete();
}
