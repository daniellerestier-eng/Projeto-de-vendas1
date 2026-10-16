package com.splitshield

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.telephony.TelephonyManager
import android.text.InputType
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
import androidx.core.content.ContextCompat
import com.wireguard.config.Config
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.URL
import java.util.TimeZone
import javax.net.ssl.HttpsURLConnection

class MainActivity : AppCompatActivity() {

    private lateinit var statusView: TextView
    private lateinit var connectBtn: Button
    private lateinit var resultView: TextView

    private val statusListener: (VpnController.Snapshot) -> Unit = { render(it) }

    private val vpnPermission =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
            if (r.resultCode == RESULT_OK) startTunnel() else toast("Permissão de VPN negada.")
        }

    private val notifPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    private val pickConfig =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri != null) importFrom(uri)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        statusView = findViewById(R.id.status)
        connectBtn = findViewById(R.id.btn_connect)
        resultView = findViewById(R.id.result)

        val autostart = findViewById<SwitchCompat>(R.id.sw_autostart)
        autostart.isChecked = Store.autostart(this)
        autostart.setOnCheckedChangeListener { _, on -> Store.setAutostart(this, on) }

        connectBtn.setOnClickListener { onConnectClicked() }
        findViewById<Button>(R.id.btn_import).setOnClickListener { pickConfig.launch(arrayOf("*/*")) }
        findViewById<Button>(R.id.btn_paste).setOnClickListener { showPasteDialog() }
        findViewById<Button>(R.id.btn_apps).setOnClickListener {
            startActivity(Intent(this, AppsActivity::class.java))
        }
        findViewById<Button>(R.id.btn_killswitch).setOnClickListener { openVpnSettings() }
        findViewById<Button>(R.id.btn_battery).setOnClickListener { requestBatteryExemption() }
        findViewById<Button>(R.id.btn_test).setOnClickListener { runNetworkTest() }

        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    override fun onStart() {
        super.onStart()
        VpnController.addListener(statusListener)
    }

    override fun onStop() {
        VpnController.removeListener(statusListener)
        super.onStop()
    }

    private fun render(s: VpnController.Snapshot) {
        statusView.text = s.message
        statusView.setTextColor(
            when (s.status) {
                VpnController.Status.ON -> Color.parseColor("#2E7D32")
                VpnController.Status.CONNECTING -> Color.parseColor("#F9A825")
                VpnController.Status.ERROR -> Color.parseColor("#C62828")
                VpnController.Status.OFF -> Color.GRAY
            }
        )
        connectBtn.text = when (s.status) {
            VpnController.Status.ON, VpnController.Status.CONNECTING -> "Desconectar"
            else -> "Conectar"
        }
    }

    private fun onConnectClicked() {
        when (VpnController.snapshot.status) {
            VpnController.Status.ON, VpnController.Status.CONNECTING ->
                ContextCompat.startForegroundService(
                    this, VpnForegroundService.intent(this, VpnForegroundService.ACTION_STOP)
                )
            else -> {
                if (Store.config(this) == null) {
                    toast("Importe uma configuração WireGuard primeiro.")
                    return
                }
                val prepare = VpnService.prepare(this)
                if (prepare != null) vpnPermission.launch(prepare) else startTunnel()
            }
        }
    }

    private fun startTunnel() {
        ContextCompat.startForegroundService(
            this, VpnForegroundService.intent(this, VpnForegroundService.ACTION_START)
        )
    }

    // ---------------------------------------------------------------- config

    private fun importFrom(uri: Uri) {
        val text = try {
            contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
        } catch (e: Exception) {
            null
        }
        if (text.isNullOrBlank()) {
            toast("Não consegui ler o arquivo.")
            return
        }
        saveConfig(text)
    }

    private fun showPasteDialog() {
        val input = EditText(this).apply {
            hint = "[Interface]\nPrivateKey = …\nAddress = …\nDNS = …\n\n[Peer]\n…"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            minLines = 8
            gravity = Gravity.TOP
        }
        AlertDialog.Builder(this)
            .setTitle("Colar configuração WireGuard")
            .setView(input)
            .setPositiveButton("Salvar") { _, _ -> saveConfig(input.text.toString()) }
            .setNegativeButton("Cancelar", null)
            .show()
    }

    private fun saveConfig(text: String) {
        if (text.length > 64 * 1024) {
            toast("Arquivo grande demais para ser uma config WireGuard.")
            return
        }
        try {
            Config.parse(ByteArrayInputStream(text.toByteArray(Charsets.UTF_8)))
        } catch (e: Exception) {
            AlertDialog.Builder(this)
                .setTitle("Configuração inválida")
                .setMessage(e.message ?: e.javaClass.simpleName)
                .setPositiveButton("OK", null)
                .show()
            return
        }
        Store.setConfig(this, text)
        val warnings = ConfigPatcher.analyze(text)
        AlertDialog.Builder(this)
            .setTitle("Configuração salva (cifrada)")
            .setMessage(
                if (warnings.isEmpty()) "Nenhum risco de vazamento óbvio na config."
                else warnings.joinToString("\n\n") { "⚠ $it" }
            )
            .setPositiveButton("OK", null)
            .show()
    }

    // ---------------------------------------------------------------- sistema

    private fun openVpnSettings() {
        toast("Toque na engrenagem do Split Shield → 'VPN sempre ativa'.")
        try {
            startActivity(Intent(Settings.ACTION_VPN_SETTINGS))
        } catch (e: ActivityNotFoundException) {
            toast("Não consegui abrir as configurações de VPN.")
        }
    }

    private fun requestBatteryExemption() {
        val pm = getSystemService(PowerManager::class.java)
        if (pm.isIgnoringBatteryOptimizations(packageName)) {
            toast("Já está liberado.")
            return
        }
        try {
            startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
            )
        } catch (e: ActivityNotFoundException) {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    // ---------------------------------------------------------------- teste

    private fun runNetworkTest() {
        resultView.text = "Testando…"
        Thread {
            val msg = try {
                val conn = URL("https://ipinfo.io/json").openConnection() as HttpsURLConnection
                conn.connectTimeout = 8000
                conn.readTimeout = 8000
                val j = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
                val org = j.optString("org")
                val country = j.optString("country")
                val tz = j.optString("timezone")
                val deviceTz = TimeZone.getDefault().id
                val sim = (getSystemService(TELEPHONY_SERVICE) as? TelephonyManager)
                    ?.simCountryIso?.uppercase().orEmpty()
                buildString {
                    appendLine("IP de saída: ${j.optString("ip")}")
                    appendLine("Rede/ASN: $org")
                    appendLine("País do IP: $country  |  País do SIM: ${sim.ifEmpty { "?" }}")
                    appendLine("Fuso do IP: $tz  |  Fuso do aparelho: $deviceTz")
                    if (Regex(DATACENTER, RegexOption.IGNORE_CASE).containsMatchIn(org)) {
                        appendLine("⚠ Rede parece de datacenter/hospedagem: é o tipo de IP que mais cai em listas de VPN.")
                    }
                    if (sim.isNotEmpty() && country.isNotEmpty() && !sim.equals(country, true)) {
                        appendLine("⚠ País do IP ≠ país do SIM: incoerência que alguns apps usam como sinal.")
                    }
                    if (tz.isNotEmpty() && tz != deviceTz) {
                        appendLine("⚠ Fuso do IP ≠ fuso do aparelho.")
                    }
                }
            } catch (e: Exception) {
                "Falha no teste: ${e.message}"
            }
            runOnUiThread { resultView.text = msg }
        }.start()
    }

    private fun toast(m: String) = Toast.makeText(this, m, Toast.LENGTH_LONG).show()

    private companion object {
        const val DATACENTER =
            "hosting|cloud|digitalocean|amazon|google|microsoft|ovh|hetzner|linode|vultr|choopa|m247|datacamp|leaseweb|contabo"
    }
}
