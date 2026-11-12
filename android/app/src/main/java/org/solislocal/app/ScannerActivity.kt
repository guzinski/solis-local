package org.solislocal.app

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowInsets
import android.os.Build
import android.widget.Button
import android.widget.LinearLayout
import com.google.zxing.BarcodeFormat
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.CameraPreview
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.journeyapps.barcodescanner.DefaultDecoderFactory

/** The app owns permission and camera lifecycle; no legacy capture Activity. */
class ScannerActivity : Activity() {
    companion object {
        const val CODE = "solar_scan_code"
        const val ERROR = "solar_scan_error"
    }
    private var scanner: DecoratedBarcodeView? = null
    private var completed = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            fail(getString(R.string.camera_denied))
            return
        }
        try {
            val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            root.setOnApplyWindowInsetsListener { view,insets ->
                if (Build.VERSION.SDK_INT >= 30) {
                    val b=insets.getInsets(WindowInsets.Type.systemBars());view.setPadding(b.left,b.top,b.right,b.bottom)
                } else { @Suppress("DEPRECATION") view.setPadding(0,insets.systemWindowInsetTop,0,insets.systemWindowInsetBottom) }
                insets
            }
            val close = Button(this).apply { text=getString(R.string.cancel_scan);setOnClickListener { finish() } }
            root.addView(close,LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.WRAP_CONTENT))
            val reader = DecoratedBarcodeView(this)
            scanner = reader
            reader.barcodeView.isUseTextureView = true
            reader.decoderFactory = DefaultDecoderFactory(listOf(BarcodeFormat.QR_CODE))
            reader.setStatusText(getString(R.string.scan_prompt))
            reader.barcodeView.addStateListener(object : CameraPreview.StateListener {
                override fun previewSized() {}
                override fun previewStarted() {}
                override fun previewStopped() {}
                override fun cameraClosed() {}
                override fun cameraError(error: Exception) {
                    Log.e("SolarScanner","Camera unavailable",error)
                    fail(getString(R.string.camera_busy))
                }
            })
            root.addView(reader,LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,0,1f))
            setContentView(root)
            reader.decodeSingle(object : BarcodeCallback {
                override fun barcodeResult(result: BarcodeResult) {
                    if (completed) return
                    completed=true
                    setResult(RESULT_OK,Intent().putExtra(CODE,result.text))
                    finish()
                }
            })
        } catch (error: Exception) {
            Log.e("SolarScanner","Scanner initialization failed",error)
            fail(getString(R.string.scanner_failed))
        }
    }
    override fun onResume() {
        super.onResume()
        if (!completed && !isFinishing) {
            try { scanner?.resume() }
            catch (error: Exception) {
                Log.e("SolarScanner","Camera start failed",error)
                fail(getString(R.string.camera_start_failed))
            }
        }
    }
    override fun onPause() {
        try { scanner?.pause() }
        catch (error: Exception) { Log.e("SolarScanner","Camera stop failed",error) }
        super.onPause()
    }
    private fun fail(message: String) {
        if (completed) return
        completed=true
        setResult(RESULT_CANCELED,Intent().putExtra(ERROR,message))
        finish()
    }
}
