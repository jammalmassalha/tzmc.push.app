# TZMC Push App - Flutter Mobile Client

A Flutter mobile client for the TZMC Push messaging application, designed to replace the existing Angular PWA frontend.

## Overview

This Flutter app provides a native mobile experience for the TZMC Push messaging system. It connects to the same backend as the Angular frontend and provides feature parity while adding native mobile capabilities.

## Features

### Implemented
- ✅ Core infrastructure (HTTP client, API service, models)
- ✅ Authentication (login, SMS verification, session management)
- ✅ Realtime transport (Socket.IO, SSE fallback, polling)
- ✅ Local database (SQLite via Drift)
- ✅ RTL/Hebrew UI support
- ✅ Basic shell UI with navigation

### In Progress
- 🔄 Chat list and message view
- 🔄 Contact list integration
- 🔄 Group management

### Planned
- 📋 Send/receive messages
- 📋 Read receipts and reactions
- 📋 File attachments and uploads
- 📋 Push notifications (FCM/APNs)
- 📋 Shuttle booking module
- 📋 Helpdesk ticketing module

## Project Structure

```
flutter_app/
├── lib/
│   ├── core/
│   │   ├── api/           # HTTP client and API services
│   │   ├── config/        # App configuration
│   │   ├── database/      # Local SQLite database
│   │   ├── models/        # Domain models
│   │   ├── realtime/      # WebSocket/SSE transport
│   │   ├── services/      # Business services
│   │   └── utils/         # Utilities
│   ├── features/
│   │   ├── auth/          # Authentication
│   │   ├── chat/          # Chat list and messages
│   │   ├── groups/        # Group management
│   │   ├── helpdesk/      # Support tickets
│   │   ├── shuttle/       # Shuttle booking
│   │   └── settings/      # App settings
│   ├── shared/
│   │   ├── widgets/       # Reusable widgets
│   │   └── theme/         # App theming
│   └── main.dart          # Entry point
├── docs/
│   └── API.md             # API documentation
├── assets/                # Images, icons, fonts
└── test/                  # Unit and widget tests
```

## Getting Started

### Prerequisites
- Flutter SDK 3.2.0 or higher
- Dart SDK 3.2.0 or higher
- Android Studio / Xcode for mobile development

### Installation

1. Navigate to the Flutter app directory:
   ```bash
   cd flutter_app
   ```

2. Install dependencies:
   ```bash
   flutter pub get
   ```

3. Generate code (Drift database, JSON serialization):
   ```bash
   dart run build_runner build --delete-conflicting-outputs
   ```

4. Run the app:
   ```bash
   flutter run
   ```

### Development

For development with hot reload:
```bash
flutter run -d chrome  # Web
flutter run -d emulator  # Android
flutter run -d simulator  # iOS
```

### Building

Build release APK:
```bash
flutter build apk --release
```

Build release iOS:
```bash
flutter build ios --release
```

## Architecture

### State Management
Uses Riverpod for state management with a unidirectional data flow.

### Data Layer
- **API Service**: Handles HTTP communication with the backend
- **Database**: SQLite (via Drift) for local persistence
- **Realtime**: Socket.IO with SSE and polling fallback

### Feature Modules
Each feature is organized as a self-contained module with:
- `data/` - Data sources and repositories
- `domain/` - Business logic and use cases
- `presentation/` - UI widgets and state

## API Compatibility

This app is designed to work with the existing TZMC backend. See [docs/API.md](docs/API.md) for the complete API documentation.

## Contributing

1. Follow the existing code style and patterns
2. Write tests for new features
3. Update documentation as needed
4. Ensure RTL support for Hebrew text

## Migration Notes

### From Angular Frontend

The Flutter app mirrors the Angular frontend's architecture:

| Angular | Flutter |
|---------|---------|
| `ChatApiService` | `ChatApiService` in `lib/core/api/` |
| `RealtimeTransportService` | `RealtimeTransportService` in `lib/core/realtime/` |
| `ChatStoreService` | State providers in feature modules |
| IndexedDB (Dexie) | SQLite (Drift) |
| SCSS styles | `AppTheme` and widget composition |

### Push Notifications

The Angular frontend uses Web Push (VAPID). For Flutter mobile:
- Android: Firebase Cloud Messaging (FCM)
- iOS: Apple Push Notification service (APNs)

The backend will need to support FCM device token registration alongside the existing Web Push subscriptions.

## License

Proprietary - TZMC
