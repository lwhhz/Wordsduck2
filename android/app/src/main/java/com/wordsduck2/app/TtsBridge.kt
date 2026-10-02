package com.wordsduck2.app

import android.content.Context
import android.os.Build
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger

/**
 * 页面 ↔ 系统 TTS 的桥接对象。
 *
 * 这个类不自己发明协议：网页侧（assets/app.js）已经内置了一套桥接约定，
 * 只要原生把对象挂在 window 上、并且方法对得上，页面就会自动优先用它。
 * 约定见 app.js 的 NATIVE_NAMES 与注释：
 *
 *   必须实现
 *     speak(text, lang, rate, id)   参数一律是字符串；id 是本条朗读的令牌
 *     stop()                        立刻停止
 *   可选
 *     isSpeaking()                  返回 true / false
 *     getVoices()                   返回 JSON 字符串
 *     onStateChange(json)           页面推状态给原生（用于点亮原生 UI，本工程只记日志）
 *     isAndroidShell()              恒为 true：让页面知道自己在 APK 里，用来关掉
 *                                   只在网页版有意义的 UI（见下面该属性的说明）
 *
 *   读完 / 出错要回调页面（方法名固定，挂在 window.WordCardSpeech 上）：
 *     WordCardSpeech.onEnd(id)
 *     WordCardSpeech.onError(id, code, message)
 *     WordCardSpeech.onVoices('[...]')
 *
 * 两个容易踩的点：
 *   1) @JavascriptInterface 只认基本类型。页面侧已经把参数都转成字符串了
 *      （app.js 里那句注释就是为这个），原生这边也别声明成别的类型。
 *   2) 页面判断「是否正在朗读」用的是 自己记的状态 && isSpeaking()。
 *      所以 isSpeaking() 必须如实反映，读完要让它变 false，否则按钮会一直显示「朗读中」。
 *
 * 所有回调都必须回到主线程再碰 WebView —— TextToSpeech 的 listener 不一定在主线程。
 *
 * 注意：这里**不再**有显示 / 隐藏状态栏的桥接方法（那个开关已去掉，状态栏改为常驻）。
 * 但 **setDarkMode() 是显示相关的**：它只用来决定状态栏图标的明暗，
 * 不控制显示与否。放在这个类里是为了不再多挂一个 JS 对象（见该方法自己的说明）。
 *
 * 另一个不属于 TTS 的方法是 **saveFile()**：「导出备份」在 WebView 里
 * 天生失效（`<a download>` + Blob URL 不被处理），必须交给原生去存。
 * 同样为了不新增 JS 对象而挂在这里，详见该方法的说明。
 */
class TtsBridge(
    private val context: Context,
    private val webView: WebView,
    /** 页面报告明暗变化时回调（参数 true = 深色）。见 setDarkMode()。 */
    private val onDarkModeChanged: ((Boolean) -> Unit)? = null,
    /** 页面要求「另存为」时回调。见 saveFile()。 */
    private val onSaveFile: ((String, String, String) -> Unit)? = null
) : TextToSpeech.OnInitListener {

    companion object {
        private const val TAG = "TtsBridge"
        /** 挂到 window 上的名字；app.js 的 NATIVE_NAMES 里包含 'AndroidTTS' */
        const val JS_NAME = "AndroidTTS"
        private const val DEFAULT_LANG = "en-US"
        private const val DEFAULT_RATE = 0.92f
    }

    private var tts: TextToSpeech? = null
    private var ready = false
    private var failed = false
    private var speaking = false
    /** 当前这条朗读的令牌，由页面传入；回调时原样带回 */
    private var currentId: String? = null
    private val seq = AtomicInteger(0)

    /** en-* 音色列表（用于 getVoices 与择优） */
    private var voices: List<Voice> = emptyList()

    init {
        tts = TextToSpeech(context.applicationContext, this)
    }

    // ---------------- 初始化 ----------------

    override fun onInit(status: Int) {
        if (status != TextToSpeech.SUCCESS) {
            failed = true
            Log.w(TAG, "系统 TTS 初始化失败，status=$status")
            return
        }
        val engine = tts ?: return
        applyLanguage(engine, DEFAULT_LANG)
        collectVoices(engine)
        engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) = Unit

            override fun onDone(utteranceId: String?) {
                // 页面可能在不停地点「发音」，只有当前这条读完才算结束
                if (utteranceId != null && utteranceId != currentId) return
                speaking = false
                currentId = null
                callJs("WordCardSpeech.onEnd('${escape(utteranceId ?: "")}')")
            }

            @Deprecated("被 onError(String, Int) 取代，但仍需实现以兼容旧版本")
            override fun onError(utteranceId: String?) {
                failWith(utteranceId, -1, "系统语音引擎报告错误")
            }

            override fun onError(utteranceId: String?, errorCode: Int) {
                failWith(utteranceId, errorCode, describeError(errorCode))
            }

            override fun onStop(utteranceId: String?, interrupted: Boolean) {
                // 主动 stop() 也会走到这里：只要还没翻篇就复位状态
                if (currentId != null && utteranceId == currentId) {
                    speaking = false
                    currentId = null
                }
            }
        })
        ready = true
        pushVoices()
        Log.i(TAG, "系统 TTS 就绪，匹配到 ${voices.size} 个英文音色")
    }

    private fun failWith(utteranceId: String?, code: Int, message: String) {
        if (utteranceId == null || utteranceId != currentId) return
        speaking = false
        currentId = null
        callJs("WordCardSpeech.onError('${escape(utteranceId)}', $code, '${escape(message)}')")
    }

    private fun describeError(code: Int): String = when (code) {
        TextToSpeech.ERROR_NOT_INSTALLED_YET -> "系统语音数据还没下载完"
        TextToSpeech.ERROR_NETWORK -> "网络错误（该系统音色需要联网合成）"
        TextToSpeech.ERROR_NETWORK_TIMEOUT -> "网络超时"
        TextToSpeech.ERROR_SYNTHESIS -> "语音合成失败"
        TextToSpeech.ERROR_SERVICE -> "语音服务异常"
        TextToSpeech.ERROR_OUTPUT -> "音频输出异常"
        TextToSpeech.ERROR_INVALID_REQUEST -> "朗读请求无效"
        else -> "系统语音引擎错误（$code）"
    }

    /**
     * 设置语言。设备没装对应语音包时返回 LANG_MISSING_DATA / LANG_NOT_SUPPORTED，
     * 这种情况下 speak() 会静默不出声，所以这里给出明确提示而不是让它悄悄失败。
     */
    private fun applyLanguage(engine: TextToSpeech, tag: String): Int {
        val locale = Locale.forLanguageTag(tag)
        val res = engine.setLanguage(locale)
        if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
            Log.w(TAG, "设备缺少 $tag 语音数据（result=$res），改用默认语言再试一次")
            return engine.setLanguage(Locale.US)
        }
        return res
    }

    private fun collectVoices(engine: TextToSpeech) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return
        voices = try {
            engine.voices.orEmpty()
                .filter { it.locale != null && it.locale.language == "en" }
                .sortedWith(
                    compareByDescending<Voice> { it.quality }
                        .thenByDescending { it.locale.toLanguageTag() == DEFAULT_LANG }
                )
        } catch (e: Exception) {
            Log.w(TAG, "读取音色列表失败：${e.message}")
            emptyList()
        }
    }

    private fun pushVoices() {
        val arr = JSONArray()
        voices.forEach { v ->
            arr.put(
                JSONObject()
                    .put("name", v.name ?: "")
                    .put("lang", v.locale?.toLanguageTag() ?: "")
                    // 页面按 localService 判断「离线可用」并优先选它
                    .put("localService", !v.isNetworkConnectionRequired)
            )
        }
        if (arr.length() > 0) callJs("WordCardSpeech.onVoices('${escape(arr.toString())}')")
    }

    // ---------------- 暴露给页面的方法 ----------------

    /**
     * 朗读。参数全是字符串 —— @JavascriptInterface 只认基本类型，
     * 传对象/undefined 在安卓侧会直接抛异常（页面会因此退回 Web Speech）。
     */
    @JavascriptInterface
    fun speak(text: String?, lang: String?, rate: String?, id: String?) {
        val content = text?.trim().orEmpty()
        val token = id?.takeIf { it.isNotEmpty() } ?: ("native" + seq.incrementAndGet())
        if (content.isEmpty()) {
            callJs("WordCardSpeech.onError('${escape(token)}', -1, '要读的文本是空的')")
            return
        }
        val engine = tts
        if (engine == null || !ready) {
            val why = if (failed) "系统语音引擎不可用" else "系统语音引擎还在初始化"
            callJs("WordCardSpeech.onError('${escape(token)}', -1, '$why')")
            return
        }

        // 换语言（页面可能根据音色把 lang 换成 en-GB 等）
        if (!lang.isNullOrEmpty()) applyLanguage(engine, lang)

        val r = rate?.toFloatOrNull()?.coerceIn(0.1f, 3.0f) ?: DEFAULT_RATE
        currentId = token
        speaking = true

        val params = Bundle()
        val result = engine.speak(content, TextToSpeech.QUEUE_FLUSH, params, token)
        if (result == TextToSpeech.ERROR) {
            speaking = false
            currentId = null
            callJs("WordCardSpeech.onError('${escape(token)}', -1, '系统语音引擎拒绝了这次朗读')")
        }
    }

    @JavascriptInterface
    fun stop() {
        tts?.stop()
        speaking = false
        currentId = null
    }

    /**
     * 页面用「自己记的状态 && isSpeaking()」判断是否正在朗读（app.js 的 isReadingNow），
     * 所以这里必须如实返回，读完要变 false。
     */
    @JavascriptInterface
    fun isSpeaking(): Boolean = speaking

    /**
     * 给网页认「我现在跑在安卓壳子里」用的标记。
     *
     * 用途：页面借此把只在网页版有意义的 UI 关掉 —— 目前是统计页的
     * 「发音引擎」选择模块（APK 里不含 Piper 内置语音包，三档选择没有意义）。
     * 相关的隐藏规则在 assets/style.css 的 html.android-shell 那一段，
     * 打类的代码在 assets/nav-bridge.js。
     *
     * 为什么不靠猜（比如探测 navigator.userAgent 里有没有 Android）：
     * 网页版在安卓手机浏览器里打开时 UA 同样含 Android，会把网页版的 UI 也误关掉。
     * 这个属性只有原生桥接对象上才有，是「确实装在 APK 里」的确证。
     */
    @JavascriptInterface
    fun isAndroidShell(): Boolean = true

    /**
     * 把一段数据交给原生「另存为」。
     *
     * 为什么网页自己下载不行：
     *   网页的导出用的是 `<a download>` + Blob URL。WebView **不会**处理这种
     *   下载 —— 它把点击当成一次导航，而默认的 WebViewClient 对
     *   blob: / data: 这类 URL 既不加载也不报错，于是点「导出备份」在
     *   APK 里表现为**完全没反应**（连失败提示都没有）。
     *   要么自己接 DownloadListener 走系统的下载管理器（会落到「下载」目录、
     *   文件名还可能被改写），要么像这里一样把数据交给原生、
     *   用 SAF 让用户自己选保存位置。后者不需要任何存储权限，
     *   也和「导入」用的系统文件选择器对称。
     *
     * 参数用 String（base64）而不是 ArrayBuffer：@JavascriptInterface 只认
     * 基本类型，二进制只能编码成字符串传。
     */
    @JavascriptInterface
    fun saveFile(name: String?, base64: String?, mime: String?) {
        val fileName = (name ?: "").trim().ifEmpty { "备份.json" }
        val data = base64 ?: ""
        val type = (mime ?: "").trim().ifEmpty { "application/octet-stream" }
        Log.d(TAG, "saveFile name=$fileName mime=$type base64Len=${data.length}")
        // 主线程再碰 Activity / 窗口
        webView.post { onSaveFile?.invoke(fileName, data, type) }
    }

    /** 保存完成 / 取消 / 失败后回调网页。ok=false 时 reason 说明原因。 */
    fun notifySaveResult(ok: Boolean, reason: String?) {
        val payload = JSONObject()
            .put("ok", ok)
            .put("reason", reason ?: "")
            .toString()
        callJs("window.WordCardSave && window.WordCardSave.onResult(${escape(payload)})")
    }

    /** 供 MainActivity 解码 base64（放在桥接里，页面传的就是这里的格式） */
    fun decodeBase64(data: String): ByteArray? = try {
        Base64.decode(data, Base64.DEFAULT)
    } catch (e: Exception) {
        null
    }

    /**
     * 页面把「当前实际是深色还是浅色」告诉原生，用来决定**状态栏图标的明暗**。
     *
     * 为什么需要网页侧来告诉原生，而不是原生自己读系统：
     *   网页「自定义」里有一个外观模式滑块（跟随系统 / 亮色 / 暗色），
     *   选「亮色」时页面可以是亮的、而系统仍是深的。系统状态栏默认按**系统**
     *   配置决定图标颜色，于是就会出现「亮色页面 + 浅色图标」= 图标看不见。
     *   所以真正的明暗只有页面知道，必须由它推过来。
     *
     * 参数用 String 而不是 Boolean：@JavascriptInterface 对基本类型的转换
     * 在各版本 WebView 上不完全一致（本工程其它桥接方法一律用 String，
     * 见类注释里那条「只认基本类型」的说明）。传 "1" = 深色、"0" = 浅色。
     *
     * 这个方法挂在 TTS 桥接对象上而不是另开一个对象，是因为
     * assets/nav-bridge.js 探测「是否在 APK 里」用的就是 AndroidTTS
     * （检查 isAndroidShell），再挂一个对象会让那处探测多一种情况要处理。
     */
    @JavascriptInterface
    fun setDarkMode(dark: String?) {
        val isDark = dark == "1"
        Log.d(TAG, "页面报告明暗：isDark=$isDark")
        // 回到主线程再碰窗口 —— 桥接方法虽然在 WebView 线程调用，
        // 但改系统栏外观属于 UI 操作
        webView.post { onDarkModeChanged?.invoke(isDark) }
    }

    @JavascriptInterface
    fun getVoices(): String {
        val arr = JSONArray()
        voices.forEach { v ->
            arr.put(
                JSONObject()
                    .put("name", v.name ?: "")
                    .put("lang", v.locale?.toLanguageTag() ?: "")
                    .put("localService", !v.isNetworkConnectionRequired)
            )
        }
        return arr.toString()
    }

    /** 页面主动推状态过来（发音开始/结束、当前单词等），用于点亮原生 UI。 */
    @JavascriptInterface
    fun onStateChange(json: String?) {
        Log.d(TAG, "页面状态：$json")
    }

    // ---------------- 生命周期 ----------------

    fun shutdown() {
        try {
            tts?.stop()
            tts?.shutdown()
        } catch (e: Exception) {
            Log.w(TAG, "关闭 TTS 时出错：${e.message}")
        }
        tts = null
        ready = false
        speaking = false
        currentId = null
    }

    /** 设备上有没有可用的英文语音数据；没有时由 Activity 引导用户去装。 */
    fun hasEnglishVoice(): Boolean = voices.isNotEmpty()

    // ---------------- 工具 ----------------

    /**
     * 回调页面。TextToSpeech 的 listener 不保证在主线程，而 WebView 必须在主线程碰，
     * 所以统一 post 回主线程再 evaluateJavascript。
     */
    private fun callJs(js: String) {
        webView.post {
            try {
                webView.evaluateJavascript(js, null)
            } catch (e: Exception) {
                Log.w(TAG, "回调页面失败：$js / ${e.message}")
            }
        }
    }

    /** JS 字符串字面量转义，防止单词里的引号把调用串打断。 */
    private fun escape(s: String): String = s
        .replace("\\", "\\\\")
        .replace("'", "\\'")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
}
