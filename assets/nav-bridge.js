/* ============================================================
   单词卡 · 导航桥接
   ------------------------------------------------------------
   为什么需要这个文件：
     底栏改版后多了 #btnHome 这个新按钮，而 assets/app.js 里只绑了它
     自己认识的那些 id —— app.js 是一份闭合的 IIFE，没有对外暴露
     show() / renderLibrary()，所以新按钮接不上原有的页面切换逻辑，
     表现就是「从统计页点主页没反应」。

   这里不做任何业务逻辑，只做转接：把新按钮的点击转交给 app.js
   已经绑好事件的既有按钮，页面切换、重新渲染都仍由 app.js 负责。
     主页 → #btnBackHome（它的处理就是 renderLibrary() + show('library')）
     统计 → #btnStats（空转，只是把 app.js 没做的事补齐）

   放在 app.js 之后加载，且不依赖文档是否已解析完：
   脚本在 </body> 前，执行时上面的 DOM 已经就绪。
   ============================================================ */
(function () {
  'use strict';

  var SCREENS = ['library', 'study', 'done', 'stats'];

  function $id(id) { return document.getElementById(id); }

  // 只重放 app.js 已经绑好的点击，不重复实现它的逻辑
  function forwardTo(el) {
    if (el) el.click();
  }

  function wire() {
    var bar = document.querySelector('.topbar-actions');
    if (!bar) return;

    // 底栏上的按钮一律不触发 app.js 的「点拖放区就弹文件框」，
    // 也不需要浏览器默认行为
    bar.addEventListener('mousedown', function (e) { e.preventDefault(); });

    var home = $id('btnHome');
    var stats = $id('btnStats');

    if (home) {
      home.addEventListener('click', function () {
        // #btnBackHome 是 app.js 的「回词书库」钩子：renderLibrary() + show('library')
        var back = $id('btnBackHome');
        if (back) forwardTo(back);
        else markActive('library');
      });
    }

    if (stats) {
      // #btnStats 的监听本来就在 app.js 里，这里不重复绑定。
      // 只是给旧内核补一份「当前页高亮」。
      stats.addEventListener('click', function () { markActive('stats'); });
    }

    if (home) home.addEventListener('click', function () { markActive('library'); });
  }

  /* 旧内核兜底：这些浏览器不支持 :has()，样式表里靠 :has() 写的
     「底栏高亮 / 背词页藏栏」会整条失效。这里改用 html 上的两个类来补，
     与样式表里等价的那两条 :has() 规则并存，谁生效都不冲突。 */
  function sync() {
    markShell();   // 桥接对象出现得晚的话，在这里重试
    var active = null;
    for (var i = 0; i < SCREENS.length; i++) {
      var s = document.getElementById('screen-' + SCREENS[i]);
      if (s && s.classList.contains('is-active')) { active = SCREENS[i]; break; }
    }
    var root = document.documentElement;
    if (root.classList.contains('nav-study') !== (active === 'study')) {
      root.classList.toggle('nav-study', active === 'study');
    }
    if (root.classList.contains('nav-stats') !== (active === 'stats')) {
      root.classList.toggle('nav-stats', active === 'stats');
    }
    markActive(active);
  }

  function markActive(which) {
    var home = $id('btnHome');
    var stats = $id('btnStats');
    if (home) home.classList.toggle('is-current', which === 'library' || which === 'done');
    if (stats) stats.classList.toggle('is-current', which === 'stats');
  }

  /* 认「跑在安卓 APK 里」，在 <html> 上打 android-shell 类。
     样式表里就靠这个类关掉只在网页版有意义的 UI（目前是「发音引擎」选择模块：
     APK 里不含 Piper 内置语音包，三档选择没有意义）。

     只认原生桥接对象上的 isAndroidShell()，不看 UA —— 网页版在安卓手机的
     浏览器里打开时 UA 同样含 Android，按 UA 判断会把网页版的 UI 也误关掉。

     app.js 的 NATIVE_NAMES 是几个候选名，这里照抄同一份顺序，
     免得两边对「什么算原生桥接」的判断不一致。
     另有兜底：addJavascriptInterface 若发生在 loadUrl 之后，脚本首次执行时
     可能还看不到桥接对象，所以没认出之前每次 sync() 都会重试一次。 */
  var NATIVE_NAMES = ['WordCardNative', 'AndroidTTS', 'AndroidSpeech', 'Android'];
  var shellMarked = false;

  function isAndroidShell() {
    for (var i = 0; i < NATIVE_NAMES.length; i++) {
      var o = null;
      try { o = window[NATIVE_NAMES[i]]; } catch (e) { continue; }
      if (!o || typeof o.speak !== 'function') continue;
      try { if (o.isAndroidShell && o.isAndroidShell()) return true; } catch (e) {}
    }
    return false;
  }

  function markShell() {
    if (shellMarked) return;
    if (!isAndroidShell()) return;
    document.documentElement.classList.add('android-shell');
    shellMarked = true;
  }

  wire();
  markShell();

  // show() 只做增删 .is-active，所以监听整棵子树即可跟着页面切换更新
  new MutationObserver(sync).observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  });
  sync();
})();
