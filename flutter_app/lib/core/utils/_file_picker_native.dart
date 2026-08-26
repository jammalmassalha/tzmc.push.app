/// Native (non-web) implementation of the PDF file-picker shim.
///
/// Uses the real file_picker package which works on Android, iOS, macOS,
/// Windows, and Linux.

import 'package:file_picker/file_picker.dart';

/// Minimal file-data carrier for the platform-agnostic shim API.
class PickedFileData {
  const PickedFileData({
    required this.name,
    required this.extension,
    required this.bytes,
    this.path,
  });
  final String name;
  final String? extension;
  final List<int>? bytes;
  final String? path;
}

/// Pick a single PDF file from the user's device.
/// Returns `null` if the user cancels.
Future<PickedFileData?> pickPdfFile() async {
  final result = await FilePicker.platform.pickFiles(
    type: FileType.custom,
    allowedExtensions: ['pdf'],
    withData: false,
  );
  if (result == null || result.files.isEmpty) return null;
  final picked = result.files.first;
  return PickedFileData(
    name: picked.name,
    extension: picked.extension,
    bytes: picked.bytes != null ? List<int>.from(picked.bytes!) : null,
    path: picked.path,
  );
}
