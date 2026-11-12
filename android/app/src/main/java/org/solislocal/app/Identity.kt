package org.solislocal.app

import android.content.Context
import android.net.Uri

object Identity {
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("solar-device", Context.MODE_PRIVATE)
    fun alias(ctx: Context): String? = prefs(ctx).getString("alias", null)
    fun caPem(ctx: Context): String? = prefs(ctx).getString("ca", null)
    fun lan(ctx: Context): String? = prefs(ctx).getString("lan", null)
    fun remote(ctx: Context): String? = prefs(ctx).getString("remote", null)
    fun save(ctx: Context, lan: String, remote: String, caPem: String, alias: String) {
        check(prefs(ctx).edit().putString("lan", lan).putString("remote", remote)
            .putString("ca", caPem).putString("alias", alias).commit())
    }
    fun origin(text: String, scheme: String): Boolean = runCatching {
        val u = Uri.parse(text)
        u.scheme == scheme && !u.host.isNullOrBlank() && u.userInfo == null &&
            u.query == null && u.fragment == null && (u.path.isNullOrEmpty() || u.path == "/") &&
            (u.port == -1 || u.port in 1..65535)
    }.getOrDefault(false)
    fun privateAddress(host: String): Boolean {
        val parts = host.split('.').map { it.toIntOrNull() ?: return false }
        if (parts.size != 4 || parts.any { it !in 0..255 }) return false
        return parts[0] == 10 || (parts[0] == 192 && parts[1] == 168) ||
            (parts[0] == 172 && parts[1] in 16..31)
    }
}
