package com.splitshield

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
import androidx.core.app.NotificationCompat
import java.util.concurrent.Executors

/**
 * Serviço em primeiro plano que mantém o túnel vivo o dia todo.
 * START_STICKY + estado "wanted" persistido: se o sistema matar o processo, ele volta e reconecta.
 */
class VpnForegroundService : Service() {

    private val worker = Executors.newSingleThreadExecutor()

    @Volatile
    private var active = true

    private val statusListener: (VpnController.Snapshot) -> Unit = { snap ->
        if (active) {
            getSystemService(NotificationManager::class.java)
                .notify(NOTIF_ID, buildNotification(statusText(snap)))
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val channel = NotificationChannel(CHANNEL, "Status da VPN", NotificationManager.IMPORTANCE_LOW)
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        VpnController.addListener(statusListener)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Sempre promover a foreground primeiro (obrigatório após startForegroundService).
        startAsForeground(buildNotification(statusText(VpnController.snapshot)))

        val action = intent?.action
        if (action == null && !Store.wanted(this)) {
            // Reinício espúrio pelo sistema sem que o usuário queira a VPN ligada.
            active = false
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        when (action) {
            ACTION_STOP -> {
                active = false
                Store.setWanted(this, false)
                worker.execute {
                    VpnController.disconnect(this)
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                }
            }
            ACTION_RESTART -> worker.execute {
                VpnController.disconnect(this)
                connectOrFail()
            }
            else -> {
                Store.setWanted(this, true)
                worker.execute { connectOrFail() }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        active = false
        VpnController.removeListener(statusListener)
        worker.shutdown()
        super.onDestroy()
    }

    private fun connectOrFail() {
        if (!VpnController.connect(this)) {
            Store.setWanted(this, false)
            active = false
            val nm = getSystemService(NotificationManager::class.java)
            nm.notify(ERROR_ID, baseBuilder().setContentText(VpnController.snapshot.message).setAutoCancel(true).build())
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun startAsForeground(n: Notification) {
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, n)
        }
    }

    private fun statusText(s: VpnController.Snapshot): String = s.message

    private fun baseBuilder(): NotificationCompat.Builder {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_shield)
            .setContentTitle("Split Shield")
            .setContentIntent(open)
    }

    private fun buildNotification(text: String): Notification {
        val stop = PendingIntent.getForegroundService(
            this, 1, intent(this, ACTION_STOP), PendingIntent.FLAG_IMMUTABLE
        )
        return baseBuilder()
            .setContentText(text)
            .addAction(0, "Desconectar", stop)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    companion object {
        const val ACTION_START = "com.splitshield.START"
        const val ACTION_STOP = "com.splitshield.STOP"
        const val ACTION_RESTART = "com.splitshield.RESTART"
        private const val CHANNEL = "vpn_status"
        private const val NOTIF_ID = 1
        private const val ERROR_ID = 2

        fun intent(ctx: Context, action: String): Intent =
            Intent(ctx, VpnForegroundService::class.java).setAction(action)
    }
}
