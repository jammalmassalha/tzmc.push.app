#!/bin/bash
# Flutter Build Script for Android, iOS, and Web
# Run this script from the flutter_app directory
# Output goes to ../dist folder

set -e

echo "=========================================="
echo "TZMC Push App - Flutter Build Script"
echo "=========================================="

# Check if Flutter is installed
if ! command -v flutter &> /dev/null; then
    echo "Error: Flutter is not installed. Please install Flutter first."
    echo "Visit: https://flutter.dev/docs/get-started/install"
    exit 1
fi

# Navigate to flutter_app directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Output directory is ../dist (at repo root level)
OUTPUT_DIR="$(dirname "$SCRIPT_DIR")/dist"
mkdir -p "$OUTPUT_DIR/android"
mkdir -p "$OUTPUT_DIR/web"
mkdir -p "$OUTPUT_DIR/ios"

echo ""
echo "Output directory: $OUTPUT_DIR"

echo ""
echo "0. Initializing platform directories if needed..."
# Create platform directories if they don't exist
if [ ! -d "android" ] || [ ! -d "ios" ] || [ ! -d "web" ]; then
    echo "   Creating platform directories..."
    flutter create --platforms=android,ios,web --org=co.il.tzmc .
fi

echo ""
echo "1. Getting Flutter dependencies..."
PUB_GET_LOG="$(mktemp)"
FALLBACK_ANALYZER_APPLIED=0
LOCAL_OVERRIDES_BACKUP=""
LOCAL_LOCKFILE_BACKUP=""
cleanup_local_overrides() {
    if [ "$FALLBACK_ANALYZER_APPLIED" -eq 1 ]; then
        if [ -n "$LOCAL_LOCKFILE_BACKUP" ] && [ -f "$LOCAL_LOCKFILE_BACKUP" ]; then
            mv "$LOCAL_LOCKFILE_BACKUP" pubspec.lock
        else
            rm -f pubspec.lock
        fi
        if [ -n "$LOCAL_OVERRIDES_BACKUP" ] && [ -f "$LOCAL_OVERRIDES_BACKUP" ]; then
            mv "$LOCAL_OVERRIDES_BACKUP" pubspec_overrides.yaml
        else
            rm -f pubspec_overrides.yaml
        fi
    fi
}
trap cleanup_local_overrides EXIT

set +e
flutter pub get 2>&1 | tee "$PUB_GET_LOG"
PUB_GET_EXIT=${PIPESTATUS[0]}
set -e

if [ "$PUB_GET_EXIT" -ne 0 ]; then
    if grep -q "_macros from sdk doesn't exist" "$PUB_GET_LOG"; then
        echo ""
        echo "⚠️  Detected Dart SDK without _macros support."
        echo "   Applying local legacy codegen fallback for this build script run."
        if [ -f pubspec_overrides.yaml ]; then
            LOCAL_OVERRIDES_BACKUP="$(mktemp)"
            cp pubspec_overrides.yaml "$LOCAL_OVERRIDES_BACKUP"
        fi
        if [ -f pubspec.lock ]; then
            LOCAL_LOCKFILE_BACKUP="$(mktemp)"
            cp pubspec.lock "$LOCAL_LOCKFILE_BACKUP"
        fi
        FALLBACK_ANALYZER_APPLIED=1
        echo "   Cleaning local resolution artifacts before fallback pub get..."
        rm -rf .dart_tool/build
        rm -f .dart_tool/package_config.json .dart_tool/package_config_subset .dart_tool/version pubspec.lock
        cat > pubspec_overrides.yaml <<'EOF'
dependency_overrides:
  shared_preferences_android: 2.4.2
  # build_runner 2.4.10 is the oldest release that accepts web_socket_channel
  # >=2.0.0 <4.0.0 (i.e. 3.x), which is required by firebase_messaging.
  # It still declares dart_style: ^2.0.0 and therefore does NOT call
  # DartFormatter(languageVersion:), which was only added in 2.4.14.
  build_runner: 2.4.10
  build_resolvers: 2.4.2
  dart_style: 2.3.6
  # analyzer 6.4.1 has no dependency on the `macros` package, so it resolves
  # correctly on Dart SDKs that lack _macros.
  analyzer: 6.4.1
  # source_gen 1.5.0 accepts analyzer >=5.2.0 <7.0.0 (satisfies 6.4.1) and
  # has no _macros dependency. All generators below require source_gen ^1.x.
  # source_gen 2.0.0 would need analyzer >=6.9.0 (macros) — unusable here.
  source_gen: 1.5.0
  # retrofit_generator 9.x requires analyzer >=6.9.0 (which needs _macros).
  # 8.2.0 accepts analyzer >=5.13.0 <7.0.0 and source_gen ^1.3.0.
  retrofit_generator: 8.2.0
  # freezed 3.x requires source_gen ^2.0.0 (needs analyzer >=6.9.0 = macros).
  # 2.5.2 is the last release with analyzer >=5.13.0 <7.0.0 + source_gen ^1.4.0.
  # (2.5.3 jumped to analyzer >=6.5.0 which pulls in macros.)
  freezed: 2.5.2
  # freezed 2.5.2 requires freezed_annotation ^2.4.1.
  # freezed_annotation 3.0.0 is an API-identical version bump paired with
  # freezed 3.0.0; downgrading to 2.4.4 is safe for codegen on old SDKs.
  freezed_annotation: 2.4.4
EOF
        FALLBACK_LOG="$(mktemp)"
        set +e
        flutter pub get 2>&1 | tee "$FALLBACK_LOG"
        FALLBACK_EXIT=${PIPESTATUS[0]}
        set -e

        if [ "$FALLBACK_EXIT" -ne 0 ]; then
            rm -f "$FALLBACK_LOG"
            echo "❌ Could not resolve dependencies with local analyzer fallbacks."
            echo "   Please upgrade Flutter/Dart to the repository CI version (Flutter 3.27.4 / Dart 3.6.x)."
            exit 1
        fi
        rm -f "$FALLBACK_LOG"
    else
        rm -f "$PUB_GET_LOG"
        exit 1
    fi
fi
rm -f "$PUB_GET_LOG"

echo ""
echo "2. Running code generation (Drift, JSON serializable, etc.)..."
dart run build_runner build --delete-conflicting-outputs

echo ""
echo "3. Checking Flutter setup..."
flutter doctor -v

echo ""
echo "=========================================="
echo "Building for WEB (Browser)..."
echo "=========================================="
# Use MSYS_NO_PATHCONV to prevent Git Bash from converting /fluttertest/ to a Windows path
# Use --pwa-strategy=none to disable service worker caching for easier updates
MSYS_NO_PATHCONV=1 flutter build web --release --base-href "/fluttertest/" --pwa-strategy=none

# Copy web build to output
rm -rf "$OUTPUT_DIR/web"
cp -r build/web "$OUTPUT_DIR/web"
echo "✅ Web build completed: $OUTPUT_DIR/web"
echo "   Deploy this folder to /fluttertest on your server"

echo ""
echo "=========================================="
echo "Building for ANDROID..."
echo "=========================================="

# Check for Java and suggest fix for SSL issues
if command -v java &> /dev/null; then
    JAVA_VERSION=$(java -version 2>&1 | head -n 1)
    echo "Java version: $JAVA_VERSION"
fi

# Build APK for direct installation
echo "Building APK..."
if flutter build apk --release --android-skip-build-dependency-validation; then
    cp build/app/outputs/flutter-apk/app-release.apk "$OUTPUT_DIR/android/tzmc-push-release.apk"
    echo "✅ Android APK: $OUTPUT_DIR/android/tzmc-push-release.apk"
else
    echo "⚠️  APK build failed. This is often due to SSL certificate issues."
    echo "   Solutions:"
    echo "   1. Run: flutter clean && flutter pub get"
    echo "   2. Update Java certificates: keytool -importkeystore ..."
    echo "   3. Check corporate proxy/firewall settings"
    echo "   4. Try building via GitHub Actions workflow instead"
fi

# Build App Bundle for Play Store
echo "Building App Bundle..."
if flutter build appbundle --release --android-skip-build-dependency-validation; then
    cp build/app/outputs/bundle/release/app-release.aab "$OUTPUT_DIR/android/tzmc-push-release.aab"
    echo "✅ Android Bundle: $OUTPUT_DIR/android/tzmc-push-release.aab"
else
    echo "⚠️  App Bundle build failed."
fi

echo ""
echo "=========================================="
echo "Building for iOS..."
echo "=========================================="
if [[ "$OSTYPE" == "darwin"* ]]; then
    flutter build ios --release --no-codesign
    if [ -d "build/ios/iphoneos/Runner.app" ]; then
        cd build/ios/iphoneos
        zip -r "$OUTPUT_DIR/ios/Runner.app.zip" Runner.app
        cd "$SCRIPT_DIR"
        echo "✅ iOS build completed: $OUTPUT_DIR/ios/Runner.app.zip"
        echo "   Note: You'll need to open Xcode to sign and archive for App Store"
    fi
else
    echo "⚠️  iOS build requires macOS. Skipping..."
    echo "   Use the GitHub Actions workflow for iOS builds."
fi

echo ""
echo "=========================================="
echo "BUILD SUMMARY"
echo "=========================================="
echo ""
echo "Output directory: $OUTPUT_DIR"
echo ""
ls -la "$OUTPUT_DIR"
echo ""
echo "Android:"
ls -la "$OUTPUT_DIR/android" 2>/dev/null || echo "  No Android builds"
echo ""
echo "Web:"
ls -la "$OUTPUT_DIR/web" 2>/dev/null || echo "  No Web builds"
echo ""
echo "iOS:"
ls -la "$OUTPUT_DIR/ios" 2>/dev/null || echo "  No iOS builds"
echo ""
echo "To deploy web build to server:"
echo "  1. Copy $OUTPUT_DIR/web/* to your server's /fluttertest folder"
echo "  2. Ensure your web server is configured to serve it at /fluttertest"
echo ""
echo "Alternative: Use GitHub Actions workflow for building in the cloud"
echo "  - Go to: Actions > Flutter Build > Run workflow"
echo "  - Download artifacts from the completed workflow"
echo ""
echo "Done!"
