package org.solislocal.app

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.Manifest
import android.content.pm.PackageManager
import android.content.Intent
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.webkit.*
import android.widget.*
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.URL
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var message: TextView
    private lateinit var retry: Button
    private lateinit var pullRefresh: SwipeRefreshLayout
    private lateinit var pairAction: Button
    private lateinit var progress: ProgressBar
    private lateinit var panel: LinearLayout
    private lateinit var route: TextView
    private val worker = Executors.newSingleThreadExecutor()
    @Volatile private var base: String? = null
    @Volatile private var connecting = false
    @Volatile private var loadingPage = false
    private var scannerOpen = false
    private var scanNotice: String? = null
    private val scanRequest = 1041
    private val cameraPermissionRequest = 1042

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val pageColor = getColor(R.color.solar_page)
        val inkColor = getColor(R.color.solar_ink)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setBackgroundColor(pageColor)
        }
        root.setOnApplyWindowInsetsListener { v, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val b = insets.getInsets(WindowInsets.Type.systemBars()); v.setPadding(b.left,b.top,b.right,b.bottom)
            } else { @Suppress("DEPRECATION") v.setPadding(0,insets.systemWindowInsetTop,0,insets.systemWindowInsetBottom) }
            insets
        }
        val bar = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(dp(12),dp(4),dp(8),dp(4)) }
        route = TextView(this).apply { text = getString(R.string.app_name); textSize = 18f; setTextColor(inkColor) }
        bar.addView(route, LinearLayout.LayoutParams(0,dp(52),1f))
        bar.addView(Button(this).apply { text="⋮"; contentDescription=getString(R.string.options); setOnClickListener { menu() } })
        root.addView(bar)
        val body = FrameLayout(this)
        web = WebView(this).apply {
            setBackgroundColor(pageColor)
            settings.javaScriptEnabled = true; settings.domStorageEnabled = true
            settings.userAgentString += " SolarMonitor/${BuildConfig.VERSION_NAME} Build/${BuildConfig.VERSION_CODE}"
            settings.allowFileAccess = false; settings.allowContentAccess = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            settings.setSupportMultipleWindows(false)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this,false)
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean = !allowed(req.url)
                override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse {
                    if (!allowed(req.url) || req.method != "GET") return response(403,getString(R.string.blocked))
                    return try {
                        val conn = URL(req.url.toString()).openConnection() as HttpsURLConnection
                        conn.setRequestProperty("Accept-Language", resources.configuration.locales[0].toLanguageTag())
                        conn.instanceFollowRedirects = false; conn.connectTimeout = 6000; conn.readTimeout = 10_000
                        try {
                            val status = conn.responseCode
                            if (req.isForMainFrame && status !in 200..299) reportPageError()
                            if (status in 300..399) return response(502,"Redirecionamento bloqueado")
                            val stream = if(status in 200..299) conn.inputStream else conn.errorStream
                            val bytes = stream?.use { input ->
                                val out=ByteArrayOutputStream(); val buffer=ByteArray(8192)
                                while(true) {
                                    val count=input.read(buffer); if(count<0) break
                                    require(out.size()+count<=5_000_000)
                                    out.write(buffer,0,count)
                                }
                                out.toByteArray()
                            } ?: ByteArray(0)
                            require(bytes.size <= 5_000_000)
                            val content = conn.contentType.orEmpty()
                            val mime = content.substringBefore(';').ifEmpty { "application/octet-stream" }
                            val headers = mutableMapOf<String,String>()
                            conn.headerFields.forEach { (key,value) ->
                                if (key != null && key.lowercase() !in setOf("content-encoding","content-length","transfer-encoding","connection")) headers[key]=value.joinToString(",")
                            }
                            WebResourceResponse(mime,"utf-8",status,conn.responseMessage?.ifBlank { "Response" } ?: "Response",headers,ByteArrayInputStream(bytes))
                        } finally { conn.disconnect() }
                    } catch (_: Exception) {
                        if (req.isForMainFrame) reportPageError()
                        response(503,getString(R.string.unavailable))
                    }
                }
                override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) { handler.cancel() }
                override fun onReceivedError(view: WebView,request: WebResourceRequest,error: WebResourceError) {
                    if (request.isForMainFrame) reportPageError()
                }
                override fun onPageFinished(view: WebView,url: String) {
                    if (loadingPage) {
                        loadingPage=false;connecting=false;this@MainActivity.progress.visibility=View.GONE
                        pullRefresh.isRefreshing=false;panel.visibility=View.GONE
                    }
                }
            }
        }
        pullRefresh = SwipeRefreshLayout(this).apply {
            setProgressBackgroundColorSchemeColor(pageColor)
            val accent=android.util.TypedValue()
            theme.resolveAttribute(android.R.attr.colorAccent,accent,true)
            setColorSchemeColors(accent.data)
            setOnChildScrollUpCallback { _,_ -> web.canScrollVertically(-1) }
            setOnRefreshListener { connect(fromPull=true) }
            addView(web,android.view.ViewGroup.LayoutParams(-1,-1))
        }
        body.addView(pullRefresh, FrameLayout.LayoutParams(-1,-1))
        panel = LinearLayout(this).apply { orientation=LinearLayout.VERTICAL; gravity=Gravity.CENTER; setPadding(dp(28),dp(20),dp(28),dp(20)); setBackgroundColor(pageColor) }
        message = TextView(this).apply { textSize=19f; gravity=Gravity.CENTER; setTextColor(inkColor) }
        progress = ProgressBar(this).apply { visibility=View.GONE;contentDescription=getString(R.string.loading) }
        retry = Button(this).apply { text=getString(R.string.retry); setOnClickListener { connect() } }
        panel.addView(progress);panel.addView(message); panel.addView(retry)
        pairAction=Button(this).apply { text=getString(R.string.pair_phone); setOnClickListener { scan() } }
        panel.addView(pairAction)
        panel.addView(TextView(this).apply { text=getString(R.string.build_version,BuildConfig.VERSION_NAME,BuildConfig.VERSION_CODE);setTextColor(inkColor);alpha=0.6f;textSize=12f;setPadding(0,dp(20),0,0) })
        body.addView(panel,FrameLayout.LayoutParams(-1,-1)); root.addView(body,LinearLayout.LayoutParams(-1,0,1f))
        setContentView(root)
        handleLink(intent)
    }
    override fun onResume() {
        super.onResume()
        if (!scannerOpen) {
            val notice = scanNotice
            if (notice != null) { scanNotice = null; showMessage(notice) } else connect()
        }
    }
    override fun onPause() { if (::web.isInitialized) web.onPause(); super.onPause() }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); handleLink(intent) }
    private fun dp(n: Int) = (n*resources.displayMetrics.density).toInt()
    private fun showMessage(text: String,error: Boolean=true,loading: Boolean=false) {
        panel.visibility=View.VISIBLE;message.text=text
        progress.visibility=if(loading) View.VISIBLE else View.GONE
        retry.visibility=if(error && !loading) View.VISIBLE else View.GONE
        pairAction.visibility=if(loading) View.GONE else View.VISIBLE
        if (!loading) pullRefresh.isRefreshing=false
    }
    private fun reportPageError() = runOnUiThread {
        if (!isDestroyed && loadingPage) {
            loadingPage=false;connecting=false
            showMessage(getString(R.string.open_failed))
        }
    }
    private fun allowed(uri: Uri): Boolean {
        val selected = base ?: return false
        val u=Uri.parse(selected)
        return uri.scheme=="https" && uri.host==u.host && uri.port==u.port && uri.userInfo==null
    }
    private fun response(status: Int,text: String) = WebResourceResponse("text/plain","utf-8",status,"Unavailable",mapOf("Cache-Control" to "no-store"),ByteArrayInputStream(text.toByteArray()))
    private fun connect(fromPull: Boolean=false) {
        if (!::web.isInitialized || connecting || scannerOpen) return
        if (Identity.alias(this)==null) { showMessage(getString(R.string.welcome),error=false); return }
        connecting=true
        loadingPage=false
        web.stopLoading()
        web.onResume()
        if (fromPull && base!=null && panel.visibility!=View.VISIBLE) {
            pullRefresh.isRefreshing=true
        } else showMessage(getString(R.string.connecting),error=false,loading=true)
        worker.execute {
            var selected: String? = null
            var label = ""
            try {
                Tls.install(this)
                for ((candidate,name) in listOf(Identity.lan(this) to getString(R.string.home),Identity.remote(this) to getString(R.string.remote))) {
                    if (candidate == null) continue
                    try {
                        val c = URL("$candidate/mobile/health").openConnection() as HttpsURLConnection
                        c.instanceFollowRedirects=false; c.connectTimeout=2200; c.readTimeout=3000
                        try { if(c.responseCode==200) { selected=candidate;label=name;break } } finally { c.disconnect() }
                    } catch (_: Exception) { }
                }
            } finally {
                runOnUiThread {
                    if (!isDestroyed) {
                        if(selected==null) { connecting=false;showMessage(getString(R.string.connection_failed)) }
                        else {
                            base=selected;route.text=getString(R.string.route,label);loadingPage=true
                            val language=resources.configuration.locales[0].toLanguageTag()
                            web.loadUrl("$selected/?lang=$language")
                        }
                    }
                }
            }
        }
    }
    private fun menu() { AlertDialog.Builder(this).setTitle(getString(R.string.app_name)).setItems(arrayOf(getString(R.string.refresh),getString(R.string.pair_other),getString(R.string.about_access))) { _,which ->
        when(which) {
            0 -> connect(fromPull=true)
            1 -> scan()
            else -> AlertDialog.Builder(this).setMessage(getString(R.string.about_message)).setPositiveButton(android.R.string.ok,null).show()
        }
    }.show() }
    private fun scan() {
        if (scannerOpen || connecting) return
        scannerOpen = true
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), cameraPermissionRequest)
        } else openScanner()
    }
    private fun openScanner() {
        try { startActivityForResult(Intent(this, ScannerActivity::class.java), scanRequest) }
        catch (e: Exception) {
            scannerOpen = false
            android.util.Log.e("SolarScanner", "Cannot launch scanner", e)
            showMessage(getString(R.string.camera_launch_failed))
        }
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode,permissions,grantResults)
        if (requestCode != cameraPermissionRequest) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) openScanner()
        else {
            scannerOpen = false
            val notice = getString(R.string.camera_permission)
            scanNotice = notice; showMessage(notice)
        }
    }
    @Deprecated("Android activity result callback")
    override fun onActivityResult(requestCode: Int,resultCode: Int,data: Intent?) {
        if(requestCode==scanRequest) {
            scannerOpen=false
            data?.getStringExtra(ScannerActivity.ERROR)?.let { scanNotice=it; showMessage(it) }
            if(resultCode==RESULT_OK) data?.getStringExtra(ScannerActivity.CODE)?.let { pair(it) }
            return
        }
        super.onActivityResult(requestCode,resultCode,data)
    }
    private fun handleLink(intent: Intent?) { intent?.dataString?.takeIf { it.startsWith("solar://pair?") }?.let { pair(it) } }
    private fun pair(text: String) {
        val code=PairingCode.parse(text)
        if(code==null) { showMessage(getString(R.string.invalid_code));return }
        if(connecting) return
        connecting=true; showMessage(getString(R.string.pairing),error=false,loading=true)
        worker.execute {
            val error=runCatching { Pairing.pair(this,code) }.exceptionOrNull()
            runOnUiThread { connecting=false;if(!isDestroyed) { if(error!=null) showMessage(if(error is PairingFailure) error.message ?: getString(R.string.pair_failed) else getString(R.string.pair_failed)) else connect() } }
        }
    }
    override fun onDestroy() { web.destroy();worker.shutdown();super.onDestroy() }
}
