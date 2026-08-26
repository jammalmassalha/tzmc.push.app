/// Web implementation of the PDF file-picker shim.
///
/// file_picker 8.x re-exports file_picker_io.dart unconditionally; in
/// Flutter 3.38+, the web CFE can no longer resolve the static
/// `FilePicker.platform` getter through that export chain.
/// This stub bypasses the issue by using the browser's native
/// <input type="file"> element directly via package:web / dart:js_interop.

import 'dart:async';
import 'dart:js_interop';
import 'dart:typed_data';

import 'package:web/web.dart';

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
  final completer = Completer<PickedFileData?>();

  final input = HTMLInputElement()
    ..type = 'file'
    ..accept = '.pdf,application/pdf'
    ..style.display = 'none';

  input.addEventListener(
    'change',
    (Event _) {
      final files = input.files;
      if (files == null || files.length == 0) {
        if (!completer.isCompleted) completer.complete(null);
        return;
      }
      final file = files.item(0)!;
      final reader = FileReader();

      reader.addEventListener(
        'loadend',
        (Event _) {
          Uint8List? bytes;
          final result = reader.result;
          if (result != null && result.typeofEquals('object')) {
            final buf = result as JSArrayBuffer;
            bytes = Uint8List.view(buf.toDart);
          }
          final name = file.name;
          final ext = name.contains('.') ? name.split('.').last : null;
          if (!completer.isCompleted) {
            completer.complete(PickedFileData(
              name: name,
              extension: ext,
              bytes: bytes,
            ));
          }
        }.toJS,
      );

      reader.addEventListener(
        'error',
        (Event _) {
          if (!completer.isCompleted) completer.complete(null);
        }.toJS,
      );

      reader.readAsArrayBuffer(file);
    }.toJS,
  );

  document.body!.appendChild(input);
  input.click();

  // Detect cancel: focus returns to window without a 'change' event firing.
  window.addEventListener(
    'focus',
    (Event _) {
      Future.delayed(const Duration(milliseconds: 300), () {
        if (!completer.isCompleted) completer.complete(null);
        input.remove();
      });
    }.toJS,
  );

  return completer.future;
}

