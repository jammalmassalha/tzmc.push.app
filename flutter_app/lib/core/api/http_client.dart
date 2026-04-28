/// HTTP client wrapper with retry, timeout, and interceptor support.
///
/// This mirrors the fetchWithRetry behavior from the Angular frontend's ChatApiService.
library;

import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:logger/logger.dart';

import '../config/app_config.dart';
import '../config/environment.dart';
import '../utils/xfile.dart';
import 'cookie_setup_stub.dart'
    if (dart.library.io) 'cookie_setup_io.dart'
    if (dart.library.html) 'cookie_setup_web.dart';

final _logger = Logger(
  printer: PrettyPrinter(methodCount: 0, errorMethodCount: 5, lineLength: 80),
);

/// HTTP client provider.
///
/// This provider must be overridden in `main()` with an instance returned
/// from [HttpClient.create] so that platform-specific cookie persistence is
/// configured before any request is sent. Using the default value will throw
/// to make the misconfiguration obvious.
final httpClientProvider = Provider<HttpClient>((ref) {
  throw StateError(
    'httpClientProvider must be overridden with HttpClient.create() in main()',
  );
});

/// HTTP client with retry support and CSRF token handling
class HttpClient {
  late final Dio _dio;
  String? _csrfToken;
  Future<void> Function() _clearCookies = () async {};

  HttpClient._();

  /// Asynchronously create and fully initialize an [HttpClient].
  ///
  /// On native platforms this wires up a [PersistCookieJar] so the backend
  /// session cookie survives app restarts. On the web it enables
  /// `withCredentials` so the browser-managed cookie is sent on every
  /// request.
  static Future<HttpClient> create() async {
    final client = HttpClient._();
    await client._init();
    return client;
  }

  Future<void> _init() async {
    _dio = Dio(
      BaseOptions(
        baseUrl: Env.current.baseUrl,
        connectTimeout: NetworkTimeouts.defaultTimeout,
        receiveTimeout: NetworkTimeouts.defaultTimeout,
        sendTimeout: NetworkTimeouts.defaultTimeout,
        validateStatus: (status) => true, // Handle all status codes manually
      ),
    );

    // Configure cookie persistence (must happen before other interceptors so
    // that cookies are attached to outgoing requests and captured from
    // responses).
    _clearCookies = await configureCookieJar(_dio);

    // Add logging interceptor in development
    if (Env.current.enableLogging) {
      _dio.interceptors.add(LogInterceptor(
        requestBody: true,
        responseBody: true,
        error: true,
        logPrint: (obj) => _logger.d(obj.toString()),
      ));
    }

    // Add CSRF token interceptor
    _dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) {
        // Attach CSRF token for non-GET requests
        final method = options.method.toUpperCase();
        if (method != 'GET' && method != 'HEAD' && _csrfToken != null) {
          options.headers['X-CSRF-Token'] = _csrfToken;
        }
        handler.next(options);
      },
    ));
  }

  /// Get current CSRF token
  String? get csrfToken => _csrfToken;

  /// Set CSRF token (typically from session response)
  void setCsrfToken(String? token) {
    _csrfToken = token?.trim().isNotEmpty == true ? token!.trim() : null;
  }

  /// Clear CSRF token
  void clearCsrfToken() {
    _csrfToken = null;
  }

  /// Clear any persisted session cookies (called on logout).
  Future<void> clearCookies() async {
    try {
      await _clearCookies();
    } catch (e) {
      _logger.w('Failed to clear persisted cookies: $e');
    }
  }

  /// Perform GET request with retry
  Future<Response<T>> get<T>(
    String path, {
    Map<String, dynamic>? queryParameters,
    Options? options,
    RetryOptions? retryOptions,
  }) {
    return _requestWithRetry<T>(
      () => _dio.get<T>(
        path,
        queryParameters: queryParameters,
        options: options,
      ),
      retryOptions ?? const RetryOptions(),
    );
  }

  /// Perform POST request with retry
  Future<Response<T>> post<T>(
    String path, {
    Object? data,
    Map<String, dynamic>? queryParameters,
    Options? options,
    RetryOptions? retryOptions,
  }) {
    return _requestWithRetry<T>(
      () => _dio.post<T>(
        path,
        data: data,
        queryParameters: queryParameters,
        options: options,
      ),
      retryOptions ?? const RetryOptions(),
    );
  }

  /// Perform PUT request with retry
  Future<Response<T>> put<T>(
    String path, {
    Object? data,
    Map<String, dynamic>? queryParameters,
    Options? options,
    RetryOptions? retryOptions,
  }) {
    return _requestWithRetry<T>(
      () => _dio.put<T>(
        path,
        data: data,
        queryParameters: queryParameters,
        options: options,
      ),
      retryOptions ?? const RetryOptions(),
    );
  }

  /// Perform DELETE request with retry
  Future<Response<T>> delete<T>(
    String path, {
    Object? data,
    Map<String, dynamic>? queryParameters,
    Options? options,
    RetryOptions? retryOptions,
  }) {
    return _requestWithRetry<T>(
      () => _dio.delete<T>(
        path,
        data: data,
        queryParameters: queryParameters,
        options: options,
      ),
      retryOptions ?? const RetryOptions(),
    );
  }

  /// Upload file(s) with multipart form data (cross-platform).
  ///
  /// Uses [XFile] for cross-platform compatibility (works on web and native).
  Future<Response<T>> uploadFile<T>(
    String path, {
    required XFile file,
    String fieldName = 'file',
    XFile? thumbnail,
    String thumbnailFieldName = 'thumbnail',
    Map<String, dynamic>? additionalFields,
    RetryOptions? retryOptions,
    void Function(int, int)? onSendProgress,
  }) async {
    final formData = FormData();

    // Read file bytes (works on both web and native)
    final fileBytes = await file.readAsBytes();
    formData.files.add(MapEntry(
      fieldName,
      MultipartFile.fromBytes(
        fileBytes,
        filename: file.name,
        contentType: file.mimeType != null
            ? DioMediaType.parse(file.mimeType!)
            : null,
      ),
    ));

    if (thumbnail != null) {
      final thumbBytes = await thumbnail.readAsBytes();
      formData.files.add(MapEntry(
        thumbnailFieldName,
        MultipartFile.fromBytes(
          thumbBytes,
          filename: thumbnail.name,
          contentType: thumbnail.mimeType != null
              ? DioMediaType.parse(thumbnail.mimeType!)
              : null,
        ),
      ));
    }

    if (additionalFields != null) {
      additionalFields.forEach((key, value) {
        formData.fields.add(MapEntry(key, value.toString()));
      });
    }

    return _requestWithRetry<T>(
      () => _dio.post<T>(
        path,
        data: formData,
        options: Options(
          sendTimeout: NetworkTimeouts.uploadTimeout,
          receiveTimeout: NetworkTimeouts.uploadTimeout,
        ),
        onSendProgress: onSendProgress,
      ),
      retryOptions ?? const RetryOptions(retries: 2, timeout: NetworkTimeouts.uploadTimeout),
    );
  }

  /// Internal retry wrapper matching Angular frontend behavior
  Future<Response<T>> _requestWithRetry<T>(
    Future<Response<T>> Function() request,
    RetryOptions options,
  ) async {
    final retries = options.retries;
    final backoff = options.backoff;

    Object? lastError;

    for (var attempt = 0; attempt <= retries; attempt++) {
      try {
        final response = await request().timeout(options.timeout);

        // Retry on 5xx errors if we have retries left; do NOT retry 429 (rate
        // limit) – retrying would only consume more quota and worsen the backoff.
        if (!_isSuccessful(response.statusCode ?? 0) && attempt < retries) {
          final statusCode = response.statusCode ?? 0;
          if (statusCode >= 500) {
            await Future.delayed(backoff * (1 << attempt));
            continue;
          }
        }

        return response;
      } on DioException catch (e) {
        lastError = e;
        if (attempt < retries) {
          await Future.delayed(backoff * (1 << attempt));
          continue;
        }
      } on TimeoutException catch (e) {
        lastError = e;
        if (attempt < retries) {
          await Future.delayed(backoff * (1 << attempt));
          continue;
        }
      }
    }

    throw lastError ?? Exception('Request failed after $retries retries');
  }

  bool _isSuccessful(int statusCode) {
    return statusCode >= 200 && statusCode < 300;
  }
}

/// Options for retry behavior
class RetryOptions {
  final int retries;
  final Duration timeout;
  final Duration backoff;

  const RetryOptions({
    this.retries = 1,
    this.timeout = NetworkTimeouts.defaultTimeout,
    this.backoff = NetworkTimeouts.retryBackoff,
  });
}

/// Extension for checking response success
extension ResponseExtension on Response {
  bool get isSuccessful {
    final code = statusCode ?? 0;
    return code >= 200 && code < 300;
  }
}
