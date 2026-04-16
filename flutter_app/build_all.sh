#!/bin/bash
# Flutter Build Script for Android, iOS, and Web
# Run this script from the flutter_app directory

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

# Create output directory
OUTPUT_DIR="$SCRIPT_DIR/build_output"
mkdir -p "$OUTPUT_DIR"

echo ""
echo "=========================================="
echo "Building for WEB (Browser)..."
echo "=========================================="
flutter build web --release --base-href /fluttertest/

# Copy web build to output
cp -r build/web "$OUTPUT_DIR/web"
echo "✅ Web build completed: $OUTPUT_DIR/web"
echo "   Deploy this folder to /fluttertest on your server"

echo ""
echo "=========================================="
echo "Building for ANDROID..."
echo "=========================================="
# Build APK for direct installation
flutter build apk --release
cp build/app/outputs/flutter-apk/app-release.apk "$OUTPUT_DIR/tzmc-push-release.apk"
echo "✅ Android APK: $OUTPUT_DIR/tzmc-push-release.apk"

# Build App Bundle for Play Store
flutter build appbundle --release
cp build/app/outputs/bundle/release/app-release.aab "$OUTPUT_DIR/tzmc-push-release.aab"
echo "✅ Android Bundle: $OUTPUT_DIR/tzmc-push-release.aab"

echo ""
echo "=========================================="
echo "Building for iOS..."
echo "=========================================="
if [[ "$OSTYPE" == "darwin"* ]]; then
    flutter build ios --release --no-codesign
    echo "✅ iOS build completed in: build/ios/iphoneos/Runner.app"
    echo "   Note: You'll need to open Xcode to sign and archive for App Store"
else
    echo "⚠️  iOS build requires macOS. Skipping..."
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
echo "To deploy web build to server:"
echo "  1. Copy $OUTPUT_DIR/web/* to your server's /fluttertest folder"
echo "  2. Ensure your web server is configured to serve it at /fluttertest"
echo ""
echo "Done!"
