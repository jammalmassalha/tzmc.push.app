/// Shared authenticated image widgets.
///
/// On **mobile (Android/iOS)** [Image.network] / [NetworkImage] do not send
/// session cookies, so those widgets use the app's Dio [HttpClient] to fetch
/// bytes and render via [Image.memory].
///
/// On **web** the browser automatically attaches cookies to every request,
/// including `<img>` tag loads. Using Dio (XHR) instead would trigger the
/// browser's CORS policy when the Flutter app origin differs from the API
/// origin (e.g. `https://tzmc.co.il` vs `https://www.tzmc.co.il`). So on
/// web we simply delegate to [Image.network] / [NetworkImage] and let the
/// browser handle cookie forwarding natively.
library;

import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/http_client.dart';
import '../../core/config/environment.dart';

/// Converts a server-issued relative upload path to an absolute URL.
///
/// Upload paths are stored as absolute-path references such as
/// `/notify/uploads/filename.jpg`. Passing them directly to Dio's [get]
/// concatenates them with the configured `baseUrl`
/// (`https://www.tzmc.co.il/notify`), producing a double-prefix URL
/// (`…/notify/notify/uploads/…`) that the server never matches.
/// Resolving against the origin instead gives the correct URL.
String resolveToAbsoluteUrl(String url) {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  final origin = Uri.parse(Env.current.baseUrl).origin;
  return origin + (url.startsWith('/') ? url : '/$url');
}

/// Fetches an image from an authenticated endpoint and renders it.
///
/// On web, uses [Image.network] (browser handles cookies natively, avoids
/// CORS issues from XHR). On mobile, uses Dio to include the session cookie.
class AuthenticatedNetworkImage extends ConsumerStatefulWidget {
  final String url;
  final double? width;
  final double? height;
  final BoxFit fit;

  const AuthenticatedNetworkImage({
    super.key,
    required this.url,
    this.width,
    this.height,
    this.fit = BoxFit.cover,
  });

  @override
  ConsumerState<AuthenticatedNetworkImage> createState() =>
      _AuthenticatedNetworkImageState();
}

class _AuthenticatedNetworkImageState
    extends ConsumerState<AuthenticatedNetworkImage> {
  Uint8List? _bytes;
  bool _loading = true;
  bool _error = false;

  @override
  void initState() {
    super.initState();
    if (!kIsWeb) _loadViaDio();
  }

  @override
  void didUpdateWidget(AuthenticatedNetworkImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!kIsWeb && oldWidget.url != widget.url) {
      setState(() {
        _bytes = null;
        _loading = true;
        _error = false;
      });
      _loadViaDio();
    }
  }

  Future<void> _loadViaDio() async {
    try {
      final client = ref.read(httpClientProvider);
      final url = resolveToAbsoluteUrl(widget.url);
      final response = await client.get<List<int>>(
        url,
        options: Options(responseType: ResponseType.bytes),
      );
      if (!mounted) return;
      if (response.statusCode == 200 && response.data != null) {
        setState(() {
          _bytes = Uint8List.fromList(response.data!);
          _loading = false;
        });
      } else {
        setState(() {
          _loading = false;
          _error = true;
        });
      }
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = true;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final w = widget.width ?? 200;
    final h = widget.height ?? 150;

    // On web: delegate to Image.network — the browser sends cookies and
    // renders the image without triggering CORS for simple img requests.
    if (kIsWeb) {
      return Image.network(
        resolveToAbsoluteUrl(widget.url),
        width: w,
        height: h,
        fit: widget.fit,
        errorBuilder: (_, __, ___) => Container(
          width: w,
          height: h,
          color: Colors.grey[300],
          child: const Icon(Icons.broken_image, size: 48),
        ),
      );
    }

    // Mobile: render bytes fetched via Dio.
    if (_loading) {
      return Container(
        width: w,
        height: h,
        color: Colors.grey[200],
        child: const Center(child: CircularProgressIndicator(strokeWidth: 2)),
      );
    }
    if (_error || _bytes == null) {
      return Container(
        width: w,
        height: h,
        color: Colors.grey[300],
        child: const Icon(Icons.broken_image, size: 48),
      );
    }
    return Image.memory(
      _bytes!,
      width: w,
      height: h,
      fit: widget.fit,
      errorBuilder: (_, __, ___) => Container(
        width: w,
        height: h,
        color: Colors.grey[300],
        child: const Icon(Icons.broken_image, size: 48),
      ),
    );
  }
}

/// A [CircleAvatar]-like widget that loads an image via the appropriate
/// strategy for the current platform. Falls back to [fallback] when [url]
/// is null/empty or the request fails.
///
/// Web: uses [NetworkImage] (browser handles cookies, no CORS issues).
/// Mobile: uses Dio to include the session cookie.
class AuthenticatedCircleAvatar extends ConsumerStatefulWidget {
  final String? url;
  final double radius;
  final Widget fallback;

  const AuthenticatedCircleAvatar({
    super.key,
    required this.url,
    required this.radius,
    required this.fallback,
  });

  @override
  ConsumerState<AuthenticatedCircleAvatar> createState() =>
      _AuthenticatedCircleAvatarState();
}

class _AuthenticatedCircleAvatarState
    extends ConsumerState<AuthenticatedCircleAvatar> {
  Uint8List? _bytes;
  bool _loading = false;
  bool _error = false;

  @override
  void initState() {
    super.initState();
    if (!kIsWeb && widget.url != null && widget.url!.isNotEmpty) {
      _loadViaDio(widget.url!);
    }
  }

  @override
  void didUpdateWidget(AuthenticatedCircleAvatar oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!kIsWeb && oldWidget.url != widget.url) {
      setState(() {
        _bytes = null;
        _error = false;
      });
      if (widget.url != null && widget.url!.isNotEmpty) {
        _loadViaDio(widget.url!);
      }
    }
  }

  Future<void> _loadViaDio(String url) async {
    setState(() => _loading = true);
    try {
      final client = ref.read(httpClientProvider);
      final resolved = resolveToAbsoluteUrl(url);
      final response = await client.get<List<int>>(
        resolved,
        options: Options(responseType: ResponseType.bytes),
      );
      if (!mounted) return;
      if (response.statusCode == 200 && response.data != null) {
        setState(() {
          _bytes = Uint8List.fromList(response.data!);
          _loading = false;
        });
      } else {
        setState(() {
          _loading = false;
          _error = true;
        });
      }
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = true;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final diameter = widget.radius * 2;

    if (widget.url == null || widget.url!.isEmpty) {
      return SizedBox(
        width: diameter,
        height: diameter,
        child: widget.fallback,
      );
    }

    // On web: use CircleAvatar with NetworkImage — browser sends cookies
    // and avoids CORS issues from XHR.
    if (kIsWeb) {
      return CircleAvatar(
        radius: widget.radius,
        backgroundImage: NetworkImage(resolveToAbsoluteUrl(widget.url!)),
        onBackgroundImageError: (_, __) {},
        child: null,
      );
    }

    // Mobile: render bytes fetched via Dio.
    return SizedBox(
      width: diameter,
      height: diameter,
      child: ClipOval(
        child: (_error || (_bytes == null && !_loading))
            ? widget.fallback
            : _loading
                ? Container(
                    color: Colors.grey[200],
                    child: const Center(
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  )
                : Image.memory(
                    _bytes!,
                    width: diameter,
                    height: diameter,
                    fit: BoxFit.cover,
                    errorBuilder: (_, __, ___) => widget.fallback,
                  ),
      ),
    );
  }
}
