# R8 混淆规则（release 走 minifyEnabled true + shrinkResources true）。
#
# 这个工程里只有两处是「名字被当字符串用」的反射点，混淆会静默弄坏它们 ——
# 不报错、能启动，只是某个功能点下去没反应。所以逐条 keep 住。

# ------------------------------------------------------------------
# 1) WebView 的 JS 桥接对象
#
# MainActivity 里 addJavascriptInterface(tts, "AndroidTTS")，
# 页面用 **字符串方法名** 调用：AndroidTTS.speak(...) / stop() / saveFile(...) 等
# （见 app.js 的 NATIVE_NAMES 与 TtsBridge 的类注释）。
# 方法一旦被改名，页面上点「发音」就是静默失效。
#
# 为什么用 -keep class 而不是 -keepclassmembers：
#   方法名要保留，类名本身也保留更省心（TtsBridge 里的 Log tag、
#   getSimpleName() 之类的输出也能对上）。
# 为什么要 keep *Annotation*：
#   @JavascriptInterface 这个注解本身会被 R8 删掉，而 WebView 是靠它
#   判断「哪些方法允许被 JS 调用」的 —— 注解没了，方法名留着也没用。
# ------------------------------------------------------------------
-keepattributes *Annotation*
-keep class com.wordsduck2.app.TtsBridge { *; }

# ------------------------------------------------------------------
# 2) Activity 的生命周期回调
#
#   · MainActivity.onActivityResult() —— 文件选择 / 另存为 / 头像裁剪
#     的结果都从这里回来（startActivityForResult 配套）。
#   · CropActivity —— 由 Intent 显式启动，它的 setResult/getIntent 取值
#     也依赖系统回调。
#   · MainActivity 是 LAUNCHER 入口。
#
# 这几条 R8 通常能靠 manifest 与官方规则自动保住，但那依赖 AGP 版本的
# 具体行为；显式写下来，换 AGP 或改玩法时不会突然失效。
# ------------------------------------------------------------------
-keep class com.wordsduck2.app.MainActivity { *; }
-keep class com.wordsduck2.app.CropActivity { *; }

# ------------------------------------------------------------------
# 3) 系统组件的反射入口
# ------------------------------------------------------------------
-keepclassmembers class * extends android.app.Activity {
    public void *(android.view.View);
}
-keepclassmembers class * implements android.os.Parcelable {
    public static final ** CREATOR;
}

# 关掉混淆产物里的行号信息会更好（体积小一点），但保留源文件名
# 有助于线上排查；这里选择保留，体积差异可以忽略。
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
