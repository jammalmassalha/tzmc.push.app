/// Environment-specific configuration
library;

enum Environment {
  development,
  staging,
  production,
}

class EnvironmentConfig {
  final Environment environment;
  final String baseUrl;
  final bool enableLogging;
  final bool enableAnalytics;

  const EnvironmentConfig({
    required this.environment,
    required this.baseUrl,
    this.enableLogging = false,
    this.enableAnalytics = false,
  });

  /// Development environment pointing to production backend
  static const EnvironmentConfig development = EnvironmentConfig(
    environment: Environment.development,
    baseUrl: 'https://www.tzmc.co.il/notify',
    enableLogging: true,
    enableAnalytics: false,
  );

  /// Production environment
  static const EnvironmentConfig production = EnvironmentConfig(
    environment: Environment.production,
    baseUrl: 'https://www.tzmc.co.il/notify',
    enableLogging: false,
    enableAnalytics: true,
  );

  bool get isDevelopment => environment == Environment.development;
  bool get isProduction => environment == Environment.production;

  /// Get the socket.io path for realtime connections
  String get socketPath => '/notify/socket.io';

  /// Get the full URL for an endpoint
  String endpoint(String path) {
    if (path.startsWith('/')) {
      return '$baseUrl$path';
    }
    return '$baseUrl/$path';
  }
}

/// Current environment configuration - set at app startup
class Env {
  static EnvironmentConfig _current = EnvironmentConfig.production;

  static EnvironmentConfig get current => _current;

  static void initialize(EnvironmentConfig config) {
    _current = config;
  }
}
