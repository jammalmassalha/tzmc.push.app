/// Cross-platform file abstraction.
///
/// Provides a unified file interface that works on both native and web platforms.
/// On web, files are represented as in-memory byte data with metadata.
library;

import 'dart:typed_data';

import 'package:flutter/foundation.dart';

/// A cross-platform file representation.
///
/// On native platforms, this wraps a dart:io File.
/// On web, this holds the file bytes and metadata in memory.
class XFile {
  /// The file path (or virtual path on web).
  final String path;

  /// The file name.
  final String name;

  /// The MIME type of the file (if known).
  final String? mimeType;

  /// The file bytes (available on both native and web).
  /// On native, this is lazily loaded from the file system.
  Uint8List? _bytes;

  /// On native platforms, this holds a reference to read bytes lazily.
  final Future<Uint8List> Function()? _bytesLoader;

  /// Creates an XFile from bytes (used on web).
  XFile.fromBytes({
    required this.name,
    required Uint8List bytes,
    this.mimeType,
  })  : path = name,
        _bytes = bytes,
        _bytesLoader = null;

  /// Creates an XFile from a path (used on native).
  /// The bytes will be loaded lazily when needed.
  XFile.fromPath({
    required this.path,
    required Future<Uint8List> Function() bytesLoader,
    this.mimeType,
  })  : name = path.split('/').last.split('\\').last,
        _bytes = null,
        _bytesLoader = bytesLoader;

  /// Whether the file bytes are already loaded.
  bool get isBytesLoaded => _bytes != null;

  /// Gets the file bytes.
  /// On native, this loads bytes from the file system if not already loaded.
  Future<Uint8List> readAsBytes() async {
    if (_bytes != null) {
      return _bytes!;
    }
    if (_bytesLoader != null) {
      _bytes = await _bytesLoader!();
      return _bytes!;
    }
    throw StateError('XFile has no bytes and no loader');
  }

  /// Gets the file extension (without the dot).
  String get extension {
    final dotIndex = name.lastIndexOf('.');
    if (dotIndex == -1 || dotIndex == name.length - 1) {
      return '';
    }
    return name.substring(dotIndex + 1).toLowerCase();
  }

  /// Whether this is an image file based on extension.
  bool get isImage {
    const imageExtensions = {'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif'};
    return imageExtensions.contains(extension);
  }
}

/// Utility functions for file handling.
class XFileUtils {
  XFileUtils._();

  /// Creates an XFile from a native file path.
  /// This should only be called on native platforms.
  static XFile fromNativePath(String path, Future<Uint8List> Function() bytesLoader, {String? mimeType}) {
    return XFile.fromPath(
      path: path,
      bytesLoader: bytesLoader,
      mimeType: mimeType,
    );
  }

  /// Creates an XFile from in-memory bytes.
  /// This works on all platforms.
  static XFile fromMemory(String name, Uint8List bytes, {String? mimeType}) {
    return XFile.fromBytes(
      name: name,
      bytes: bytes,
      mimeType: mimeType,
    );
  }

  /// Detects MIME type from file extension.
  static String? mimeTypeFromExtension(String extension) {
    switch (extension.toLowerCase()) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'gif':
        return 'image/gif';
      case 'webp':
        return 'image/webp';
      case 'bmp':
        return 'image/bmp';
      case 'heic':
      case 'heif':
        return 'image/heic';
      case 'pdf':
        return 'application/pdf';
      case 'doc':
        return 'application/msword';
      case 'docx':
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      case 'xls':
        return 'application/vnd.ms-excel';
      case 'xlsx':
        return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      case 'txt':
        return 'text/plain';
      case 'mp4':
        return 'video/mp4';
      case 'mp3':
        return 'audio/mpeg';
      default:
        return 'application/octet-stream';
    }
  }
}
