/// Native (non-web) implementation of the PDF file-picker shim.
///
/// Uses the real file_picker package which works on Android, iOS, macOS,
/// Windows, and Linux.  file_picker 12 exposes `pickFiles` as a static
/// method on [FilePicker] (the old `FilePicker.platform` instance getter and
/// the `FilePickerResult` wrapper were removed) and returns the picked
/// entries directly as a list.

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
  final files = await FilePicker.pickFiles(
    type: FileType.custom,
    allowedExtensions: ['pdf'],
    allowMultiple: false,
  );
  if (files.isEmpty) return null;
  final picked = files.first;
  // file_picker 12 dropped `PlatformFile.bytes`; the caller prefers `path`
  // when it is available, so only materialise the bytes when there is no
  // local path to read from.
  final path = picked.path;
  final hasPath = path != null && path.trim().isNotEmpty;
  return PickedFileData(
    name: picked.name,
    extension: picked.extension,
    bytes: hasPath ? null : await picked.readAsBytes(),
    path: path,
  );
}
