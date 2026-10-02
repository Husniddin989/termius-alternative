package com.termiusalt.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Keeps the app process running while SSH sessions are open. Without it
 * Android freezes the app soon after it leaves the screen, and the
 * connections drop. Shows an ongoing notification with the session count;
 * holds a partial wake lock so keep-alives still go out with the screen off.
 */
class SessionService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val count = intent?.getIntExtra(EXTRA_COUNT, 1) ?: 1
    val notification = buildNotification(count)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    if (wakeLock == null) {
      val power = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "TermiusAlternative:ssh").apply {
        setReferenceCounted(false)
        acquire()
      }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    super.onDestroy()
  }

  private fun buildNotification(count: Int): Notification {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "SSH sessions", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Shown while SSH sessions are kept open in the background"
          setShowBadge(false)
        }
      )
    }
    val open = PendingIntent.getActivity(
      this, 0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
    val text = if (count == 1) "1 SSH session is open" else "$count SSH sessions are open"
    @Suppress("DEPRECATION")
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL_ID) else Notification.Builder(this)
    return builder
      .setContentTitle("Termius Alternative")
      .setContentText(text)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentIntent(open)
      .setOngoing(true)
      .build()
  }

  companion object {
    private const val CHANNEL_ID = "ssh-sessions"
    private const val NOTIFICATION_ID = 1
    private const val EXTRA_COUNT = "count"

    /** Starts, updates (count > 0) or stops (count == 0) the service. */
    fun update(context: Context, count: Int) {
      val intent = Intent(context, SessionService::class.java)
      if (count <= 0) {
        context.stopService(intent)
        return
      }
      intent.putExtra(EXTRA_COUNT, count)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
      else context.startService(intent)
    }
  }
}
