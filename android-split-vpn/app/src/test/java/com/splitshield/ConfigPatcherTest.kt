package com.splitshield

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConfigPatcherTest {
    private val base = """
        [Interface]
        PrivateKey = AAAA
        Address = 10.0.0.2/32
        DNS = 10.0.0.1

        [Peer]
        PublicKey = BBBB
        Endpoint = example.com:51820
        AllowedIPs = 0.0.0.0/0, ::/0
    """.trimIndent()

    @Test
    fun injectsSortedExclusionsRightAfterInterfaceHeader() {
        val out = ConfigPatcher.withExclusions(base, listOf("com.b.app", "com.a.app"))
        val lines = out.lines()
        assertEquals("[Interface]", lines[0])
        assertEquals("ExcludedApplications = com.a.app, com.b.app", lines[1])
        assertEquals("PrivateKey = AAAA", lines[2])
    }

    @Test
    fun replacesExistingIncludedAndExcludedLines() {
        val cfg = base.replace(
            "[Interface]",
            "[Interface]\nIncludedApplications = com.x.y\nExcludedApplications = com.old.app"
        )
        val out = ConfigPatcher.withExclusions(cfg, listOf("com.new.app"))
        assertFalse(out.contains("IncludedApplications"))
        assertFalse(out.contains("com.old.app"))
        assertEquals(1, Regex("ExcludedApplications").findAll(out).count())
        assertTrue(out.contains("ExcludedApplications = com.new.app"))
    }

    @Test
    fun emptySelectionRemovesAppLinesAndAddsNone() {
        val cfg = base.replace("[Interface]", "[Interface]\nExcludedApplications = com.old.app")
        val out = ConfigPatcher.withExclusions(cfg, emptyList())
        assertFalse(out.contains("Applications"))
        assertTrue(out.contains("PrivateKey = AAAA"))
    }

    @Test
    fun ignoresInvalidPackageNames() {
        val out = ConfigPatcher.withExclusions(base, listOf("com.ok.app", "bad name;rm", "x"))
        assertTrue(out.contains("ExcludedApplications = com.ok.app\n"))
        assertFalse(out.contains("bad"))
    }

    @Test
    fun handlesCrlfLineEndings() {
        val crlf = base.replace("\n", "\r\n").replace(
            "[Interface]",
            "[Interface]\r\nExcludedApplications = com.old.app"
        )
        val out = ConfigPatcher.withExclusions(crlf, listOf("com.new.app"))
        assertFalse(out.contains("com.old.app"))
        assertTrue(out.contains("ExcludedApplications = com.new.app"))
        assertTrue(out.contains("PrivateKey = AAAA"))
    }

    @Test
    fun analyzeAcceptsFullTunnelWithDns() {
        assertTrue(ConfigPatcher.analyze(base).isEmpty())
    }

    @Test
    fun analyzeFlagsMissingDnsAndIpv6() {
        val cfg = base.replace("DNS = 10.0.0.1\n", "").replace("0.0.0.0/0, ::/0", "0.0.0.0/0")
        val w = ConfigPatcher.analyze(cfg)
        assertEquals(2, w.size)
        assertTrue(w.any { it.contains("DNS") })
        assertTrue(w.any { it.contains("::/0") })
    }
}
