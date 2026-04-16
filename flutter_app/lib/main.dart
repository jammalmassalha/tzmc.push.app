/// TZMC Push App - Flutter mobile client
///
/// Main entry point for the application.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/config/environment.dart';
import 'shared/theme/app_theme.dart';
import 'features/auth/presentation/auth_state.dart';
import 'features/auth/presentation/login_screen.dart';
import 'features/chat/presentation/chat_shell_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  // Initialize environment
  Env.initialize(EnvironmentConfig.production);

  // Set system UI overlay style
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.dark,
      systemNavigationBarColor: Colors.white,
      systemNavigationBarIconBrightness: Brightness.dark,
    ),
  );

  // Lock to portrait mode for now
  SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
    DeviceOrientation.portraitDown,
  ]);

  runApp(
    const ProviderScope(
      child: TzmcPushApp(),
    ),
  );
}

/// Main application widget
class TzmcPushApp extends ConsumerWidget {
  const TzmcPushApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp(
      title: 'TZMC Push',
      debugShowCheckedModeBanner: false,

      // RTL support for Hebrew
      locale: const Locale('he', 'IL'),

      // Theme
      theme: AppTheme.light,
      darkTheme: AppTheme.dark,
      themeMode: ThemeMode.system,

      // Initial route handling based on auth state
      home: const AuthRouter(),
    );
  }
}

/// Router that shows appropriate screen based on auth state
class AuthRouter extends ConsumerWidget {
  const AuthRouter({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final authState = ref.watch(authStateProvider);

    return switch (authState) {
      AuthLoading() => const SplashScreen(),
      AuthUnauthenticated() => const LoginScreen(),
      AuthAwaitingCode() => const LoginScreen(),
      AuthAuthenticated() => const ChatShellScreen(),
      AuthError() => const LoginScreen(),
    };
  }
}

/// Splash screen shown while checking authentication
class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Theme.of(context).colorScheme.primary,
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            // App logo placeholder
            Container(
              width: 120,
              height: 120,
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(24),
              ),
              child: const Icon(
                Icons.chat_bubble_rounded,
                size: 60,
                color: Color(0xFF1976D2),
              ),
            ),
            const SizedBox(height: 32),
            const Text(
              'TZMC Push',
              style: TextStyle(
                fontSize: 28,
                fontWeight: FontWeight.bold,
                color: Colors.white,
              ),
            ),
            const SizedBox(height: 48),
            const CircularProgressIndicator(
              valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
            ),
          ],
        ),
      ),
    );
  }
}
