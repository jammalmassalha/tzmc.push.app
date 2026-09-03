package co.il.tzmc.tzmc_push

import android.os.Bundle
import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // FLAG_SECURE is enforced by the system WindowManager, not by the app,
        // so it cannot be bypassed from Dart or by a rooted-app overlay the way
        // a drawn-on privacy overlay could be. With it set the OS refuses
        // screenshots ("Can't take screenshot due to security policy"), renders
        // screen recordings, casts and other non-secure displays as a black
        // frame, and blanks the recent-apps preview.
        //
        // It must be applied before the first frame is presented, which is why
        // it lives in onCreate rather than being toggled per screen.
        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        )
    }
}
