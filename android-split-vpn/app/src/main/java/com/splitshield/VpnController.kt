package com.splitshield

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.wireguard.android.backend.GoBackend
import com.wireguard.android.backend.Tunnel
import com.wireguard.config.Config
import java.io.ByteArrayInputStream
import java.util.concurrent.CopyOnWriteArrayList

/** Liga/desliga o túnel WireGuard e publica o estado para a UI e para a notificação. */
object VpnController {
    enum class Status { OFF, CONNECTING, ON, ERROR }
    data class Snapshot(val status: Status, val message: String)

    private val main = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArrayList<(Snapshot) -> Unit>()

    @Volatile
    var snapshot: Snapshot = Snapshot(Status.OFF, "Desconectado")
        private set

    @Volatile
    private var backend: GoBackend? = null

    private val tunnel = AppTunnel("shield") { state ->
        // O sistema pode derrubar a VPN (ex.: outro app de VPN assumiu).
        if (state == Tunnel.State.DOWN && snapshot.status == Status.ON) {
            publish(Snapshot(Status.OFF, "Desconectado"))
        }
    }

    private fun backend(ctx: Context): GoBackend {
        backend?.let { return it }
        synchronized(this) {
            backend?.let { return it }
            val created = GoBackend(ctx.applicationContext)
            backend = created
            return created
        }
    }

    fun addListener(l: (Snapshot) -> Unit) {
        listeners.add(l)
        l(snapshot)
    }

    fun removeListener(l: (Snapshot) -> Unit) {
        listeners.remove(l)
    }

    private fun publish(s: Snapshot) {
        snapshot = s
        main.post { listeners.forEach { it(s) } }
    }

    /** Bloqueante: chame de uma thread de trabalho. Retorna true se conectou. */
    fun connect(ctx: Context): Boolean {
        publish(Snapshot(Status.CONNECTING, "Conectando…"))
        return try {
            val raw = Store.config(ctx) ?: error("Nenhuma configuração importada")
            val excluded = Store.excluded(ctx)
            val patched = ConfigPatcher.withExclusions(raw, excluded)
            val cfg = Config.parse(ByteArrayInputStream(patched.toByteArray(Charsets.UTF_8)))
            backend(ctx).setState(tunnel, Tunnel.State.UP, cfg)
            publish(Snapshot(Status.ON, "Conectado • ${excluded.size} app(s) fora da VPN"))
            true
        } catch (e: Exception) {
            publish(Snapshot(Status.ERROR, "Erro: ${e.message ?: e.javaClass.simpleName}"))
            false
        }
    }

    /** Bloqueante: chame de uma thread de trabalho. */
    fun disconnect(ctx: Context) {
        try {
            backend(ctx).setState(tunnel, Tunnel.State.DOWN, null)
        } catch (ignored: Exception) {
            // já estava desligado
        }
        publish(Snapshot(Status.OFF, "Desconectado"))
    }
}
