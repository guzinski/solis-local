package org.solislocal.app

import android.content.Context
import android.net.Uri
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import org.json.JSONObject

class PairingFailure(message: String) : IOException(message)

data class PairingCode(val token: String, val lan: String, val secure: String, val remote: String, val caFingerprint: String) {
    companion object {
        fun parse(text: String): PairingCode? = runCatching {
            val uri = Uri.parse(text.trim())
            require(uri.scheme == "solar" && uri.host == "pair" && uri.getQueryParameter("v") == "1")
            val token = uri.getQueryParameter("t")!!
            val lan = uri.getQueryParameter("lan")!!.trimEnd('/')
            val secure = uri.getQueryParameter("secure")!!.trimEnd('/')
            val remote = uri.getQueryParameter("remote")!!.trimEnd('/')
            val ca = uri.getQueryParameter("ca")!!.lowercase()
            require(Regex("[0-9a-f]{64}").matches(ca) && Regex("[A-Za-z0-9_-]{32}").matches(token))
            require(Identity.origin(lan, "http") && Identity.privateAddress(Uri.parse(lan).host.orEmpty()))
            require(Identity.origin(secure, "https") && Identity.origin(remote, "https"))
            PairingCode(token, lan, secure, remote, ca)
        }.getOrNull()
    }
}

/**
 * Pairs this phone with a hub.
 *
 * The phone's key is created inside the Android Keystore (hardware-backed,
 * StrongBox when available) and can never be exported. Only a certificate
 * signing request (CSR) goes to the hub; the hub returns a certificate signed
 * by its private CA. The CA's fingerprint, read from the QR code, is checked
 * before anything is trusted, so a fake hub on the network can't take over.
 */
object Pairing {
    private const val KEY_PREFIX = "solar-device-"

    /** Blocking: run off the main thread. Must be on the hub's home network. */
    fun pair(ctx: Context, code: PairingCode) {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val alias = KEY_PREFIX + java.util.UUID.randomUUID().toString()
        val pair = generateKey(alias)
        try {

        val csr = buildCsr(pair.public, pair.private, "solar-device")
        val body = JSONObject()
            .put("token", code.token)
            .put("name", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
            .put("csr", pem("CERTIFICATE REQUEST", csr))
        val res = JSONObject(post(ctx, "${code.lan}/api/pair/claim", body.toString()))

        val cf = CertificateFactory.getInstance("X.509")
        val ca = cf.generateCertificate(res.getString("ca").byteInputStream()) as X509Certificate
        val cert = cf.generateCertificate(res.getString("cert").byteInputStream()) as X509Certificate

        val fp = MessageDigest.getInstance("SHA-256").digest(ca.encoded).joinToString("") { "%02x".format(it) }
        if (fp != code.caFingerprint) {
            ks.deleteEntry(alias)
            throw PairingFailure(ctx.getString(R.string.cert_mismatch))
        }
        cert.verify(ca.publicKey) // signed by that CA
        if (cert.publicKey != pair.public) throw PairingFailure(ctx.getString(R.string.cert_wrong_key))

        // Attach the signed certificate (and the CA) to the keystore key.
        ca.checkValidity(); cert.checkValidity()
        require(ca.basicConstraints >= 0 && cert.basicConstraints < 0)
        require(cert.extendedKeyUsage?.contains("1.3.6.1.5.5.7.3.2") == true)
        ks.setKeyEntry(alias, pair.private, null, arrayOf(cert, ca))

        val oldAlias = Identity.alias(ctx)
        Identity.save(ctx, code.secure, code.remote, res.getString("ca"), alias)
        Tls.install(ctx)
        if (oldAlias != null && oldAlias != alias) ks.deleteEntry(oldAlias)
        } catch (error: Exception) {
            ks.deleteEntry(alias)
            throw error
        }
    }

    private fun generateKey(alias: String): java.security.KeyPair {
        fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            // TLS signs with various digests, or pre-hashed (NONE).
            .setDigests(
                KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256,
                KeyProperties.DIGEST_SHA384, KeyProperties.DIGEST_SHA512,
            )
            .setIsStrongBoxBacked(strongBox)
            .build()
        val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        return try {
            kpg.initialize(spec(strongBox = true))
            kpg.generateKeyPair()
        } catch (_: StrongBoxUnavailableException) {
            kpg.initialize(spec(strongBox = false))
            kpg.generateKeyPair()
        }
    }

    private fun post(ctx: Context, url: String, json: String): String {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.instanceFollowRedirects = false
        conn.connectTimeout = 8_000
        conn.readTimeout = 15_000
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.setRequestProperty("content-type", "application/json")
        try {
            conn.outputStream.use { it.write(json.toByteArray()) }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (code !in 200..299) {
                // 403 is the one failure people hit in normal use; the hub's other
                // messages are technical and stay in English.
                if (code == 403) throw PairingFailure(ctx.getString(R.string.code_expired))
                throw PairingFailure(ctx.getString(R.string.pair_request_failed,code))
            }
            return text
        } finally {
            conn.disconnect()
        }
    }

    // ---- minimal PKCS#10 CSR (ECDSA P-256, SHA-256), DER-encoded by hand ----

    private fun buildCsr(pub: PublicKey, priv: PrivateKey, cn: String): ByteArray {
        val name = seq(set(seq(OID_CN, tlv(0x0C, cn.toByteArray()))))
        val info = seq(byteArrayOf(0x02, 0x01, 0x00), name, pub.encoded, byteArrayOf(0xA0.toByte(), 0x00))
        val sig = Signature.getInstance("SHA256withECDSA").run {
            initSign(priv)
            update(info)
            sign()
        }
        return seq(info, seq(OID_ECDSA_SHA256), tlv(0x03, byteArrayOf(0) + sig))
    }

    private val OID_CN = byteArrayOf(0x06, 0x03, 0x55, 0x04, 0x03)
    private val OID_ECDSA_SHA256 =
        byteArrayOf(0x06, 0x08, 0x2A, 0x86.toByte(), 0x48, 0xCE.toByte(), 0x3D, 0x04, 0x03, 0x02)

    private fun seq(vararg parts: ByteArray) = tlv(0x30, parts.fold(ByteArray(0)) { a, b -> a + b })
    private fun set(vararg parts: ByteArray) = tlv(0x31, parts.fold(ByteArray(0)) { a, b -> a + b })

    private fun tlv(tag: Int, content: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(tag)
        val n = content.size
        when {
            n < 0x80 -> out.write(n)
            n < 0x100 -> { out.write(0x81); out.write(n) }
            else -> { out.write(0x82); out.write(n shr 8); out.write(n and 0xFF) }
        }
        out.write(content)
        return out.toByteArray()
    }

    private fun pem(type: String, der: ByteArray): String =
        "-----BEGIN $type-----\n" + Base64.encodeToString(der, Base64.NO_WRAP).chunked(64).joinToString("\n") +
            "\n-----END $type-----\n"
}
