import Flutter
import FirebaseMessaging
import UIKit
import UserNotifications

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

  override func applicationDidBecomeActive(_ application: UIApplication) {
    super.applicationDidBecomeActive(application)
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
