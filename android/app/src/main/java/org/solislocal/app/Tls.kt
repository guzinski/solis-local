package org.solislocal.app

import android.content.Context
import java.net.Socket
import java.security.KeyStore
import java.security.Principal
import java.security.PrivateKey
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509ExtendedKeyManager

/**
 * HTTPS to the hub, for every connection the app makes (API calls and the
 * video player both use HttpsURLConnection, so installing these as the
 * defaults covers everything; the app talks to nothing else).
 *
 * - Trust: only the hub's own CA from pairing. Public CAs are not trusted.
 * - Identity: the server certificate must name [SERVER_NAME], whatever
 *   address (VPS IP, LAN) the connection went to.
 * - Client certificate: this phone's key from the Android Keystore.
 */
object Tls {
    /** Must match SERVER_NAME in the hub's src/pki.ts. */
    const val SERVER_NAME = "hub.solar"

    fun install(ctx: Context) {
        val caPem = Identity.caPem(ctx) ?: return
        val ca = CertificateFactory.getInstance("X.509")
            .generateCertificate(caPem.byteInputStream()) as X509Certificate

        val trust = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null)
            setCertificateEntry("hub-ca", ca)
        }
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(trust) }

        val ssl = SSLContext.getInstance("TLS").apply {
            init(arrayOf(DeviceKeyManager(Identity.alias(ctx) ?: return)), tmf.trustManagers, null)
        }
        HttpsURLConnection.setDefaultSSLSocketFactory(ssl.socketFactory)
        HttpsURLConnection.setDefaultHostnameVerifier(HostnameVerifier { _, session ->
            // The chain was already validated against the hub CA during the
            // handshake; additionally require the hub's name, which client
            // certificates (signed by the same CA) never carry.
            val leaf = session.peerCertificates.firstOrNull() as? X509Certificate
            leaf?.subjectAlternativeNames?.any { it[0] == 2 && it[1] == SERVER_NAME } == true
        })
    }

    /** Presents the keystore key and its certificate chain as the client identity. */
    private class DeviceKeyManager(private val alias: String) : X509ExtendedKeyManager() {
        private val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

        private fun hasKey() = ks.containsAlias(alias)

        override fun chooseClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?) =
            if (hasKey()) alias else null

        override fun chooseEngineClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, engine: SSLEngine?) =
            if (hasKey()) alias else null

        override fun getCertificateChain(alias: String?): Array<X509Certificate>? =
            ks.getCertificateChain(this.alias)?.map { it as X509Certificate }?.toTypedArray()

        override fun getPrivateKey(alias: String?): PrivateKey? = ks.getKey(this.alias, null) as? PrivateKey

        override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?) =
            if (hasKey()) arrayOf(alias) else null

        override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? = null
        override fun chooseServerAlias(keyType: String?, issuers: Array<out Principal>?, socket: Socket?): String? = null
    }
}
