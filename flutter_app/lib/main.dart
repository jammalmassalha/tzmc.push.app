/// TZMC Push App - Flutter mobile client
///
/// Main entry point for the application.
library;

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/date_symbol_data_local.dart';

import 'core/api/http_client.dart';
import 'core/config/environment.dart';
import 'core/navigation/root_navigator.dart';
import 'core/services/push_notification_service.dart';
import 'shared/theme/app_theme.dart';
import 'features/auth/presentation/auth_state.dart';
import 'features/auth/presentation/login_screen.dart';
import 'features/chat/presentation/chat_shell_screen.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Initialize Hebrew (and default) date formatting symbols so DateFormat
  // calls like DateFormat.yMd('he') don't throw LocaleDataException at build
  // time (which would render screens as a blank/gray ErrorWidget).
  await initializeDateFormatting('he', null);

  // Initialize environment
  Env.initialize(EnvironmentConfig.production);

  // Initialize Firebase + register the background message handler before
  // runApp(). The background handler must be a top-level function and must
  // be registered after Firebase.initializeApp(). Web uses the existing
  // web-push system, so skip there. We tolerate failures (e.g. missing
  // google-services.json during development) so the app still launches.
  if (!kIsWeb) {
    try {
      await Firebase.initializeApp();
      FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);
    } catch (e, st) {
      debugPrint('[main] Firebase init skipped: $e\n$st');
    }
  }

  // Build the HTTP client up-front so that platform-specific cookie
  // persistence (PersistCookieJar on native, withCredentials on web) is
  // wired up before any request — including the initial session check —
  // is sent. This is what keeps the user signed in across app restarts
  // and browser refreshes.
  final httpClient = await HttpClient.create();

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
    ProviderScope(
      overrides: [
        httpClientProvider.overrideWithValue(httpClient),
      ],
      child: const TzmcPushApp(),
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
      navigatorKey: rootNavigatorKey,

      // RTL support for Hebrew
      locale: const Locale('he', 'IL'),
      supportedLocales: const [
        Locale('he', 'IL'),
        Locale('en', 'US'),
      ],
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],

      // Theme
      // Match the Angular frontend, which is unconditionally light-themed
      // (see frontend/src/styles.scss: body background #f3f5fb, text #202330,
      // no prefers-color-scheme handling). Using ThemeMode.system caused the
      // Android app to fall back to a sparsely-styled dark theme, which made
      // the bottom navigation nearly unreadable on devices in dark mode.
      theme: AppTheme.light,
      darkTheme: AppTheme.light,
      themeMode: ThemeMode.light,

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
