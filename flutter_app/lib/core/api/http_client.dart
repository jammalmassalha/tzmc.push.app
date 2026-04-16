/// HTTP client wrapper with retry, timeout, and interceptor support.
///
/// This mirrors the fetchWithRetry behavior from the Angular frontend's ChatApiService.
library;

import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:logger/logger.dart';

import '../config/app_config.dart';
import '../config/environment.dart';

final _logger = Logger(
  printer: PrettyPrinter(methodCount: 0, errorMethodCount: 5, lineLength: 80),
);

/// HTTP client provider
final httpClientProvider = Provider<HttpClient>((ref) {
  return HttpClient();
});

/// HTTP client with retry support and CSRF token handling
class HttpClient {
  late final Dio _dio;
  String? _csrfToken;

  HttpClient() {
    _dio = Dio(
      BaseOptions(
        baseUrl: Env.current.baseUrl,
        connectTimeout: NetworkTimeouts.defaultTimeout,
        receiveTimeout: NetworkTimeouts.defaultTimeout,
        sendTimeout: NetworkTimeouts.defaultTimeout,
        validateStatus: (status) => true, // Handle all status codes manually
      ),
    );

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

  /// Upload file(s) with multipart form data
  Future<Response<T>> uploadFile<T>(
    String path, {
    required File file,
    String fieldName = 'file',
    File? thumbnail,
    String thumbnailFieldName = 'thumbnail',
    Map<String, dynamic>? additionalFields,
    RetryOptions? retryOptions,
    void Function(int, int)? onSendProgress,
  }) async {
    final formData = FormData();

    formData.files.add(MapEntry(
      fieldName,
      await MultipartFile.fromFile(file.path, filename: file.path.split('/').last),
    ));

    if (thumbnail != null) {
      formData.files.add(MapEntry(
        thumbnailFieldName,
        await MultipartFile.fromFile(thumbnail.path, filename: thumbnail.path.split('/').last),
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

        // Retry on 5xx or 429 errors if we have retries left
        if (!_isSuccessful(response.statusCode ?? 0) && attempt < retries) {
          final statusCode = response.statusCode ?? 0;
          if (statusCode >= 500 || statusCode == 429) {
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
