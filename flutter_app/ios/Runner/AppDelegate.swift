import Flutter
import FirebaseMessaging
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate {
  private let pushRegistrationChannelName = "flutter_push_registration"

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
        guard call.method == "registerForRemoteNotifications" else {
          result(FlutterMethodNotImplemented)
          return
        }
        let dispatchRegistrationRequest = {
          UIApplication.shared.registerForRemoteNotifications()
          // This confirms the request was dispatched. APNs completion/failure
          // is reported asynchronously via the UIApplicationDelegate callbacks.
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
