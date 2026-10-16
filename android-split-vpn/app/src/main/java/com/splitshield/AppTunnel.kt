package com.splitshield

import com.wireguard.android.backend.Tunnel

/** Representa o nosso único túnel para o GoBackend do WireGuard. */
class AppTunnel(
    private val tunnelName: String,
    private val listener: (Tunnel.State) -> Unit
) : Tunnel {
    override fun getName(): String = tunnelName
    override fun onStateChange(newState: Tunnel.State) = listener(newState)
}
