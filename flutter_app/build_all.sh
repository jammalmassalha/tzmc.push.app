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
flutter pub get

echo ""
echo "2. Checking Flutter setup..."
flutter doctor -v

echo ""
echo "=========================================="
echo "Building for WEB (Browser)..."
echo "=========================================="
# Use MSYS_NO_PATHCONV to prevent Git Bash from converting /fluttertest/ to a Windows path
MSYS_NO_PATHCONV=1 flutter build web --release --base-href "/fluttertest/"

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
