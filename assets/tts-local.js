/* 网页内置语音引擎（离线，完全不依赖系统 TTS）
 * ============================================================
 *  音素化  espeak-ng            -> assets/tts/piper_phonemize.js + 内嵌 wasm/data
 *  声学模型 Piper VITS (ONNX)   -> assets/tts/chunks/voice_gb.*.js  (en_GB-cori-high, fp32)
 *  推理后端 onnxruntime-web WASM -> assets/tts/ort.wasm.min.js + 内嵌 wasm
 *
 *  页面跑在 file:// 下，fetch / XHR / Worker / 模块化 <script src> 全部取不到本地文件，
 *  所以资源都在 assets/tts/boot.js 里以 base64 载入内存（详见该文件注释）。
 *
 *  合成出来的音频不会原样播出：先做时长校验与首尾静音裁剪，坏样本会被拒绝重采，
 *  见下面「采样质量控制」那段。缓存里存的也只会是校验、裁剪过的音频。
 *
 *  对外（window.WCTTSLocal）：
 *    state()      'idle' | 'loading' | 'ready' | 'error'
 *    ready()      是否已可用
 *    error()      失败原因（字符串）
 *    progress()   资源装载进度
 *    info()       音色名 / 采样率 / 已缓存条数 / 最近一条的体检数据
 *    tune(patch)  采样质量控制参数（时长预算、重采次数、静音阈值）读写
 *    clearCache() 清空音频缓存（自检用）
 *    poke()       立刻开始装载（不等 boot 的默认延时）
 *    synth(text)  Promise<Blob>，跳过播放直接拿音频，供离线自检用
 *    pcm(text, rate) Promise<{pcm:Float32Array, sampleRate:number}>
 *    engine       注册给 app.js 的引擎对象
 * ============================================================ */
(function (W, D) {
  'use strict';

  var NAME = 'en_GB-cori-high';
  var ESPEAK_DATA = '/espeak-ng-data';
  var MAX_CHARS = 200;          // 单次朗读文本上限，防呆
  var CACHE_MAX = 24;           // 音频缓存条数（每条约几十 KB）
  var READY_TITLE = '内置语音（离线，无需系统 TTS）';   // 就绪后发音按钮上的 title
  /* espeak 的 wasm 模块实例反复 callMain，到第 111 次左右必崩（与输入无关，堆内存也不涨），
     所以按调用次数留足余量重建实例：每 80 次换一个。 */
  var PHEN_MAX = 80;
  var PHEN_AHEAD = 12;          // 剩余额度低于这个数就提前在后台重建

  /* ---------- 采样质量控制 ----------
     VITS 的时长预测器是随机的（Piper 的 noise_w），同一个词每次采样出来的时长都不一样，
     而且尾巴很重：实测 "and" 在 3.3~9.5 秒之间乱跳（正常应该 0.5 秒左右），
     "the" 1.4~3.8 秒。采到这种坏样本就是「有时对有时错」的来源。
     模型随机源在 wasm 内部（JS 侧 Math.random / crypto 都没被调用），从页面里没法设种子，
     所以这里用「先验校验 + 拒绝重采 + 兜底压缩」来保证每条音频都可用：
       1) 正常采样（保留音色变化），时长落在这一句的预算内才收；
       2) 连续几次都超标就量出确定性基准时长（noise_w=0，时长完全可复现）；
       3) 基准本身也超标，说明这个音素序列就是模型的坏点，按预算把 length_scale 压下来
          确定性重采一次——听起来会比正常语速快一点，但不会再播出一段长拖音。
     另外推理结果一律做首尾静音裁剪，坏样本里那截长长的气息/静音不会再被播出来，
     缓存里存的也只会是裁剪、校验过的音频。 */
  var VITS_RETRY = 3;           // 自然采样最多试几次
  var W_DUR_CEIL = 0.22;        // 时长预算：每编号 220ms（正常词 40~120ms）
  var W_DUR_FLOOR = 1.8;        // 预算保底值（秒），短词别卡太死
  var W_DUR_HOPELESS = 2.2;     // 超过预算这么多倍就直接认命，不再浪费推理重采
  var W_DUR_BAD = 0.6;          // 压缩比低于这个值说明是模型的坏点，预算再收紧一档
  var W_DUR_TIGHT = 0.72;       // 坏点用的收紧系数
  var GAP_MAX = 0.22;           // 语音中间允许的最长静音（秒）：正常词实测都 < 70ms
  var TRIM_TH = 0.001;          // 静音判定阈值（-60dBFS）
  var TRIM_PAD = 0.025;         // 裁剪后两端各留 25ms
  var TRIM_KEEP_LOW = 0.08;     // 有声部分不足 8% 就当整条都是静音，不裁
  var TRIM_KEEP_PEAK = 0.02;    // 峰值太低也不裁，避免把气声削掉
  var SCALE_MIN = 0.25;         // length_scale 最多压到基准的 1/4
  var SCALE_MAX = 3;            // 也不会无限拉长
  var BASE_MAX = 512;           // 基准时长缓存条数（键是语速+编号序列，每条几十字节）
  var NOISE_W = null;           // 时长噪声强度（null = 用音色配置里的值），可用 WCTTS_TUNE.noiseW 覆盖

  var state = 'idle';
  var errMsg = '';
  var initPromise = null;

  var CFG = null;               // 音色配置
  var VOICE_BLOB = '';          // 当前音色对应的模型资源名（boot.js 里的 SIZES key）
  var ORT = null;               // onnxruntime-web
  var SESS = null;              // 推理会话
  var PHON = null;              // espeak-ng 模块实例
  var phonCalls = 0;            // 当前实例已经 callMain 过多少次
  var phenWasmBytes = null;     // 重建实例要用的 wasm / espeak 数据包（boot.js 里那份可以还掉，自己留一份）
  var phenDataAB = null;
  var phonBuilding = null;      // 正在重建时的 Promise，避免并发重复构建
  var SR = 22050;

  var PRINTQ = [];              // espeak stdout 收集
  var collecting = false;

  var A = null;                 // 复用的 <audio>
  var playSeq = 0;              // 每次朗读自增；异步结果回来时用它判断是否已被打断
  var playing = false;

  var cache = [];               // [{key, blob}] 简易 LRU
  var BASE = {};                // 编号序列 -> 基准时长体检结果（见 synthPcmChecked）
  var BAD_SEQ = {};             // 编号序列 -> 自然采样从来没达标的，记下来别再空采
  var BAD_MAX = 512;

  function log() {
    if (!W.console || !W.console.log) return;
    try { W.console.log.apply(W.console, ['[tts-local]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
  }
  function warn() {
    if (!W.console || !W.console.warn) return;
    try { W.console.warn.apply(W.console, ['[tts-local]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
  }

  /* ---------- 能力探测：任何一项不满足就彻底不掺和，让页面走原来的系统 TTS ---------- */
  function unsupportedReason() {
    if (!W.WCTTS) return 'assets/tts/boot.js 未加载';
    if (typeof W.WebAssembly !== 'object' || typeof W.WebAssembly.instantiate !== 'function') return '不支持 WebAssembly';
    if (typeof W.Blob !== 'function') return '不支持 Blob';
    if (!W.URL || typeof W.URL.createObjectURL !== 'function') return '不支持 Blob URL';
    if (typeof W.Promise !== 'function') return '不支持 Promise';
    if (typeof W.BigInt !== 'function') return '不支持 BigInt';
    if (typeof W.BigInt64Array !== 'function') return '不支持 BigInt64Array';
    if (typeof W.TextDecoder !== 'function') return '不支持 TextDecoder';
    if (typeof W.Audio !== 'function') return '不支持 Audio';
    return null;
  }

  /* 动态 import 必须能解析出来；用 new Function 包住，
     这样不支持的老引擎也不会因为 import() 语法把整个脚本解析掉。 */
  function makeDynImport() {
    try { return new Function('u', 'return import(u);'); } catch (e) { return null; }
  }

  /* ---------- 音素 -> 编号 ---------- */
  function idsFromPhones(phones, map) {
    var bos = map['^'], pad = map['_'], eos = map['$'];
    if (!bos || !pad || !eos) return null;
    var out = [bos[0], pad[0]];
    var missed = 0;
    for (var i = 0; i < phones.length; i++) {
      var c = phones.charAt(i);
      var cc = phones.charCodeAt(i);
      if (cc >= 0xD800 && cc <= 0xDBFF && i + 1 < phones.length) { c = phones.substr(i, 2); i++; }
      var e = map[c];
      if (!e) { missed++; continue; }
      out.push(e[0], pad[0]);
    }
    out.push(eos[0]);
    if (missed) warn('音素表缺少 ' + missed + ' 个字符的映射：' + phones);
    return out;
  }

  function onPrint(line) {
    if (!collecting) return;
    var o;
    try { o = JSON.parse(line); } catch (e) { return; }
    if (o && o.phonemes) PRINTQ.push(o);
  }

  /* ---------- 音素化器实例管理 ----------
     espeak 的 wasm 模块实例有调用次数上限：同一个实例反复 callMain，到第 111 次左右会直接
     abort（RuntimeError: memory access out of bounds / Aborted()），跟输入内容无关，
     堆内存也始终稳定在 16MB。所以按次数定期用同样的字节重建实例，并且崩了也能自愈。 */
  function newPhonemizer() {
    return W.createPiperPhonemize({
      noInitialRun: true,
      print: onPrint,
      printErr: function () {},
      wasmBinary: phenWasmBytes,
      getPreloadedPackage: function () { return phenDataAB; }
    });
  }

  function rebuildPhonemizer() {
    if (phonBuilding) return phonBuilding;
    var t = +new Date();
    phonBuilding = newPhonemizer().then(function (mod) {
      PHON = mod;                  // 新的好了才替换旧的，期间老的还能用
      phonCalls = 0;
      phonBuilding = null;
      log('音素化器已重建（用时 ' + (+new Date() - t) + ' ms）');
      return mod;
    }, function (e) {
      phonBuilding = null;         // 重建失败就保持原样，下次调用再试
      throw e;
    });
    return phonBuilding;
  }

  function ensurePhonemizer() {
    if (phonBuilding) return phonBuilding.then(function () { return PHON; });
    if (PHON && phonCalls < PHEN_MAX) return W.Promise.resolve(PHON);
    return rebuildPhonemizer();
  }

  function phonemize(text) {
    /* 额度快用完了就提前在后台重建一个，别等真崩了再补 */
    if (phonCalls >= PHEN_MAX - PHEN_AHEAD && !phonBuilding && phenWasmBytes) {
      try { rebuildPhonemizer().then(null, function () {}); } catch (e) {}
    }
    PRINTQ.length = 0;
    collecting = true;
    try {
      PHON.callMain(['-l', CFG.espeak_voice, '--input', JSON.stringify([{ text: text }]), '--espeak_data', ESPEAK_DATA]);
    } finally {
      collecting = false;
    }
    phonCalls++;
    var r = PRINTQ[0];
    if (!r) return null;
    return idsFromPhones(r.phonemes.join(''), CFG.phoneme_id_map);
  }

  /* ---------- VITS 推理 ---------- */
  /* nw 是时长预测器的噪声强度：给了就用它，没给（null）才用音色配置里那个随机值。
     设成 0 时同一条输入的时长完全确定，用来给每一句标一个「基准时长」。 */
  function runVits(ids, rate, nw, lsScale) {
    var n = ids.length;
    var seq = new BigInt64Array(n);
    for (var i = 0; i < n; i++) seq[i] = BigInt(ids[i]);
    var lens = new BigInt64Array(1);
    lens[0] = BigInt(n);
    var scales = new Float32Array(3);
    scales[0] = CFG.noise_scale;
    // speechSynthesis 的 rate 越大越快；Piper 的 length_scale 越大越慢，正好取倒数
    var ls = CFG.length_scale / (rate > 0.1 && rate < 4 ? rate : 1);
    if (lsScale) ls *= lsScale;
    scales[1] = ls;
    scales[2] = (nw === null || nw === undefined) ? tuneNoiseW() : nw;

    var feeds = {};
    feeds.input = new ORT.Tensor('int64', seq, [1, n]);
    feeds.input_lengths = new ORT.Tensor('int64', lens, [1]);
    feeds.scales = new ORT.Tensor('float32', scales, [3]);

    return SESS.run(feeds).then(function (res) {
      return res[SESS.outputNames[0]].data;     // Float32Array，[-1, 1]
    });
  }

  /* ---------- 音频校验与裁剪 ---------- */
  function tune() {
    var t = W.WCTTS_TUNE;
    return (t && typeof t === 'object') ? t : null;
  }
  function tuneNoiseW() {
    if (NOISE_W === null) {
      var t = tune();
      NOISE_W = (t && typeof t.noiseW === 'number') ? t.noiseW : CFG.noise_w;
    }
    return NOISE_W;
  }

  /* 结果：裁掉首尾静音；同时给出有声占比、最长内部静音等体检指标 */
  function polish(pcm) {
    var n = pcm.length;
    var i, v, peak = 0, voiced = 0;
    for (i = 0; i < n; i++) {
      v = pcm[i] < 0 ? -pcm[i] : pcm[i];
      if (v > peak) peak = v;
      if (v > TRIM_TH) voiced++;
    }
    var out = pcm, lead = 0, tail = n - 1, trimmed = 0;
    if (n && peak >= TRIM_KEEP_PEAK && voiced >= n * TRIM_KEEP_LOW) {
      while (lead < n && (pcm[lead] < 0 ? -pcm[lead] : pcm[lead]) <= TRIM_TH) lead++;
      while (tail > lead && (pcm[tail] < 0 ? -pcm[tail] : pcm[tail]) <= TRIM_TH) tail--;
      var pad = Math.round(TRIM_PAD * SR);
      var a = Math.max(0, lead - pad);
      var b = Math.min(n, tail + 1 + pad);
      trimmed = a + (n - b);
      if (b - a >= 512) out = pcm.subarray(a, b);   // 裁完太短就保持原样
    }
    // 最长内部静音：坏样本常常是「语音 + 一长段空白 + 语音」
    var runs = 0, cur = 0, maxGap = 0, from = 0, to = out.length - 1;
    while (from <= to && (out[from] < 0 ? -out[from] : out[from]) <= TRIM_TH) from++;
    while (to > from && (out[to] < 0 ? -out[to] : out[to]) <= TRIM_TH) to--;
    for (i = from; i <= to; i++) {
      v = out[i] < 0 ? -out[i] : out[i];
      if (v <= TRIM_TH) { cur++; if (cur > maxGap) maxGap = cur; }
      else { if (cur) { runs++; cur = 0; } }
    }
    return {
      pcm: out, leadMs: lead / SR * 1000, trimmedMs: trimmed / SR * 1000,
      voicedRatio: n ? voiced / n : 0, peak: peak,
      maxGapMs: maxGap / SR * 1000, gapRuns: runs,
      fullMs: n / SR * 1000, ms: out.length / SR * 1000
    };
  }

  function durCapMs(ids) { return Math.max(W_DUR_FLOOR * 1000, ids * W_DUR_CEIL * 1000); }

  /* 音素序列的指纹：音素化是确定性的，同一个词每次拿到的编号序列都一样，
     所以可以用它记住「这一句的自然采样从来不达标」，省掉注定失败的推理。 */
  function seqKey(ids) { return ids.join(','); }

  /* 一条样本能不能用：整体别太长（模型坏点会拖到好几秒），
     中间也不能有一大段空白（用户描述的「多吐一长段气息或静音」） */
  function acceptable(p, cap) { return p.fullMs <= cap && p.maxGapMs <= GAP_MAX * 1000; }

  /* ---------- 一次性把音符合成到可用音频：校验 -> 重采 -> 兜底压缩 -> 裁剪 ---------- */
  var lastStats = null;
  function synthPcmChecked(text, rate) {    return ensurePhonemizer().then(function () {
      var ids;
      try {
        ids = phonemize(text);
      } catch (e) {
        /* 音素化器崩了（wasm abort）：丢掉这个实例，重建后重试一次 */
        warn('音素化器异常，重建后重试：' + ((e && e.message) ? e.message : e));
        PHON = null;
        phonCalls = 0;
        return ensurePhonemizer().then(function () {
          var ids2 = phonemize(text);
          if (!ids2 || ids2.length < 3) throw new Error('无法合成：' + text);
          return build(ids2, text);
        });
      }
      if (!ids || ids.length < 3) throw new Error('无法合成：' + text);
      return build(ids, text);
    });

    function build(ids, label) {
      var cap = durCapMs(ids.length);
      var stats = { text: label, ids: ids.length, capMs: cap, tries: 0, probeMs: 0, picked: '', finalMs: 0, trimMs: 0, maxGapMs: 0, rejected: 0 };

      /* 先自然采一次：绝大多数词这一下就过，过的就是带音色变化的自然样本 */
      return runVits(ids, rate).then(function (pcm) {
        stats.tries++;
        var p = polish(pcm);
        if (acceptable(p, cap)) return finish(p);
        stats.rejected++;

        /* 超标了：先量出这一句的确定性基准时长（noise_w=0，时长完全可复现）。
           它本身合格说明只是这次采歪了，值得再采几次；它本身就离谱说明是模型的坏点，
           再采也是白费（实测 "and" 的自然采样永远在 3.3~9.5 秒），直接进兜底。 */
        return probe().then(function (bp) {
          stats.probeMs = +bp.fullMs.toFixed(1);
          stats.probeGapMs = +bp.maxGapMs.toFixed(1);
          if (bp.fullMs > 0 && acceptable(bp, cap)) return finish(bp);

          var key = seqKey(ids);
          var hopeless = bp.fullMs > cap * W_DUR_HOPELESS || bp.maxGapMs > GAP_MAX * 1000 || BAD_SEQ[key];
          if (hopeless) return compress();

          return natural(VITS_RETRY - 1).then(function (q) {
            if (q) return finish(q);
            markBad(key);
            return compress();
          });

          /* 兜底：把 length_scale 压到预算内，确定性重采一次。
             会比正常语速快一些，但不会再播出一段 5 秒的长拖音。 */
          function compress() {
            var scale = bp.fullMs > 0 ? Math.max(SCALE_MIN, Math.min(SCALE_MAX, cap / bp.fullMs)) : SCALE_MIN;
            /* 要压到一半以下说明这不是「读得慢」，而是模型对这个音素序列给出了荒唐时长，
               兜底预算再收紧一档，别让这种拖音仍然占着两秒。 */
            if (scale < W_DUR_BAD) scale *= W_DUR_TIGHT;
            stats.scale = +scale.toFixed(3);
            return runVits(ids, rate, 0, scale).then(function (pcm2) {
              stats.tries++;
              return finish(polish(pcm2));
            });
          }
        });
      });

      /* 基准时长只跟音素序列和语速有关，量一次就存下来：
         同一个词再合成（缓存被挤掉、或换了语速）时不用再花一次推理去量。 */
      function probe() {
        var key = rate + '\u0000' + ids.join(',');
        var hit = BASE[key];
        if (hit) return W.Promise.resolve(hit);
        return runVits(ids, rate, 0).then(function (pcm) {
          var bp = polish(pcm);
          BASE[key] = bp;
          var keys = Object.keys(BASE);
          if (keys.length > BASE_MAX) delete BASE[keys[0]];
          return bp;
        });
      }

      function natural(left) {
        if (left <= 0) return W.Promise.resolve(null);
        return runVits(ids, rate).then(function (pcm) {
          stats.tries++;
          var p = polish(pcm);
          if (acceptable(p, cap)) return p;
          stats.rejected++;
          return natural(left - 1);
        });
      }

      function markBad(key) {
        BAD_SEQ[key] = 1;
        var keys = Object.keys(BAD_SEQ);
        if (keys.length > BAD_MAX) delete BAD_SEQ[keys[0]];
      }

      function finish(p) {
        stats.picked = p.trimmedMs > 1 ? 'trimmed' : 'full';
        stats.finalMs = +p.ms.toFixed(1);
        stats.trimMs = +p.trimmedMs.toFixed(1);
        stats.maxGapMs = +p.maxGapMs.toFixed(1);
        stats.voicedRatio = +p.voicedRatio.toFixed(3);
        lastStats = stats;
        if (stats.probeMs || stats.rejected || p.trimmedMs > 60) {
          log('音频体检：' + label + ' 编号' + stats.ids + ' 上限' + Math.round(cap) + 'ms ' +
            (stats.rejected ? '弃采' + stats.rejected + '次 ' : '') +
            (stats.probeMs ? '基准' + stats.probeMs + 'ms ' : '') +
            (stats.scale ? '压缩×' + stats.scale + ' ' : '') +
            '最终' + stats.finalMs + 'ms 裁掉' + stats.trimMs + 'ms 最长内部静音' + stats.maxGapMs + 'ms 推理' + stats.tries + '次');
        }
        // 复制成独立缓冲：subarray 还挂在 wasm 堆上，缓存它会把整块堆留着
        return new Float32Array(p.pcm);
      }
    }
  }

  /* ---------- WAV 编码（16bit 单声道 PCM） ---------- */
  function pcmToWav(pcm, sampleRate) {
    var n = pcm.length;
    var buf = new ArrayBuffer(44 + n * 2);
    var v = new DataView(buf);
    function s32(o, x) { v.setUint32(o, x, true); }
    function s16(o, x) { v.setUint16(o, x, true); }
    s32(0, 0x46464952); s32(4, 36 + n * 2); s32(8, 0x45564157); s32(12, 0x20746d66);
    s32(16, 16); s16(20, 1); s16(22, 1);
    s32(24, sampleRate); s32(28, sampleRate * 2); s16(32, 2); s16(34, 16);
    s32(36, 0x61746164); s32(40, n * 2);
    var p = 44;
    for (var i = 0; i < n; i++) {
      var x = pcm[i];
      v.setInt16(p, x >= 1 ? 32767 : (x <= -1 ? -32768 : (x * 32768) | 0), true);
      p += 2;
    }
    return buf;
  }

  function synthPcm(text, rate) {
    return synthPcmChecked(text, rate || 1);
  }

  function synth(text, rate) {
    return synthPcm(text, rate || 1).then(function (pcm) {
      return new W.Blob([pcmToWav(pcm, SR)], { type: 'audio/wav' });
    });
  }

  /* ---------- 缓存 ---------- */
  function ckey(text, rate) { return (rate || 1) + '\u0000' + text; }
  function cacheGet(key) {
    for (var i = 0; i < cache.length; i++) {
      if (cache[i].key === key) {
        var hit = cache.splice(i, 1)[0];
        cache.push(hit);                 // 命中就挪到队尾
        return hit.blob;
      }
    }
    return null;
  }
  function cachePut(key, blob) {
    cache.push({ key: key, blob: blob });
    while (cache.length > CACHE_MAX) cache.shift();
  }

  /* ---------- 播放 ---------- */
  function audio() {
    if (!A) {
      A = new W.Audio();
      A.preload = 'auto';
    }
    return A;
  }

  function haltAudio() {
    playing = false;
    if (!A) return;
    A.onended = null;
    A.onerror = null;
    try { A.pause(); } catch (e) {}
    try { A.currentTime = 0; } catch (e) {}
  }

  function play(blob, seq, done) {
    var url = W.URL.createObjectURL(blob);
    var a = audio();
    var settled = false;
    function finish(err) {
      if (settled) return;
      settled = true;
      a.onended = null;
      a.onerror = null;
      playing = false;
      if (seq === playSeq) {
        try { W.URL.revokeObjectURL(url); } catch (e) {}
        if (done) done(err || null);
      } else {
        try { W.URL.revokeObjectURL(url); } catch (e) {}
      }
    }
    a.onended = function () { finish(null); };
    a.onerror = function () { finish(new Error('音频播放失败')); };
    a.src = url;
    a.playbackRate = 1;                 // 语速已经由 length_scale 决定，这里不再叠加
    playing = true;
    var pr;
    try { pr = a.play(); } catch (e) { finish(e); return; }
    if (pr && typeof pr.then === 'function') {
      pr.then(null, function (e) { finish(e || new Error('音频被浏览器拦截')); });
    }
  }

  /* ---------- 初始化 ---------- */
  var dynImport = makeDynImport();

  function init() {
    if (initPromise) return initPromise;
    initPromise = new Promise(function (resolve, reject) {
      var reason = unsupportedReason();
      if (reason) { reject(new Error(reason)); return; }
      if (!dynImport) { reject(new Error('不支持动态 import')); return; }
      state = 'loading';
      resolve();
    }).then(function () {
      return W.WCTTS.whenReady();
    }).then(function () {
      CFG = W.WCTTS.config();
      if (!CFG || !CFG.phoneme_id_map) throw new Error('音色配置缺失');
      SR = CFG.sample_rate || 22050;
      var vid = (typeof W.WCTTS.currentVoice === 'function' && W.WCTTS.currentVoice()) || 'gb';
      VOICE_BLOB = 'voice_' + vid;

      /* 1) 推理后端：wasm 与 emscripten glue 都从内存注入，一次网络请求都不发 */
      ORT = W.ort;
      if (!ORT || !ORT.InferenceSession) throw new Error('onnxruntime-web 未加载');
      var glueUrl = W.URL.createObjectURL(new W.Blob([decodeText(W.WCTTS.glueB64())], { type: 'text/javascript' }));
      ORT.env.wasm.numThreads = 1;                 // file:// 下没有 SharedArrayBuffer
      ORT.env.wasm.simd = true;
      ORT.env.wasm.wasmBinary = W.WCTTS.bytes('ortwasm');
      ORT.env.wasm.wasmPaths = { mjs: glueUrl };
      ORT.env.logLevel = 'error';
      return dynImport(glueUrl).then(function (mod) {
        if (!mod || typeof mod.default !== 'function') throw new Error('ort glue 载入失败');
        return W.WCTTS.bytes(VOICE_BLOB);
      });
    }).then(function (modelBytes) {
      if (!modelBytes || modelBytes.length < 1024) throw new Error('音色模型缺失');
      var t = +new Date();
      return ORT.InferenceSession.create(modelBytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      }).then(function (s) {
        SESS = s;
        W.WCTTS.release(VOICE_BLOB);               // 权重已进 wasm 堆，JS 侧这份可以还回去了
        W.WCTTS.release('ortwasm');
        log('推理会话就绪 ' + (+new Date() - t) + ' ms，输入 ' + s.inputNames.join('/'));
      });
    }).then(function () {
      /* 2) 音素化器：wasm 用 wasmBinary 注入，espeak 数据包用 getPreloadedPackage 注入。
            这两份二进制要自己留一份 —— 到调用次数上限时得用同样的字节重建实例。
            boot.js 里那份引用照旧还掉，省内存。 */
      phenDataAB = W.WCTTS.bytes('phendata').buffer;   // 独占 ArrayBuffer，长度精确
      phenWasmBytes = W.WCTTS.bytes('phenwasm');
      var t = +new Date();
      return newPhonemizer().then(function (mod) {
        PHON = mod;
        phonCalls = 0;
        W.WCTTS.release('phendata');
        W.WCTTS.release('phenwasm');
        log('音素化器就绪 ' + (+new Date() - t) + ' ms');
      });
    }).then(function () {
      /* 3) 预热：第一次推理要编译内核，先空跑一句，免得用户第一次点发音要等。
         这里故意走裸推理，不经过校验/重采那一套——预热只要把内核跑热。 */
      var t = +new Date();
      var ids = phonemize('the');
      if (!ids || ids.length < 3) throw new Error('预热音素化失败');
      return runVits(ids, 0.92).then(function (pcm) {
        log('预热完成 ' + (+new Date() - t) + ' ms，输出 ' + pcm.length + ' 采样点');
        if (!pcm || pcm.length < 512) throw new Error('预热输出异常');
      });
    }).then(function () {
      state = 'ready';
      log('内置语音就绪：' + NAME + ' @ ' + SR + 'Hz');
      mount();
      setTitle(READY_TITLE);   // 进度百分比到这一步就该收尾了，别把它留在按钮上
    }, function (e) {
      state = 'error';
      errMsg = (e && e.message) ? e.message : String(e);
      warn('内置语音不可用，回退系统 TTS：' + errMsg);
      setTitle('内置语音包加载失败：' + errMsg);
      mount();          // 仍然挂上去，但 ready() 为 false，页面会自动走系统 TTS
    });
    return initPromise;
  }

  function decodeText(b64) {
    var bin = W.atob(b64);
    var u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new W.TextDecoder().decode(u);
  }

  /* ---------- 引擎对象：app.js（WordCardSpeech）认的就是这三个方法 ---------- */
  var engine = {
    name: 'local',
    voice: NAME,
    ready: function () { return state === 'ready'; },
    state: function () { return state; },
    error: function () { return errMsg; },
    poke: function () { poke(); },
    speak: function (text, lang, rate, id, done) {
      if (state !== 'ready') return false;
      text = String(text == null ? '' : text).slice(0, MAX_CHARS);
      if (!text) return false;
      var seq = ++playSeq;
      haltAudio();
      var r = parseFloat(rate);
      r = (r > 0.1 && r < 4) ? r : 1;
      var key = ckey(text, r);
      var hit = cacheGet(key);
      if (hit) { play(hit, seq, done); return true; }
      synth(text, r).then(function (blob) {
        if (seq !== playSeq) return;              // 期间又点了别的
        cachePut(key, blob);
        play(blob, seq, done);
      }, function (e) {
        if (seq !== playSeq) return;
        state = 'ready';                          // 单次失败不算引擎坏掉
        if (done) done(e);
      });
      return true;
    },
    stop: function () {
      playSeq++;
      haltAudio();
    },
    isSpeaking: function () { return playing && !!A && !A.paused && !A.ended; }
  };

  /* ---------- 状态提示：只改按钮的 title，不动任何视觉 ---------- */
  function btn() { return D.getElementById('btnSpeak'); }
  function setTitle(s) {
    var b = btn();
    if (b) { try { b.title = s; } catch (e) {} }
  }

  /* ---------- 注册进页面 ---------- */
  function mount() {
    var S = W.WordCardSpeech;
    if (S && typeof S.mountLocal === 'function') {
      S.mountLocal(engine);
      return true;
    }
    return false;
  }

  function poke() {
    if (state !== 'idle') return;
    if (W.WCTTS) W.WCTTS.start();
  }

  if (W.WCTTS) {
    W.WCTTS.onProgress(function (p, s) {
      // 已经就绪（或已失败）之后，晚到的进度回调不许再往按钮上写百分比
      if (s !== 'loading' || state === 'ready' || state === 'error') return;
      setTitle('内置语音包加载中 ' + Math.round(p.ratio * 100) + '%');
    });
    if (W.WCTTS.state() === 'ready') init(); else W.WCTTS.whenReady().then(init, function () {});
  }

  /* 先把引擎挂进页面（app.js 一就位就挂），但 title 不能在挂载那一刻就写成「已就绪」——
     那时模型还在装载。挂上之后再等 state 变成 ready，由 init() 里的 setTitle 收尾。 */
  function mountWhenReady() {
    var n = 0;
    (function tick() {
      if (mount() || ++n > 60) {
        if (state === 'ready') setTitle(READY_TITLE);
        return;
      }
      W.setTimeout(tick, 200);
    })();
  }
  mountWhenReady();

  W.WCTTSLocal = {
    name: NAME,
    state: function () { return state; },
    ready: function () { return state === 'ready'; },
    error: function () { return errMsg; },
    progress: function () { return W.WCTTS ? W.WCTTS.progress() : null; },
    info: function () {
      return {
        state: state, error: errMsg, voice: NAME, sampleRate: SR,
        cached: cache.length, speaking: playing,
        noiseW: CFG ? tuneNoiseW() : null,       // 时长噪声：配置里的原值（可用 WCTTS_TUNE.noiseW 改）
        last: lastStats                            // 最近一条的体检数据，排查用
      };
    },
    /* 采样质量控制参数：WCTTS_TUNE = { noiseW, retry, durCeil, durFloor, hopeless } 可在控制台调 */
    tune: function (patch) {
      if (patch && typeof patch === 'object') {
        if (typeof patch.noiseW === 'number') NOISE_W = patch.noiseW;
        if (typeof patch.retry === 'number') VITS_RETRY = patch.retry;
        if (typeof patch.durCeil === 'number') W_DUR_CEIL = patch.durCeil;
        if (typeof patch.durFloor === 'number') W_DUR_FLOOR = patch.durFloor;
        if (typeof patch.hopeless === 'number') W_DUR_HOPELESS = patch.hopeless;
      }
      return {
        noiseW: CFG ? tuneNoiseW() : null, retry: VITS_RETRY, durCeil: W_DUR_CEIL, durFloor: W_DUR_FLOOR,
        hopeless: W_DUR_HOPELESS, scaleMin: SCALE_MIN, scaleMax: SCALE_MAX,
        trimTh: TRIM_TH, trimPadMs: TRIM_PAD * 1000
      };
    },
    poke: poke,
    /* 清空音频缓存（排查/自检用）：下次朗读会重新合成，正好能验证采样质量控制那条路 */
    clearCache: function () {
      var n = cache.length;
      cache.length = 0;
      return n;
    },
    synth: function (text, rate) {
      if (state !== 'ready') return Promise.reject(new Error('引擎未就绪：' + (errMsg || state)));
      return synth(String(text), rate || 1);
    },
    pcm: function (text, rate) {
      if (state !== 'ready') return Promise.reject(new Error('引擎未就绪：' + (errMsg || state)));
      return synthPcm(String(text), rate || 1).then(function (pcm) {
        return { pcm: pcm, sampleRate: SR };
      });
    },
    phonemize: function (text) {
      if (state !== 'ready') return null;
      return phonemize(String(text));
    },
    engine: engine
  };
})(window, document);
