/* ============================================================
   单词卡 · 语音包装载提示
   ------------------------------------------------------------
   背景：网页内置语音（Piper，en_GB-cori-high fp32）有 127 MB，
   assets/tts/boot.js 会在页面打开约 0.9 秒后开始后台搬运，分 21 个
   分片逐个解码进内存。搬运期间浏览器要解析这么多 base64，用户却看不到
   任何反馈，容易以为页面卡住 —— 所以这里弹一个居中的提示框，
   装好（或装失败）自动关闭。

   为什么单独一个文件：
     提示逻辑是新增的，app.js 里没有对应实现，而它是一份闭合的 IIFE。
     这里只读 window.WCTTS 的公开接口（state / progress / onProgress），
     不改变它的装载策略 —— 按需求，装载时机保持原样。

   两种不弹的情况：
     1) 用户已经把发音引擎明确选成「本机内置语音」——那就根本用不到内置
        语音包，弹出来是误导；
     2) 没有 WCTTS（语音包文件缺失）——没什么可等的。
   ============================================================ */
(function (W, D) {
  'use strict';

  var LS_SET = 'danci.settings.v1';
  var FALLBACK_MS = 20000;   // 兜底：万一状态回调没来，也不能一直挡着
  var MIN_SHOW_MS = 400;     // 太快闪一下反而像故障，至少留这么久

  var box = null;
  var title = null;
  var sub = null;
  var fill = null;
  var count = null;
  var note = null;
  var shownAt = 0;
  var hideTimer = null;
  var done = false;

  // 用户是否明确选了「本机内置语音」——那样就不该弹这个框
  function prefIsSystem() {
    try {
      var raw = localStorage.getItem(LS_SET);
      if (!raw) return false;
      var s = JSON.parse(raw);
      return !!(s && s.speakEngine === 'system');
    } catch (e) {
      return false;
    }
  }

  function setProgress(ratio) {
    var pct = Math.max(0, Math.min(100, Math.round((ratio || 0) * 100)));
    if (fill) {
      // 还没拿到第一个分片时别把进度条画成一条空槽，给一点点起始宽度
      fill.style.width = (pct < 1 ? 2 : pct) + '%';
    }
    if (count) count.textContent = pct + '%';
  }

  function close(why) {
    if (done) return;
    done = true;
    clearTimeout(hideTimer);
    var wait = Math.max(0, MIN_SHOW_MS - (Date.now() - shownAt));
    setTimeout(function () {
      if (box) box.hidden = true;
    }, wait);
    if (why === 'error' && note) {
      note.textContent = '这次没装上，单词改用本机语音朗读，不影响背词。';
    }
  }

  function open() {
    if (!box) return;
    shownAt = Date.now();
    box.hidden = false;
    // 已经装好一部分了（比如用户提前点了发音），起点就按真实进度画
    var p = W.WCTTS.progress && W.WCTTS.progress();
    setProgress(p ? p.ratio : 0);
  }

  function wire() {
    box = D.getElementById('ttsModal');
    if (!box) return false;                 // 页面里没有这个框就静默跳过
    title = D.getElementById('ttsTitle');
    sub = D.getElementById('ttsSub');
    fill = D.getElementById('ttsBarFill');
    count = D.getElementById('ttsCount');
    note = D.getElementById('ttsNote');

    var T = W.WCTTS;
    if (!T || typeof T.onProgress !== 'function') return false;
    if (prefIsSystem()) return false;       // 用不到内置语音，不打扰

    var state = T.state();

    // 装完了 / 装失败了：什么都不用做
    if (state === 'ready' || state === 'error') return false;

    open();

    T.onProgress(function (p, s) {
      if (done) return;
      if (p && typeof p.ratio === 'number') setProgress(p.ratio);
      if (s === 'ready' || s === 'error') {
        close(s === 'error' ? 'error' : 'ok');
        return;
      }
      // 已经进到音色那一段了，把「在装什么」说得更具体
      if (s === 'loading' && title && p && p.phase === 'core') {
        title.textContent = '正在装载语音包';
      }
    });

    // onProgress 注册时会立刻回调一次当前状态，所以上面已经能拿到进度；
    // 万一它正好在注册前完成，这里再确认一次。
    var s2 = T.state();
    if (s2 === 'ready' || s2 === 'error') close(s2 === 'error' ? 'error' : 'ok');

    hideTimer = setTimeout(function () { close('timeout'); }, FALLBACK_MS);
    return true;
  }

  // 等 boot.js 定义好 WCTTS 再接线；没有就什么都不做
  var tries = 0;
  (function tick() {
    if (W.WCTTS) { wire(); return; }
    if (++tries > 120) return;              // 最多等 6 秒
    setTimeout(tick, 50);
  })();
})(window, document);
