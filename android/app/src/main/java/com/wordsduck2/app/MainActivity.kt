package com.wordsduck2.app

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.updatePadding
import org.json.JSONObject
import java.io.File

/**
 * 整个应用只有一个 WebView，加载打包进 assets 的网页。
 *
 * 为什么是 file:// 而不是本地 http 服务：
 *   页面里的 localStorage（词书库、学习记录）在 file:// 下可以正常持久化，
 *   而开本地 http 服务就要多一个前台服务 / 端口占用，得不偿失。
 *   代价是 file:// 下 fetch 不可用 —— 这一点原作者已经处理过了：
 *   Excel 解析库（libs/xlsx.full.min.js）走的是 <script> 动态插入，不是 fetch。
 *
 * 页面与本机的分工：
 *   朗读交给系统 TTS，桥接对象是 TtsBridge（挂名 AndroidTTS）。
 *   app.js 会自己探测它并优先使用，无需页面侧改任何东西。
 *
 * 显示方式：**状态栏始终显示**，手势线始终隐藏，顶部恒定留出状态栏高度的空白
 *   （详见 setUpSystemBars()）。曾经做过状态栏显示 / 隐藏的开关，已移除 ——
 *   在不挖孔机型和挖孔机型上「是否位移」与「是否被挖孔挡」无法兼得，固定成
 *   常驻 + 恒定留白后两条都满足，也不会有切换位移。
 *
 * 文件选择：网页里的 <input type="file">（导入词书 Excel、导入备份、换头像）
 *   必须由 WebChromeClient.onShowFileChooser 接管，否则点按钮没有任何反应。
 *   注意这一条**不需要任何存储权限**，用的是系统文件选择器（见 openFileChooser）。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    /** 「再按一次退出」的确认窗口状态；窗口由 exitConfirmHandler 关掉 */
    private var awaitingExitConfirm = false
    private val exitConfirmHandler = Handler(Looper.getMainLooper())
    private var tts: TtsBridge? = null

    /** 网页发来的文件选择回调。同一时刻只允许有一个，见 openFileChooser()。 */
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    /* ---- 头像裁剪（见 startCrop / applyCropped）----
       pendingCropCallback 非空 = 当前处在「已经选好图，等用户裁 1:1」这一步。
       裁剪结束后用它把 <input type=file> 那次选择收尾。 */
    private var pendingCropCallback: ValueCallback<Array<Uri>>? = null

    /** 交给裁剪界面裁剪的那份「源图副本」（从选择器给的 uri 复制到我们缓存里的）。
        用完即删 —— 它只是为了让 CropActivity 能按文件路径解码，没有留存价值。 */
    private var cropSource: File? = null

    /** 页面最近一次报告的明暗；null = 页面还没报告过，此时按系统配置走。 */
    private var lastDarkMode: Boolean? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(
            webView,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )

        configureWebView()

        // 先把系统栏摆好、接上 insets 监听，再 loadUrl：
        // 让页面第一次布局就拿得到正确高度，否则会先按整屏渲染再跳一下
        setUpSystemBars()
        keepContentClearOfSystemAreas(webView)

        // 先把桥接挂上，再 loadUrl —— 页面脚本可能在解析阶段就探测它
        tts = TtsBridge(
            this, webView,
            onDarkModeChanged = { isDark -> applyDarkMode(isDark) },
            onSaveFile = { name, base64, mime -> startSaveFile(name, base64, mime) }
        ).also {
            webView.addJavascriptInterface(it, TtsBridge.JS_NAME)
        }

        webView.loadUrl("file:///android_asset/www/index.html")

        // 系统返回键 / 侧滑返回手势
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = handleBack()
        })
    }

    /* ---------------- 返回键（含手势返回） ----------------

       规则（层级判断全部交给页面，见 window.WordCardNav）：
         · 有弹窗      → 关掉最上面那个
         · 在背词页    → 回词书库（不再直接退出应用）
         · 在成绩页 / 统计页 → 回词书库
         · 已经在词书库 → 弹一句确认；在它显示期间再返回一次就退出

       为什么不能沿用「webView.canGoBack() 就 goBack()」：
       页面是单文件应用，切屏是切 DOM 的 class，不产生历史记录，
       canGoBack() 永远是 false —— 所以以前在背词页按返回会**直接退出应用**。
       现在改成让页面自己回答「还能不能往上退一层」。

       为什么不在这里判断「现在是哪一屏」：
       那样原生就得知道每个 DOM id 的含义，页面一改屏幕名就得跟着改。
       页面暴露的 back() 返回 true/false 就够了 —— 原生只关心
       「这一下消化掉了没有」。

       evaluateJavascript 是异步的，所以 handleBack() 立刻返回；
       连按两次也不会错乱：每次都重新问一遍页面，答案一致。 */
    private fun handleBack() {
        // 整页历史（理论上没有，兜底）优先按浏览器语义后退
        if (webView.canGoBack()) {
            webView.goBack()
            return
        }
        // 退出确认的计时窗口内再按一次 —— 直接退出，不再问页面
        if (awaitingExitConfirm) {
            finish()
            return
        }
        webView.evaluateJavascript(
            "(window.WordCardNav && window.WordCardNav.back) ? window.WordCardNav.back() : false"
        ) { raw ->
            /* 回传是 JSON：true / false / null。
               只有明确的 true 才算「页面消化掉了这一下」；
               其余（false / null / 页面还没加载完）都落到退出确认 ——
               宁可多问一次，也不要按了没反应。 */
            if ((raw ?: "").trim() != "true") askExitConfirm()
        }
    }

    /** 首次返回：弹一句「再按一次退出」，并开一个计时窗口 */
    private fun askExitConfirm() {
        awaitingExitConfirm = true
        /* 时长用 LENGTH_SHORT（约 2s），下面的计时窗口跟它对齐 ——
           窗口内再按一次退出，超时后回到「先弹确认」的状态。 */
        Toast.makeText(this, EXIT_CONFIRM_TEXT, Toast.LENGTH_SHORT).show()
        exitConfirmHandler.removeCallbacksAndMessages(null)
        exitConfirmHandler.postDelayed({ awaitingExitConfirm = false }, EXIT_CONFIRM_WINDOW_MS)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        val s = webView.settings
        s.javaScriptEnabled = true
        // 词书库 / 学习记录 / 复习本都存在 localStorage，必须打开
        s.domStorageEnabled = true
        s.databaseEnabled = true
        s.allowFileAccess = true
        s.allowContentAccess = true
        // 页面是 file://，要读同目录下的其它资源
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN) {
            s.allowFileAccessFromFileURLs = true
            s.allowUniversalAccessFromFileURLs = true
        }
        // 视口交给页面里的 <meta name="viewport">，这里不强制缩放
        s.useWideViewPort = true
        s.loadWithOverviewMode = false
        s.builtInZoomControls = false
        s.displayZoomControls = false
        s.cacheMode = WebSettings.LOAD_DEFAULT
        // 不跟随系统深色强制反色：页面自己实现了 prefers-color-scheme 深浅两套
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            s.isAlgorithmicDarkeningAllowed = false
        }

        webView.webViewClient = WebViewClient()
        webView.webChromeClient = object : WebChromeClient() {
            /* 网页里 <input type="file"> 被点击时走这里。
               不接管的话 WebView 默认什么都不做（连错误都不报），
               表现就是「导入词书点一下没反应」。 */
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                return openFileChooser(filePathCallback, fileChooserParams)
            }
        }

        // 网页不需要滚动条，交给页面自己布局
        webView.isVerticalScrollBarEnabled = true
        // 注意 OVER_SCROLL_NEVER 是 View 上的常量，不是 WebView 上的
        webView.overScrollMode = View.OVER_SCROLL_NEVER
    }

    // ---------------- 沉浸式：藏掉状态栏与手势线 ----------------

    /**
     * 状态栏**始终显示**；导航栏那条手势线**始终隐藏**。
     *
     * 为什么不做开关了：
     *   曾经在网页「自定义」里给状态栏做过一个显示 / 隐藏的开关，后来去掉了。
     *   原因是那台挖孔机（Redmi 23013RK75C）上「挖孔高度 == 状态栏高度」都是 104px，
     *   两个诉求互相冲突：
     *     · 开关一开页面就下移  → 隐藏时必须留 0，于是全屏时挖孔会盖住内容
     *     · 任何时候都不被挖孔挡 → 必须恒定留 104px，于是开关切换没有位移
     *   现在固定成「显示状态栏 + 恒定留白」：两条都满足，也不会再有位移，
     *   交互上最简单。
     *
     * 几个关键点：
     *   1) setDecorFitsSystemWindows(false) —— 让内容铺到整屏（含系统栏位置）。
     *      不设的话 insets 会由系统自动内缩，下面按 insets 加的 padding 就白加了。
     *   2) 只 hide(navigationBars())，不碰 statusBars —— 状态栏交给系统照常绘制。
     *   3) BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE —— 用户从边缘上滑时临时唤出手势线，
     *      几秒后自动缩回。必须带，否则手势条藏起来了就叫不出来。
     *   4) LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES —— 允许内容铺到挖孔区域；
     *      真正保证「不被摄像头挡住」的是下面按 insets 留的顶部内边距。
     *   5) 走 WindowInsetsController（androidx 封装），不用已废弃的 systemUiVisibility。
     *   6) 手势线被临时唤出后，focus 回来要重新收敛 —— 见 onWindowFocusChanged()。
     */
    private fun setUpSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }

        applySystemBars()
    }

    /** 状态栏保持显示，只把手势线收起来。 */
    private fun applySystemBars() {
        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            show(WindowInsetsCompat.Type.statusBars())
            hide(WindowInsetsCompat.Type.navigationBars())
            // 图标明暗跟着页面报告的明暗走。放在 show() 之后是因为
            // show/hide 会重置一部分外观状态，先设会被它盖掉。
            isAppearanceLightStatusBars = lastDarkMode != true
        }
    }

    /**
     * 页面报告「现在是深色还是浅色」后，把状态栏调整成对应的样子。
     *
     * 要同时做两件事：
     *   1) 图标明暗 —— 这是页面报告的直接目的。亮色页面配深色图标。
     *   2) 状态栏本身的底色 —— Android 15 起系统栏强制透明（edge-to-edge），
     *      露出来的是**窗口背景**。窗口背景由 values / values-night 两份
     *      colors.xml 决定，而那是按**系统**明暗选的；用户若在页面里手动
     *      选了与系统相反的档位，窗口背景就会和页面底色不一致，
     *      状态栏那一圈会露出突兀的一条。所以这里显式指定一次。
     *
     * 为什么不用 AppCompatDelegate.setDefaultNightMode 去重跑整套资源：
     *   那会重建 Activity，WebView 跟着重新加载 —— 用户点一下滑块就白屏闪一次，
     *   代价太大。这里改的是两个颜色 + 一个图标开关，不需要重跑资源。
     */
    private fun applyDarkMode(isDark: Boolean) {
        lastDarkMode = isDark
        applySystemBars()
        val barColor = if (isDark) DARK_SURFACE else LIGHT_SURFACE
        window.statusBarColor = barColor
        window.navigationBarColor = barColor
    }

    /** 手势线被临时唤出、或切出去再回来之后，重新把该隐藏的收起来。 */
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applySystemBars()
    }

    /**
     * 把系统栏 / 挖孔 / 软键盘区域换算成 WebView 的内边距。
     *
     * 手势线已经隐藏了，为什么还要留白：
     *   隐藏只是不让系统**画**手势条，屏幕物理上仍是整块。上面那圈要避开
     *   状态栏和摄像头挖孔、屏幕圆角；底部那圈要避开上滑回桌面的手势带 ——
     *   悬浮底栏正好在那条带上，贴太近会和系统手势抢触摸。
     *
     * 顶部内边距是「不被挖孔摄像头挡住」的关键：
     *   状态栏**显示**时，systemBars 的顶部 inset 就是状态栏高度；状态栏
     *   **隐藏**时，挖孔区域在 targetSdk 36 上仍计入 displayCutout / systemBars。
     *   两种情况下 WebView 都被整体推到挖孔下方，网页文字不可能顶进摄像头。
     *   页面里的 fixed 悬浮栏也会跟着这个安全区走。
     *
     * 为什么必须自己处理软键盘（ime）：
     *   和 setDecorFitsSystemWindows(false) 搭配时，窗口不再自动因键盘而内缩，
     *   键盘会直接盖在网页上，搜索框就看不见了。这里把键盘高度换算成底部内边距，
     *   等于手工把内容顶到键盘上方。（清单里的 adjustResize 仍是需要的 ——
     *   它决定系统是否把 ime insets 发给我们。）
     *
     * 为什么加在 WebView 上而不是包一层容器：
     *   加在 WebView 自己身上，网页的 <html> 尺寸就等于「可用高度」，
     *   页面里 position:fixed 的悬浮底栏、100vw、100% 这些布局会自动跟着收缩，
     *   网页侧不需要任何配套改动。
     */
    private fun keepContentClearOfSystemAreas(view: View) {
        // 用不限制类型的方式监听：只有拿到「完整体」insets，getInsets(...) 才取得到值
        ViewCompat.setOnApplyWindowInsetsListener(view) { v, windowInsets ->
            val sys = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars())
            val cut = windowInsets.getInsets(WindowInsetsCompat.Type.displayCutout())
            val ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime())

            v.updatePadding(
                left = maxOf(sys.left, cut.left),
                // 顶部：状态栏高度（系统给的 statusBars.top 本身已覆盖挖孔区域，
                // 实测 104 = 挖孔高度，所以不需要再额外加一份 cutout，不会重复计算）
                top = maxOf(sys.top, ime.top),
                right = maxOf(sys.right, cut.right),
                // 底部：键盘优先，其次 systemBars，再兜底手势线高度
                bottom = bottomClearance(maxOf(ime.bottom, sys.bottom))
            )
            // 这里**必须**把 windowInsets 原样返回，不能返回 CONSUMED。
            //
            // 返回 CONSUMED 会把「这个 View 自己消费掉了 insets」记在框架里
            // （View.mPrivateFlags 的 PFLAG_WINDOW_INSETS_CONSUMED），此后
            // requestApplyInsets() 对它就再也不派发了 —— 内边距会一直停在旧值。
            // 原样返回时 androidx 会回退去调 View.onApplyWindowInsets，
            // 既能继续往下传，也不会把自己标成已消费。
            windowInsets
        }
        ViewCompat.requestApplyInsets(view)
    }

    /**
     * 底部要留多少空间。
     *
     * 全面屏手势导航下 insets.bottom 只是那条「手势线」区域的高度，各家 ROM 报的值
     * 还不一样 —— OPPO / ColorOS 明显偏小，网页里的悬浮底栏（离视口底边 12px）就会
     * 贴着屏幕最底边，既难看又和上滑回桌面的手势抢触摸。所以取
     *     max(系统值, 手势线最小高度 + 额外呼吸空间)
     *
     * 系统值更大时（虚拟导航键三键模式约 48dp）说明系统确实占了那么多，照给。
     * 键盘弹出时不用特判：那时 insets.bottom 就是键盘高度（几百 dp），max() 直接取它。
     */
    private fun bottomClearance(systemBottom: Int): Int {
        return maxOf(systemBottom, dp(MIN_GESTURE_BAR_DP + BOTTOM_CUSHION_DP))
    }

    /** dp 转像素。别写死像素数字，密度一变就不准了。 */
    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    // ---------------- 文件选择：导入词书 Excel / 导入备份 / 换头像 ----------------

    /**
     * 打开系统文件选择器，让用户挑一个文件交给网页。
     *
     * 为什么不需要声明存储权限（READ_EXTERNAL_STORAGE / READ_MEDIA_*）：
     *   走的是系统文件选择器（Storage Access Framework）。用户挑中某个文件之后，
     *   系统会把「这一个文件」的临时读取授权随结果一起给回本应用，读取范围仅限
     *   这一个文件、且随本次会话结束失效。应用从来没有去遍历存储卡，所以不需要
     *   也不应该申请整个存储的读权限。
     *
     *   顺带说明：READ_MEDIA_* 那一组（Android 13+）只管图片 / 视频 / 音频，
     *   对 .xlsx 词书文件本来也无效 —— 即使申请了也解决不了导入问题。
     *
     * 为什么用 ACTION_GET_CONTENT 而不是 ACTION_OPEN_DOCUMENT：
     *   网页 <input type="file"> 给过来的 accept 是「扩展名」写法
     *   （.xlsx,.xls,.xlsm,.csv,.txt），浏览器语义就是「文件名后缀匹配」。
     *   ACTION_GET_CONTENT 正好按扩展名转 MIME 匹配，两者对得上；
     *   ACTION_OPEN_DOCUMENT 偏「文档库」语义，对扩展名的转换更容易把文件滤没。
     *   反正只读一次就完事，不需要可持久化的授权。
     */
    private fun openFileChooser(
        callback: ValueCallback<Array<Uri>>,
        params: WebChromeClient.FileChooserParams
    ): Boolean {
        // 上一次还没回来的回调要作废，否则 WebView 会一直等它
        filePathCallback?.onReceiveValue(null)
        filePathCallback = callback

        val contentIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            // 网页给了 accept 就按它过滤；空的话不设 type，等于任意文件
            type = pickMimeType(params.acceptTypes)
        }
        // createChooser 是必须的：直接 startActivityForResult 时，
        // 用户从「最近使用」里退出会回一个空 data，界面看着像卡住
        val chooser = Intent.createChooser(contentIntent, "选择要导入的文件")

        return try {
            startActivityForResult(chooser, FILE_CHOOSER_REQUEST)
            true
        } catch (e: ActivityNotFoundException) {
            // 设备上没有任何能做这件事的应用：必须回一个 null 并清掉回调，
            // 否则网页那边的选择框会永远停在「打开中」
            filePathCallback = null
            callback.onReceiveValue(null)
            false
        }
    }

    /**
     * 把网页给的 accept 转成 Intent 用的 MIME 类型。
     *
     * 两种写法都要认：
     *   1) 已经是 MIME 的，形如 image 加斜杠加星号（头像那个文件框给的就是这种），
     *      直接用；
     *   2) 扩展名列表，形如 .xlsx,.xls,.xlsm，转成对应的 MIME（取第一个能认出来的）。
     *
     * 一个都认不出来就返回 null（不设 type，等于任意文件）—— 宁可多显示几个文件，
     * 也好过把用户的词书滤没了、选不到。
     *
     * 注意：上面的注释里**不能**写出完整的通配 MIME 字面量，因为它的结尾正好是
     * 注释结束符，会把这段 KDoc 提前截断、后面整段代码变成注释，编译直接失败。
     */
    private fun pickMimeType(acceptTypes: Array<String>?): String? {
        if (acceptTypes == null || acceptTypes.isEmpty()) return null

        for (raw in acceptTypes) {
            // Java 侧传过来的数组元素理论上是可空的，稳妥起见先挡一层
            val item = raw?.trim()?.lowercase().orEmpty()
            if (item.isEmpty()) continue
            if (item.startsWith(".")) {
                MIME_BY_EXTENSION[item]?.let { return it }
                continue
            }
            if (item.contains("/")) {
                // 形如 "text/*" 这种通配也照收
                if (item == "*/*") return null
                return item
            }
        }
        return null
    }

    // 这两个是配套的一对。startActivityForResult / onActivityResult 已废弃，
    // 但 WebView 的 onShowFileChooser 回调本身是非阻塞式的，用 Activity Result API
    // 要额外接一层，收益不大，这里就先按老写法来（只在本类内部使用，不外泄）。
    @Deprecated("startActivityForResult 的配套回调，换 Activity Result API 时一并替换")
    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)

        /* 「另存为」：用户选完位置（或取消）就回来。
           取消时 resultCode != RESULT_OK，pendingSaveBytes 也要清掉，
           否则下一次保存会先写上一份残留数据。 */
        if (requestCode == SAVE_FILE_REQUEST) {
            if (resultCode != RESULT_OK) {
                pendingSaveBytes = null
                tts?.notifySaveResult(false, "已取消保存")
                return
            }
            val ok = finishSaveFile(data?.data)
            tts?.notifySaveResult(ok, if (ok) null else "写入文件失败")
            return
        }

        // 先处理裁剪那一步（它才是给用户的第二步）
        if (requestCode == CROP_REQUEST) {
            pendingCropCallback = null
            if (resultCode != RESULT_OK) {
                // 用户在裁剪界面取消：把文件选择的回调也作废掉，免得网页一直等
                cropSource?.delete()
                cropSource = null
                filePathCallback?.onReceiveValue(null)
                filePathCallback = null
                return
            }
            applyCropped(data)
            return
        }

        if (requestCode != FILE_CHOOSER_REQUEST) return

        val cb = filePathCallback
        // 用户取消时 data 是 null，必须回 null，否则网页里的选择框不会复位
        val uri = if (resultCode == RESULT_OK) data?.data else null

        /* 头像是「图片类」的选择框（accept 就是 image 通配），
           拿到图之后**先不走网页**，改为先让用户裁一个 1:1 —— 详见 startCrop()。
           其余（词书 Excel、备份 JSON）照旧直接把 uri 交回网页。 */
        if (uri != null && isImage(uri)) {
            // 这一步只是把 uri 记下来给裁剪用；真正的 onReceiveValue 在裁剪结束后才调
            pendingCropCallback = cb
            if (!startCrop(uri)) {
                // 这台机器没有系统裁剪器：退回「不裁剪」，直接把原图交给网页
                pendingCropCallback = null
                filePathCallback = null
                cb?.onReceiveValue(arrayOf(uri))
            }
            return
        }
        filePathCallback = null
        if (cb == null) return
        cb.onReceiveValue(if (uri != null) arrayOf(uri) else null)
    }

    /** 这个 uri 是不是图片（按 MIME 判断，拿不到就按扩展名兜一下）。 */
    private fun isImage(uri: Uri): Boolean {
        val type = contentResolver.getType(uri)
        if (type != null) return type.startsWith("image/")
        val path = uri.lastPathSegment?.lowercase().orEmpty()
        return path.endsWith(".png") || path.endsWith(".jpg") ||
            path.endsWith(".jpeg") || path.endsWith(".webp")
    }

    /* ---------------- 「导出 / 另存为」 ----------------

       为什么网页自己下载不行（这是「安卓版导出失效」的根因）：
         网页的导出走的是 `<a download>` + Blob URL。WebView 不处理这种下载 ——
         它把这次点击当成一次导航，而默认 WebViewClient 对 blob: 既加载不了
         也不报错，于是点「导出备份」在 APK 里表现为**完全没反应**，
         连 catch 到的失败提示都不会出现（因为 a.click() 本身不抛异常）。
         要么自己接 DownloadListener 交给系统下载管理器（落到「下载」目录、
         文件名可能被改写），要么像这里一样让用户用系统文件选择器挑位置。
         选后者：不需要任何存储权限，而且和「导入」用的系统选择器对称。

       数据怎么传过来：base64 字符串（@JavascriptInterface 只认基本类型，
       二进制只能编码成字符串）。备份 JSON 通常几十 KB，实测没问题；
       传之前网页侧会挡一道超大体积的提醒，见 app.js 的 saveViaNative。 */

    /** 待保存的内容。用户选完位置后由 onActivityResult 写盘。 */
    private var pendingSaveBytes: ByteArray? = null
    private var pendingSaveName: String = ""

    /**
     * 弹系统「另存为」，让用户挑保存位置。
     * 用 ACTION_CREATE_DOCUMENT（SAF）：系统把新文件的写权限授予本应用，
     * 全程不碰公共存储，所以不需要任何存储权限。
     */
    private fun startSaveFile(name: String, base64: String, mime: String) {
        val bytes = tts?.decodeBase64(base64)
        if (bytes == null || bytes.isEmpty()) {
            tts?.notifySaveResult(false, "要保存的内容是空的或格式不对")
            return
        }
        pendingSaveBytes = bytes
        pendingSaveName = name

        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mime
            putExtra(Intent.EXTRA_TITLE, name)
        }
        try {
            startActivityForResult(intent, SAVE_FILE_REQUEST)
        } catch (e: ActivityNotFoundException) {
            pendingSaveBytes = null
            tts?.notifySaveResult(false, "这台设备没有可用的文件保存器")
        }
    }

    /** 把待保存的字节写进用户选中的 uri。 */
    private fun finishSaveFile(uri: Uri?): Boolean {
        val bytes = pendingSaveBytes
        pendingSaveBytes = null
        if (bytes == null || uri == null) return false
        return try {
            contentResolver.openOutputStream(uri)?.use { out ->
                out.write(bytes)
                out.flush()
                true
            } ?: false
        } catch (e: Exception) {
            false
        }
    }

    /**
     * 调系统裁剪器，让用户裁一个 1:1 的方图。
     *
     * 用的是流传最广的 `com.android.camera.action.CROP`。它不是 Android SDK 的公开
     * 契约（AOSP 里没有声明），但各家的相册 / 相机应用普遍都实现了它 ——
     * 主流的国产 ROM 也都带。所以：
     *   · 用 resolveActivity 先探一下有没有应用能接，没有就返回 false；
     *   · 调用处拿到 false 会**退回「不裁剪」**，直接把原图交给网页，
     *     所以即使某台机器没有裁剪器，功能也只是少一步，不会坏掉。
     * 这也是没有引入 uCrop / Android-Image-Cropper 这类第三方库的原因：
     * 为一个可降级的功能加一个几十 KB 的依赖不划算。
     *
     * 注意下面 setDataAndType 里那个图片通配 MIME 的**字面量不能写进注释**：
     * 它的结尾正好是注释结束符，会把这段 KDoc 提前截断、后面整段代码变成注释。
     * （pickMimeType 的注释里也踩过同一个坑，这里是第二次。）
     *
     * 几个参数的含义：
     *   aspectX / aspectY = 1 / 1  → 锁定正方形
     *   outputX / outputY = 512    → 输出 512×512
     *   return-data = false        → 不通过 Intent 传 Bitmap（大图会触发
     *                                TransactionTooLargeException），改成写文件
     *   output = 临时文件 uri      → 裁剪结果落在这里，随后由 applyCropped() 读
     */
    /**
     * 调**应用内**的裁剪界面，让用户裁一个 1:1 的方图。
     *
     * 这里曾经是发 com.android.camera.action.CROP 给系统相册裁，但那套在这台
     * MIUI 上实测**不落盘**（RESULT_OK 但输出 0 字节、Intent 也没有 extras），
     * 而且它不是 AOSP 的公开契约。改用自己实现的 CropActivity 之后，
     * 行为完全可控，也不需要任何存储权限 —— 详细结论见 CropActivity 的类注释。
     *
     * 流程：把选择器给的图复制到缓存 → 把路径交给 CropActivity →
     * 它在 onActivityResult 里回一个已经压好的 data URL。
     */
    private fun startCrop(source: Uri): Boolean {
        /* 先把选中的图复制到我们自己的缓存，再把这个副本交给裁剪界面。
           为什么不直接把选中的 uri 传过去：
             · 系统照片选择器（Photopicker）给的是它自己 authority 下的 uri，
               外部组件读不到，除非同时 grant 读权限 —— 而这个 uri 的授权
               寿命由选择器控制，跨到下一个 Activity 未必还有效；
             · CropActivity 直接按**文件路径**解码（BitmapFactory.decodeFile），
               复制一份到自己的缓存目录是最省事、也最不容易出错的做法。 */
        val staged = try {
            val f = File(cacheDir, "avatar-src-${System.currentTimeMillis()}.jpg")
            contentResolver.openInputStream(source).use { input ->
                if (input == null) null
                else {
                    f.outputStream().use { out -> input.copyTo(out) }
                    f
                }
            }
        } catch (e: Exception) {
            null
        }
        if (staged == null || staged.length() == 0L) return false

        cropSource = staged

        val intent = Intent(this, CropActivity::class.java).apply {
            putExtra(CropActivity.EXTRA_SRC, staged.absolutePath)
            putExtra(CropActivity.EXTRA_OUT_W, AVATAR_SIZE)
            putExtra(CropActivity.EXTRA_OUT_H, AVATAR_SIZE)
        }

        return try {
            startActivityForResult(intent, CROP_REQUEST)
            true
        } catch (e: ActivityNotFoundException) {
            staged.delete()
            cropSource = null
            false
        }
    }

    /**
     * 裁剪结束：CropActivity 已经把结果压成 data URL 放在 extras 里了，
     * 这里只负责把它推给网页，并把 <input type=file> 那次选择收尾。
     *
     * 收尾为什么回**空数组**而不是 null：
     *   网页侧的 change handler 只有在拿不到文件时才直接 return
     *   （见 profile.js 的注释）。回 null 会让它跑到错误提示那条分支上去，
     *   所以空数组是这里唯一正确的收尾方式。
     */
    private fun applyCropped(data: Intent?) {
        val cb = filePathCallback
        filePathCallback = null

        // 源图副本用完即删
        cropSource?.delete()
        cropSource = null

        val dataUrl = data?.getStringExtra(CropActivity.EXTRA_DATA_URL).orEmpty()
        if (dataUrl.isEmpty()) {
            // 用户取消，或裁剪失败：回 null 让网页复位
            cb?.onReceiveValue(null)
            return
        }

        /* 直接把结果推给网页 —— 网页里 window.onNativeCroppedAvatar 会应用它。
           走这条路而不是「让 <input> 返回一个文件」，是因为网页需要的是
           data URL（要存进 localStorage），而 file input 给不了这个。 */
        webView.post {
            webView.evaluateJavascript(
                "window.onNativeCroppedAvatar && window.onNativeCroppedAvatar(" +
                    JSONObject.quote(dataUrl) + ");",
                null
            )
        }
        cb?.onReceiveValue(emptyArray())
    }

    override fun onDestroy() {
        // 先摘桥接再销毁：否则残留的 JS 调用会打到已经 shutdown 的 TTS 上
        try {
            webView.removeJavascriptInterface(TtsBridge.JS_NAME)
        } catch (_: Exception) {
        }
        // 页面销毁时把没回来的文件选择回调作废，避免泄漏 / 卡死
        filePathCallback?.onReceiveValue(null)
        filePathCallback = null

        tts?.shutdown()
        tts = null

        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        private const val FILE_CHOOSER_REQUEST = 1001

        /** 头像裁剪那一步的 requestCode */
        private const val CROP_REQUEST = 1002

        /** 「另存为」那一步的 requestCode */
        private const val SAVE_FILE_REQUEST = 1003

        /** 「再按一次退出」那句提示的文案与时窗。
            2 秒和 Toast.LENGTH_SHORT 的实际显示时长基本一致 ——
            用户看到提示的这段时间里再按一次就退出，看不到提示了就当重新来过。 */
        private const val EXIT_CONFIRM_TEXT = "再按一次返回退出应用"
        private const val EXIT_CONFIRM_WINDOW_MS = 2000L

        /** 最终存进 localStorage 的头像边长，与网页版 profile.js 的 PHOTO_SIZE 一致。
            CropActivity 会按这个尺寸输出（它自己也压一次 JPEG）。 */
        private const val AVATAR_SIZE = 256

        /**
         * 状态栏 / 导航栏的底色，与 assets/style.css 的 --md-surface 保持一致
         * （浅 #fdfbff / 深 #111318）。页面报告明暗后由 applyDarkMode() 用它显式指定，
         * 覆盖掉 values / values-night 那份按**系统**明暗选的默认值。
         */
        private const val LIGHT_SURFACE = 0xFFFDFBFF.toInt()
        private const val DARK_SURFACE = 0xFF111318.toInt()

        /** 手势线区域至少要留这么多，防止 ROM 报 0 或报得过小。 */
        private const val MIN_GESTURE_BAR_DP = 24

        /** 在手势线之上再垫一点，让悬浮底栏不显得贴边。调这个数字即可微调高低。 */
        private const val BOTTOM_CUSHION_DP = 16

        /** <input accept> 里的扩展名到 MIME 的换算表，只需要覆盖网页真正用到的那些。 */
        private val MIME_BY_EXTENSION = mapOf(
            // 词书：Excel 与文本
            ".xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ".xlsm" to "application/vnd.ms-excel.sheet.macroEnabled.12",
            ".xls" to "application/vnd.ms-excel",
            ".csv" to "text/csv",
            ".txt" to "text/plain",
            // 数据备份
            ".json" to "application/json",
            // 头像
            ".png" to "image/png",
            ".jpg" to "image/jpeg",
            ".jpeg" to "image/jpeg",
            ".webp" to "image/webp",
            ".gif" to "image/gif"
        )
    }
}
