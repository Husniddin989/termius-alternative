package com.termiusalt.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView

// Not edge-to-edge on purpose: with the classic layout the system bars stay
// outside the web view and the on-screen keyboard resizes it
// (windowSoftInputMode="adjustResize"), so the terminal stays visible.
class MainActivity : TauriActivity() {
  private var askedForNotifications = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    webView.addJavascriptInterface(Bridge(), "AndroidSessions")
  }

  override fun onDestroy() {
    // Closing the app ends its sessions; don't leave the notification behind.
    if (isFinishing) SessionService.update(applicationContext, 0)
    super.onDestroy()
  }

  /** Called from the web UI whenever the number of open SSH sessions changes. */
  inner class Bridge {
    @JavascriptInterface
    fun setCount(count: Int) {
      runOnUiThread {
        if (count > 0 && !askedForNotifications && Build.VERSION.SDK_INT >= 33 &&
          checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
          // The service runs either way; this only makes its notification visible.
          askedForNotifications = true
          requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS)) { }
        }
        SessionService.update(applicationContext, count)
      }
    }
  }
}
