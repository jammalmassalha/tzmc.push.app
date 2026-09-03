import Flutter
import FirebaseMessaging
import UIKit
import UserNotifications

/// Covers the app's window with a blur while its contents must not be captured.
///
/// iOS gives an app no way to block the physical screenshot chord, so unlike
/// Android's `FLAG_SECURE` this cannot be a hard guarantee. What it *can* cover
/// is every capture path the system routes through the app's own window:
///
///   * the snapshot iOS takes when the app resigns active, which is what the
///     app switcher and the "app backgrounded" screenshot show, and
///   * active screen recording, AirPlay mirroring and QuickTime capture, which
///     are reported by `UIScreen.isCaptured`.
///
/// The blur is added as a subview of the window rather than of the Flutter view
/// so it survives route changes and covers any native overlay too.
final class PrivacyShield {
  static let shared = PrivacyShield()

  private var effectView: UIVisualEffectView?

  private init() {}

  /// True while the screen is being recorded, mirrored or otherwise captured.
  var isScreenCaptured: Bool {
    UIScreen.main.isCaptured
  }

  func cover(_ window: UIWindow?) {
    guard let window else { return }
    // Re-entrant: resigning active while already covered for a recording must
    // not stack a second blur that a single `uncover()` would fail to remove.
    guard effectView == nil else { return }

    let view = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
    view.frame = window.bounds
    view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    window.addSubview(view)
    effectView = view
  }

  func uncover() {
    effectView?.removeFromSuperview()
    effectView = nil
  }

  /// Uncover only when nothing is capturing the screen. Becoming active while a
  /// recording is still running must keep the blur in place.
  func uncoverIfNotCaptured() {
    guard !isScreenCaptured else { return }
    uncover()
  }
}

@main
@objc class AppDelegate: FlutterAppDelegate {
  // Must match _kPushRegistrationChannelName in push_notification_service.dart.
  private let pushRegistrationChannelName = "flutter_push_registration"

  private func clearBadgeAndDeliveredNotifications(completion: (() -> Void)? = nil) {
    let clearBadge = {
      UIApplication.shared.applicationIconBadgeNumber = 0
      let center = UNUserNotificationCenter.current()
      center.removeAllDeliveredNotifications()
      if #available(iOS 16.0, *) {
        center.setBadgeCount(0) { _ in
          completion?()
        }
      } else {
        completion?()
      }
    }
    if Thread.isMainThread {
      clearBadge()
    } else {
      DispatchQueue.main.async(execute: clearBadge)
    }
  }

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    GeneratedPluginRegistrant.register(with: self)
    let didFinishLaunching = super.application(
      application,
      didFinishLaunchingWithOptions: launchOptions
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleScreenCaptureChange),
      name: UIScreen.capturedDidChangeNotification,
      object: nil
    )
    // A recording may already be running when the app is launched, in which
    // case no change notification will arrive to install the blur.
    handleScreenCaptureChange()
    if let controller = window?.rootViewController as? FlutterViewController {
      let pushRegistrationChannel = FlutterMethodChannel(
        name: pushRegistrationChannelName,
        binaryMessenger: controller.binaryMessenger
      )
      pushRegistrationChannel.setMethodCallHandler { call, result in
        if call.method == "resetBadge" {
          self.clearBadgeAndDeliveredNotifications {
            result(nil)
          }
          return
        }
        guard call.method == "registerForRemoteNotifications" else {
          result(FlutterMethodNotImplemented)
          return
        }
        let dispatchRegistrationRequest = {
          UIApplication.shared.registerForRemoteNotifications()
          // This confirms only that the request was dispatched, not that APNs
          // registration succeeded. APNs completion/failure is reported later
          // via the UIApplicationDelegate callbacks.
          result(nil)
        }
        if Thread.isMainThread {
          dispatchRegistrationRequest()
        } else {
          DispatchQueue.main.async(execute: dispatchRegistrationRequest)
        }
      }
    }
    return didFinishLaunching
  }

  @objc private func handleScreenCaptureChange() {
    if PrivacyShield.shared.isScreenCaptured {
      PrivacyShield.shared.cover(window)
    } else if UIApplication.shared.applicationState == .active {
      // A recording can also stop while the app is backgrounded. Uncovering
      // then would leave the window exposed for the next snapshot, so the
      // shield is only lifted while the app is actually on screen —
      // `applicationDidBecomeActive` handles the rest.
      PrivacyShield.shared.uncover()
    }
  }

  override func applicationWillResignActive(_ application: UIApplication) {
    super.applicationWillResignActive(application)
    // Installed before the system takes its app-switcher snapshot, so the
    // preview shows the blur instead of the open conversation.
    PrivacyShield.shared.cover(window)
  }

  override func applicationDidBecomeActive(_ application: UIApplication) {
    super.applicationDidBecomeActive(application)
    PrivacyShield.shared.uncoverIfNotCaptured()
    clearBadgeAndDeliveredNotifications()
  }

  override func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    Messaging.messaging().apnsToken = deviceToken
    NSLog("[AppDelegate] APNs registration succeeded: %lu bytes", deviceToken.count)
    super.application(application, didRegisterForRemoteNotificationsWithDeviceToken: deviceToken)
  }

  override func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    NSLog("[AppDelegate] APNs registration failed: %@", error.localizedDescription)
    super.application(application, didFailToRegisterForRemoteNotificationsWithError: error)
  }
}
