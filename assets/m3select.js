/* ============================================================
   m3select.js · 把原生 <select> 换成 M3 菜单
   ------------------------------------------------------------
   为什么需要这个文件：
     原生下拉的弹出层是**系统画**的，CSS 完全够不着。安卓 WebView 上它会
     按系统主题画成一块白底 + 系统单选钮的浮层 —— 和这套 M3 令牌毫无关系。
     截图里那两个「不记得的词 / 每本每轮」弹出的白色菜单就是这么来的。

   做法（关键：app.js 一行都不用改）：
     原生 <select> 留作**状态载体**，只在视觉上藏起来（opacity:0）。
     app.js 依旧读写它的 .value、往里面 innerHTML 填 option、监听 change，
     全都照常工作。我们只在它上面盖一个同尺寸的 trigger，
     点 trigger 时弹出一个自己的菜单；选中后写回 select.value 并派发 change，
     让 app.js 那边照常收到通知。

   与 app.js 的耦合点只有三个，都是原生 select 本身就有的行为：
     1) 读写 .value
     2) innerHTML 重建 option（编辑词书那四个下拉会这么做）
     3) 监听 'change' 事件
   所以这里：监听 change、用 MutationObserver 盯 childList（重建选项）、
     并用一个低频定时器兜住「程序里直接赋值 .value 但不派发事件」的情况
     （app.js 的 renderSettings 就是这么干的）。

   要不要给某个 select 跳过：加 data-native-select 属性即可。
   ============================================================ */

(function () {
  'use strict';

  if (!document.querySelector) return;

  /* 需要接管的 select。用 data-native-select 可以跳过某一个。 */
  var NATIVE_OPTS = { passive: true };

  var CHECK_SVG =
    '<svg class="m3sel-check" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M20 6.5 9.5 17 4 11.5"/></svg>';

  var ARROW_SVG =
    '<svg class="m3sel-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M6 9.5 12 15.5 18 9.5"/></svg>';

  /* 同一时刻只允许一个菜单展开 */
  var openInstance = null;

  function M3Select(sel) {
    this.sel = sel;

    var wrap = document.createElement('span');
    wrap.className = 'm3sel';

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'm3sel-trigger';
    /* role=combobox + aria-expanded 是「点击展开列表」的标准无障碍写法。
       aria-controls 指向菜单 id，方便读屏把两者关联起来。 */
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    var value = document.createElement('span');
    value.className = 'm3sel-value';
    trigger.appendChild(value);
    trigger.insertAdjacentHTML('beforeend', ARROW_SVG);

    /* 结构：<span.m3sel>[<span.m3sel-trigger>…</span><select 原样>]</span>
       先把 select 插进 wrap，再把 wrap 放到 select 原来的位置。 */
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(trigger);
    wrap.appendChild(sel);

    this.wrap = wrap;
    this.trigger = trigger;
    this.valueEl = value;
    this.menu = null;
    /* 上一帧看到的 value，用来兜住「程序里直接赋值但不派发 change」的情况 */
    this.lastValue = null;

    this.syncLabel();
    this.bind();
  }

  M3Select.prototype.bind = function () {
    var self = this;

    this.trigger.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (self.isDisabled()) return;
      if (self.menu) self.close();
      else self.open();
    });

    /* 原生 select 自己触发 change（键盘在其上操作、或我们派发的）→ 更新文字 */
    this.sel.addEventListener('change', function () { self.syncLabel(); });

    /* 编辑词书那四个下拉会用 innerHTML 整体重建 option，值也跟着换。
       盯 childList 就能在重建后立刻把 trigger 的文字刷新。 */
    if (window.MutationObserver) {
      this.obs = new MutationObserver(function () { self.syncLabel(); });
      this.obs.observe(this.sel, { childList: true });
    }

    /* 兜底：app.js 有几处是「直接 el.selBatch.value = '50'」这样赋值而不派发
       change 的。没有这一条，trigger 上会一直显示旧文字。
       间隔取 200ms —— 只读一次 value 字符串，开销可以忽略； */
    this.timer = window.setInterval(function () {
      if (self.sel.value !== self.lastValue) self.syncLabel();
    }, 200);

    /* 菜单开着时，页面滚动 / 尺寸变化就让菜单跟着关掉。
       菜单是 fixed 定位、不跟随 trigger 滚动，硬要跟随得每帧同步位置，
       不如直接关掉 —— 系统原生下拉在滚动时也是这个行为。 */
    this.onScroll = function () { if (self.menu) self.close(); };
    window.addEventListener('scroll', this.onScroll, NATIVE_OPTS);
    window.addEventListener('resize', this.onScroll);
  };

  M3Select.prototype.isDisabled = function () {
    return !!this.sel.disabled;
  };

  /** 取当前选中项的文字，写进 trigger；同时同步禁用态 */
  M3Select.prototype.syncLabel = function () {
    var sel = this.sel;
    var idx = sel.selectedIndex;
    var opt = idx >= 0 ? sel.options[idx] : null;
    /* 没有选中项时退回第一个非空的，避免 trigger 一片空白 */
    if (!opt && sel.options.length) opt = sel.options[0];
    this.valueEl.textContent = opt ? (opt.textContent || '').trim() : '';
    this.lastValue = sel.value;

    var dis = this.isDisabled();
    this.wrap.classList.toggle('is-disabled', dis);
    this.trigger.setAttribute('aria-disabled', dis ? 'true' : 'false');
    this.trigger.disabled = dis;
    if (dis && this.menu) this.close();
  };

  /** 把菜单宽度对齐 trigger，并把纵向位置算出来 */
  M3Select.prototype.place = function () {
    var r = this.trigger.getBoundingClientRect();
    this.menu.style.width = r.width + 'px';
    this.menu.style.left = Math.round(r.left) + 'px';

    /* 先放上去量高度，再决定往上还是往下弹 */
    this.menu.style.top = '-9999px';
    var mh = this.menu.offsetHeight;
    var below = window.innerHeight - r.bottom;
    var above = r.top;
    var top;
    if (below >= mh + 8 || below >= above) {
      top = r.bottom + 4;                       // 往下弹
    } else {
      top = r.top - mh - 4;                     // 下面放不下，改往上弹
    }
    /* 夹在视口内，避免菜单跑出屏幕 */
    top = Math.max(8, Math.min(top, window.innerHeight - mh - 8));
    this.menu.style.top = Math.round(top) + 'px';
  };

  M3Select.prototype.buildMenu = function () {
    var self = this;
    var sel = this.sel;

    var menu = document.createElement('div');
    menu.className = 'm3sel-menu';
    menu.setAttribute('role', 'listbox');
    var menuId = 'm3sel-menu-' + (++M3Select.uid);
    menu.id = menuId;
    this.trigger.setAttribute('aria-controls', menuId);

    var opts = [];
    for (var i = 0; i < sel.options.length; i++) {
      var o = sel.options[i];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'm3sel-opt' + (o.selected ? ' is-selected' : '') +
        (o.disabled ? ' is-disabled' : '');
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', o.selected ? 'true' : 'false');
      b.dataset.index = String(i);

      b.insertAdjacentHTML('beforeend', CHECK_SVG);
      var t = document.createElement('span');
      t.className = 'm3sel-opt-text';
      t.textContent = (o.textContent || '').trim();
      b.appendChild(t);

      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (this.classList.contains('is-disabled')) return;
        self.choose(parseInt(this.dataset.index, 10));
      });
      /* 菜单内的滚轮不要传到页面上去 */
      b.addEventListener('wheel', function (e) { e.stopPropagation(); });

      menu.appendChild(b);
      opts.push(b);
    }

    this.menu = menu;
    this.options = opts;
    document.body.appendChild(menu);
  };

  /** 选中第 i 项：写回原生 select，派发 change，让 app.js 照常收到 */
  M3Select.prototype.choose = function (i) {
    var sel = this.sel;
    if (!(i >= 0 && i < sel.options.length)) return;
    if (sel.selectedIndex !== i) {
      sel.selectedIndex = i;
      /* 派发原生 change：app.js 的监听器（selRequeue / selBatch / editX）
         就是靠这个跑起来的，所以这一步不能省。 */
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    this.syncLabel();
    this.close();
    this.trigger.focus();
  };

  M3Select.prototype.open = function () {
    if (this.menu) return;
    if (openInstance && openInstance !== this) openInstance.close();
    openInstance = this;

    this.buildMenu();
    this.wrap.classList.add('is-open');
    this.trigger.setAttribute('aria-expanded', 'true');
    this.place();

    /* 把当前选中项滚进视野，长列表（编辑词书的列名）尤其需要 */
    var cur = null;
    for (var i = 0; i < this.options.length; i++) {
      if (this.options[i].classList.contains('is-selected')) { cur = this.options[i]; break; }
    }
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });

    /* 点页面其它地方 / 按 Esc 关闭。用捕获阶段，保证在别人的 handler 之前收到。 */
    this.onDocClick = function (e) {
      if (!this.menu) return;
      if (this.menu.contains(e.target) || this.wrap.contains(e.target)) return;
      this.close();
    }.bind(this);
    this.onKey = function (e) {
      if (e.key === 'Escape') { e.preventDefault(); this.close(); this.trigger.focus(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.move(e.key === 'ArrowDown' ? 1 : -1);
      }
    }.bind(this);

    /* 延后一拍再挂，避免「打开菜单的那一次点击」立刻又把它关掉 */
    window.setTimeout(function () {
      document.addEventListener('pointerdown', this.onDocClick, true);
    }.bind(this), 0);
    document.addEventListener('keydown', this.onKey, true);
  };

  /** 上下键在菜单项之间移动（跳过禁用项） */
  M3Select.prototype.move = function (step) {
    if (!this.options || !this.options.length) return;
    var n = this.options.length;
    var i = this.sel.selectedIndex;
    for (var k = 0; k < n; k++) {
      i = (i + step + n) % n;
      if (!this.options[i].classList.contains('is-disabled')) {
        this.choose(i);
        this.open();   // choose 会关掉菜单，键盘操作要保持展开
        return;
      }
    }
  };

  M3Select.prototype.close = function () {
    if (!this.menu) return;
    this.menu.remove();
    this.menu = null;
    this.options = null;
    this.wrap.classList.remove('is-open');
    this.trigger.setAttribute('aria-expanded', 'false');
    if (this.onDocClick) document.removeEventListener('pointerdown', this.onDocClick, true);
    if (this.onKey) document.removeEventListener('keydown', this.onKey, true);
    if (openInstance === this) openInstance = null;
  };

  M3Select.uid = 0;

  /* ---------------- 接管页面里所有的 <select> ----------------
     不限于那两个设置项：编辑词书弹窗里还有四个列映射下拉，
     它们同样是原生弹出层，不改的话会在这套无描边 M3 界面里显得很突兀。 */
  function upgradeAll(root) {
    var list = (root || document).querySelectorAll('select');
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (s.dataset.m3select === '1') continue;   // 已经接管过
      if (s.hasAttribute('data-native-select')) continue;
      s.dataset.m3select = '1';
      new M3Select(s);
    }
  }

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  ready(function () {
    upgradeAll(document);
    /* 编辑词书弹窗里的下拉是页面里写好的静态元素，不需要再监听新增节点；
       但万一将来有动态插入的 select，这里能自动接住。 */
    if (window.MutationObserver) {
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n.nodeType !== 1) continue;
            if (n.tagName === 'SELECT') upgradeAll(n.parentNode || document);
            else if (n.querySelector) upgradeAll(n);
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    }
  });
})();
