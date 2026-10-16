package com.splitshield

import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.ListView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

/**
 * Split tunneling: apps marcados acessam a internet FORA da VPN e, para eles,
 * a VPN não existe (não enxergam interface tun nem TRANSPORT_VPN).
 */
class AppsActivity : AppCompatActivity() {

    private class Entry(val label: String, val pkg: String)

    private lateinit var list: ListView
    private var entries: List<Entry> = emptyList()
    private var changed = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_apps)
        title = getString(R.string.apps_title)

        list = findViewById(R.id.apps_list)
        list.choiceMode = ListView.CHOICE_MODE_MULTIPLE
        list.setOnItemClickListener { _, _, _, _ -> saveSelection() }

        Thread {
            val pm = packageManager
            val loaded = pm.getInstalledApplications(PackageManager.GET_META_DATA)
                .filter { it.packageName != packageName && pm.getLaunchIntentForPackage(it.packageName) != null }
                .map { Entry(pm.getApplicationLabel(it).toString(), it.packageName) }
                .sortedBy { it.label.lowercase() }
            val excluded = Store.excluded(this)
            runOnUiThread {
                entries = loaded
                list.adapter = ArrayAdapter(
                    this,
                    android.R.layout.simple_list_item_multiple_choice,
                    loaded.map { "${it.label}\n${it.pkg}" }
                )
                loaded.forEachIndexed { i, e -> list.setItemChecked(i, e.pkg in excluded) }
            }
        }.start()
    }

    private fun saveSelection() {
        val checked = list.checkedItemPositions
        val selected = HashSet<String>()
        for (i in 0 until checked.size()) {
            if (checked.valueAt(i)) selected.add(entries[checked.keyAt(i)].pkg)
        }
        // Mantém exclusões antigas de pacotes que não aparecem na lista (ex.: sem ícone de launcher).
        val known = entries.map { it.pkg }.toSet()
        selected.addAll(Store.excluded(this).filter { it !in known })
        Store.setExcluded(this, selected)
        changed = true
    }

    override fun onStop() {
        super.onStop()
        // Se a VPN está ligada, reaplica para as exclusões valerem já.
        if (changed && VpnController.snapshot.status == VpnController.Status.ON) {
            ContextCompat.startForegroundService(
                this, VpnForegroundService.intent(this, VpnForegroundService.ACTION_RESTART)
            )
        }
        changed = false
    }
}
