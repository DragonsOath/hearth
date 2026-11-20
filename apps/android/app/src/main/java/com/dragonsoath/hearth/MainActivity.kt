package com.dragonsoath.hearth

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

/**
 * Hearth for Android: your Hearth, full screen, on a phone or tablet. The first time, it asks
 * for the QR code from Add a device (Settings, PCs and devices) and signs in with it; after that
 * it opens straight to your Hearth. It runs nothing itself: everything happens on your PCs.
 */
class MainActivity : ComponentActivity() {
    private val prefs by lazy { getSharedPreferences("hearth", MODE_PRIVATE) }
    private var web: WebView? = null
    private var forwarder: Forwarder? = null
    private var filePick: ValueCallback<Array<Uri>>? = null
    private var micAsk: PermissionRequest? = null

    private val scan = registerForActivityResult(ScanContract()) { result ->
        val text = result.contents ?: return@registerForActivityResult
        val pair = parsePairLink(text)
        if (pair == null) {
            showConnect("That QR code is not from Hearth. Open Add a device on your Hearth and scan its code.")
        } else {
            connect(pair.first, pair.second)
        }
    }

    private val micPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            val ask = micAsk ?: return@registerForActivityResult
            micAsk = null
            if (granted) ask.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else ask.deny()
        }

    private val pickFiles =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
            filePick?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
            filePick = null
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Test builds can be inspected from a computer (chrome://inspect); release builds can't.
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        window.statusBarColor = BG
        window.navigationBarColor = BG
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val w = web
                if (w != null && w.canGoBack()) w.goBack() else finish()
            }
        })
        val saved = prefs.getString("hearth", null)
        if (saved != null) openHearth(saved, "/") else showConnect(null)
    }

    override fun onDestroy() {
        forwarder?.stop()
        web?.destroy()
        super.onDestroy()
    }

    /* ---------- connecting the first time ---------- */

    private fun showConnect(problem: String?) {
        web?.destroy()
        web = null
        val pad = dp(24)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, dp(56), pad, pad)
            setBackgroundColor(BG)
        }
        fun text(s: String, size: Float, color: Int, top: Int = 0) = TextView(this).apply {
            text = s
            textSize = size
            setTextColor(color)
            setPadding(0, top, 0, 0)
        }
        col.addView(text("Hearth", 34f, GOLD))
        col.addView(text("Connect to your Hearth", 20f, INK, dp(8)))
        col.addView(
            text(
                "On your Hearth, open Settings, then PCs and devices, then Add a device. Scan the QR code it shows.",
                15f, MUTED, dp(12),
            ),
        )
        if (problem != null) col.addView(text(problem, 14f, BAD, dp(12)))
        col.addView(button("Scan the QR code", primary = true) {
            scan.launch(
                ScanOptions()
                    .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                    .setPrompt("Scan the QR code from Add a device")
                    .setBeepEnabled(false)
                    .setOrientationLocked(false),
            )
        }.also { it.layoutParams = margins(top = dp(24)) })
        col.addView(text("Or type them in", 15f, MUTED, dp(28)))
        val address = field("Your Hearth's address, like http://192.168.1.10:7600")
        val code = field("Code, like ABCD-EFGH").apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
        }
        col.addView(address)
        col.addView(code)
        col.addView(button("Connect", primary = false) {
            val a = address.text.toString().trim().let { if (it.startsWith("http")) it else "http://$it" }
            val origin = try {
                val u = Uri.parse(a)
                "${u.scheme}://${u.authority}"
            } catch (_: Exception) {
                null
            }
            if (origin == null || code.text.isBlank()) showConnect("Type both your Hearth's address and the code.")
            else connect(origin, code.text.toString().trim())
        }.also { it.layoutParams = margins(top = dp(12)) })
        setContentView(ScrollView(this).apply {
            setBackgroundColor(BG)
            addView(col)
        })
    }

    /** A QR code's link: your Hearth's address and the one-time code. */
    private fun parsePairLink(text: String): Pair<String, String>? = try {
        val u = Uri.parse(text.trim())
        val code = u.getQueryParameter("code")
        if ((u.scheme == "http" || u.scheme == "https") && u.path == "/pair" && !code.isNullOrBlank())
            "${u.scheme}://${u.authority}" to code
        else null
    } catch (_: Exception) {
        null
    }

    private fun connect(origin: String, code: String) {
        prefs.edit().putString("hearth", origin).apply()
        openHearth(origin, "/pair?code=" + Uri.encode(code))
    }

    /* ---------- your Hearth ---------- */

    @SuppressLint("SetJavaScriptEnabled")
    private fun openHearth(origin: String, path: String) {
        val base = pageBase(origin)
        val w = WebView(this)
        web = w
        w.setBackgroundColor(BG)
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            userAgentString = "$userAgentString HearthApp/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        w.addJavascriptInterface(Bridge(), "HearthApp")
        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val url = req.url
                // Your Hearth stays in the app; anything else (a system's own page) opens outside.
                if (url.toString().startsWith(base)) return false
                startActivity(Intent(Intent.ACTION_VIEW, url))
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                CookieManager.getInstance().flush()
            }
        }
        w.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    if (!request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                        request.deny()
                    } else if (ContextCompat.checkSelfPermission(
                            this@MainActivity, Manifest.permission.RECORD_AUDIO,
                        ) == PackageManager.PERMISSION_GRANTED
                    ) {
                        request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                    } else {
                        micAsk = request
                        micPermission.launch(Manifest.permission.RECORD_AUDIO)
                    }
                }
            }

            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                filePick?.onReceiveValue(null)
                filePick = callback
                return try {
                    pickFiles.launch(params.createIntent())
                    true
                } catch (_: Exception) {
                    filePick = null
                    false
                }
            }
        }
        w.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        setContentView(w)
        w.loadUrl(base + path)
    }

    /**
     * Where the page is opened: a secure (https) Hearth directly; a home-network one through this
     * device's own address, so the microphone works (see Forwarder).
     */
    private fun pageBase(origin: String): String {
        val u = Uri.parse(origin)
        if (u.scheme == "https") return origin
        forwarder?.stop()
        val f = Forwarder(u.host ?: "127.0.0.1", if (u.port > 0) u.port else 80)
        forwarder = f
        return "http://127.0.0.1:${f.start()}"
    }

    /** What the page can ask of the app (Settings, PCs and devices: Disconnect this app). */
    inner class Bridge {
        @JavascriptInterface
        fun disconnect() {
            runOnUiThread {
                prefs.edit().clear().apply()
                CookieManager.getInstance().removeAllCookies(null)
                WebStorage.getInstance().deleteAllData()
                forwarder?.stop()
                forwarder = null
                showConnect(null)
            }
        }

        @JavascriptInterface
        fun version(): String = BuildConfig.VERSION_NAME
    }

    /* ---------- small helpers ---------- */

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun margins(top: Int) = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
    ).apply { topMargin = top }

    private fun button(label: String, primary: Boolean, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        textSize = 16f
        setTextColor(if (primary) BG else GOLD)
        setBackgroundColor(if (primary) GOLD else PANEL)
        minHeight = dp(52)
        setOnClickListener { onClick() }
    }

    private fun field(hint: String) = EditText(this).apply {
        this.hint = hint
        setHintTextColor(FAINT)
        setTextColor(INK)
        textSize = 16f
        setSingleLine()
        setBackgroundColor(PANEL)
        setPadding(dp(14), dp(12), dp(14), dp(12))
        gravity = Gravity.CENTER_VERTICAL
        layoutParams = margins(top = dp(10))
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
    }

    companion object {
        val BG = Color.parseColor("#0b0d12")
        val PANEL = Color.parseColor("#171b24")
        val GOLD = Color.parseColor("#ff8a1a")
        val INK = Color.parseColor("#f2ede4")
        val MUTED = Color.parseColor("#a8a29a")
        val FAINT = Color.parseColor("#6b675f")
        val BAD = Color.parseColor("#ff6b6b")
    }
}
