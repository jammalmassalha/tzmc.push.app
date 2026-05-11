import Flutter
import FirebaseMessaging
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate {
  private let pushRegistrationChannelName = "co.il.tzmc.tzmc_push/push_registration"

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
      pushRegistrationChannel.setMethodCallHandler { [weak application] call, result in
        guard call.method == "registerForRemoteNotifications" else {
          result(FlutterMethodNotImplemented)
          return
        }
        guard let application = application else {
          result(FlutterError(
            code: "APPLICATION_UNAVAILABLE",
            message: "UIApplication is unavailable",
            details: nil
          ))
          return
        }
        DispatchQueue.main.async {
          application.registerForRemoteNotifications()
          result(nil)
        }
      }
    }
    return didFinishLaunching
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
