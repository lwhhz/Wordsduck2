/* ============================================================
   涟漪（ripple）· 对 @material/web 状态层的手写还原
   ------------------------------------------------------------
   为什么单独一个文件、而不是塞进 app.js：
     assets/app.js 是一个闭合的 IIFE，顶层没有任何对外入口，
     页面里所有既有功能都靠它内部的 id 绑定跑着。要加这一层交互
     只有两条路 —— 改 app.js（风险大，且它同时被网页版与安卓版共用），
     或者另起一个脚本、只用事件委托从 document 上旁听。
     这里选后者：app.js 一行不动，涟漪是纯叠加的观感层，
     删掉这个 <script> 页面功能完全不受影响。

   Material Web 里涟漪由 <md-ripple> 实现，挂在按钮、列表项、
   导航项等各种「可点面」上。它做两件事：
     1. 按下瞬间，从指针位置扩散一个圆，到覆盖整个控件为止；
     2. 动画结束后把圆移除。
   圆在整个动画里从「按下态的 10% 不透明」渐隐到 0，
   所以看起来是「一按就起一层色，然后化开」。

   本文件只负责 1 和 2 的 DOM 操作，样式全在 style.css 的 .ripple 里。
   ============================================================ */

(function () {
  'use strict';

  /* 哪些元素吃涟漪。
     挑的是「按下就触发动作」的控件，和样式表里 user-select:none
     那一组基本重合；输入框、下拉、开关这些不在这里 ——
     它们有自己的按压反馈（轨道滑动、原生控件），再叠涟漪是噪音。 */
  var RIPPLE_SELECTOR = [
    '.btn',
    '.link',
    '.iconbtn',
    '.speak-btn',
    '.avatar-preset',
    '.theme-swatch',
    '.group-head',
    '.modal-close',
    '.searchbox-clear',
    '.sheet-row'
  ].join(',');

  /* 涟漪是「视觉糖果」，不是功能。系统偏好里要求减少动态效果时直接不挂，
     免得为了一个装饰性动画去和 prefers-reduced-motion 较劲
     （CSS 侧也有一条 .ripple{display:none} 兜底，两处都留着更稳）。 */
  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduceMotion && reduceMotion.matches) return;
  if (!window.PointerEvent) return;   // 老内核：不挂，功能照旧

  /* 每个涟漪的动画时长，必须和 style.css 里 .ripple 的
     `animation: ripple-press 480ms linear` 保持一致。
     480 = 按下淡入 105ms + 松开淡出 375ms，两个数都来自
     Material Web 的 ripple（设计规范/ripple/internal/_ripple.scss）。
     留一点余量再删节点，否则动画最后一帧可能被截断。 */
  var RIPPLE_MS = 480;
  var CLEANUP_MS = RIPPLE_MS + 100;

  /* 同一个元素上只允许一个活跃涟漪。
     连点时如果堆上十几个圆，颜色会叠加到发黑，明显不是 M3 的样子 ——
     Material Web 也是「新按下先撤掉旧的」。 */
  var active = new WeakMap();

  /* ---- 取涟漪颜色 ----
     状态层的语义是「用内容色低透明度叠一层」，所以涟漪应该和按钮文字同色。
     拿法：读计算后的 color。
     两个坑：
       · 元素带 is-current 之类的类时，颜色是 class 决定的 ——
         所以每次按压都重新读，不能缓存；
       · 全局 color 不一定是按钮自己的色（比如 .btn 没写 color 时继承下来），
         但 .btn / .link 这些都显式写了 color，读到的是对的值。 */
  function inkFor(el) {
    var c = getComputedStyle(el).color;
    return c || 'currentColor';
  }

  function spawn(el, clientX, clientY) {
    // 先撤掉上一次的，避免叠色
    var prev = active.get(el);
    if (prev && prev.parentNode) prev.parentNode.removeChild(prev);

    var rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    /* 半径 = 按下点到四个角里最远的那个角。
       这样无论按在正中间还是边角上，圆都能盖满整个控件；
       正方形按钮上这个值就是「半对角线」。 */
    var dx = Math.max(clientX - rect.left, rect.right - clientX);
    var dy = Math.max(clientY - rect.top, rect.bottom - clientY);
    var radius = Math.sqrt(dx * dx + dy * dy);

    var span = document.createElement('span');
    span.className = 'ripple';
    span.setAttribute('aria-hidden', 'true');   // 纯装饰，读屏不该念

    /* 尺寸给直径（2r），位置要「从按下点退回一个半径」才是居中。
       用 left/top 而不是 transform 定位：transform 留给 scale 动画，
       两者写在同一条属性上会互相覆盖。 */
    span.style.width = (radius * 2) + 'px';
    span.style.height = (radius * 2) + 'px';
    span.style.left = (clientX - rect.left - radius) + 'px';
    span.style.top = (clientY - rect.top - radius) + 'px';
    span.style.setProperty('--ripple-ink', inkFor(el));

    /* 有些可点面在样式表里没写 position（例如 .group-head 是 flex 行），
       涟漪是绝对定位的，父级没有定位上下文就会跑到 <body> 上。
       这里补一个 relative —— 只补不覆盖，已有的 absolute/fixed 不动。 */
    if (getComputedStyle(el).position === 'static') {
      el.style.position = 'relative';
    }

    el.appendChild(span);
    active.set(el, span);
    window.setTimeout(function () {
      if (span.parentNode) span.parentNode.removeChild(span);
      if (active.get(el) === span) active.delete(el);
    }, CLEANUP_MS);
  }

  /* 用 pointerdown 而不是 click：
     · click 要等抬手，涟漪就晚了半拍；
     · 安卓 WebView 上 pointerdown 的坐标已经是 CSS 像素，不用再换算。
     非主要按键（右键、中键）不触发，和 Material Web 一致。 */
  document.addEventListener('pointerdown', function (ev) {
    if (ev.button !== 0) return;

    var el = ev.target && ev.target.closest ? ev.target.closest(RIPPLE_SELECTOR) : null;
    if (!el) return;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;

    spawn(el, ev.clientX, ev.clientY);
  }, { passive: true });

  /* 键盘操作也给一层反馈：
     用 Enter / 空格「按下」时没有坐标，就按控件正中起涟漪。
     手感上和指针按下一致，读屏/键盘用户不会觉得自己被区别对待。 */
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
    var el = ev.target && ev.target.closest ? ev.target.closest(RIPPLE_SELECTOR) : null;
    if (!el || el.disabled) return;
    if (ev.repeat) return;                 // 长按连发不重复起涟漪
    var rect = el.getBoundingClientRect();
    spawn(el, rect.left + rect.width / 2, rect.top + rect.height / 2);
  });

  /* 页面切走时把残留的圆清掉。
     背词页切屏靠 .screen 的 display 切换，元素没被销毁，
     如果动画正跑着就被 display:none，圆会留在 DOM 里等定时器收 ——
     定时器本来也会收，这里只是让「切回来时不会有半个圆一闪」。 */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    var nodes = document.querySelectorAll('.ripple');
    for (var i = 0; i < nodes.length; i++) {
      var p = nodes[i].parentNode;
      if (p) p.removeChild(nodes[i]);
    }
  });
})();
