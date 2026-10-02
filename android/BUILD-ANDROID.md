# 打包成安卓 APK

这个目录（`android/`）是一个标准 Gradle 安卓工程，它把项目根目录里的网页
（`index.html` / `assets/` / `libs/`）打进 APK，并用**系统 TTS** 朗读单词。

- 网页源码不在这个目录里维护。改网页请改根目录那一套，打包时会自动同步。
- 内置的 Piper 神经语音包（162 MB）**不随 APK 分发**，已从打包范围排除。
- **本机没有 JDK / Android SDK / Gradle，所以我没能实际编译验证过。**
  下面的步骤请在装了 Android Studio 的机器上执行。

---

## 〇、应用规格

| 项 | 值 | 位置 |
|---|---|---|
| 应用名称 | **Wordsduck2** | `app/src/main/res/values/strings.xml` 的 `app_name` |
| 版本名 / 版本号 | **Realduck** / **1** | `app/build.gradle` 的 `versionName` / `versionCode` |
| 包名 | **com.wordsduck2.app** | `app/build.gradle` 的 `namespace` + `applicationId`，以及各 `.kt` 的 `package` |
| compileSdk / targetSdk | **36**（Android 16） | `app/build.gradle` |
| minSdk | **29**（Android 10） | 同上 |
| 支持的 ABI | **仅 arm64-v8a**（64 位） | `ndk { abiFilters }` |
| 签名（release） | **Android debug 密钥** | `signingConfigs.release`，见「四、签名」 |
| 混淆 / 资源压缩 | **开启**（release） | `minifyEnabled` / `shrinkResources`，见「三、打包」 |
| AGP / Gradle / Kotlin | 8.9.0 / 8.11.1 / 2.0.21 | `build.gradle`、wrapper |

> **应用名和版本名是两个不同的字段，别搞混**（这里故意取不同的值）：
> - **应用名** `Wordsduck2` —— 桌面图标下面、最近任务、应用信息页标题看到的都是它。
>   改它要去 `strings.xml` 改 `app_name`。
> - **版本名** `Realduck` —— 只显示在应用信息页的「版本：」那一行。
>   改它要去 `build.gradle` 改 `versionName`。
>
> 只改 `versionName` 的话，图标下面还是旧名字；只改 `app_name` 的话，版本行不变。

> **minSdk 29 = Android 10 及以上。**
> 2026-10 出成品包时从 36 放开到 29 —— 原来写 36 只支持 Android 16，
> 等于几乎装不上任何机器。工程里用到的 API 全在 29 之下
> （WebView / addJavascriptInterface、SAF 的 ACTION_CREATE_DOCUMENT、系统 TTS），
> 所以这一改不需要动任何代码。想再放宽可以把数字继续调小（26 = Android 8.0）。

包名一旦上架就不能再改，改之前请确认 `com.wordsduck2.app` 是最终选择。

> 包名连着四个地方，改的时候必须一起动，漏一个就编译不过
> （`R` 类与 `MainActivity` 都会找不到）：
> 1. `app/build.gradle` 的 `namespace`
> 2. `app/build.gradle` 的 `applicationId`
> 3. `app/src/main/java/com/wordsduck2/app/*.kt` 里的 `package` 声明
> 4. 源码**目录层级** `java/com/wordsduck2/app/`（要跟着包名一起改）
>
> 另外 `proguard-rules.pro` 里有一条 `-keepclassmembers class ...TtsBridge`，
> 它写的是全限定名，同样要同步。

---

## 一、朗读是怎么接起来的

没有新增任何协议。网页侧 `assets/app.js` 早就内置了一套桥接约定
（见该文件里 `NATIVE_NAMES` 那段注释），原生只要按约定实现，
页面会**自动**优先使用它。所以：

| 项目 | 说明 |
|---|---|
| 挂载名字 | `AndroidTTS`（`TtsBridge.JS_NAME`）——它就在 `app.js` 的 `NATIVE_NAMES` 里 |
| 实现类 | `app/src/main/java/com/wordsduck2/app/TtsBridge.kt` |
| 宿主 | `MainActivity.kt`，用 `addJavascriptInterface` 注册后 `loadUrl` |

原生必须实现：

```kotlin
speak(text, lang, rate, id)   // 参数都是字符串
stop()
isSpeaking()                  // 返回 Boolean
getVoices()                   // 返回 JSON 字符串（可选）
onStateChange(json)           // 页面推状态过来（可选）
isAndroidShell()              // 恒为 true，见下面「安卓壳子标记」（可选）
```

有两个方法不属于 TTS，是为了**不再多挂一个 JS 对象**而寄存在同一个桥接上的：

```kotlin
setDarkMode("1" | "0")                       // 状态栏图标明暗，见「外观模式滑块」
saveFile(name, base64, mime)                 // 「导出 / 另存为」，见「一之三」
```

读完 / 出错要回调页面（方法名固定，挂在 `window.WordCardSpeech` 上）：

```js
WordCardSpeech.onEnd(id)
WordCardSpeech.onError(id, code, message)
WordCardSpeech.onVoices('[{"name":"...","lang":"en-US","localService":true}]')
```

保存文件的结果也走回调（挂在 `window.WordCardSave` 上）：

```js
WordCardSave.onResult('{"ok":true,"reason":""}')
```

### 返回键 / 手势返回：`window.WordCardNav`

壳子的返回键（以及 Android 10+ 的侧滑手势）**不能**沿用 `webView.canGoBack()`：
页面是单文件应用，切屏只是切 DOM 的 `class`，不产生历史记录，
`canGoBack()` 恒为 `false` —— 所以那样写在背词页按返回会**直接退出应用**。

改成由页面回答「还能不能往上退一层」：

```js
WordCardNav.snapshot()   // 纯字符串，便于原生打日志 → 'library'|'study'|'done'|'stats'|'modal'
WordCardNav.back()       // 执行一次返回：true = 已消化；false = 已在最外层
```

`MainActivity.handleBack()` 的流程：

```
evaluateJavascript("WordCardNav.back()") →
    "true"  → 页面自己退了一层（关弹窗 / 背词页→词书库 / 成绩页→词书库 / 统计页→词书库）
    其余     → Toast「再按一次返回退出应用」+ 开 2s 窗口；窗口内再按一次 finish()
```

页面侧对应的是 `closeTopLayer()`，Esc 键与它共用同一份分层顺序
（弹窗 → 背词页 → 成绩页 → 统计页），两处不会漂移。

> 注意 `evaluateJavascript` 是异步的，所以 `handleBack()` 立刻返回；
> 连按两次不会错乱，因为每次都重新问一遍页面，答案一致。

### 安卓壳子标记：`isAndroidShell()`

页面需要知道「我是在 APK 里跑，还是在浏览器里跑」，用来关掉只在网页版有意义的 UI。
目前唯一用到它的是**统计页的「发音引擎」选择模块**：APK 里不含 Piper 内置语音包，
安卓版只走系统 TTS，那三档选择没有任何可选性，所以整个面板在 APK 里隐藏。

链路是：

| 位置 | 做什么 |
|---|---|
| `TtsBridge.isAndroidShell()` | 返回 `true`，是「确实装在 APK 里」的确证 |
| `assets/nav-bridge.js` 的 `markShell()` | 探测到该属性就在 `<html>` 上加 `android-shell` 类 |
| `assets/style.css` | `html.android-shell .speak-panel { display: none; }` |

**为什么不用 UA 判断**：网页版在安卓手机的浏览器里打开时，
`navigator.userAgent` 同样含 `Android`，按 UA 判断会把网页版的 UI 也误关掉。
只有原生桥接对象上才有这个属性，不会误判。

隐藏而不是删除 DOM，是因为 `index.html` 是网页版与安卓版**共用的一份**；
删掉网页版就没有了。只隐藏是安全的：`app.js` 里读这几个元素的地方都带空值判断。

### 三个已经踩过的坑（代码里都处理了）

1. **`@JavascriptInterface` 只认基本类型。** 页面传的是 `text/label/rate/id`
   四个字符串；原生侧签名也必须全是 `String`，否则调用直接抛异常，页面会退回
   Web Speech。已验证页面确实传四个字符串。
2. **`isSpeaking()` 必须如实返回。** 页面判断「是否在读」用的是
   `自己记的状态 && isSpeaking()`。读完不清成 `false`，按钮会一直卡在「朗读中」。
3. **Android 11+ 必须在清单里声明 `<queries>` 查 `TTS_SERVICE`**，
   否则 `TextToSpeech` 初始化就失败、`getVoices()` 恒为空。
   `AndroidManifest.xml` 里已加。

---

## 一之二、状态栏 / 手势线：状态栏常驻，手势线隐藏

### 问题是什么

`targetSdk = 36`（≥ 35）时，**Android 15 及以上对应用强制「边到边」(edge-to-edge)**：
窗口铺满整屏，网页直接画到状态栏和导航栏底下。表现就是标题、搜索框被状态栏的
时钟/信号图标压住，底部悬浮栏压在导航条上。

关键点：**这不是 bug，是系统行为，而且系统不会自动帮你躲开**。
主题里的 `android:statusBarColor` / `android:navigationBarColor` 在这类系统上
**会被直接忽略**（它们只对 Android 15 以下生效），所以改主题是没用的。
`windowOptOutEdgeToEdgeEnforcement` 之类的「退出边到边」开关也不值得用 ——
Android 16 起已废弃、Android 17 会被彻底忽略。

### 当前做法：状态栏常驻 + 恒定留白

```kotlin
WindowCompat.setDecorFitsSystemWindows(window, false)   // 内容铺到整屏
window.attributes = window.attributes.apply {
    layoutInDisplayCutoutMode = LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
}
WindowCompat.getInsetsController(window, window.decorView).apply {
    systemBarsBehavior = BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    show(WindowInsetsCompat.Type.statusBars())            // 状态栏：始终显示
    hide(WindowInsetsCompat.Type.navigationBars())        // 手势线：始终隐藏
}
```

| 设置 | 作用 |
|---|---|
| `setDecorFitsSystemWindows(false)` | 让内容铺满整屏，否则系统会把内容自动内缩 |
| `LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES` | 允许内容铺到挖孔两侧（`themes.xml` 里也申明了一份，避免启动首帧跳动） |
| `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` | 从边缘上滑可临时唤出手势线，几秒后自动缩回。**必须带**，否则藏起来就叫不出来 |
| `statusBars()` 恒 `show` | 状态栏常驻显示 |
| `navigationBars()` 恒 `hide` | 手势线始终隐藏 |
| `onWindowFocusChanged` 里重新收敛 | 手势线被临时唤出、或切出去再回来后，要重新收起来 |

### 曾经做过开关，为什么又去掉了

一度在网页「自定义」模块里给状态栏做过一个显示 / 隐藏的开关。在挖孔机上
（Redmi 23013RK75C，挖孔高度与状态栏高度都是 **104px**）这两个诉求无法兼得：

| 方案 | 状态栏隐藏时 | 状态栏显示时 |
|---|---|---|
| 只跟状态栏走 | 留 0 → **挖孔盖住内容** | 留 104 → 页面下移 |
| 恒定留挖孔高度 | 留 104 | 留 104 → **切换没有位移** |

固定成「常驻显示 + 恒定留白」之后两条都满足，也不再有切换位移，
所以开关连同它的桥接方法、`SharedPreferences`、网页侧的设置项一起删掉了。
本文件里凡是提到「状态栏开关」的段落都属历史，代码中已不存在。

### 顶部留白 & 不被挖孔挡

`keepContentClearOfSystemAreas()` 把 insets 换算成 WebView 的 `padding`，
顶部取 `systemBars().top`（实测 104px，**系统给的这个值本身就覆盖了挖孔区域**，
所以不需要再额外加一份 `displayCutout` 的高度，不会重复计算）。

⚠️ **踩过的坑**：顶部曾经写成 `max(systemBars.top, displayCutout.top)`。
targetSdk 36 在 Android 16+ 会把 `layoutInDisplayCutoutMode` 强制成 `always`，
于是**状态栏即使隐藏，挖孔区域仍然算作 displayCutout**：

```
状态栏隐藏 → systemBars.top = 0    displayCutout.top = 104
状态栏显示 → systemBars.top = 104  displayCutout.top = 104
```

取 max 的话两种情况都是 104，内边距恒定 —— 表现就是「状态栏显示了，
但页面没有下移留出空间，只是半透明浮在上面」。**不要再退回取 max 的写法。**

### 第二个坑：监听器不能返回 CONSUMED

insets 监听器必须**原样返回 `windowInsets`**，不能返回 `WindowInsetsCompat.CONSUMED`。
返回 CONSUMED 会把「这个 View 自己消费掉了 insets」记进框架
（`View.mPrivateFlags` 的 `PFLAG_WINDOW_INSETS_CONSUMED`），此后
`requestApplyInsets()` 对它**再也不派发** —— 内边距会永远停在旧值。

**为什么加在 WebView 上、而不是外面包一层 `FrameLayout`：**
加在 WebView 自己身上，网页的 `<html>` 尺寸就等于「可用高度」，页面里
`position: fixed` 的悬浮底栏、`100vw`、`100%` 这些布局会自动跟着收缩。
包一层容器只把容器内缩的话，WebView 视口仍是整屏，`fixed` 元素照样会越界。

**网页侧不需要任何改动**（不用加 `viewport-fit=cover`，也不用 `env(safe-area-inset-*)`），
留白完全由原生负责。

### 软键盘

`ime()` 也必须算进内边距：和 `setDecorFitsSystemWindows(false)` 搭配时窗口
**不再自动因键盘内缩**，必须自己把键盘高度让出来，否则搜索框会被键盘盖住。

### 底部为什么不直接用系统的 insets.bottom

悬浮底栏（`.topbar-actions`）自己离视口底边只有 12px（窄屏 `bottom: 12px`），
全靠这里的留白把它托起来。而全面屏手势导航下 `insets.bottom` 只是那条**手势线**
区域的高度，各家 ROM 报的值不一致 —— OPPO / ColorOS 明显偏小，底栏就会贴着屏幕
最底边，既难看又和上滑手势抢位置。

所以 `bottomClearance()` 不照抄系统值：

```kotlin
maxOf(systemBottom, dp(MIN_GESTURE_BAR_DP + BOTTOM_CUSHION_DP))   // 24 + 16 = 40dp
```

- 系统值更大时（虚拟导航键**三键模式**约 48dp）说明系统确实占了那么多，照给；
- 系统值偏小或报 0 时由 40dp 下限兜住，各家 ROM 表现一致；
- 键盘弹出时不用特判：那时 `insets.bottom` 是键盘高度（几百 dp），`max()` 直接取它。

> **想微调底栏高低，只改 `BOTTOM_CUSHION_DP` 一个数字就行**（在
> `MainActivity` 的 `companion object` 里）。调大底栏升高，调小则降低。

### 手机窄屏：小心「输入框撑破视口」

这是网页侧的一个坑，但在手机上才会暴露，记在这里。

**现象**（Redmi 23013RK75C / Android 17 实测）：词书库的搜索框比屏幕还长，
整个页面被缩小、还能左右拖。

**根因**：`<input>` 的固有宽度默认按 `size=20` 个字符算，作为 flex 子项时
它的「自动最小尺寸」就是这个固有宽度。搜索框那行的 flex 子项于是被顶到
**514px**，而手机视口只有 **411px** —— 页面横向溢出后，Chromium 会把布局视口
整体放大到 544px 来容纳溢出，表现就是「东西变长 + 整页缩小还能横拖」。

实测数据（`window.innerWidth` 等指标由临时探针读回）：

| | innerW | doc.scrollW | 搜索框宽 |
|---|---|---|---|
| 修前 | **544** | **544** | **514** |
| 修后 | **411** | **411** | **350** |

**修法**（都在 `assets/style.css` / `index.html`）：

```css
.searchbox        { max-width: 100%; min-width: 0; }   /* 不许超出父级 */
.searchbox input  { width: 100%;  min-width: 0; }      /* 解除固有宽度下限 */
```
```html
<input id="libSearch" size="1" …>   <!-- 压掉 UA 默认的 20 字符固有宽度 -->
```

**要点**：`min-width: 0` 单独用不够，还要 `width: 100%` 把宽度交还给 CSS；
`size="1"` 是兜底。以后再加 `<input>` / `<textarea>` 到窄屏行内布局时，
同样要留意这条。

### 顺带修掉的深色模式白边

`res/values-night/colors.xml` 提供深色窗口底色（`#111318`，与网页深色
`md-surface` 一致）。主题本来就是 `Theme.AppCompat.DayNight.*`，系统切深色时
自动生效，不用写代码。两份底色要和 `assets/style.css` 里 `md-surface` 那个
CSS 变量的浅 `#fdfbff` / 深 `#111318` 保持一致。

> ⚠️ **XML 注释里不能出现连续两个减号**，否则 aapt2 会直接报错、编译中断。
> 写 CSS 变量名时不要带上前面的两个减号（别写 `--md-surface`）。

### 外观模式滑块（跟随系统 / 亮色 / 暗色）

统计页「自定义」里有一个三档滑块，让用户**覆盖**系统偏好。纯网页侧实现，
原生不用做任何事：

| 环节 | 位置 | 做什么 |
|---|---|---|
| 控件 | `index.html` 的 `#schemeSlider` | 三个 `<button class="mode-opt">`，`role="radiogroup"` |
| 状态 | `assets/profile.js` 的 `applyScheme()` | 把选中的档位写成 `<html data-scheme="light\|dark">`；**auto 时删掉属性** |
| 生效 | `assets/style.css` 的 1.9b 节 | `html[data-scheme="dark"]` / `[data-scheme="light"]` 覆盖深色 / 亮色令牌 |
| 持久化 | `danci.profile.v1` 的 `mode` 字段 | 白名单校验，只认 `auto` / `light` / `dark` |

**为什么强制亮色也要写一整块令牌**（而不是只写 `color-scheme: light`）：
`@media (prefers-color-scheme: dark)` 是按**系统偏好**触发的，
用户选亮色时它照样把深色值压上来；而 `color-scheme` 只影响原生部件
（滚动条、表单控件）的明暗，不改我们的变量。所以「系统深 + 用户选亮」这个象限
必须显式把亮色令牌写回来。

> ⚠️ **维护点**：基础深色令牌现在有三份副本 ——
> 1.9 的媒体查询、1.9b 的 `[data-scheme="dark"]`、1.9b 的 `[data-scheme="light"]`（亮色那份）。
> 改深色值要三处一起改。各主题自己的深色值（1.10 里六个 `html[data-theme]` 块）不用重复 ——
> 它们本来就成对写在同一个媒体查询里，`data-scheme` 只覆盖基础令牌。
> 这是纯 CSS 下无法避免的重复（替代方案是预处理器或 `light-dark()`，前者要加构建步骤、后者兼容性不够）。

### 改完怎么验证

1. 顶部：状态栏整个不见，词书库页首的**用户名称**（默认「你好！」）完整可见。
2. 底部：手势线不见，悬浮底栏（主页 / 统计 / 使用说明）离屏幕底边有一段距离。
3. 临时唤出：从屏幕顶部下拉、底部上滑，系统栏能临时出来并自动缩回。
4. 键盘：点搜索框弹出键盘后，输入框应仍可见、不被键盘遮住。
5. 横屏 / 刘海屏：旋转屏幕后顶部同样不留压字。
6. 导航方式切换：设置里在「手势导航」和「三键导航」之间切换，都不该再被系统栏压住。

---

## 一之三、导入词书 Excel：为什么不需要申请存储权限

**结论：一个存储权限都不需要，也不应该申请。** 真正缺的是代码，见下。

### 真正的问题：`<input type="file">` 需要自己接管

网页里的导入入口是三个隐藏的原生文件框：

| 位置 | 用途 |
|---|---|
| `#fileInput` | 导入词书（`.xlsx,.xls,.xlsm,.csv,.txt`） |
| `#importFile` | 导入数据备份（`.json`） |
| `#profilePhoto` | 换头像（`image/*`）—— 壳子里会**多一步裁剪**，见下 |

WebView **默认不处理** `<input type="file">`：不接管
`WebChromeClient.onShowFileChooser` 的话，点「导入词书」不会有任何反应，
连报错都没有 —— 表现就像缺权限，其实是缺代码。

`MainActivity.openFileChooser()` 已经接管：发一个
`ACTION_GET_CONTENT` + `CATEGORY_OPENABLE` 的意图，把用户选中的 URI 回给网页。

### 换头像：壳子里多一步 1:1 裁剪（`CropActivity`）

`#profilePhoto` 选中的如果是图片，`onActivityResult` **不直接交回网页**，
而是先起 `CropActivity` 让用户裁一个 1:1，裁完压到 256×256 再通过
`window.onNativeCroppedAvatar(dataUrl)` 推回去。网页侧 `assets/profile.js`
里那段注释写了它为什么是安全的（原生用**空数组**收尾 `<input>` 那次选择，
所以网页的 change handler 会因拿不到文件而直接 return，不会覆盖结果）。

**为什么不用系统的 `com.android.camera.action.CROP`**（这段是实测结论）：

它确实能被拉起（这台 MIUI 是 `com.miui.gallery.crop.CropperActivity`，
界面也正常），但**它什么都不写** —— `onActivityResult` 收到 `RESULT_OK`，
输出文件不存在（预创建后仍是 0 字节），返回的 Intent 里也没有任何 extras。
试过的写法都不行：只给 content uri、只给 `file://` 路径、`return-data=true`、
显式 `grantUriPermission`、源图复制到自己的 FileProvider。

**也不是权限问题**：预创建的输出文件能被正常创建（说明我们有写权限），
MIUI 相册自身还持有 `MANAGE_EXTERNAL_STORAGE`。所以「加存储权限」解决不了它 ——
加了只是多一个用不上的权限。这个 action 本来就不是 AOSP 的公开契约，
在个别 ROM 上表现不可预期，所以改为自己实现：行为完全可控、
不依赖任何第三方应用、也不需要任何权限。

> 顺带记一个**包可见性**的坑：`Android 11+` 起不声明 `<queries>` 时，
> `resolveActivity()` 对未声明的应用一律返回 `null`。最早用
> `resolveActivity` 探「有没有裁剪器」，结果在 MIUI 上一直误判成「没有」
> 而跳过了裁剪（后来才查明是可见性，不是真没有），改成直接
> `startActivityForResult` + 捕 `ActivityNotFoundException` 之后就正常拉起了 ——
> 拉起来才发现真正的问题是它不落盘，于是最终换成了自实现。

### 为什么走系统文件选择器就不需要权限

用户挑中某个文件后，**系统会把「这一个文件」的临时读取授权随结果一起给回应用**，
范围仅限这一个文件。应用从来没有去遍历存储卡，所以不需要也不应该申请整个存储的
读权限。

顺带说明两个常见误解：

- `READ_MEDIA_*`（Android 13+）只管**图片 / 视频 / 音频**，对 `.xlsx` 词书文件
  本来也无效 —— 申请了也解决不了导入问题。
- `READ_EXTERNAL_STORAGE` 在 Android 13+ 已被拆分取代，对文档类文件同样不适用。
  新版应用申请它只会引来应用商店的权限审查质疑。

所以 `AndroidManifest.xml` 里**没有** `READ_*` / `WRITE_*` / `MANAGE_EXTERNAL_STORAGE`，
这是刻意的，不是漏了。

### accept 是扩展名写法，要做 MIME 换算

网页给的 `accept=".xlsx,.xls,.xlsm,.csv,.txt"` 是**扩展名**写法（浏览器语义），
而 Intent 要的是 MIME 类型。`pickMimeType()` 按 `MIME_BY_EXTENSION` 换算；
一个都认不出来时不设 type（等于任意文件）—— 宁可多显示几个文件，
也好过把用户的词书滤没了、选不到。

### 导出 / 另存为：`AndroidTTS.saveFile()`（已解决）

网页里的「导出备份」「下载词书模板」原本用 Blob URL + `<a download>`，
**WebView 默认不处理 `blob:` 下载**：它把点击当成一次导航，而默认
`WebViewClient` 对 `blob:` 既不加载也不报错 —— 表现就是点「导出备份」
**完全没反应**，连 `catch` 都不会进（`a.click()` 自己不抛异常）。

> 早先这里记的是「需要额外接一个 `DownloadListener`，当前未实现」。
> 最终**没有**走 `DownloadListener`：那条路会把文件丢进「下载」目录、
> 文件名还可能被改写。改用 SAF「另存为」，让用户自己挑位置，
> 而且**不需要任何存储权限** —— 和导入用的系统选择器对称。

链路：

| 位置 | 做什么 |
|---|---|
| `assets/app.js` 的 `saveFile()` | 统一入口：壳子里调原生，否则回退网页下载 |
| `TtsBridge.saveFile(name, base64, mime)` | `@JavascriptInterface`，接住数据后回主线程 |
| `MainActivity.startSaveFile()` | 发 `ACTION_CREATE_DOCUMENT`，预填文件名 |
| `MainActivity.finishSaveFile()` | 用户选完位置后把字节写进目标 uri |
| `assets/app.js` 的 `window.WordCardSave.onResult` | 原生回传成功 / 取消 / 失败，网页出提示 |

三个实现上的注意点：

1. **数据用 base64 传**。`@JavascriptInterface` 只认基本类型，二进制只能
   编码成字符串。`app.js` 里有 2 MB 上限（正常备份只有几十 KB），
   超了直接提示，不让人等一个永远不会出现的保存框。
2. **结果必须由原生回报**。用户还要在选择器里挑位置，网页侧不能
   `a.click()` 之后就说「已导出」—— 所以走 `WordCardSave.onResult` 回调。
3. **取消也要清状态**。`onActivityResult` 里 `resultCode != RESULT_OK` 时
   要把待写字节清空，否则下一次保存会先写上一份残留数据。

同一入口也支持二进制（`Uint8Array`），所以「下载模板」的 xlsx 走的是同一条路。

---

## 二、环境准备

装 **Android Studio**（它自带 JDK 和 Android SDK，是最省事的路）：

1. 下载安装 Android Studio：https://developer.android.com/studio
2. 首次启动会引导你装 SDK。确保装了：
   - **Android SDK Platform 36**（compileSdk 36 = Android 16）
   - **Android SDK Build-Tools**
   - **Android SDK Platform-Tools**（要 `adb` 装包）
3. JDK：**用 17 或 21，不要用 25**（见下面的坑）。

> ⚠️ **命令行构建不要用 Android Studio 自带的 JBR（Java 25）。**
> Gradle 8.11.1 里的 Groovy 3 读不了 Java 25 的 class 文件，会直接抛出：
>
> ```
> BUG! exception in phase 'semantic analysis' in source unit '_BuildScript_'
> Unsupported class file major version 69
> ```
>
> 69 就是 Java 25 的 class 文件版本号。**这不是代码问题**，换 JDK 21 立刻就好。
> Android Studio 自带的 `jbr` 是 25（`D:\AndroidStudio\jbr`），所以命令行构建要
> 另指一个 JDK：
>
> ```powershell
> $env:JAVA_HOME="C:\path\to\jdk-21"     # 例如 Temurin 21
> $env:ANDROID_HOME="C:\Users\<你>\AppData\Local\Android\Sdk"
> .\gradlew.bat assembleDebug
> ```
>
> 实测：JDK 21 + Gradle 8.11.1 + AGP 8.9.0，`assembleDebug` 与 `assembleRelease`
> 都能过一次通过。Android Studio 图形界面里 Gradle Sync 用的是它自己的 JBR，
> 若也遇到同样报错，在 `Settings → Build Tools → Gradle → Gradle JDK` 里改成 17/21。

> **版本下限**：compileSdk 36 需要 **AGP 8.9+ 配 Gradle 8.11+**。
> 工程里已经按这个配好了（`build.gradle` 顶部 8.9.0，wrapper 8.11.1），
> 不要往下调，否则会报「compileSdk 36 requires AGP ...」。
> AGP 8.9.0 官方只测到 compileSdk 35，所以构建时会刷一条警告；
> 已经在 `gradle.properties` 里用 `android.suppressUnsupportedCompileSdk=36` 压掉，
> 实际编译没问题（两个变体都验证过）。

`gradle/wrapper/` 里 **`gradlew` / `gradlew.bat` / `gradle-wrapper.jar` 都在**，
直接把 `android/` 用 Android Studio 打开，或直接跑 `.\gradlew.bat` 即可。

### lint 在 release 打包时是关掉的

`app/build.gradle` 里有：

```groovy
lint { checkReleaseBuilds = false }
```

原因是一个 Gradle 的隐式依赖校验冲突：`syncWebAssets` 产出的
`app/build/generated/webAssets` 同时被当作 assets 源目录，lint 扫描它时
Gradle 判定「用了别的任务的输出却没声明依赖」，`assembleRelease` 直接失败：

```
Task ':app:lintVitalAnalyzeRelease' uses this output of task ':app:syncWebAssets'
without declaring an explicit or implicit dependency.
```

`assembleDebug` 走不到 lint 任务，所以这个错**只在 release 打包时暴露**。
试过 `tasks.configureEach` 补 `dependsOn`、`taskGraph.whenReady` 补依赖、
把生成目录挪出 `build/`、给源目录加 `builtBy` —— 都不行（`lintVitalAnalyzeRelease`
是 AGP 在执行阶段才创建的任务，配置阶段挂不上钩子），最后选择在 release 打包时
跳过 lint。要恢复 lint 的话，得改用 AGP 的 variant API 注册生成目录，而不是
往 `sourceSets` 里塞任务输出。

---

## 三、出包

### 方式 A：Android Studio（推荐）

1. `File → Open`，选这个 `android/` 目录（**不是**项目根目录）。
2. 等 Gradle Sync 完成。
3. `Build → Build Bundle(s) / APK(s) → Build APK(s)`。
4. 产物在 `android/app/build/outputs/apk/debug/app-debug.apk`。

### 方式 B：命令行

```bash
cd android

# 调试包（不混淆、不压缩资源，便于排查问题）
./gradlew assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk

# 正式成品（混淆 + 资源压缩 + debug 密钥签名，可直接安装）
./gradlew assembleRelease
# 产物：app/build/outputs/apk/release/app-release.apk
```

Windows / PowerShell 下（**注意 `JAVA_HOME` 要指向 JDK 17 或 21，不能用 JBR 25**）：

```powershell
$env:JAVA_HOME="C:\path\to\jdk-21"
$env:ANDROID_HOME="C:\Users\<你>\AppData\Local\Android\Sdk"
cd android
.\gradlew.bat assembleRelease
```

> 两个变体都已实测通过。`assembleDebug` 约 **7.7 MB**，`assembleRelease`
> 约 **1.6 MB**（R8 混淆 + 资源压缩的效果）。
>
> **release 变体的三个关键设置**（都在 `app/build.gradle`）：
>
> | 项 | 值 | 说明 |
> |---|---|---|
> | `minifyEnabled` | `true` | R8 混淆，见下面「混淆要注意的两处反射」 |
> | `shrinkResources` | `true` | 资源压缩。实测**不会**动 `assets/www/**`——那 11 个网页文件每次都完整保留 |
> | `signingConfig` | `release` → debug 密钥 | 见「四、签名」 |
>
> **混淆要注意的两处反射**（`app/proguard-rules.pro` 里已 keep 住，改动时别删）：
>
> 1. `TtsBridge` 的方法名是页面用**字符串**调用的（`AndroidTTS.speak(...)`）。
>    一旦被改名，点「发音」就是静默失效 —— 不报错、能启动、就是没声音。
>    另外 `@JavascriptInterface` 注释本身也必须保留（WebView 靠它决定
>    哪些方法允许被 JS 调用），所以要 `-keepattributes *Annotation*`。
> 2. `MainActivity.onActivityResult()` 与 `CropActivity` 走系统的反射回调，
>    文件选择 / 另存为 / 头像裁剪都依赖它。
>
> 出包后想自检混淆有没有伤到桥接，可以反汇编 dex 看方法名还在不在：
>
> ```powershell
> $bt = "$env:ANDROID_HOME\build-tools\36.0.0"
> # 先把 apk 里的 classes.dex 解出来，然后：
> & "$bt\dexdump.exe" -d classes.dex | Select-String 'TtsBridge' | Select-Object -First 20
> ```

装到手机：

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

---

## 四、签名

### 现状：release 复用 Android 的 debug 密钥

`app/build.gradle` 里：

```groovy
signingConfigs {
    release {
        storeFile file(System.getProperty("user.home") + "/.android/debug.keystore")
        storePassword "android"
        keyAlias "androiddebugkey"
        keyPassword "android"
    }
}
```

好处是 `assembleRelease` 直接产出**可安装**的包。
代价必须记住（**这不是一个能上架的签名**）：

- `~/.android/debug.keystore` 的密码是公开的（就是 `"android"`），
  任何人都能签出同一个包名的 APK；
- 那个文件在**构建机上**：换一台机器重新构建，Android 会自动生成一份**新的**
  debug 密钥，签名指纹就变了 —— 存量设备必须先卸载才能装新包，数据会丢。
  所以**对外分发前一定要换成项目自己的 keystore**；
- 本工程 `debug` 与 `release` 用的是同一个密钥，所以 `install -r` 可以互相覆盖。

### 要换成正式密钥时

1. 生成密钥库（只需一次，**务必备份，丢了就永远无法再升级同一个包名**）：

```bash
keytool -genkeypair -v -keystore wordsduck2.jks -keyalg RSA -keysize 2048 \
        -validity 10000 -alias wordsduck2
```

2. 在 `android/` 下新建 `keystore.properties`（**不要提交到版本库**）：

```properties
storeFile=../wordsduck2.jks
storePassword=你的密码
keyAlias=wordsduck2
keyPassword=你的密码
```

3. 把 `build.gradle` 里的 `signingConfigs.release` 换成读这个文件：

```groovy
def keystoreProps = new Properties()
def kp = rootProject.file('keystore.properties')
if (kp.exists()) keystoreProps.load(new FileInputStream(kp))

android {
    signingConfigs {
        release {
            if (kp.exists()) {
                storeFile file(keystoreProps['storeFile'])
                storePassword keystoreProps['storePassword']
                keyAlias keystoreProps['keyAlias']
                keyPassword keystoreProps['keyPassword']
            }
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
        }
    }
}
```

> ⚠️ 换密钥后，**已装 debug 签名版本的设备必须先卸载**（签名不一致，装不上），
> 卸载会清掉 `localStorage` —— 也就是词书库、复习本、学习统计**全部丢失**。
> 换密钥前先在应用内「数据备份 → 导出备份」存一份 JSON，装完再导入。

---

## 五、实际体积

以下是在 JDK 21 + Gradle 8.11.1 + AGP 8.9.0 下**实测**的结果（`clean` 后重新打包）：

| 产物 | 大小 |
|---|---|
| `app/build/outputs/apk/debug/app-debug.apk` | **7.41 MB** |
| `app/build/outputs/apk/release/app-release-unsigned.apk` | **6.24 MB** |

拆开看（debug 包，未压缩体积）：

| 内容 | 大小 |
|---|---|
| 网页（index.html + assets + libs） | 1254 KB（其中 xlsx 解析库 930 KB） |
| `classes.dex` + `classes2.dex` + `classes3.dex` | ≈ 6.5 MB |
| `resources.arsc` | 258 KB |

> **别被「合计约 1.3 MB」骗了** —— 那是只算了网页的估算，实际包体的大头是
> AndroidX + Kotlin 运行时的 dex，网页只占 1.2 MB。要显著变小，得开
> `minifyEnabled true` 配 R8（本工程目前是关的）。
>
> 被排除的内置语音包是 30 个文件、161.8 MB，**确实没有打进包里** ——
> 两个 APK 里都搜不到 `assets/www/assets/tts/` 下的任何文件，这一条已核实。

排除清单在 `app/build.gradle` 的 `syncWebAssets` 任务里。

打包时网页会被同步到构建目录：

```
app/build/generated/webAssets/
└── www/
    ├── index.html          ← 同步时会去掉两个内置语音包的 <script>
    ├── assets/…
    └── libs/xlsx.full.min.js
```

`www/` 这一层是为了对上 `MainActivity` 里的
`loadUrl("file:///android_asset/www/index.html")`。APK 里的最终路径是
`assets/www/index.html`。

`syncWebAssets` 会在每次打包时重跑，所以**改网页之后直接重新打包即可**，
不需要手动拷文件。（它写成 `doLast` 而不是用 `filter`，是因为要让
「重写 index.html」和「同步」在同一个任务里完成：只要在别处再读一次
这个目录，Gradle 会因为任务已执行而把拷贝整个跳过。）

---

## 六、装好后需要检查的行为

> **真机验证记录（当前实现）**
>
> *Redmi 23013RK75C「mondrian」/ Android 17 / SDK 37 / 手势导航 / 有摄像头挖孔*
> （挖孔顶部 104px，状态栏高度同为 104px）
> - 状态栏常驻：`type=statusBars frame=[0,0][1080,104] visible=true`
> - 手势线隐藏：`type=navigationBars ... visible=false`
> - 顶部留白 = 104px，内容整齐落在状态栏下方：截图里时间 / 电量与「单词卡」
>   标题各就各位，既没有重叠也没有多余空档
> - 「自定义」模块里已无状态栏开关
>
> （上面这条是**当时**的记录，其中的「单词卡」是那时的固定标题。
> 现在页首显示的是用户名称，默认「你好！」，可在「自定义」里改；
> 另外 `main` 的上留白后来按设计调大了很多，「没有多余空档」不再适用。）
>
> *OPPO OPD2409 / Android 16 / SDK 36 / 手势导航 / 无挖孔*
> - 更早期版本的验证机；统计页不再出现「发音引擎」面板一条是在这台机上确认的

1. **首次点「发音」应有声音。** 若没声音，多半是设备没装英文 TTS 语音数据：
   `设置 → 系统 → 语言和输入法 → 文字转语音 → 安装语音数据 → English`。
   `TtsBridge.applyLanguage()` 遇到缺数据会打进 Logcat（tag `TtsBridge`）。
2. **统计页不应再出现「发音引擎」面板。** 安卓版走系统 TTS，不需要选引擎，
   该面板由 `html.android-shell` 隐藏（见「一」里的「安卓壳子标记」）。
   网页版打开时它应该还在 —— 这是这次改动的对照点。
   另外，朗读应自动用原生桥接：APK 里没有内置语音包，引擎会落到本机语音。
3. **词书库 / 学习记录要能留存。** 关掉进程再打开，词书还在，说明 localStorage
   持久化正常（靠 `domStorageEnabled`）。
4. **看 Logcat 确认桥接被识别**：tag `TtsBridge`，应出现「系统 TTS 就绪，
   匹配到 N 个英文音色」。也可以在 `chrome://inspect` 里连 WebView 看控制台。
5. **状态栏常驻显示，手势线始终隐藏。** 状态栏的时间 / 电量图标应始终可见；
   从屏幕底部上滑能临时唤出手势线。
6. **顶部内容不被状态栏和挖孔挡住**：词书库页首的**用户名称**（默认「你好！」）完整可见，
   与状态栏之间没有重叠、也没有多余的大空档。
   注意这里刻意留了一大段上留白（`main` 的 `padding-top`，见 style.css），
   所以「没有多余的大空档」这条不适用于它 —— 那段是设计要的。
7. **统计页的「自定义」模块里不应该再有「显示状态栏」开关**（已移除）。
8. **导入词书 Excel 能弹出文件选择器**：点「导入词书」应弹出系统文件选择器，
   选中 `.xlsx` 后能正常解析成词书。这一条不需要任何存储权限，详见「一之三」一节。
9. **导出备份能弹出「另存为」并真的落盘**：点「导出备份」应弹出系统文件选择器、
   文件名预填 `单词卡备份-<日期>.json`；保存后去「下载」目录确认文件存在、
   且内容是一份合法 JSON（`kind` 为 `danci.backup`）。「下载模板」同理，
   落盘的是 `.xlsx`（前两字节是 `50 4B`）。详见「一之三」的导出小节。
   取消时网页应提示「未保存：已取消保存」，而不是静默什么都不发生。

---

## 七、目录结构

```
android/
├── build.gradle                 顶层：声明插件版本
├── settings.gradle              仓库与模块
├── gradle.properties
├── gradle/wrapper/
│   └── gradle-wrapper.properties
└── app/
    ├── build.gradle             模块配置 + syncWebAssets（同步网页、排除语音包）
    ├── proguard-rules.pro
    └── src/main/
        ├── AndroidManifest.xml  <queries> TTS_SERVICE 在这里；刻意不含存储权限
        ├── java/com/wordsduck2/app/
        │   ├── MainActivity.kt  WebView 宿主（系统栏 + 文件选择/另存为接管）
        │   ├── TtsBridge.kt     window.AndroidTTS 桥接（TTS + isAndroidShell
        │   │                    + setDarkMode + saveFile）
        │   └── CropActivity.kt  头像 1:1 裁剪界面（自实现，不依赖系统裁剪器；
        │                        原因见该文件类注释）
        └── res/
            ├── mipmap-*/ic_launcher.png  各密度启动图标（由根目录 logo.png 生成，
            │                              脚本见 tools/make-icons.py；
            │                              原来那个 drawable/ic_launcher.xml 已删）
            ├── values/strings.xml
            ├── values/colors.xml          窗口底色（浅色）
            ├── values-night/colors.xml    窗口底色（深色）
            └── values/themes.xml          含挖孔布局模式，避免启动首帧跳动
```

> 图标源图是项目根目录的 `logo.png`（2160×2160）。换 logo 的步骤：
> 把新图覆盖到根目录同名位置，然后跑
> `python tools/make-icons.py`（脚本会同时更新 `assets/logo-192.png`、`logo-512.png`
> 和上面那五个 `mipmap-*/ic_launcher.png`），再重新打包即可。
