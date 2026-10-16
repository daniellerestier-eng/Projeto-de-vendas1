package com.splitshield

/**
 * Lógica pura (sem Android) para ajustar a config WireGuard antes de subir o túnel.
 *
 * Split tunneling usa o recurso oficial `ExcludedApplications` do WireGuard, que vira
 * `VpnService.Builder.addDisallowedApplication()`: o app excluído usa a rede normal e,
 * para ele, a VPN não existe (não aparece TRANSPORT_VPN nem interface tun).
 */
object ConfigPatcher {
    private val APP_LINES =
        Regex("(?im)^[ \\t]*(ExcludedApplications|IncludedApplications)[ \\t]*=.*(\\r\\n|\\n|\\r)?")
    private val INTERFACE_HEADER = Regex("(?i)\\[Interface\\][ \\t]*(\\r\\n|\\n|\\r)?")
    private val PACKAGE = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+$")
    private val DNS_LINE = Regex("(?im)^[ \\t]*DNS[ \\t]*=[ \\t]*\\S+")
    private val ALLOWED_LINE = Regex("(?im)^[ \\t]*AllowedIPs[ \\t]*=(.*)$")

    /** Remove Included/ExcludedApplications existentes e injeta a lista escolhida no app. */
    fun withExclusions(config: String, excluded: Collection<String>): String {
        val cleaned = APP_LINES.replace(config, "")
        val packages = excluded.filter { PACKAGE.matches(it) }.distinct().sorted()
        if (packages.isEmpty()) return cleaned
        val line = "ExcludedApplications = " + packages.joinToString(", ")
        return INTERFACE_HEADER.replace(cleaned) { "[Interface]\n$line\n" }
    }

    /** Avisos de vazamento comuns em configs WireGuard. */
    fun analyze(config: String): List<String> {
        val warnings = mutableListOf<String>()
        if (!DNS_LINE.containsMatchIn(config)) {
            warnings += "Sem 'DNS =' na config: as consultas DNS podem sair fora do túnel (vazamento)."
        }
        val allowed = ALLOWED_LINE.findAll(config).joinToString(",") { it.groupValues[1] }
        val items = allowed.split(',').map { it.trim() }.filter { it.isNotEmpty() }
        if ("0.0.0.0/0" !in items) {
            warnings += "AllowedIPs sem 0.0.0.0/0: só parte do tráfego IPv4 vai pela VPN."
        }
        if ("::/0" !in items) {
            warnings += "AllowedIPs sem ::/0: o tráfego IPv6 pode vazar fora da VPN."
        }
        return warnings
    }
}
