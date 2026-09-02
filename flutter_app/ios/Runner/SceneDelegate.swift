import Flutter
import UIKit

/// Scene delegate for the Runner app.
///
/// `Info.plist` declares a `UIApplicationSceneManifest` that points at this
/// custom class via `UISceneDelegateClassName`. When a custom
/// `UISceneDelegate` is registered, iOS 13+ no longer falls back to the
/// `AppDelegate.window` path — this delegate is solely responsible for
/// creating the `UIWindow` and installing a `rootViewController`. If that
/// wiring is missing the app launches into a blank white window because no
/// view controller is ever made key & visible.
///
/// We instantiate `Main.storyboard`'s initial view controller, which is the
/// `FlutterViewController` that hosts the Flutter engine and renders the
/// Dart UI.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }

    let storyboard = UIStoryboard(name: "Main", bundle: nil)
    guard let rootViewController = storyboard.instantiateInitialViewController() else {
      return
    }

    let window = UIWindow(windowScene: windowScene)
    window.rootViewController = rootViewController
    self.window = window
    window.makeKeyAndVisible()
  }

  // `Info.plist` currently declares no `UIApplicationSceneManifest`, so this
  // delegate is dormant and `AppDelegate` owns the window and the privacy
  // shield. These hooks exist so that enabling scenes later does not silently
  // disable the shield: with scenes active the `UIApplication` lifecycle
  // callbacks on `AppDelegate` stop firing and `AppDelegate.window` is nil, so
  // the app-switcher snapshot would once again expose chat content.
  func sceneWillResignActive(_ scene: UIScene) {
    PrivacyShield.shared.cover(window)
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    PrivacyShield.shared.uncoverIfNotCaptured()
  }
}
