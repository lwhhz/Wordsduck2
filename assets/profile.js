/* ============================================================
   单词卡 · 自定义模块（头像 / 用户名称 / 个性签名）
   ------------------------------------------------------------
   为什么单独一个文件：
     这三项是新增功能，app.js 里没有对应逻辑。而 app.js 是一份闭合的
     IIFE（既没暴露 show()，也没暴露它的存取函数），所以新功能的读写
     与渲染都在这里自管，尽量不去碰 app.js 的行为。

   两个绕不开的坑，这里都避开了：
     1) 不能存进 danci.settings.v1。那是 app.js 的 settings，它的
        loadSettings() 只回填它认识的字段（白名单），自定义项一刷新
        就会被丢掉。所以这里单开一个键 danci.profile.v1。
     2) #brandSub 不是一块静态文案。app.js 在每轮开背时会把它改写成
        「第 N 轮 · M 本词书」（见 app.js 的 startRound），所以签名
        不能把它 textContent 清掉 —— 那样会连带弄丢轮次信息。
        做法：把 app.js 每次写进来的文字存进 data-app-text 备着，
        有签名时用 CSS 换成签名显示，没签名时照旧显示轮次信息。

   数据形状（danci.profile.v1）：
     { name: string, sign: string, avatar: string, photo: string }
     avatar 是预设字符（'词' 等），photo 是压缩后的 data URL；
     两者同时有值时以 photo 为准。
   ============================================================ */
(function () {
  'use strict';

  var LS_PROFILE = 'danci.profile.v1';
  var MAX_NAME = 16;
  var MAX_SIGN = 40;
  var PHOTO_SIZE = 256;      // 头像压到 256×256，够清晰，体积可控
  var PHOTO_QUALITY = 0.85;

  var PRESETS = ['词', '学', '书', '拼', '语', '星'];

  /* 主题色预设。
     sw 只是色板上那颗圆点的颜色（浅/深色下都能看清的那个值），
     真正的换肤靠 style.css 里的 html[data-theme="…"] 覆盖 --md-primary 一族
     —— 页面里所有强调色都走那些令牌，所以换个主题是全站生效的。
     'default' 表示不覆盖，用样式表里的原始蓝色。 */
  var THEMES = [
    { id: 'default', label: '默认蓝', sw: '#0b57d0' },
    { id: 'teal',    label: '青色',   sw: '#0f7f84' },
    { id: 'green',   label: '绿色',   sw: '#146c2e' },
    { id: 'yellow',  label: '黄色',   sw: '#8a7600' },
    { id: 'orange',  label: '橙色',   sw: '#a35f0a' },
    { id: 'purple',  label: '紫色',   sw: '#6750a4' },
    { id: 'pink',    label: '粉色',   sw: '#8e4585' }
  ];
  var THEME_IDS = THEMES.map(function (t) { return t.id; });

  /* 外观模式：跟随系统 / 强制亮 / 强制暗。
     值会被写进 <html data-scheme="…">，样式表里 1.9b 那两块据此覆盖深色令牌。
     auto 时把属性摘掉，交回给 prefers-color-scheme 媒体查询 ——
     和主题色那边「default 就删属性」是同一套思路，避免再抄一份默认值。 */
  var MODES = ['auto', 'light', 'dark'];

  /* 默认值就是词书库顶栏第一眼看到的内容：
       name = 大号标题（用户名称）
       sign = 小一号的副标题（个性签名）
     两者都可改，改完存在 danci.profile.v1 里。
     注意 sign 不再是空串 —— 空串会让顶栏只剩一行大标题，
     而顶栏是按「两行」设计的（见 style.css 的 .library-hero）。 */
  var DEFAULTS = {
    name: '你好！',
    sign: '你的学习口号是...',
    /* avatar 留空 = 用项目里的 logo.png 当默认头像（见 paintAvatar 的第三种情况）。
       留 '词' 的话那个字会盖过 logo，就看不到 logo 了。
       PRESETS 里仍然保留「词」，用户主动选它就能换回那个字。 */
    avatar: '',
    photo: '',
    theme: 'default',
    /* 外观模式默认跟随系统 */
    mode: 'auto'
  };

  var P = null;   // 当前生效的档案

  function $(id) { return document.getElementById(id); }

  /* ---------------- 读写 ---------------- */
  function clean(s, max) {
    return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
  }

  function load() {
    var out = {
      name: DEFAULTS.name, sign: DEFAULTS.sign, avatar: DEFAULTS.avatar,
      photo: DEFAULTS.photo, theme: DEFAULTS.theme, mode: DEFAULTS.mode
    };
    var raw = null;
    try { raw = localStorage.getItem(LS_PROFILE); } catch (e) {}
    if (!raw) return out;
    try {
      var d = JSON.parse(raw);
      if (!d || typeof d !== 'object') return out;
      // 名称留空就退回默认；头像必须落在预设集合里，防止外部文件塞进怪东西
      out.name = clean(d.name, MAX_NAME) || DEFAULTS.name;
      out.sign = clean(d.sign, MAX_SIGN);
      out.avatar = PRESETS.indexOf(clean(d.avatar, 4)) >= 0 ? clean(d.avatar, 4) : DEFAULTS.avatar;
      out.photo = typeof d.photo === 'string' && /^data:image\//.test(d.photo) ? d.photo : '';
      // 主题同样只认白名单里的值
      var th = clean(d.theme, 16);
      out.theme = THEME_IDS.indexOf(th) >= 0 ? th : DEFAULTS.theme;
      // 外观模式也走白名单，防止存进来看不懂的值
      var md = clean(d.mode, 8);
      out.mode = MODES.indexOf(md) >= 0 ? md : DEFAULTS.mode;
    } catch (e) {}
    return out;
  }

  function save() {
    try {
      localStorage.setItem(LS_PROFILE, JSON.stringify(P));
      return true;
    } catch (e) {
      return false;
    }
  }

  function saveSoon() {
    clearTimeout(saveSoon._t);
    saveSoon._t = setTimeout(function () {
      if (!save()) {
        var tip = $('profileTip');
        if (tip) tip.textContent = '保存失败：本地存储可能已满，可以换一张小一点的照片。';
      }
    }, 300);
  }

  /* ---------------- 渲染 ---------------- */
  function applyBrand() {
    var name = document.querySelector('.brand-text h1');
    var nameNode = name || null;
    var sub = $('brandSub');
    var signEl = $('brandSign');
    var seal = document.querySelector('.brand-seal');

    if (nameNode) nameNode.textContent = P.name;

    /* #brandSub 与 #brandSign 是两个各自独立的元素，这里只切换谁显示。
       为什么不把签名塞进 #brandSub 里面：app.js 每开一轮背词都会执行
       el.brandSub.textContent = '第 N 轮 · M 本词书'，会把里面塞的东西
       连同节点一起抹掉。分开之后，app.js 的轮次信息只是被 CSS 收起，
       取消签名立刻就能看到它照旧更新，没有任何信息被销毁。

       注意这里**不再把 #brandSub 显示出来**（早先是 sub.hidden = !!P.sign）：
       词书库顶栏已改成参考图那种「大号用户名 + 一行签名」的两行排版，
       再挂一行「第 N 轮 · M 本词书」就成了第三行、小字也会有两条。
       签名由用户自己填，没填就只显示用户名 —— 与参考图一致。
       app.js 往 #brandSub 写的轮次信息没有丢，只是不再露在词书库页
       （背词页的 HUD 里本来就有「第 N 轮」，信息并不缺）。 */
    if (sub) sub.hidden = true;
    if (signEl) {
      signEl.hidden = !P.sign;
      if (P.sign) signEl.textContent = P.sign;
      else signEl.textContent = '';
    }
    if (seal) paintAvatar(seal, false);
  }

  /* 把头像画到一个圆形元素里：
     kind=true 时是表单里的「当前头像」预览（会带上 data-* 供样式判断），
     kind=false 时是页首品牌位那个圆。

     三种情况，优先级从高到低：
       1) P.photo  —— 用户上传的照片（压缩后的 data URL）
       2) P.avatar —— 用户选的预设字符
       3) 兜底     —— 项目根目录的 logo.png（缩放后放在 assets/ 里）
     第 3 种是本次加上的：默认头像不再是一个「词」字，而是那个便签 logo。
     实现上借用 has-photo 那条样式（background-size: cover 铺满圆形），
     所以走到第 3 种时也要加 has-photo 类、并清掉文字。 */
  var FALLBACK_LOGO = 'assets/logo-192.png';

  function paintAvatar(el, withRing) {
    if (!el) return;
    var useLogo = !P.photo && !P.avatar;
    if (P.photo) {
      el.style.backgroundImage = 'url("' + P.photo + '")';
      el.classList.add('has-photo');
      el.textContent = '';
    } else if (useLogo) {
      el.style.backgroundImage = 'url("' + FALLBACK_LOGO + '")';
      el.classList.add('has-photo');
      el.textContent = '';
    } else {
      el.style.backgroundImage = '';
      el.classList.remove('has-photo');
      el.textContent = P.avatar;
    }
    if (withRing) el.dataset.kind = (P.photo || useLogo) ? 'photo' : 'preset';
  }

  /* 换肤：样式表里靠 html[data-theme="…"] 覆盖 M3 主色令牌，
     这里只负责把属性挂上去 / 摘下来。选「默认蓝」时把属性删掉，
     让它回落到样式表 :root 里的原始蓝色（而不是再写一份重复的值）。 */
  function applyTheme() {
    var root = document.documentElement;
    var th = THEME_IDS.indexOf(P.theme) >= 0 ? P.theme : DEFAULTS.theme;
    if (th === 'default') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', th);

    var box = $('themeSwatches');
    if (!box) return;
    var btns = box.querySelectorAll('.theme-swatch');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].dataset.themeName === th;
      btns[i].classList.toggle('is-on', on);
      btns[i].setAttribute('aria-checked', on ? 'true' : 'false');
      btns[i].tabIndex = on ? 0 : -1;
    }
  }

  // 一次性把色板按钮建出来（页面里不需要硬写 7 个按钮）
  function buildThemeSwatches() {
    var box = $('themeSwatches');
    if (!box || box.firstChild) return;
    THEMES.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'theme-swatch';
      b.dataset.themeName = t.id;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.setAttribute('aria-label', t.label);
      b.title = t.label;
      // 色板本体的颜色：浅/深色下都用一个中间值，保证圆点自己看得清
      b.style.setProperty('--sw', t.sw);
      b.addEventListener('click', function () {
        P.theme = t.id;
        // 必须连 applyForm 一起调：它负责刷新「恢复默认」按钮的可点状态。
        // 只调 applyTheme 的话，换完主题按钮还是灰的，换肤就退不回去。
        applyTheme();
        applyForm();
        saveSoon();
      });
      box.appendChild(b);
    });
  }

  function applyForm() {
    var name = $('profileName');
    var sign = $('profileSign');
    var cur = $('profileAvatar');
    if (name && name.value !== P.name) name.value = P.name;
    if (sign && sign.value !== P.sign) sign.value = P.sign;
    if (cur) paintAvatar(cur, true);

    var presets = document.querySelectorAll('#profilePresets .avatar-preset');
    for (var i = 0; i < presets.length; i++) {
      var on = !P.photo && presets[i].dataset.ch === P.avatar;
      presets[i].classList.toggle('is-on', on);
      presets[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    var reset = $('btnAvatarReset');
    // 「恢复默认」要覆盖这个模块的**全部六项**，所以只要有一项不是默认值就该可点。
    // 早先这里只判断了头像（!P.photo && P.avatar === DEFAULTS.avatar），
    // 结果「只改了主题色」时按钮是灰的，点不动 —— 换肤就退不回去了。
    // mode（外观模式）同理：只改它而不改别的时，也必须能点恢复。
    if (reset) {
      reset.disabled = !P.photo &&
        P.avatar === DEFAULTS.avatar &&
        P.name === DEFAULTS.name &&
        P.sign === DEFAULTS.sign &&
        P.theme === DEFAULTS.theme &&
        P.mode === DEFAULTS.mode;
    }

    var tip = $('profileTip');
    if (tip) tip.textContent = '改动即时保存，只存在本机浏览器里。';
  }

  /* 外观模式：把 <html data-scheme> 挂上 / 摘掉，并同步滑块状态。
     auto 时**删掉属性**而不是写 data-scheme="auto" ——
     样式表里没有这个选择器，删掉就回落到 prefers-color-scheme 媒体查询，
     默认行为只维护一处。 */
  function applyScheme() {
    var root = document.documentElement;
    var md = MODES.indexOf(P.mode) >= 0 ? P.mode : DEFAULTS.mode;
    if (md === 'auto') root.removeAttribute('data-scheme');
    else root.setAttribute('data-scheme', md);

    syncSchemeControls(md);
    reportDarkMode();

    var box = $('schemeSlider');
    if (!box) return;
    box.dataset.mode = md;
  }

  /* 同步滑块的选中态 / Tab 停靠 */
  function syncSchemeControls(md) {
    var box = $('schemeSlider');
    if (!box) return;
    var opts = box.querySelectorAll('.mode-opt');
    for (var i = 0; i < opts.length; i++) {
      var on = opts[i].dataset.scheme === md;
      opts[i].setAttribute('aria-checked', on ? 'true' : 'false');
      /* 只让选中的那一档进 Tab 顺序 —— 这是 role="radiogroup" 的惯例：
         整组只有一个 tab 停靠点，组内用方向键切换。
         这里没实现方向键（鼠标/触摸为主），但至少不要把三个都塞进 Tab 顺序。 */
      opts[i].tabIndex = on ? 0 : -1;
    }
  }

  /* 把「当前实际是深色还是浅色」告诉原生（APK 里的状态栏要用它决定图标明暗）。
     为什么不能靠原生自己读系统：滑块可以选「亮色」而系统是深的 ——
     此时页面是亮的，但系统状态栏会按系统配置画浅色图标，亮底上就看不见了。
     所以真正的明暗只有这里知道。网页版没有这个桥接对象，typeof 判断后直接跳过。 */
  function reportDarkMode() {
    var dark;
    var m = MODES.indexOf(P.mode) >= 0 ? P.mode : DEFAULTS.mode;
    if (m === 'dark') dark = true;
    else if (m === 'light') dark = false;
    else {
      /* auto：问系统。用 media query 而不是看 data-scheme，
         因为 auto 时属性是删掉的。 */
      dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }
    try {
      if (window.AndroidTTS && typeof window.AndroidTTS.setDarkMode === 'function') {
        window.AndroidTTS.setDarkMode(dark ? '1' : '0');
      }
    } catch (e) { /* 桥接调用失败不影响页面本身 */ }
  }

  function applyAll() {
    applyTheme();
    applyScheme();
    applyBrand();
    applyForm();
  }

  /* ---------------- 照片：压到 256×256 的正方形，避免塞爆 localStorage ----------------
     WEB_ONLY：APK 里**不**走这条路。

     APK 里选完图之后，原生会先弹系统裁剪器让用户拉一个 1:1 的框，再把裁好的
     图压到 256×256 通过 window.onNativeCroppedAvatar 推回来。
     此时 <input type=file> 那次选择会被原生用空数组收尾，下面的 change
     handler 因为拿不到文件而直接 return —— 正好不会覆盖原生送来的结果。
     所以同一个文件框，网页版走客户端裁切、APK 走系统裁剪器，两条路互不干扰。 */
  function readPhoto(file, done) {
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        try {
          var side = Math.min(img.width, img.height);      // 居中裁成正方形
          var sx = (img.width - side) / 2;
          var sy = (img.height - side) / 2;
          var cv = document.createElement('canvas');
          cv.width = cv.height = PHOTO_SIZE;
          var ctx = cv.getContext('2d');
          ctx.drawImage(img, sx, sy, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
          done(cv.toDataURL('image/jpeg', PHOTO_QUALITY));
        } catch (e) {
          done(null);
        }
      };
      img.onerror = function () { done(null); };
      img.src = String(reader.result || '');
    };
    reader.onerror = function () { done(null); };
    reader.readAsDataURL(file);
  }

  /* 把一张照片应用为头像：写进档案 → 重画 → 存盘。 */
  function applyPhoto(dataUrl) {
    P.photo = dataUrl;
    applyAll();
    saveSoon();
  }

  /* ---------------- 事件 ---------------- */
  function wire() {
    var name = $('profileName');
    var sign = $('profileSign');
    var file = $('profilePhoto');
    var pick = $('btnAvatarPick');
    var reset = $('btnAvatarReset');

    if (name) {
      name.addEventListener('input', function () {
        P.name = clean(name.value, MAX_NAME) || DEFAULTS.name;
        applyBrand();
        applyForm();   // 让「恢复默认」跟着变成可点
        saveSoon();
      });
      // 失焦时把规范化后的值写回去（去掉首尾空格等）
      name.addEventListener('blur', function () { name.value = P.name; });
    }

    if (sign) {
      sign.addEventListener('input', function () {
        P.sign = clean(sign.value, MAX_SIGN);
        applyBrand();
        applyForm();   // 让「恢复默认」跟着变成可点
        saveSoon();
      });
      sign.addEventListener('blur', function () { sign.value = P.sign; });
    }

    var presets = document.querySelectorAll('#profilePresets .avatar-preset');
    for (var i = 0; i < presets.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          P.avatar = btn.dataset.ch;
          P.photo = '';
          applyAll();
          saveSoon();
        });
      })(presets[i]);
    }

    if (pick && file) {
      pick.addEventListener('click', function () { file.click(); });
      file.addEventListener('change', function () {
        var f = file.files && file.files[0];
        file.value = '';
        if (!f) return;
        /* APK 里这条路是「空的」：原生会在拿到图后先弹系统裁剪器，
           裁完再通过 window.onNativeCroppedAvatar 把结果推回来。
           而这里之所以能安全地 return，是因为原生收尾时回的是**空数组**，
           上面的 f 就是 undefined。见 readPhoto 上方的说明。 */
        readPhoto(f, function (data) {
          if (!data) {
            var tip = $('profileTip');
            if (tip) tip.textContent = '这张图片读不出来，换一张试试（支持 png / jpg）。';
            return;
          }
          applyPhoto(data);
        });
      });
    }

    /* 原生裁剪完成的回调。原生侧用 evaluateJavascript 调它，
       并传一个已经压到 256×256 的 JPEG data URL。
       定义成全局而不是内部函数 —— 原生只能按名字调 window 上的东西。 */
    window.onNativeCroppedAvatar = function (dataUrl) {
      if (typeof dataUrl !== 'string' || !/^data:image\//.test(dataUrl)) return;
      applyPhoto(dataUrl);
    };

    /* ---- 外观模式滑块：三个档位各绑一次 click ----
       用 click 而不是 change：这是三个 <button>，不是原生 radio。
       click 同时也是键盘回车 / 空格的激活方式，两处行为自然统一。 */
    var schemeBox = $('schemeSlider');
    if (schemeBox) {
      var schemeOpts = schemeBox.querySelectorAll('.mode-opt');
      for (var si = 0; si < schemeOpts.length; si++) {
        schemeOpts[si].addEventListener('click', function () {
          var v = this.dataset.scheme;
          P.mode = MODES.indexOf(v) >= 0 ? v : DEFAULTS.mode;
          applyScheme();
          applyForm();     // 让「恢复默认」跟着变成可点
          saveSoon();
        });
      }
    }

    if (reset) {
      reset.addEventListener('click', function () {
        P = {
          name: DEFAULTS.name, sign: DEFAULTS.sign, avatar: DEFAULTS.avatar,
          photo: DEFAULTS.photo, theme: DEFAULTS.theme, mode: DEFAULTS.mode
        };
        applyAll();
        /* applyAll() 只重画顶栏和主题，不会回写输入框 ——
           少了这一句，点「恢复默认」之后顶栏变了、输入框里还留着旧值，
           看起来像没生效（而且再改一下别处就会把旧值又存回去）。
           applyForm() 会把 name / sign 输入框、头像预览、预设选中态、
           以及「恢复默认」按钮自身的可用状态一起同步。 */
        applyForm();
        saveSoon();
      });
    }
  }

  /* ---------------- 启动 ---------------- */
  /* 系统明暗变化时，若当前是「跟随系统」，要重新报告一次：
     页面颜色会被 CSS 媒体查询自动切过去，但**原生状态栏**不会自己知道，
     得我们再说一声。选亮/暗档位时这个监听没影响（reportDarkMode 不看系统）。 */
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onMq = function () { reportDarkMode(); };
    if (mq.addEventListener) mq.addEventListener('change', onMq);
    else if (mq.addListener) mq.addListener(onMq);   // 老 WebView 走这条
  }

  P = load();
  buildThemeSwatches();
  wire();
  applyAll();
})();
