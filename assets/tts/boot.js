/* 网页内置语音包 —— 资源装载器（自动生成文件，请勿手工修改；生成脚本：build-tts.cjs）
 *
 * 为什么长这样：
 *   页面跑在 file:// 下，fetch / XHR / Worker / 模块化 <script src> 都取不到本地文件
 *   （Chromium 实测：只有「经典 <script src>」与「inline module」可用）。
 *   因此所有二进制都以 base64 文本内嵌成 .js，逐个用经典 <script> 载入；
 *   每个分片落地的瞬间就解码写进预分配的 Uint8Array，随即丢掉 base64 字符串，
 *   让内存峰值 = 资源总量 + 一个分片，而不是资源总量 × 2。
 *
 * 音色按需装载：
 *   启动先装「核心（wasm/glue/配置）」，再装音色；切到别的音色时再补装，
 *   装完就能用；装载队列串行执行，避免 <script> 交叉插入打乱顺序。
 *
 * 对外接口（window.WCTTS）：
 *   state()           -> 'idle' | 'loading' | 'ready' | 'error'（核心 + 默认音色）
 *   progress()        -> 装载进度（含各音色进度 voices[id]）
 *   voiceProgress(id) -> 单个音色的装载进度
 *   voices()          -> [{ id, label, name, state, bytes, ratio }]
 *   currentVoice()    -> 当前主音色 id
 *   loadVoice(id)     -> Promise，按需装载指定音色
 *   whenReady()       -> Promise（核心 + 默认音色就绪；失败 reject）
 *   bytes(name)       -> Uint8Array，name ∈ ortwasm | phenwasm | phendata | voice_gb
 *   release(name)     -> 让出内存（数据已被推理引擎拷进自己的堆，之后不再需要）
 *   config(id)        -> 音色配置：采样率 / 推理参数 / 音素-编号表
 *   glueB64()         -> 改写过的 ort emscripten glue（base64，运行时转 Blob 后动态 import）
 *   onProgress(fn) / start()
 */
(function (W, D) {
  'use strict';

  var CHUNK = 6291456;
  var SIZES = {"ortwasm":11210254,"phenwasm":635212,"phendata":986700,"voice_gb":114219352};
  var CORE = ["ort.wasm.min.js","piper_phonemize.js","chunks/ortglue.js","chunks/ortwasm.00.js","chunks/ortwasm.01.js","chunks/phenwasm.00.js","chunks/phendata.00.js","voice-config.js"];
  var CORE_BYTES = 12832166;
  var VOICES = {
    "gb": { label: "英音（en_GB-cori-high）", name: "voice_gb", files: ["chunks/voice_gb.00.js","chunks/voice_gb.01.js","chunks/voice_gb.02.js","chunks/voice_gb.03.js","chunks/voice_gb.04.js","chunks/voice_gb.05.js","chunks/voice_gb.06.js","chunks/voice_gb.07.js","chunks/voice_gb.08.js","chunks/voice_gb.09.js","chunks/voice_gb.10.js","chunks/voice_gb.11.js","chunks/voice_gb.12.js","chunks/voice_gb.13.js","chunks/voice_gb.14.js","chunks/voice_gb.15.js","chunks/voice_gb.16.js","chunks/voice_gb.17.js","chunks/voice_gb.18.js"] }
  };
  var DEFAULT_VOICE = "gb";

  /* 资源目录：从自己的 src 推出来，页面放在哪一层都不用改 */
  var BASE = '';
  var self = D.currentScript;
  if (self && self.src) BASE = self.src;
  if (!BASE) {
    var all = D.getElementsByTagName('script');
    for (var i = all.length - 1; i >= 0; i--) {
      if (all[i].src && all[i].src.indexOf('boot.js') >= 0) { BASE = all[i].src; break; }
    }
  }
  BASE = String(BASE || '').replace(/[?#][\s\S]*$/, '').replace(/[^\/]*$/, '');

  var st = {
    state: 'idle',                       /* 核心 + 默认音色 */
    loaded: 0,
    total: CORE.length + VOICES[DEFAULT_VOICE].files.length,
    loadedBytes: 0,
    totalBytes: CORE_BYTES + SIZES[VOICES[DEFAULT_VOICE].name],
    msDecode: 0,
    t0: 0,
    error: null,
    glue: '',
    cfgs: {},
    voice: DEFAULT_VOICE,
    charge: ''                           /* 当前分片记到哪个音色的账上（'' = 核心/默认音色） */
  };
  var bufs = {};
  var waits = [];
  var subs = [];
  var vst = {};

  (function () {
    for (var id in VOICES) {
      if (!Object.prototype.hasOwnProperty.call(VOICES, id)) continue;
      vst[id] = {
        id: id,
        label: VOICES[id].label,
        name: VOICES[id].name,
        state: 'idle',
        loaded: 0,
        total: VOICES[id].files.length,
        loadedBytes: 0,
        totalBytes: SIZES[VOICES[id].name],
        error: null,
        waiters: []
      };
    }
  })();

  function vpub(v) {
    return {
      id: v.id, label: v.label, name: v.name, state: v.state,
      loaded: v.loaded, total: v.total,
      loadedBytes: v.loadedBytes, totalBytes: v.totalBytes,
      ratio: v.totalBytes ? v.loadedBytes / v.totalBytes : 0,
      error: v.error
    };
  }

  function progress() {
    var voices = {};
    for (var id in vst) { if (Object.prototype.hasOwnProperty.call(vst, id)) voices[id] = vpub(vst[id]); }
    return {
      phase: st.state === 'ready' ? 'ready' : 'core',
      loaded: st.loaded,
      total: st.total,
      loadedBytes: st.loadedBytes,
      totalBytes: st.totalBytes,
      msDecode: st.msDecode,
      msElapsed: st.t0 ? (+new Date()) - st.t0 : 0,
      ratio: st.totalBytes ? st.loadedBytes / st.totalBytes : 0,
      voice: st.voice,
      voices: voices
    };
  }

  function emit() {
    if (!subs.length) return;
    var p = progress();
    for (var i = 0; i < subs.length; i++) { try { subs[i](p, st.state); } catch (e) {} }
  }

  var WCTTS = W.WCTTS = {
    state: function () { return st.state; },
    progress: progress,
    voiceProgress: function (id) { return vst[id] ? vpub(vst[id]) : null; },
    voices: function () {
      var out = [];
      for (var id in vst) { if (Object.prototype.hasOwnProperty.call(vst, id)) out.push(vpub(vst[id])); }
      return out;
    },
    currentVoice: function () { return st.voice; },
    error: function () { return st.error; },
    config: function (id) { return st.cfgs[id || st.voice] || null; },
    glueB64: function () { return st.glue; },
    bytes: function (name) { return bufs[name] || null; },
    release: function (name) { if (bufs[name]) { bufs[name] = null; delete bufs[name]; } },
    onProgress: function (fn) { if (typeof fn === 'function') { subs.push(fn); try { fn(progress(), st.state); } catch (e) {} } },
    whenReady: function () {
      if (st.state === 'ready') return Promise.resolve(WCTTS);
      if (st.state === 'error') return Promise.reject(new Error(st.error));
      return new Promise(function (res, rej) { waits.push({ ok: res, no: rej }); });
    },
    loadVoice: function (id) { return loadVoice(id); },
    start: function () { start(); },

    /* ↓ 仅供各分片脚本调用 */
    _glue: function (b64) { st.glue = b64; },
    _config: function (id, c) {
      if (c === undefined) { c = id; id = DEFAULT_VOICE; }   /* 兼容单参写法 */
      if (id) st.cfgs[id] = c;
    },
    _blit: function (name, index, b64) {
      var total = SIZES[name];
      if (total === undefined) throw new Error('未声明的资源: ' + name);
      var buf = bufs[name];
      if (!buf) buf = bufs[name] = new Uint8Array(total);   /* 独占 ArrayBuffer，长度精确 */
      var off = index * CHUNK;
      var t = +new Date();
      var bin = W.atob(b64);
      var n = bin.length;
      if (off + n > total) n = total - off;
      for (var i = 0; i < n; i++) buf[off + i] = bin.charCodeAt(i);
      st.msDecode += (+new Date()) - t;
      var v = st.charge && vst[st.charge];
      if (v) v.loadedBytes += n; else st.loadedBytes += n;
      return n;
    }
  };

  function settle(kind, errOrRes) {
    if (st.state === 'ready' || st.state === 'error') return;
    st.state = kind;
    if (kind === 'error') st.error = String(errOrRes);
    emit();
    var w = waits; waits = [];
    for (var i = 0; i < w.length; i++) { try { kind === 'ready' ? w[i].ok(WCTTS) : w[i].no(new Error(st.error)); } catch (e) {} }
  }

  /* 串行装载队列：start() 与 loadVoice() 都排在同一条链上，避免两条队列把
     <script> 交叉插进 <head>（虽然 async=false 会保序，但进度统计会串味）。 */
  var chain = Promise.resolve();
  function enqueue(task) {
    var run = chain.then(task, task);
    chain = run.then(function () {}, function () {});
    return run;
  }

  function loadSeq(list, onStep, onDone, onFail) {
    var i = 0;
    function next() {
      if (i >= list.length) { onDone(); return; }
      if (!D.head && !D.documentElement) { onFail('页面还没有 <head>，无法装载资源'); return; }
      var cur = i;
      var s = D.createElement('script');
      s.async = false;
      s.src = BASE + list[cur];
      s.onload = function () {
        /* 剥掉 <script> 节点，让 V8 有机会回收这一片 base64 的源码字符串 */
        if (s.parentNode) s.parentNode.removeChild(s);
        s = null;
        i = cur + 1;
        onStep(cur);
        next();
      };
      s.onerror = function () { onFail('资源装载失败: ' + list[cur]); };
      (D.head || D.documentElement).appendChild(s);
    }
    next();
  }

  function start() {
    if (st.state !== 'idle') return chain;
    st.state = 'loading';
    st.t0 = +new Date();
    st.charge = '';
    vst[DEFAULT_VOICE].state = 'loading';
    emit();
    var list = CORE.concat(VOICES[DEFAULT_VOICE].files);
    return enqueue(function () {
      return new Promise(function (res) {
        loadSeq(list, function (idx) {
          st.loaded = idx + 1;
          if (idx >= CORE.length) vst[DEFAULT_VOICE].loaded = idx - CORE.length + 1;
          emit();
        }, function () {
          vst[DEFAULT_VOICE].state = 'ready';
          vst[DEFAULT_VOICE].loaded = vst[DEFAULT_VOICE].total;
          settle('ready');
          res();
        }, function (msg) {
          vst[DEFAULT_VOICE].state = 'error';
          settle('error', msg);
          res();
        });
      });
    });
  }

  function loadVoice(id) {
    var v = vst[id];
    if (!v) return Promise.reject(new Error('未知音色: ' + id));
    if (v.state === 'ready') return Promise.resolve(WCTTS);
    if (v.state === 'error') return Promise.reject(new Error(v.error));
    return enqueue(function () {
      if (v.state === 'ready') return Promise.resolve(WCTTS);
      if (v.state === 'error') return Promise.reject(new Error(v.error));
      v.state = 'loading';
      st.charge = id;
      emit();
      return new Promise(function (res, rej) {
        loadSeq(VOICES[id].files, function (idx) {
          v.loaded = idx + 1;
          emit();
        }, function () {
          st.charge = '';
          v.state = 'ready';
          v.loaded = v.total;
          emit();
          var w = v.waiters; v.waiters = [];
          for (var i = 0; i < w.length; i++) { try { w[i].ok(WCTTS); } catch (e) {} }
          res(WCTTS);
        }, function (msg) {
          st.charge = '';
          v.state = 'error';
          v.error = String(msg);
          emit();
          var w = v.waiters; v.waiters = [];
          for (var i = 0; i < w.length; i++) { try { w[i].no(new Error(v.error)); } catch (e) {} }
          rej(new Error(v.error));
        });
      });
    });
  }

  /* 页面首屏优先：DOM 就绪后再等一小会儿才开始搬资源。
     调用方（tts-local.js）可以在用户提前点发音时直接 start() 抢先加载。 */
  function schedule() { W.setTimeout(start, 900); }
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', schedule);
  else schedule();
})(window, document);
