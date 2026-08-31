/// Native (non-web) implementation of the PDF file-picker shim.
///
/// Uses the real file_picker package which works on Android, iOS, macOS,
/// Windows, and Linux.  file_picker 12 exposes its API as static methods on
/// [FilePicker] (the old `FilePicker.platform` instance getter and the
/// `FilePickerResult` wrapper were removed), and `pickFile` is the
/// non-deprecated entry point for single-file selection.

import 'dart:typed_data';

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
  final Uint8List? bytes;
  final String? path;
}

/// Pick a single PDF file from the user's device.
/// Returns `null` if the user cancels.
Future<PickedFileData?> pickPdfFile() async {
  final picked = await FilePicker.pickFile(
    type: FileType.custom,
    allowedExtensions: ['pdf'],
  );
  if (picked == null) return null;
  // `PlatformFile.extension` only exists from
  // file_picker_platform_interface 3.1.0 onward, and the lockfile pins 3.0.1.
  // Deriving it from `name` keeps this shim version-agnostic and matches what
  // the web implementation already does.
  final name = picked.name;
  final dotIndex = name.lastIndexOf('.');
  final extension = dotIndex > 0 && dotIndex < name.length - 1
      ? name.substring(dotIndex + 1)
      : null;
  // file_picker 12 dropped `PlatformFile.bytes`; the caller prefers `path`
  // when it is available, so only materialise the bytes when there is no
  // local path to read from.
  final path = picked.path;
  final hasPath = path != null && path.trim().isNotEmpty;
  return PickedFileData(
    name: name,
    extension: extension,
    bytes: hasPath ? null : await picked.readAsBytes(),
    path: path,
  );
}
