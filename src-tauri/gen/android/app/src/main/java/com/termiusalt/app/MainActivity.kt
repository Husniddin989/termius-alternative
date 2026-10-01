package com.termiusalt.app

import android.os.Bundle

// Not edge-to-edge on purpose: with the classic layout the system bars stay
// outside the web view and the on-screen keyboard resizes it
// (windowSoftInputMode="adjustResize"), so the terminal stays visible.
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
  }
}
