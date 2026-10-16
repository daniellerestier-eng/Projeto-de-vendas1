package com.splitshield

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.VpnService
import androidx.core.content.ContextCompat

/** Restaura a VPN após reiniciar o celular ou atualizar o app, se o usuário deixou ligada. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!Store.autostart(context) || !Store.wanted(context)) return
        // Só inicia se a permissão de VPN já foi concedida (prepare == null).
        if (VpnService.prepare(context) != null) return
        ContextCompat.startForegroundService(
            context,
            VpnForegroundService.intent(context, VpnForegroundService.ACTION_START)
        )
    }
}
