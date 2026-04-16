/// Realtime transport service for WebSocket, SSE, and polling fallback.
///
/// This mirrors the Angular RealtimeTransportService behavior with the
/// same fallback strategy: Socket → SSE → Polling
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:logger/logger.dart';
import 'package:socket_io_client/socket_io_client.dart' as socket_io;
import 'package:http/http.dart' as http;
import 'package:connectivity_plus/connectivity_plus.dart';

import '../config/app_config.dart';
import '../config/environment.dart';
import '../models/chat_models.dart';

final _logger = Logger(
  printer: PrettyPrinter(methodCount: 0, errorMethodCount: 5, lineLength: 80),
);

/// Transport mode enumeration
enum RealtimeTransportMode { socket, sse, polling }

/// Provider for the realtime transport service
final realtimeTransportServiceProvider = Provider<RealtimeTransportService>((ref) {
  return RealtimeTransportService();
});

/// Realtime transport service with fallback strategy
class RealtimeTransportService {
  /// Current transport mode
  RealtimeTransportMode _transportMode = RealtimeTransportMode.polling;
  RealtimeTransportMode get transportMode => _transportMode;

  /// Stream controller for incoming messages
  final _messageController = StreamController<dynamic>.broadcast();
  Stream<dynamic> get messageStream => _messageController.stream;

  /// Stream controller for connection events
  final _connectedController = StreamController<void>.broadcast();
  Stream<void> get connectedStream => _connectedController.stream;

  /// Stream controller for poll ticks
  final _pollTickController = StreamController<void>.broadcast();
  Stream<void> get pollTickStream => _pollTickController.stream;

  // Internal state
  socket_io.Socket? _socket;
  bool _socketConnected = false;
  bool _socketConnecting = false;
  http.Client? _sseClient;
  StreamSubscription? _sseSubscription;
  Timer? _pollTimer;
  Timer? _reconnectTimer;
  Timer? _socketReconnectTimer;
  Timer? _socketSseFallbackTimer;
  bool _shuttingDown = false;
  int _socketConsecutiveFailures = 0;
  int _socketDisabledUntil = 0;

  String? _activeUser;
  bool Function()? _isNetworkReachable;

  /// Human-readable label for current transport mode
  String get transportLabel {
    switch (_transportMode) {
      case RealtimeTransportMode.socket:
        return 'Socket';
      case RealtimeTransportMode.sse:
        return 'SSE';
      case RealtimeTransportMode.polling:
        return 'Polling';
    }
  }

  /// Start the transport state machine for the given user.
  /// Attempts Socket.io first, then falls back to SSE, with automatic reconnect.
  void connect(String user, {bool Function()? isNetworkReachable}) {
    disconnect();
    _activeUser = user;
    _isNetworkReachable = isNetworkReachable ?? () => true;

    if (!_isNetworkReachable!()) {
      return;
    }

    _connectSocketPreferred(user);
  }

  /// Emit an event through the active socket and wait for acknowledgement.
  /// Returns null when socket is not connected or ack times out.
  Future<Map<String, dynamic>?> emitWithAck(
    String eventName,
    dynamic payload, {
    Duration timeout = RealtimeConfig.socketAckTimeout,
  }) async {
    if (_socket == null || !_socketConnected) {
      return null;
    }

    final completer = Completer<Map<String, dynamic>?>();
    Timer? timeoutTimer;

    void done(Map<String, dynamic>? value) {
      if (!completer.isCompleted) {
        timeoutTimer?.cancel();
        completer.complete(value);
      }
    }

    timeoutTimer = Timer(timeout, () => done(null));

    try {
      _socket!.emitWithAck(eventName, payload, ack: (ackPayload) {
        if (ackPayload is Map<String, dynamic>) {
          done(ackPayload);
        } else {
          done(null);
        }
      });
    } catch (e) {
      done(null);
    }

    return completer.future;
  }

  /// Tear down all transports and timers
  void disconnect() {
    _shuttingDown = true;
    _stopSocketOnly();
    _stopSseOnly();

    _pollTimer?.cancel();
    _pollTimer = null;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _socketReconnectTimer?.cancel();
    _socketReconnectTimer = null;
    _socketSseFallbackTimer?.cancel();
    _socketSseFallbackTimer = null;

    _setTransportMode(RealtimeTransportMode.polling);
    _shuttingDown = false;
  }

  /// Start interval-based polling
  void startPolling(String user) {
    _pollTimer?.cancel();

    _pollTimer = Timer.periodic(RealtimeConfig.pollInterval, (_) {
      _pollTickController.add(null);
    });

    if (!_socketConnected && _sseSubscription == null) {
      _setTransportMode(RealtimeTransportMode.polling);
    }

    _pollTickController.add(null);
    _activeUser = user;
  }

  /// Dispose resources
  void dispose() {
    disconnect();
    _messageController.close();
    _connectedController.close();
    _pollTickController.close();
  }

  // ---------------------------------------------------------------------------
  // Socket.io Connection
  // ---------------------------------------------------------------------------

  Future<void> _connectSocketPreferred(String user) async {
    _shuttingDown = false;

    if (_socketDisabledUntil > DateTime.now().millisecondsSinceEpoch) {
      _startSseFallback(user);
      _scheduleSocketReconnect(user);
      return;
    }

    if (_isNetworkReachable != null && !_isNetworkReachable!()) {
      _startSseFallback(user);
      return;
    }

    if (_socketConnecting) {
      return;
    }
    _socketConnecting = true;

    _socketSseFallbackTimer?.cancel();
    _socketSseFallbackTimer = Timer(RealtimeConfig.socketFallbackToSseDelay, () {
      _socketSseFallbackTimer = null;
      if (!_socketConnected && _activeUser == user) {
        _startSseFallback(user);
      }
    });

    try {
      final socket = _createSocket(user);
      if (_activeUser != user) {
        socket.disconnect();
        return;
      }

      _shuttingDown = true;
      _stopSocketOnly();
      _shuttingDown = false;
      _socket = socket;

      socket.onConnect((_) {
        if (_activeUser != user) return;
        _resetSocketFailureState();
        _socketConnected = true;
        _socketConnecting = false;
        _setTransportMode(RealtimeTransportMode.socket);
        _socketSseFallbackTimer?.cancel();
        _socketSseFallbackTimer = null;
        _stopSseOnly();
        _connectedController.add(null);
        _logger.d('Socket connected');
      });

      socket.on('chat:message', (incoming) {
        if (incoming == null) return;
        _messageController.add(incoming);
      });

      socket.on('chat:connected', (_) {
        if (_activeUser != user) return;
        _resetSocketFailureState();
        _socketConnected = true;
        _setTransportMode(RealtimeTransportMode.socket);
        _stopSseOnly();
        _connectedController.add(null);
      });

      socket.onDisconnect((_) {
        if (_shuttingDown || _activeUser != user) return;
        _shuttingDown = true;
        _stopSocketOnly();
        _shuttingDown = false;
        _socketConnected = false;
        _socketConnecting = false;
        _setTransportMode(RealtimeTransportMode.polling);
        _handleSocketConnectFailure(user);
        _logger.d('Socket disconnected');
      });

      socket.onConnectError((error) {
        if (_shuttingDown || _activeUser != user) return;
        _shuttingDown = true;
        _stopSocketOnly();
        _shuttingDown = false;
        _socketConnected = false;
        _socketConnecting = false;
        _setTransportMode(RealtimeTransportMode.polling);
        _handleSocketConnectFailure(user);
        _logger.e('Socket connect error: $error');
      });

      socket.connect();
    } catch (e) {
      _shuttingDown = true;
      _stopSocketOnly();
      _shuttingDown = false;
      _socketConnecting = false;
      _socketConnected = false;
      _setTransportMode(RealtimeTransportMode.polling);
      _handleSocketConnectFailure(user);
      _logger.e('Socket creation error: $e');
    }
  }

  socket_io.Socket _createSocket(String user) {
    final serverUrl = Env.current.baseUrl.replaceAll('/notify', '');

    return socket_io.io(
      serverUrl,
      socket_io.OptionBuilder()
          .setPath(Env.current.socketPath)
          .setTransports(['polling', 'websocket'])
          .disableReconnection()
          .setAuth({'user': user})
          .setQuery({'user': user})
          .disableAutoConnect()
          .build(),
    );
  }

  // ---------------------------------------------------------------------------
  // SSE Fallback
  // ---------------------------------------------------------------------------

  void _startSseFallback(String user) {
    if (_socketConnected || (_isNetworkReachable != null && !_isNetworkReachable!())) {
      return;
    }
    if (_sseSubscription != null) {
      return;
    }

    try {
      final streamUrl = '${Env.current.baseUrl}${ApiEndpoints.stream}?user=${Uri.encodeComponent(user)}';
      _sseClient = http.Client();
      
      _setTransportMode(RealtimeTransportMode.sse);
      _logger.d('Starting SSE connection');

      // Note: For production, use a proper SSE client library
      // This is a simplified implementation
      _startSseStream(streamUrl, user);
    } catch (e) {
      _scheduleStreamReconnect(user);
      _logger.e('SSE start error: $e');
    }
  }

  void _startSseStream(String url, String user) async {
    try {
      final request = http.Request('GET', Uri.parse(url));
      request.headers['Accept'] = 'text/event-stream';
      request.headers['Cache-Control'] = 'no-cache';

      final response = await _sseClient!.send(request);
      
      if (response.statusCode != 200) {
        _stopSseOnly();
        _scheduleStreamReconnect(user);
        return;
      }

      _connectedController.add(null);

      _sseSubscription = response.stream
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .listen(
        (line) {
          if (line.startsWith('data: ')) {
            final data = line.substring(6);
            try {
              final parsed = jsonDecode(data);
              _messageController.add(parsed);
            } catch (e) {
              _messageController.add(data);
            }
          }
        },
        onError: (error) {
          _stopSseOnly();
          _scheduleStreamReconnect(user);
        },
        onDone: () {
          _stopSseOnly();
          _scheduleStreamReconnect(user);
        },
      );
    } catch (e) {
      _stopSseOnly();
      _scheduleStreamReconnect(user);
    }
  }

  // ---------------------------------------------------------------------------
  // Failure Handling & Reconnect
  // ---------------------------------------------------------------------------

  void _handleSocketConnectFailure(String user) {
    if (_activeUser != user) return;

    _socketConsecutiveFailures += 1;
    _startSseFallback(user);

    if (_socketConsecutiveFailures >= RealtimeConfig.maxSocketFailuresBeforeCooldown) {
      _socketConsecutiveFailures = 0;
      _socketDisabledUntil =
          DateTime.now().millisecondsSinceEpoch + RealtimeConfig.socketFailureCooldown.inMilliseconds;
    }

    _scheduleSocketReconnect(user);
  }

  void _resetSocketFailureState() {
    _socketConsecutiveFailures = 0;
    _socketDisabledUntil = 0;
  }

  void _scheduleStreamReconnect(String user) {
    if (_socketConnected || _reconnectTimer != null) return;

    _reconnectTimer = Timer(RealtimeConfig.streamRetryDelay, () {
      _reconnectTimer = null;
      if (_activeUser != user) return;
      _startSseFallback(user);
    });
  }

  void _scheduleSocketReconnect(String user) {
    if (_socketReconnectTimer != null) return;

    final now = DateTime.now().millisecondsSinceEpoch;
    final waitMs = _socketDisabledUntil > now
        ? (_socketDisabledUntil - now).clamp(RealtimeConfig.socketRetryDelay.inMilliseconds, double.infinity).toInt()
        : RealtimeConfig.socketRetryDelay.inMilliseconds;

    _socketReconnectTimer = Timer(Duration(milliseconds: waitMs), () {
      _socketReconnectTimer = null;
      if (_activeUser != user || (_isNetworkReachable != null && !_isNetworkReachable!())) return;
      _connectSocketPreferred(user);
    });
  }

  // ---------------------------------------------------------------------------
  // Internal Teardown Helpers
  // ---------------------------------------------------------------------------

  void _stopSocketOnly() {
    _socketConnected = false;
    _socketConnecting = false;
    if (_socket != null) {
      _socket!.disconnect();
      _socket!.dispose();
      _socket = null;
    }
    if (_sseSubscription != null) {
      _setTransportMode(RealtimeTransportMode.sse);
    } else {
      _setTransportMode(RealtimeTransportMode.polling);
    }
  }

  void _stopSseOnly() {
    _sseSubscription?.cancel();
    _sseSubscription = null;
    _sseClient?.close();
    _sseClient = null;
    if (!_socketConnected) {
      _setTransportMode(RealtimeTransportMode.polling);
    }
  }

  void _setTransportMode(RealtimeTransportMode mode) {
    if (_transportMode == mode) return;
    _transportMode = mode;
    _logger.d('Transport mode changed to: ${mode.name}');
  }
}

/// API endpoints for realtime connections
class ApiEndpoints {
  static const String stream = '/stream';
}

/// Network connectivity helper
class NetworkConnectivity {
  static Future<bool> isConnected() async {
    final connectivityResult = await Connectivity().checkConnectivity();
    return !connectivityResult.contains(ConnectivityResult.none);
  }

  static Stream<bool> get onConnectivityChanged {
    return Connectivity().onConnectivityChanged.map(
      (result) => !result.contains(ConnectivityResult.none),
    );
  }
}
