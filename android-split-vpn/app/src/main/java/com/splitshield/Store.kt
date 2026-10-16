package com.splitshield

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Tudo (inclusive a chave privada do WireGuard) fica em SharedPreferences cifradas
 * com AES-256, chave guardada no Android Keystore.
 */
object Store {
    private const val FILE = "split_shield_secure"
    private const val K_CONFIG = "config"
    private const val K_EXCLUDED = "excluded"
    private const val K_AUTOSTART = "autostart"
    private const val K_WANTED = "wanted"

    @Volatile
    private var prefs: SharedPreferences? = null

    private fun p(ctx: Context): SharedPreferences {
        prefs?.let { return it }
        synchronized(this) {
            prefs?.let { return it }
            val app = ctx.applicationContext
            val key = MasterKey.Builder(app)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            val created = EncryptedSharedPreferences.create(
                app,
                FILE,
                key,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
            prefs = created
            return created
        }
    }

    fun config(ctx: Context): String? = p(ctx).getString(K_CONFIG, null)
    fun setConfig(ctx: Context, v: String) = p(ctx).edit().putString(K_CONFIG, v).apply()

    fun excluded(ctx: Context): Set<String> =
        p(ctx).getStringSet(K_EXCLUDED, emptySet()) ?: emptySet()

    fun setExcluded(ctx: Context, v: Set<String>) =
        p(ctx).edit().putStringSet(K_EXCLUDED, HashSet(v)).apply()

    /** Reconectar sozinho depois de reiniciar o celular. */
    fun autostart(ctx: Context): Boolean = p(ctx).getBoolean(K_AUTOSTART, false)
    fun setAutostart(ctx: Context, v: Boolean) = p(ctx).edit().putBoolean(K_AUTOSTART, v).apply()

    /** O usuário deixou a VPN ligada? (restaurado após boot ou reinício do serviço) */
    fun wanted(ctx: Context): Boolean = p(ctx).getBoolean(K_WANTED, false)
    fun setWanted(ctx: Context, v: Boolean) = p(ctx).edit().putBoolean(K_WANTED, v).apply()
}
