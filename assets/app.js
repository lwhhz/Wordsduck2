/* ============================================================
   单词卡 · 背单词逻辑
   词书库（可累加 / 排序 / 删除 / 搜索 / 按来源文件分组）
   → 多工作表批量导入 → 随机顺序 → 只看中文
   → 记得移除 / 不记得归队 → 一轮结束 → 学习统计 + 热力图
   ============================================================ */
(function () {
  'use strict';

  var LS_BOOKS = 'danci.books.v2';
  var LS_PROG = 'danci.prog.v1';       // 覆盖进度单独一个键：背词时每次只写这几十 KB
  var LS_OLD = 'danci.library.v1';
  var LS_SET = 'danci.settings.v1';
  var LS_STATS = 'danci.stats.v1';
  var LS_REVIEW = 'danci.review.v1';   // 动态词书「复习本」的收录与遗忘记录
  var MAX_COLS = 20;
  var HEAT_DAYS = 62;         // 统计页正文的热力图窗口：约两个月（62 天 = 9 列整齐）
  var HEAT_DAYS_YEAR = 365;   // 「看一年」弹窗里的窗口
  var MAX_WORD_STAT = 4000;   // 单个词统计的条数上限，避免撑爆本地存储
  var SEARCH_DEBOUNCE = 140;  // 只在「词书特别多」的极端情况下才启用的防抖
  var SEARCH_PLAIN_MAX = 120; // 词书不超过这个数量就直接跟着按键重排（实测一次 1~2 ms）
  var REVIEW_ID = '__review__';  // 复习本固定 id：它是一本动态词书，不写进 ST.books
  var REVIEW_BATCH = 20;         // 每次复习最多取多少个词条
  var REVIEW_DONE_OK = 2;        // 连续答对这么多次算「已消化」，先退出复习队列
  var MAX_REVIEW = 2000;         // 复习本条目上限，超出后淘汰已消化的 + 权重最低的
  var BACKUP_KIND = 'danci.backup';  // 备份文件的标识，导入时用来确认「这是我们自己导出的」
  var BACKUP_VER = 2;                // v1 只有复习本 + 统计；v2 起补上词书库 / 勾选 / 覆盖进度 / 设置

  var WORD_KEYS = ['英文', '单词', '词组', '短语', '拼写', '词汇', 'word', 'english', 'vocab', 'expression', 'term'];
  var MEAN_KEYS = ['中文', '意思', '释义', '含义', '翻译', '解释', '词义', 'meaning', 'chinese', 'definition'];
  var POS_KEYS = ['词性', '词类', 'part of speech', 'pos'];
  var EX_KEYS = ['例句', '示例', '例子', 'sentence', 'example'];

  var DEMO = [
    ['abandon', '放弃；抛弃', 'v.', 'He abandoned his car in the snow.'],
    ['ability', '能力；本领', 'n.', 'She has the ability to solve problems quickly.'],
    ['accurate', '准确的；精确的', 'adj.', 'The report gives an accurate picture of the market.'],
    ['achieve', '实现；达到', 'v.', 'He achieved his goal of studying abroad.'],
    ['adapt to', '适应；习惯于', 'phrase', 'Children adapt to new environments easily.'],
    ['advantage', '优势；有利条件', 'n.', 'Fluency in English is a great advantage.'],
    ['anticipate', '预料；期望', 'v.', 'We anticipate a rise in demand next year.'],
    ['approach', '方法；途径', 'n./v.', 'This approach saves both time and money.'],
    ['assess', '评估；评定', 'v.', "Teachers assess students' progress every term."],
    ['attribute to', '把……归因于', 'phrase', 'She attributes her success to hard work.'],
    ['capacity', '容量；能力', 'n.', 'The stadium has a capacity of 60,000.'],
    ['comprehensive', '全面的；综合的', 'adj.', 'The book offers a comprehensive overview.'],
    ['considerable', '相当大的；重要的', 'adj.', 'The project required considerable effort.'],
    ['contribute to', '促成；有助于', 'phrase', 'Exercise contributes to better sleep.'],
    ['crucial', '至关重要的', 'adj.', 'Timing is crucial in this experiment.'],
    ['demonstrate', '证明；演示', 'v.', 'The study demonstrates a clear link.'],
    ['distinguish', '区分；辨别', 'v.', 'Can you distinguish between the two dialects?'],
    ['enhance', '提高；增强', 'v.', 'Music can enhance the mood of a film.'],
    ['inevitable', '不可避免的', 'adj.', 'Some mistakes are inevitable when learning.'],
    ['significant', '重要的；显著的', 'adj.', 'There was a significant rise in prices.']
  ];

  var $ = function (id) { return document.getElementById(id); };

  var el = {
    brandSub: $('brandSub'), btnHelp: $('btnHelp'), btnBackHome: $('btnBackHome'), btnStats: $('btnStats'),
    /* 背景词：词书库顶栏下方随机展示的一个词条，整块可点换词 */
    heroWord: $('heroWord'), heroWordEn: $('heroWordEn'),
    heroWordPos: $('heroWordPos'), heroWordCn: $('heroWordCn'), heroWordEx: $('heroWordEx'),
    dropzone: $('dropzone'), fileInput: $('fileInput'), btnPick: $('btnPick'), btnDemo: $('btnDemo'),
    btnTemplate: $('btnTemplate'),
    bookCount: $('bookCount'), bookList: $('bookList'), emptyState: $('emptyState'), libEmpty: $('libEmpty'),
    libSearch: $('libSearch'), btnSearchClear: $('btnSearchClear'), searchInfo: $('searchInfo'),
    btnSelectAll: $('btnSelectAll'), btnSelectNone: $('btnSelectNone'), btnDeleteSelected: $('btnDeleteSelected'),
    btnGroupExpand: $('btnGroupExpand'), btnGroupCollapse: $('btnGroupCollapse'),
    optShuffle: $('optShuffle'), selRequeue: $('selRequeue'), selBatch: $('selBatch'),
    selSummary: $('selSummary'), btnStart: $('btnStart'),
    hudRound: $('hudRound'), roundBooks: $('roundBooks'), hudRemain: $('hudRemain'),
    hudDone: $('hudDone'), hudRepeat: $('hudRepeat'), hudRingBar: $('hudRingBar'), ringText: $('ringText'),
    wordcard: $('wordcard'), cardIndex: $('cardIndex'), cardHintFlag: $('cardHintFlag'),
    meaning: $('meaning'), answer: $('answer'), wordText: $('wordText'),
    wordExample: $('wordExample'), wordPos: $('wordPos'), stamp: $('stamp'), stampText: $('stampText'),
    btnSpeak: $('btnSpeak'), speakTxt: $('speakTxt'),
    controlsAsk: $('controlsAsk'), controlsNext: $('controlsNext'),
    btnNo: $('btnNo'), btnYes: $('btnYes'), btnNext: $('btnNext'),
    btnUndo: $('btnUndo'), btnUndoStep: $('btnUndoStep'), btnQuit: $('btnQuit'), btnBackLib: $('btnBackLib'),
    doneRound: $('doneRound'), doneSub: $('doneSub'), doneBooks: $('doneBooks'),
    doneTotal: $('doneTotal'), doneFirst: $('doneFirst'), doneRate: $('doneRate'), doneTime: $('doneTime'),
    doneForgotCount: $('doneForgotCount'), doneForgotList: $('doneForgotList'),
    doneMasteredCount: $('doneMasteredCount'), doneMasteredList: $('doneMasteredList'),
    btnAgain: $('btnAgain'), btnBackLibrary: $('btnBackLibrary'), btnNewFile: $('btnNewFile'), btnDoneStats: $('btnDoneStats'),
    statsSub: $('statsSub'), statGrid: $('statGrid'), heatWrap: $('heatWrap'), heatSub: $('heatSub'),
    heatRange: $('heatRange'), heatTip: $('heatTip'), trendWrap: $('trendWrap'), trendSub: $('trendSub'),
    heatWrapFull: $('heatWrapFull'), heatModalSub: $('heatModalSub'),
    heatModalRange: $('heatModalRange'), heatModal: $('heatModal'),
    btnHeatOpen: $('btnHeatOpen'), btnHeatClose: $('btnHeatClose'),
    hud: $('hud'), hudRingTrack: $('hudRingTrack'),
    btnFullText: $('btnFullText'), btnFullTextClose: $('btnFullTextClose'),
    fullTextModal: $('fullTextModal'), fullTextBody: $('fullTextBody'), fullTextSub: $('fullTextSub'),
    screenLibrary: $('screen-library'), screenStudy: $('screen-study'), screenStats: $('screen-stats'),
    screenDone: $('screen-done'),
    reviewBook: $('reviewBook'), reviewPick: $('reviewPick'), reviewCount: $('reviewCount'),
    reviewMeta: $('reviewMeta'), reviewNote: $('reviewNote'), reviewList: $('reviewList'),
    reviewTip: $('reviewTip'), btnReviewStart: $('btnReviewStart'), btnReviewClear: $('btnReviewClear'),
    doneReview: $('doneReview'),
    bookStats: $('bookStats'), hardWords: $('hardWords'), hardCount: $('hardCount'),
    btnStatsReset: $('btnStatsReset'), btnBackLibFromStats: $('btnBackLibFromStats'),
    backupSummary: $('backupSummary'), backupTip: $('backupTip'),
    speakEngineGroup: $('speakEngineGroup'), speakEngineHint: $('speakEngineHint'),
    speakSystemLabel: $('speakSystemLabel'), btnSpeakTest: $('btnSpeakTest'), speakTestTip: $('speakTestTip'),
    btnExport: $('btnExport'), btnImportMerge: $('btnImportMerge'), btnImportReplace: $('btnImportReplace'),
    importFile: $('importFile'),
    sheetModal: $('sheetModal'), btnSheetClose: $('btnSheetClose'), sheetModalFile: $('sheetModalFile'),
    sheetList: $('sheetList'), sheetAll: $('sheetAll'), btnSheetCancel: $('btnSheetCancel'), btnSheetOk: $('btnSheetOk'),
    editModal: $('editModal'), btnEditClose: $('btnEditClose'), editName: $('editName'), editMeta: $('editMeta'),
    editW: $('editW'), editM: $('editM'), editP: $('editP'), editE: $('editE'),
    editCount: $('editCount'), editPreview: $('editPreview'),
    cfHead: $('cfHead'), cfCount: $('cfCount'), cfPanel: $('cfPanel'), cfList: $('cfList'),
    btnEditDelete: $('btnEditDelete'), btnEditCancel: $('btnEditCancel'), btnEditSave: $('btnEditSave'),
    helpModal: $('helpModal'), btnCloseHelp: $('btnCloseHelp'), toast: $('toast'),
    /* 最近 7 / 14 天趋势：面板本身是按钮，弹窗由它打开 */
    btnTrendOpen: $('btnTrendOpen'), trendWrapFull: $('trendWrapFull'),
    trendModal: $('trendModal'), trendModalSub: $('trendModalSub'),
    trendModalScroll: $('trendModalScroll'),
    btnTrendClose: $('btnTrendClose')
  };

  var ST = {
    books: [],            // 词书列表，数组顺序就是用户排序
    selected: {},         // id -> true
    prog: {},             // 覆盖进度：bookId -> { 词键 -> 1 }，答过「记得」才算过了一遍
    credit: null,         // 本轮允许计入进度的词：bookId -> { 词键 -> 1 }（按本轮的取词计划定）
    settings: { shuffle: true, requeue: 'random', batch: 50, collapsed: {}, speakEngine: 'auto' },
    stats: newStats(),    // 学习统计
    review: { items: {} }, // 复习本：wl -> 收录的词条 + 遗忘 / 连续记住记录
    revRound: 0,          // 本轮来自复习本的词条数
    revCleared: 0,        // 本轮「消化掉」的词条数
    query: '',            // 词书库搜索词
    searchTimer: null,
    pending: null,        // 待导入：{ fileName, sheets: [{name, analysis, mapping, checked}] }
    editingId: null,
    cfEdits: null,        // 编辑窗口里查重部分改了还没保存的内容：'行号:w' / '行号:m' -> 新值
    importMode: null,     // 导入备份的方式：'merge' 合并 / 'replace' 覆盖
    saveTimer: null,
    statsTimer: null,
    reviewTimer: null,
    // 一轮背词状态
    words: [], round: 0, total: 0, queue: [], current: null, answered: false,
    mastered: [], repeats: 0, firstTry: 0, startAt: 0, undoStack: [],
    roundNames: '', roundNote: '', roundLogged: false
  };

  var WCACHE = {};        // bookId -> 词条数组（搜索 / 合并用，避免重复解析）
  var CFCOUNT = {};       // bookId -> 查重冲突条数（词书库每一行都要读，单独存个数字）

  /* ---------------- 性能：预编译正则（避免循环里反复构造正则对象） ---------------- */
  var RE_HAS_WS = /\s/;
  var RE_WS = /\s+/g;
  var RE_EXT = /\.[^.]+$/;
  var RE_BAD_CHAR = /\uFFFD/;
  var RE_FIELD_TAG = /^(INPUT|SELECT|TEXTAREA)$/;
  // 朗读前的文本清洗：斜杠、分号会被读成「slash / semicolon」，换成逗号更自然
  var RE_SPEAK_BREAK = /[\/;；、]+/g;
  var RE_SPEAK_CJK = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]+/g;
  var RE_SPEAK_EDGE = /^[\s,]+|[\s,]+$/g;

  /* ---------------- 性能：派生数据缓存 ----------------
     词书内容变了 STEP 自增（词书表、分组、id 索引、序列化片段一起失效）；
     只有勾选变了就只让 SELVER 自增 —— 词书表格一个字都没改，那份整表 JSON
     和按 id 的索引都不必重算，省掉一次白跑的序列化。 */
  var STEP = 0;                 // 数据版本号（词书内容）
  var SELVER = 0;               // 勾选版本号（只管「选了哪些」的派生结果）
  var MVER = -1, MSVER = -1, MCACHE = null; // mergedWords 缓存
  var GVER = -1, GCACHE = null; // groupedBooks 缓存
  var IVER = -1, ICACHE = null; // bookId -> book 索引
  var BVER = -1, BSVER = -1, BCACHE = null; // selectedBooks 缓存
  var SVER = -1, SCACHE = '';   // 词书部分的 JSON 片段缓存（保存时复用）
  var SAVED_VER = -1, SAVED_SEL = null, SAVED_PROG = -1; // 上次成功写入的内容指纹，避免重复写盘
  var PROGVER = 0;              // 覆盖进度版本号（只有进度变了才重算进度条 / 重写盘）
  var PJSON = null, PJSON_VER = -1;                      // 进度部分的 JSON 片段缓存
  var COVVER = -1, COVSTEP = -1, COVCACHE = {};          // bookId -> {done,total,rest}
  var PLAN = null, PLANVER = -1, PLANSEL = -1, PLANPROG = -1, PLANBATCH = -1; // 本轮取词计划缓存
  var DEFAULT_BATCH = 50;       // 每本每轮最多背多少词（0 = 不限）
  var STATS_VER = 0;            // 统计版本号（热力图等据此判断要不要重绘）
  var RVVER = -1, RVPEND = 0, RVTOT = 0; // 复习本：待复习 / 总条数缓存
  var pendingStore = false, pendingStats = false, pendingReview = false;

  /* 落盘节奏：停手 WRITE_DEBOUNCE 毫秒后写一次。
     背词时每张卡都会改统计，靠这个防抖把「一张卡就同步写几十 KB」压成「停下来才写一次」，
     真到关页 / 切后台时 flushSaves 会立刻补上，数据不会丢。 */
  var WRITE_DEBOUNCE = 400;

  function touchData() { STEP++; }
  function touchSel() { SELVER++; }   // 只改了勾选：让「合并 / 选中」类缓存失效，词书缓存原地不动

  // 把非紧急的写盘推迟到浏览器空闲时，避免打断点击 / 翻卡的动画
  function scheduleIdle(fn) {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(function () { fn(); }, { timeout: 800 });
    } else {
      setTimeout(fn, 0);
    }
  }

  /* 防抖落盘：连续操作时不会每一下都触发一次同步写盘，停手后才写。 */
  function scheduleWrite(timerField, run) {
    clearTimeout(ST[timerField]);
    ST[timerField] = setTimeout(function () {
      ST[timerField] = null;
      scheduleIdle(run);
    }, WRITE_DEBOUNCE);
  }

  /* ---------------- 基础工具 ---------------- */
  /* 背词界面（#screen-study 处于激活态）里不弹任何小提示。
     用户的要求是「按下各种按钮时弹出的小提示全部取消」——
     那一屏上能触发的提示有「已撤销上一张」「已消化「x」，暂时退出复习本」
     以及发音失败提示。它们在按下按钮时飘出来，反而干扰读词。
     为什么在这里统一拦，而不是逐个删掉调用点：
       · 发音失败提示是共用的（词书库 / 设置里点「试听」也走同一条路径），
         删掉调用点会把那些地方的反馈一起干掉；
       · 「没有可撤销的步骤」这类「告诉你为什么没反应」的提示要保留
         （下面两处 toast 分别负责它们），逐个判断容易漏。
     所以按「当前是哪一屏」来分流：背词界面静音，其它屏照旧。
     注意判定的是 screen-study 而不是背完那一屏（screen-done）——
     成绩页不在这次要求范围内。 */
  function inStudy() {
    return !!(el.screenStudy && el.screenStudy.classList.contains('is-active'));
  }
  function toast(msg) {
    if (inStudy()) return;
    el.toast.textContent = msg;
    el.toast.hidden = false;
    requestAnimationFrame(function () { el.toast.classList.add('is-show'); });
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      el.toast.classList.remove('is-show');
      setTimeout(function () { el.toast.hidden = true; }, 260);
    }, 2400);
  }

  var SCREENS = null;
  function show(screen) {
    if (!SCREENS) SCREENS = document.querySelectorAll('.screen');
    for (var i = 0; i < SCREENS.length; i++) SCREENS[i].classList.remove('is-active');
    el['screen' + screen.charAt(0).toUpperCase() + screen.slice(1)].classList.add('is-active');
    if (screen !== 'study') { el.btnBackHome.hidden = true; stopSpeak(); }
    el.heatTip.hidden = true;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* 翻卡动画和释义浮现动画都要「先回到起点、再重新播放」，
     而浏览器只有在两处改动之间真的算过一次样式时才会认账，所以必须强制同步布局。
     旧写法是两条动画各自读一次 offsetWidth，等于每张卡强制布局两回；
     把两处改动夹在同一次强制布局的两侧，效果完全一样，布局只做一次。 */
  function restartCardAnims() {
    var card = el.wordcard;
    card.classList.remove('is-flipping');
    el.meaning.style.animation = 'none';
    void card.offsetWidth;      // 唯一的强制同步布局：这一次同时把上面两处改动刷进样式系统
    card.classList.add('is-flipping');
    el.meaning.style.animation = '';
  }

  /* ---------------- 词卡固定高度 ----------------

     需求：揭示答案前后，下面那排按钮不许位移。
     做法分两步 ——
       1) lockCardHeight()：算出「本轮所有词里最高的那张卡」的高度，
          写成 --card-h 锁死。所以同一轮里翻页、揭示都不改变卡片高度。
       2) detectCardOverflow()：把当前这张的内容塞进锁定的高度，
          若确实放不下（scrollHeight > clientHeight），亮出「完整内容」按钮。

     为什么量「本轮最高」而不是「当前这张的最高」：
       逐张卡各锁各的高度，翻到下一张卡片仍然会变高变矮，
       下方的按钮照样跳 —— 只有整轮统一才真的不动。

     为什么用离屏克隆来量：
       直接把卡片的 height 放开去量会闪一下（真机上能看见）。
       克隆一份到视口外，用同一套 CSS 量完就删，对可见内容零影响。 */

  /** 本轮锁定的卡片高度；0 = 还没锁 */
  var CARD_H = 0;

  /**
   * 量一张卡在「揭示后」的**自然高度**。
   *
   * 用离屏克隆而不是放开真卡片去量：放开真卡片会让用户看见卡片长高又缩回，
   * 克隆体在视口外，对可见内容零影响。
   *
   * 两个必须做对的地方（都是实测踩出来的）：
   *   1) 克隆体也要清掉 --card-h。--card-h 是写在卡片元素上的内联自定义属性，
   *      cloneNode 会把它一起复制过去，于是克隆体量到的是**锁定高度**
   *      而不是自然高度 —— 锁一次之后就再也测不准了。
   *   2) 加 is-measuring 把动画位移归零，否则 letter-up 起始帧的
   *      translateY(10px) 会被算进高度，每张卡都多出约 10px。
   */
  function measureCardHeight(item) {
    var card = el.wordcard;
    if (!card || !card.parentNode) return 0;
    var clone = card.cloneNode(true);
    clone.removeAttribute('id');
    clone.removeAttribute('style');
    clone.style.position = 'absolute';
    clone.style.left = '-99999px';
    clone.style.top = '0';
    clone.style.height = 'auto';
    clone.style.visibility = 'hidden';
    clone.style.width = card.getBoundingClientRect().width + 'px';
    /* 1) 清掉继承来的锁定高度，否则量到的是 410 而不是自然高度 */
    clone.style.removeProperty('--card-h');
    /* 2) 量的时候不要动画位移 */
    clone.classList.add('is-measuring');

    var q = function (sel) { return clone.querySelector(sel); };
    var meaningEl = q('#meaning') || q('.meaning');
    var answerEl = q('#answer') || q('.answer');
    var wordEl = q('#wordText') || q('.word');
    var exEl = q('#wordExample') || q('.example');
    var posEl = q('#wordPos') || q('.word-pos');
    var fullEl = q('#btnFullText');

    if (meaningEl) meaningEl.textContent = item.m || '';
    if (wordEl) wordEl.textContent = item.w || '';
    /* 词性那一行**始终可见**（提问和揭示两态都在），所以克隆体照原样显示，
       不额外隐藏 —— 量出来的高度才和真实卡片一致。 */
    if (posEl) {
      posEl.textContent = item.p || '';
      posEl.hidden = !item.p;
    }
    if (exEl) {
      exEl.textContent = item.e || '';
      exEl.hidden = !item.e;
    }
    if (answerEl) answerEl.hidden = false;
    if (fullEl) fullEl.hidden = true;

    card.parentNode.appendChild(clone);
    var h = clone.getBoundingClientRect().height;
    clone.remove();
    return h;
  }

  /**
   * 算出本轮所有词里最高的卡片高度并锁死。
   * 只量前 N 个：词条高度只有少数几种（一行/两行/三行例句），
   * 量 30 个足以覆盖最高的情况，而每个都要一次强制布局，不宜全量。
   *
   * **还要把「屏幕装不下」这一层夹进去**（这就是背词页「不用上下滑动」的关键）：
   * 锁定的高度是内容的自然高度，若它比屏幕能给的还高，整页就会溢出。
   * 所以最终值取 min(自然最高, 实测可用空间) —— 后者靠临时把内联高度摘掉、
   * 量一次 .card-stage 的真实 clientHeight 得到（CSS 那边做不到：
   * .card-stage 是 display:grid、宽度 auto，百分比 max-height 会解析成 none）。
   */
  function lockCardHeight(items) {
    if (!el.wordcard) return;
    var list = items || [];
    var card = el.wordcard;
    if (!list.length) {
      /* 没有词条（理论上进不来）：退回不锁，至少不出错 */
      card.style.removeProperty('--card-h');
      CARD_H = 0;
      return;
    }

    /* 先量内容自然高度 */
    var max = 0;
    var n = Math.min(list.length, 30);
    for (var i = 0; i < n; i++) {
      var h = measureCardHeight(list[i]);
      if (h > max) max = h;
    }
    if (max <= 0) return;

    /* 再量屏幕能给的（此时清掉锁定值，stage 才有空间可量）。
       注意 stage 的 padding 也算在它能提供的高度里，而卡片是它的子元素，
       所以可用上限就是 stage 的 clientHeight（content box）再减去上下 padding。 */
    var prev = card.style.getPropertyValue('--card-h');
    card.style.removeProperty('--card-h');
    var stage = card.parentNode;
    var stageCS = getComputedStyle(stage);
    var avail = stage.clientHeight
      - parseFloat(stageCS.paddingTop || 0)
      - parseFloat(stageCS.paddingBottom || 0);
    card.style.setProperty('--card-h', prev);

    if (avail > 0 && max > avail) max = avail;

    /* 向上取整而不是向下：
       max 是从 rect 量出来的**小数**（例如 417.88），取整成 416 会凭空少掉
       1.88px，而 detectCardOverflow() 又是拿这个整数高度去分空间的 ——
       内容明明刚好放得下，却因为这点零头被判成溢出，例句被白裁到三行。
       向上取整整好让「锁定的高度 ≥ 需要的自然高度」，一分不多一分不少
       （最多多 1px，肉眼不可见）。
       仍然保留一个下限 180：极矮屏上别把卡片压得没法看。 */
    CARD_H = Math.max(180, Math.ceil(max));
    card.style.setProperty('--card-h', CARD_H + 'px');
  }

  /**
   * 当前这张卡的内容是否放不下。是则亮出「完整内容」，并给卡片加
   * is-overflow 让长文本走省略号。
   *
   * 判据：**内容的自然高度** vs **容器能给的高度**，而不是
   * scrollHeight/clientHeight。后者在这里不可靠 —— .answer 是 flex 子项、
   * 被压到固定高度且 overflow:hidden，它的 scrollHeight 会等于被压后的
   * padding box（内容是从 padding box 底部被裁掉的，padding box 本身
   * 仍是容器高度），于是「明明裁掉了内容」却判成没溢出。实测
   * comprehensive 那张就是这样漏判的。
   *
   * 自然高度的量法：临时把 .answer 放开（flex:none; height:auto;
   * overflow:visible），此时它的高度就是内容的真实高度；量完恢复。
   * 这一步会触发一次同步布局，但只在揭示答案时各做一次，可以接受。
   *
   * 另外要临时加 is-measuring 把动画位移归零：答案词的每个字母带
   * letter-up 动画（起始 translateY(10px)），动画没跑完就量，
   * 那 10px 会被算进去，让放得下的卡也误判成溢出。
   *
   * 判断依据是「**有没有真的被裁**」，而不是「内容有没有超过卡片的余量」。
   *
   * 为什么不能用「natural > avail」：卡片高度一旦被屏幕夹住
   * （lockCardHeight 取 min(自然最高, 可用空间)），可用的余量就恒小于内容，
   * 于是**每一张卡**都会被判成溢出、按钮一路亮着 —— 窄一点的手机
   * （实测 360×784 的机型，卡片被夹在 351px）上就是这样。
   * 可实际上 .answer 是 flex 子项，空间不够时它会先被压缩，
   * 文字只要没被 line-clamp 裁掉就仍然读得全，这时候按钮点了也白点。
   *
   * 所以改为比较「同一块内容，放开限制后的高度」与「实际渲染出来的高度」：
   *   · 例句被裁 → 亮按钮（这才是真需要看完整内容的情况）
   *   · 文字挤但完整 → 不亮
   * 两个量都在放开限制的状态下取，避免把 .word-pos 那个不折叠的 margin
   * 算进来（见下面 natural 的注释）。
   */
  function detectCardOverflow() {
    if (!el.wordcard || !el.answer || el.answer.hidden) return;
    var card = el.wordcard;
    var ans = el.answer;
    var ex = el.wordExample;
    card.classList.remove('is-overflow');
    card.classList.add('is-measuring');

    /* 量自然高度时两个限制都要去掉：
       · flex / min-height 去掉，它才不会被压缩；
       · 内联的 height 是上一轮 is-measuring 之后可能残留的，清掉。 */
    var prevFlex = ans.style.flex;
    var prevHeight = ans.style.height;
    var prevOverflow = ans.style.overflow;
    var prevMinH = ans.style.minHeight;
    ans.style.flex = 'none';
    ans.style.minHeight = '0';
    ans.style.height = 'auto';
    ans.style.overflow = 'visible';

    /* 这里量到的 rect 高度就是「.answer 的内容高度」：
       上面的 flex/height/overflow 三处限制一放开，盒子就按内容自然撑开。
       两个必须注意的点：
         · 不能改成 scrollHeight —— .word / .example 的截断是靠
           -webkit-line-clamp 做的，被裁掉的文字仍在盒子里，
           scrollHeight 照样算进去，量出来会偏大；
         · 也不能在**恢复样式之后**再量 rect —— .answer 会从 .word-pos
           收到一个 margin-bottom（两个盒子之间不折叠），
           而这个 margin 会被算进它下面的 rect 里，凭空多出十几像素，
           于是「内容明明装得下」也被判成溢出，卡片底下还空着就冒出
           「完整内容」按钮。放在恢复样式之前量，就没有这个 margin。 */
    var natural = ans.getBoundingClientRect().height;
    /* 例句的自然高度同样在这一刻取（此时 is-overflow 已摘掉、
       line-clamp 不生效），用来和它渲染出来的高度比。 */
    var exNatural = ex ? ex.getBoundingClientRect().height : 0;

    ans.style.flex = prevFlex;
    ans.style.minHeight = prevMinH;
    ans.style.height = prevHeight;
    ans.style.overflow = prevOverflow;
    card.classList.remove('is-measuring');

    /* 恢复样式之后，量「实际渲染出来的高度」：
       .answer 若被 flex 压过，它的 rect 会小于 natural。 */
    var rendered = ans.getBoundingClientRect().height;
    var exRendered = ex ? ex.getBoundingClientRect().height : 0;

    /* 真的被裁了才亮按钮，两种情况都算：
         · 例句被 line-clamp 裁掉 —— 这是「完整内容」最主要的用途；
         · 答案区整体被压得比自然高度还矮 —— 说明连词/发音那几行都挤了。
       1px 容差是给亚像素对齐留的余量。 */
    var exClipped = exNatural > exRendered + 1;
    var ansSqueezed = natural > rendered + 1;
    var over = exClipped || ansSqueezed;
    card.classList.toggle('is-overflow', over);
    if (el.btnFullText) el.btnFullText.hidden = !over;
  }

  /** 把当前词条的完整内容铺进「完整内容」弹窗 */
  function fillFullText() {
    if (!el.fullTextBody) return;
    var c = ST.current;
    var body = el.fullTextBody;
    body.innerHTML = '';
    if (!c) return;

    var add = function (label, text, cls) {
      if (!text) return;
      var p = document.createElement('p');
      if (label) {
        var l = document.createElement('span');
        l.className = 'ft-label';
        l.textContent = label;
        p.appendChild(l);
      }
      var t = document.createElement('span');
      if (cls) t.className = cls;
      t.textContent = text;
      p.appendChild(t);
      body.appendChild(p);
    };

    add('中文意思', c.m || '');
    add('单词', c.w || '', 'ft-word');
    if (c.p) add('词性', c.p);
    add('例句', c.e || '');
    if (c.forgot > 0) add('本轮记录', '第 ' + (c.forgot + 1) + ' 次考到');
  }

  function openFullText() {
    if (!el.fullTextModal) return;
    fillFullText();
    el.fullTextModal.hidden = false;
    if (el.btnFullText) el.btnFullText.setAttribute('aria-expanded', 'true');
    if (el.btnFullTextClose) el.btnFullTextClose.focus();
  }

  function closeFullText() {
    if (!el.fullTextModal || el.fullTextModal.hidden) return;
    el.fullTextModal.hidden = true;
    if (el.btnFullText) {
      el.btnFullText.setAttribute('aria-expanded', 'false');
      el.btnFullText.focus();
    }
  }

  /* ---------------- 发音：原生桥接优先，Web Speech 兜底 ----------------
     【为什么要有桥接】
     speechSynthesis 在桌面浏览器上走的是系统语音包，离线可用；但网页被塞进 Android
     WebView 打包成 APK 之后这条路经常断：WebView 里 getVoices() 常常返回空数组
     （没装 Google TTS、或没给 WebView 语音权限），甚至能返回音色却一点声音都没有。
     所以这里加一层桥接：原生侧实现一个对象挂到 window 上，页面优先走它；
     桌面浏览器 / 没实现桥接的壳子自动退回 Web Speech；两条路都不通时按钮不出现。

     【原生侧需要提供的对象】按 NATIVE_NAMES 顺序探测，命中第一个带 speak 函数的即采用
       speak(text, lang, rate, id)  必须。参数一律是字符串；id 是页面给的令牌，读完请回传
       stop()                       必须。立刻停掉当前朗读
       isSpeaking()                 可选。返回 true / false
       getVoices()                  可选。返回 JSON 字符串 [{"name","lang","localService"}]
       onStateChange(json)          可选。页面主动推状态，原生据此联动自己的悬浮按钮等 UI

     【原生读完 / 出错后回调页面】必须在 UI 线程执行
       webView.post(() -> webView.evaluateJavascript("WordCardSpeech.onEnd('wc1')", null));
       WordCardSpeech.onError(id, code, message)
       WordCardSpeech.onVoices('[{"name":"en-us-x","lang":"en-US","localService":true}]')

     【页面给原生的 API】挂在 window.WordCardSpeech 上，清单见下面那段导出。
     ============================================================ */
  var NATIVE_NAMES = ['WordCardNative', 'AndroidTTS', 'AndroidSpeech', 'Android'];
  var NATIVE = null;          // 命中的原生桥接对象
  var NATIVE_LOCKED = false;  // 被 setBridge 手动登记过就不再自动探测
  var SPEAK_FORCE = 'auto';   // setEngine 改这里：'auto' | 'local' | 'native' | 'web' | 'system'
  var SPEAK_MODE = 'none';    // 当前实际生效的引擎：'local' | 'native' | 'web' | 'none'
  var SPEAK_FORCED = false;   // 本轮由「发音引擎」设置固定过：voice 列表/装载完成不再改动它
  /* 发音引擎的三档选择（统计页那个模块）。存在 ST.settings.speakEngine：
       'auto'   自动：网页内置语音优先，没装载好就退到本机语音
       'local'  只用网页内置语音（实在不可用时仍会退到本机，否则按钮点了没反应）
       'system' 只用本机语音：安卓走原生桥接，其它设备走 speechSynthesis
       UI 上只给这三档，内部仍复用手上已有的一套 SPEAK_FORCE 取值。
     'system' 映射到 'system' 这一档：它表示「用本机自带的朗读功能」——安卓上是原生桥接，
     桌面浏览器上是 speechSynthesis，两者都没有时才退回网页内置语音（总比不出声强）。 */
  var SPEAK_ENGINE_MODES = ['auto', 'local', 'system'];
  var SPEAK_ENGINE_FORCE = { auto: 'auto', local: 'local', system: 'system' };
  var WEB_OK = typeof window.speechSynthesis !== 'undefined' &&
    typeof window.SpeechSynthesisUtterance === 'function';
  var speakVoice = null;      // Web Speech 选中的音色，选到之前每次点击都重试
  var speakUtter = null;      // 当前这条 Web Speech 朗读，用来分辨 onend 是不是自己那条
  var nativeVoices = null;    // 原生推过来的音色表
  var nativeLang = 'en-US';   // 交给原生的语言标记
  var nativeId = null;        // 当前这条原生朗读的令牌
  var nativeSeq = 0;
  var nativeFails = 0;        // 原生 speak 连续失败次数，够多就不再试它
  var speakOn = false;        // 是否正在读（对外 API 与状态推送都用它）
  var lastErrMsg = '';        // 同一条错误不重复弹提示

  /* 网页内置语音包（assets/tts-local.js）——不依赖系统 TTS 的那条路。
     它自己载入完成后调 mountLocal() 把引擎登记进来，在此之前恒为 null。 */
  var LOCAL = null;
  var localSeq = 0;           // 当前这条内置朗读的令牌

  // 探测原生桥接。壳子多在 loadUrl 之前 addJavascriptInterface，
  // 但也有跑完页面脚本才注入的，所以这个函数会被反复调用。
  function findNativeBridge() {
    for (var i = 0; i < NATIVE_NAMES.length; i++) {
      var o = null;
      try { o = window[NATIVE_NAMES[i]]; } catch (e) { continue; }
      if (o && typeof o.speak === 'function') return o;
    }
    return null;
  }

  function bridgeObj() {
    if (!NATIVE_LOCKED) {
      var found = findNativeBridge();
      if (found) NATIVE = found;
    }
    return NATIVE;
  }

  /* 内置语音包是否已经可以出声。资源没装完 / 装失败都算不可用，
     这时下面的 currentMode 会自动退回原生桥接或 Web Speech。 */
  function haveLocal() {
    if (!LOCAL || typeof LOCAL.ready !== 'function') return false;
    try { return !!LOCAL.ready(); } catch (e) { return false; }
  }

  /* 当前该走哪条路。优先级：内置语音包 > 原生桥接 > Web Speech。
     内置排最前是因为它才是真正的离线发音——原生桥接和 Web Speech 都会去调系统 TTS，
     而内置语音包压根不经过系统。资源没载好之前 haveLocal() 为 false，照旧走后面两条。
     原生仍在 Web Speech 前面：WebView 里 speechSynthesis 能返回对象却不出声是很常见的坑，
     只要壳子实现了桥接就优先信它。
     'system' 是「本机自带的朗读功能」这一档：先原生桥接、再 Web Speech，
     两个都没有才退回内置语音（用户明确要本机语音，但本机真没有，不出声不如出声）。 */
  function currentMode() {
    var hasNative = !!bridgeObj();
    var hasLocal = haveLocal();
    if (SPEAK_FORCE === 'local') return hasLocal ? 'local' : (hasNative ? 'native' : (WEB_OK ? 'web' : 'none'));
    if (SPEAK_FORCE === 'native') return hasNative ? 'native' : (hasLocal ? 'local' : (WEB_OK ? 'web' : 'none'));
    if (SPEAK_FORCE === 'system') return hasNative ? 'native' : (WEB_OK ? 'web' : (hasLocal ? 'local' : 'none'));
    if (SPEAK_FORCE === 'web') return WEB_OK ? 'web' : (hasLocal ? 'local' : (hasNative ? 'native' : 'none'));
    if (hasLocal) return 'local';
    if (hasNative) return 'native';
    return WEB_OK ? 'web' : 'none';
  }

  SPEAK_MODE = currentMode();   // 初始引擎，后面的 setEngine 会再改

  // 音色打分：本地语音包权重最重（离线可用），en-US 优先，联网音色往后排
  function scoreVoices(list) {
    var best = null, bestScore = -1;
    for (var i = 0; i < list.length; i++) {
      var v = list[i] || {};
      var lang = String(v.lang || '').toLowerCase();
      if (lang.indexOf('en') !== 0) continue;
      var sc = 0;
      if (lang === 'en-us') sc += 4;
      else if (lang === 'en-gb') sc += 3;
      if (v.localService) sc += 8;                                   // 离线可用，权重最重
      if (/online|natural|google|wavenet/i.test(v.name || '')) sc -= 6;  // 联网音色，能避就避
      if (sc > bestScore) { bestScore = sc; best = v; }
    }
    return best;
  }

  function pickVoice() {
    if (speakVoice) return speakVoice;
    if (!WEB_OK) return null;
    var list;
    try { list = window.speechSynthesis.getVoices() || []; } catch (e) { return null; }
    speakVoice = scoreVoices(list);
    return speakVoice;
  }

  // 把词条文本收拾成适合朗读的样子：去掉中文（词库里偶尔混着）、斜杠分号换成停顿
  function speakable(w) {
    return String(w == null ? '' : w)
      .replace(RE_SPEAK_BREAK, ', ')
      .replace(RE_SPEAK_CJK, ' ')
      .replace(RE_WS, ' ')
      .replace(RE_SPEAK_EDGE, '');
  }

  // 门禁：单词没展示出来就不算「可以读」
  function canSpeakNow() {
    return !!(ST.answered && ST.current && el.answer && !el.answer.hidden);
  }

  // 已经展示出来的词条，没展示则返回空串
  function displayedWord() {
    return canSpeakNow() ? String(ST.current.w || '') : '';
  }

  function speakState() {
    return JSON.stringify({
      speaking: speakOn,
      canSpeak: canSpeakNow(),
      word: displayedWord(),
      engine: SPEAK_MODE
    });
  }

  // 把状态推给原生，壳子可以据此点亮自己的悬浮发音按钮
  function notifyNative() {
    var b = bridgeObj();
    if (!b || typeof b.onStateChange !== 'function') return;
    try { b.onStateChange(speakState()); } catch (e) {}
  }

  function setSpeaking(on) {
    speakOn = !!on;
    el.btnSpeak.classList.toggle('is-speaking', speakOn);
    el.speakTxt.textContent = speakOn ? '朗读中' : '发音';
    notifyNative();
  }

  // 按钮可见性跟着引擎走：两条路都不通就藏起来
  function syncSpeakButton() {
    el.btnSpeak.hidden = (SPEAK_MODE === 'none');
  }

  /* 真的在读吗。自己记的 speakOn 是主信号：
     Web Speech 可以再问 speechSynthesis，原生桥接实现了 isSpeaking 也问它——
     但两边都答「在读」才算在读，免得壳子读完忘了清状态导致点一下变成「停」。 */
  function isReadingNow() {
    if (SPEAK_MODE === 'web' && WEB_OK) {
      try {
        var ss = window.speechSynthesis;
        if (ss.speaking || ss.pending) return true;
      } catch (e) {}
    } else if (SPEAK_MODE === 'native') {
      var b = bridgeObj();
      if (b && typeof b.isSpeaking === 'function') {
        var nativeSays = false;
        try { nativeSays = !!b.isSpeaking(); } catch (e) { return speakOn; }
        return speakOn && nativeSays;
      }
    }
    return speakOn;
  }

  function webStop() {
    if (!WEB_OK) return;
    try { window.speechSynthesis.cancel(); } catch (e) {}
    speakUtter = null;
    setSpeaking(false);
  }

  function nativeStop() {
    nativeId = null;
    var b = bridgeObj();
    if (b && typeof b.stop === 'function') { try { b.stop(); } catch (e) {} }
    setSpeaking(false);
  }

  function stopSpeak() {
    if (SPEAK_MODE === 'local') localStop();
    else if (SPEAK_MODE === 'native') nativeStop();
    else if (SPEAK_MODE === 'web') webStop();
    else setSpeaking(false);   // 引擎不可用时也要把 UI 复位
  }

  function webSpeak(text) {
    if (!WEB_OK) return false;
    var ss = window.speechSynthesis;
    var u = new window.SpeechSynthesisUtterance(text);
    var v = pickVoice();
    u.lang = (v && v.lang) ? v.lang : 'en-US';
    if (v) u.voice = v;
    u.rate = 0.92;      // 略慢于常速，跟读用
    u.pitch = 1;
    u.onend = u.onerror = function () {
      if (speakUtter !== u) return;
      speakUtter = null;
      setSpeaking(false);
    };
    speakUtter = u;
    setSpeaking(true);
    try {
      ss.cancel();                    // 先清干净，避免上一次卡在队列里
      if (ss.paused) ss.resume();     // Chrome 长时间静置后会自己 paused
      ss.speak(u);
      return true;
    } catch (e) {
      speakUtter = null;
      setSpeaking(false);
      return false;
    }
  }

  function nativeSpeak(text) {
    var b = bridgeObj();
    if (!b) {   // 桥接在这一刻没了，能退就退
      SPEAK_MODE = WEB_OK ? 'web' : 'none';
      return WEB_OK ? webSpeak(text) : false;
    }
    nativeId = 'wc' + (++nativeSeq);
    setSpeaking(true);
    try {
      /* 参数一律转字符串：@JavascriptInterface 只认基本类型，
         传 Object 或 undefined 在安卓侧会直接抛异常。 */
      b.speak(text, nativeLang, '0.92', nativeId);
      nativeFails = 0;
      return true;
    } catch (e) {
      /* 方法签名对不上（壳子只实现了 speak(text) 之类）就退回 Web Speech 再试一次，
         否则按钮看着能用、点了没反应，比一开始就藏起来更难查。 */
      nativeId = null;
      setSpeaking(false);
      if (window.console && console.warn) {
        console.warn('[WordCardSpeech] 原生桥接 speak() 调用失败，本次回退 Web Speech：', e);
      }
      // 连着几次都失败就别再试原生了，本会话固定走 Web Speech
      if (WEB_OK && ++nativeFails >= 3) SPEAK_FORCE = 'web';
      SPEAK_MODE = WEB_OK ? 'web' : 'none';
      return WEB_OK ? webSpeak(text) : false;
    }
  }

  /* 内置语音包这条路。它的接口比桥接多一个回调：
     engine.speak(text, lang, rate, id, done)，done(err) 在读完或出错后回调。 */
  function localSpeak(text) {
    if (!haveLocal()) {          // 引擎在这一刻还没装好／已崩，能退就退
      SPEAK_MODE = currentMode();
      if (SPEAK_MODE === 'local') SPEAK_MODE = bridgeObj() ? 'native' : (WEB_OK ? 'web' : 'none');
      if (SPEAK_MODE === 'native') return nativeSpeak(text);
      return SPEAK_MODE === 'web' ? webSpeak(text) : false;
    }
    var id = 'lc' + (++localSeq);
    setSpeaking(true);
    try {
      var started = LOCAL.speak(text, nativeLang, '0.92', id, function (err) {
        if (String(id) !== 'lc' + localSeq) return;   // 不是当前这条，忽略
        setSpeaking(false);
        if (err) {
          var msg = '发音失败：' + ((err && err.message) ? err.message : '内置语音合成出错');
          if (msg !== lastErrMsg) { lastErrMsg = msg; toast(msg); }
        }
      });
      if (started === false) throw new Error('内置语音未能开始合成');
      return true;
    } catch (e) {
      /* 内置引擎临时出问题（比如内存不够）就退回其它引擎，别让按钮点了没反应 */
      localSeq++;                 // 作废上面那条回调
      setSpeaking(false);
      if (window.console && console.warn) {
        console.warn('[WordCardSpeech] 内置语音失败，本次回退：', e);
      }
      SPEAK_MODE = bridgeObj() ? 'native' : (WEB_OK ? 'web' : 'none');
      if (SPEAK_MODE === 'native') return nativeSpeak(text);
      return SPEAK_MODE === 'web' ? webSpeak(text) : false;
    }
  }

  function localStop() {
    localSeq++;                   // 作废正在排队的那条朗读
    if (LOCAL && typeof LOCAL.stop === 'function') { try { LOCAL.stop(); } catch (e) {} }
    setSpeaking(false);
  }

  // 送一段文本去读。不查门禁——外部 API 直接调这个，时机由调用方负责。
  function readText(text) {
    text = String(text == null ? '' : text);
    if (!text) return false;
    SPEAK_MODE = currentMode();
    if (SPEAK_MODE === 'local') return localSpeak(text);
    if (SPEAK_MODE === 'native') return nativeSpeak(text);
    if (SPEAK_MODE === 'web') return webSpeak(text);
    return false;
  }

  function speakWord() {
    if (currentMode() === 'none') return;
    /* 门禁：单词没展示出来就不给读。
       .answer 隐藏时按钮本来也点不到，这里再挡一道，
       是为了防住快捷键 / 脚本触发绕过界面。 */
    if (!canSpeakNow()) return;
    var text = speakable(ST.current.w);
    if (!text) return;
    if (isReadingNow()) { stopSpeak(); return; }   // 正在读 → 再点一下就是停
    readText(text);
  }

  /* ---- 原生 → 页面的回调入口（都挂在 window.WordCardSpeech 上） ---- */

  function parseVoices(json) {
    var list = json;
    if (typeof json === 'string') {
      try { list = JSON.parse(json); } catch (e) { return []; }
    }
    if (!list || typeof list.length !== 'number') return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i] || {};
      out.push({
        name: String(v.name || ''),
        lang: String(v.lang || ''),
        localService: v.localService !== false   // 原生音色默认当离线可用
      });
    }
    return out;
  }

  function nativeSetVoices(json) {
    nativeVoices = parseVoices(json);
    var best = scoreVoices(nativeVoices);
    if (best && best.lang) nativeLang = best.lang;
    return nativeVoices.length;
  }

  function nativeEnd(id) {
    if (id && nativeId && String(id) !== nativeId) return;   // 不是当前这条，忽略
    nativeId = null;
    setSpeaking(false);
  }

  function nativeError(id, code, message) {
    if (id && nativeId && String(id) !== nativeId) return;
    nativeId = null;
    setSpeaking(false);
    var msg = '发音失败：' + (message || code || '系统语音引擎没有响应');
    if (msg !== lastErrMsg) { lastErrMsg = msg; toast(msg); }
  }

  /* ---------------- 对外 API：window.WordCardSpeech ----------------
     APK / 原生壳子拿它做三件事：
       1) 读状态：engine / available() / canSpeak() / speaking() / currentWord() / state()
       2) 触发朗读：speak(text) / speakCurrent() / stop()
       3) 回报结果：onEnd(id) / onError(id, code, msg) / onVoices(json)
     桌面浏览器里这个对象同样存在；引擎优先用网页内置语音包（assets/tts-local.js），
     它还没装好或装失败时依次退回原生桥接、Web Speech。 */
  window.WordCardSpeech = {
    /* 当前引擎：'local'（网页内置语音包，纯离线）| 'native'（走壳子桥接）|
       'web'（Web Speech）| 'none'（不可用） */
    get engine() { return SPEAK_MODE; },
    /* 桥接协议版本，原生侧可据此做兼容判断 */
    version: '1.0.0',

    /* 有没有可用的朗读能力。false 时卡片上的发音按钮是隐藏的 */
    available: function () { return currentMode() !== 'none'; },
    /* 当前卡片的词是否已经展示出来——没展示就不允许读，和按钮同一道门禁 */
    canSpeak: function () { return canSpeakNow(); },
    /* 现在是否正在朗读 */
    speaking: function () { return isReadingNow(); },
    /* 已经展示出来的单词/词组；没展示则返回空串 */
    currentWord: function () { return displayedWord(); },
    /* 一次性状态快照（JSON 字符串），方便原生打日志 */
    state: function () { return speakState(); },

    /* 朗读指定文本：给壳子用的硬通道，不查门禁，时机由调用方自己负责 */
    speak: function (text) { return readText(speakable(text)); },
    /* 等价于点一下「发音」按钮：正在读就停，否则读当前卡片（门禁照查）。
       返回调用后是否处于朗读状态。 */
    speakCurrent: function () { speakWord(); return speakOn; },
    /* 立刻停止 */
    stop: function () { stopSpeak(); },

    /* 强制指定引擎：'local' | 'native' | 'web' | 'system' | 'auto'。
       'system' 表示「本机自带的朗读功能」，原生桥接与 speechSynthesis 都算。
       壳子自测、桌面端排查都用得上。返回切换后实际生效的引擎。 */
    setEngine: function (mode) {
      SPEAK_FORCE = (mode === 'local' || mode === 'native' || mode === 'web' || mode === 'system') ? mode : 'auto';
      SPEAK_FORCED = true;  // 显式指定过：内置语音之后才装载完也不再自动抢回来
      nativeFails = 0;      // 手动切过引擎，重新给原生一次机会
      SPEAK_MODE = currentMode();
      syncSpeakButton();
      return SPEAK_MODE;
    },
    /* 手动登记桥接对象：壳子把对象挂在别的名字下时用（登记后不再自动探测） */
    setBridge: function (obj) {
      if (!obj || typeof obj.speak !== 'function') return false;
      NATIVE = obj;
      NATIVE_LOCKED = true;
      SPEAK_MODE = currentMode();
      syncSpeakButton();
      return true;
    },

    /* 登记网页内置语音引擎：assets/tts-local.js 载入完成后自己调这里。
       引擎对象需要 ready() / speak(text, lang, rate, id, done) / stop()，
       可选 state() / error() / isSpeaking() / poke()。
       资源没装完时引擎还不出声，这里轮询等它，装好立刻切过来说话。 */
    mountLocal: function (engine) {
      if (!engine || typeof engine.speak !== 'function' || typeof engine.ready !== 'function') return false;
      LOCAL = engine;
      if (typeof LOCAL.poke === 'function') { try { LOCAL.poke(); } catch (e) {} }
      SPEAK_MODE = currentMode();
      syncSpeakButton();
      renderSpeakEngine();   // 内置语音装载进度/失败要反映到「发音引擎」那块摘要上
      if (haveLocal()) {
        if (window.console && console.log) {
          console.log('[WordCardSpeech] 已切到网页内置语音：' + (LOCAL.voice || ''));
        }
        return true;
      }
      var n = 0;
      (function tick() {
        if (haveLocal()) {
          SPEAK_MODE = currentMode();
          syncSpeakButton();
          notifyNative();
          renderSpeakEngine();
          if (window.console && console.log) {
            console.log('[WordCardSpeech] 已切到网页内置语音：' + (LOCAL.voice || ''));
          }
          return;
        }
        var st = '';
        try { st = LOCAL.state ? String(LOCAL.state()) : ''; } catch (e) { st = 'error'; }
        if (st === 'error') return;      // 引擎已放弃，别再空转
        if (++n > 600) return;           // 最多等约两分钟
        window.setTimeout(tick, 200);
      })();
      return true;
    },

    /* ↓ 原生侧回调入口，配合 webView.evaluateJavascript 调用 */
    onEnd: nativeEnd,
    onError: nativeError,
    onVoices: nativeSetVoices
  };

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function clean(v) {
    if (v == null) return '';
    var s = typeof v === 'string' ? v : String(v);
    // 绝大多数单元格本来就没有多余空白，直接返回，省掉正则替换与 trim 的开销
    if (!RE_HAS_WS.test(s)) return s;
    return s.replace(RE_WS, ' ').trim();
  }

  function fmtTime(ms) {
    var s = Math.round(ms / 1000);
    var m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  function timeAgo(ts) {
    if (!ts) return '';
    var d = Date.now() - ts;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.round(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.round(d / 3600000) + ' 小时前';
    return Math.round(d / 86400000) + ' 天前';
  }

  function uid() {
    return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* ---------------- 日期工具（统计 / 热力图） ---------------- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function dayKey(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function todayKey() { return dayKey(new Date()); }

  function parseDay(k) {
    var p = String(k).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  function shiftDay(k, delta) {
    var d = parseDay(k);
    d.setDate(d.getDate() + delta);
    return dayKey(d);
  }

  function fmtDay(k) {
    var d = parseDay(k);
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }

  function newStats() {
    return { v: 1, days: {}, books: {}, words: {} };
  }

  /* ---------------- 存取：词书库 / 设置 ---------------- */
  // 词书部分体积最大，勾选变化时复用它，避免每次都把整份表格重新序列化
  function booksJson() {
    if (SVER !== STEP) { SCACHE = JSON.stringify(ST.books); SVER = STEP; }
    return SCACHE;
  }

  /* 落盘分两份，各写各的键：
     - 词书表（含整份表格，通常 1 MB 上下）体积巨大，只在词书本身或勾选变化时才写；
     - 覆盖进度（几十 KB）单独一个键，背词每答一张卡只重写它。
     以前每答一张卡都要把整份词书表拼进去重写一遍，几十 KB 的进度被放大成 MB 级写盘。 */
  function saveProg() {
    if (SAVED_PROG === PROGVER) return true;
    var pj = progJsonOf();
    try {
      if (pj === '{}') localStorage.removeItem(LS_PROG);
      else localStorage.setItem(LS_PROG, pj);
      SAVED_PROG = PROGVER;
      return true;
    } catch (e) { return false; }
  }

  function saveStore() {
    pendingStore = false;
    var ok = saveProg();
    var selJson = JSON.stringify(Object.keys(ST.selected));
    if (SAVED_VER !== STEP || SAVED_SEL !== selJson) {   // 词书表 / 勾选没变就不重复写盘
      try {
        localStorage.setItem(LS_BOOKS, '{"v":2,"books":' + booksJson() + ',"selected":' + selJson + '}');
        SAVED_VER = STEP;
        SAVED_SEL = selJson;
      } catch (e) { ok = false; }
    }
    if (!ok) toast('浏览器存储空间不足，这次改动没能保存到本地（当前会话仍可正常使用）');
    return ok;
  }

  // 覆盖进度落盘片段：{ bookId: [词键…] }。进度条只认「词书里真实存在」的词，
  // 所以存键比存整条词省得多，编辑改列后对不上的旧键会被自动忽略。
  function readProgStore() {
    var raw = null;
    try { raw = localStorage.getItem(LS_PROG); } catch (e) {}
    if (!raw) return null;
    try {
      var d = JSON.parse(raw);
      return d && typeof d === 'object' ? d : null;
    } catch (e) { return null; }
  }

  // 覆盖进度的纯对象形式：{ bookId: [词键…] }。存盘与导出备份共用同一个形状，
  // 保证「备份里那份进度」和「本机存的那份」永远对得上。
  function progPlain() {
    var out = {};
    Object.keys(ST.prog).forEach(function (id) {
      var keys = Object.keys(ST.prog[id]);
      if (keys.length) out[id] = keys;
    });
    return out;
  }

  function progJsonOf() {
    if (PJSON_VER === PROGVER && PJSON !== null) return PJSON;
    PJSON = JSON.stringify(progPlain());
    PJSON_VER = PROGVER;
    return PJSON;
  }

  function saveStoreSoon() {
    pendingStore = true;
    scheduleWrite('saveTimer', function () { if (pendingStore) saveStore(); });
  }

  // 离开页面 / 切到后台前，把还没落盘的改动立刻写下去
  function flushSaves() {
    if (ST.saveTimer) { clearTimeout(ST.saveTimer); ST.saveTimer = null; }
    if (ST.statsTimer) { clearTimeout(ST.statsTimer); ST.statsTimer = null; }
    if (ST.reviewTimer) { clearTimeout(ST.reviewTimer); ST.reviewTimer = null; }
    if (pendingStore) saveStore();
    if (pendingStats) saveStats();
    if (pendingReview) saveReview();
  }

  /* ---------------- 分批背词 & 覆盖进度 ----------------
     规则：一本词书的词数超过「每本每轮上限」（默认 50）时，一轮最多只取这么多词；
     多本一起勾选时，每本各按自己的上限取（合起来可能超过 50）。
     只有答过「记得」的词才算这本词书里「过了一遍」，进度随背随存、刷新不丢；
     一本书的词全部过完一遍之后，再开始新一轮才会把它的进度清零、从头再背。 */
  function batchSize() {
    var n = ST.settings.batch;
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return DEFAULT_BATCH;
    return Math.floor(n);
  }

  // 进度表：bookId -> { 词键 -> 1 }
  function progMap(id, make) {
    var m = ST.prog[id];
    if (!m && make) m = ST.prog[id] = Object.create(null);
    return m || null;
  }

  // 记一个词「过了一遍」；返回是不是新记的（撤销时要按这个精确回滚）
  function markDone(id, key) {
    if (!id || !key || id === REVIEW_ID) return false;
    var m = progMap(id, true);
    if (m[key]) return false;
    m[key] = 1;
    PROGVER++;
    return true;
  }

  function clearProg(id) {
    if (ST.prog[id]) { delete ST.prog[id]; PROGVER++; }
  }

  // 这本词书里已经过了一遍多少个词（只数词书里真实存在的词，改列后对不上的旧键自动忽略）
  function coverStat(b) {
    if (!b || b.virtual) return { done: 0, total: 0, rest: 0 };
    if (COVVER !== PROGVER || COVSTEP !== STEP) { COVCACHE = {}; COVVER = PROGVER; COVSTEP = STEP; }
    var hit = COVCACHE[b.id];
    if (hit) return hit;
    var ws = wordsOf(b), m = ST.prog[b.id] || null, done = 0;
    if (m) {
      for (var i = 0; i < ws.length; i++) {
        if (m[ws[i].wl || ws[i].w.toLowerCase()]) done++;
      }
    }
    return (COVCACHE[b.id] = { done: done, total: ws.length, rest: ws.length - done });
  }

  // 本轮「每本词书各取哪些词」。返回 [{ book, words, cs, batch, restart }]：
  //   batch   —— 这本受上限约束（词数超过上限）
  //   restart —— 这本已经全部过完一遍，本轮要点「从头再背」，开始这一轮时才清零它的进度
  function batchPlan() {
    var bs = batchSize();
    if (PLAN && PLANVER === STEP && PLANSEL === SELVER && PLANPROG === PROGVER && PLANBATCH === bs) return PLAN;
    var plan = [];
    selectedBooks().forEach(function (b) {
      var ws = wordsOf(b);
      if (b.virtual || !bs) {          // 复习本有自己的 20 词额度；设成「不限」就整本上
        plan.push({ book: b, words: ws, cs: coverStat(b), batch: false, restart: false });
        return;
      }
      var cs = coverStat(b);
      if (cs.total <= bs) {            // 没超过上限：照旧整本一轮背完
        plan.push({ book: b, words: ws, cs: cs, batch: false, restart: false });
        return;
      }
      var m = ST.prog[b.id] || null, fresh = [], i;
      for (i = 0; i < ws.length && fresh.length < bs; i++) {
        if (m && m[ws[i].wl || ws[i].w.toLowerCase()]) continue;
        fresh.push(ws[i]);
      }
      if (fresh.length) plan.push({ book: b, words: fresh, cs: cs, batch: true, restart: false });
      else plan.push({ book: b, words: ws.slice(0, bs), cs: cs, batch: true, restart: true });
    });
    PLAN = plan; PLANVER = STEP; PLANSEL = SELVER; PLANPROG = PROGVER; PLANBATCH = bs;
    return plan;
  }

  // 把各本取出来的词合成一轮的清单：同一个英文只留一条，src 记下它来自哪些词书
  function planWords(plan) {
    var seen = Object.create(null), out = [];
    plan.forEach(function (p) {
      p.words.forEach(function (x) {
        var k = x.wl || x.w.toLowerCase();
        var hit = seen[k];
        if (hit) {
          if (hit.src.indexOf(p.book.id) < 0) hit.src.push(p.book.id);
          if (x.rev) hit.rev = true;
          return;
        }
        seen[k] = { w: x.w, m: x.m, wl: k, p: x.p, e: x.e, src: [p.book.id], rev: !!x.rev };
        out.push(seen[k]);
      });
    });
    return out;
  }

  // 本轮允许计入进度的词（bookId -> { 词键 -> 1 }）：只有真的在本轮清单里的词才算，
  // 免得「复习本里的词刚好也属于某本词书」把没背到的进度也算进去。
  function creditFrom(plan) {
    var credit = Object.create(null);
    plan.forEach(function (p) {
      if (p.book.virtual) return;
      var keys = credit[p.book.id] || (credit[p.book.id] = Object.create(null));
      p.words.forEach(function (x) { keys[x.wl || x.w.toLowerCase()] = 1; });
    });
    return credit;
  }

  // 词书库那一行的「继续背」：只勾这一本，立刻背它还没过一遍的那批词
  function startBatch(id) {
    if (!bookById(id)) return;
    Object.keys(ST.selected).forEach(function (k) { delete ST.selected[k]; });
    ST.selected[id] = true;
    touchSel();
    updateSummary();
    startRound();
  }

  /* ---------------- 复习本（动态词书） ----------------
     收录：背词时答「不记得」的词自动进来，已经收录过的只累加遗忘次数。
     权重：遗忘次数是主项，隔得越久越该复习，连续记住则快速降权。
     额度：每次复习最多取 REVIEW_BATCH 个，按权重从高到低取。 */
  function loadReview() {
    var raw = null;
    try { raw = localStorage.getItem(LS_REVIEW); } catch (e) {}
    if (!raw) return;
    try {
      var d = JSON.parse(raw);
      if (!d || !d.items) return;
      var out = Object.create(null), k, it;
      for (k in d.items) {
        it = d.items[k];
        if (!it || !it.w || !it.m) continue;
        out[k] = {
          w: it.w, m: it.m, p: it.p || '', e: it.e || '',
          f: it.f > 0 ? it.f : 1,          // 累计遗忘次数
          ok: it.ok > 0 ? it.ok : 0,       // 进入复习本后连续记住的次数
          done: !!it.done,                 // 是否已消化
          added: it.added || Date.now(),
          last: it.last || it.added || Date.now()
        };
      }
      ST.review.items = out;
      touchData();
    } catch (e) {}
  }

  function saveReview() {
    pendingReview = false;
    try {
      localStorage.setItem(LS_REVIEW, JSON.stringify({ v: 1, items: ST.review.items }));
      return true;
    } catch (e) {
      toast('复习本保存失败（本地存储已满），可以先清空复习本');
      return false;
    }
  }

  function saveReviewSoon() {
    pendingReview = true;
    scheduleWrite('reviewTimer', function () { if (pendingReview) saveReview(); });
  }

  // 复习权重：遗忘次数是主项，隔得越久越该复习，连续记住的快速降权
  function reviewWeight(it, now) {
    var f = it.f > 0 ? it.f : 1;
    var days = Math.max(0, (now - (it.last || it.added || now)) / 86400000);
    var w = (1 + (f - 1) * 1.6) * (1 + Math.min(days, 30) / 10) / (1 + 0.9 * (it.ok || 0));
    return w > 0.1 ? w : 0.1;
  }

  // 待复习条目（已消化的不算），按权重从高到低排好
  function reviewRanked(now) {
    var items = ST.review.items, arr = [], k, it;
    now = now || Date.now();
    for (k in items) {
      it = items[k];
      if (it.done) continue;
      arr.push({ k: k, it: it, w: reviewWeight(it, now) });
    }
    // 权重相同的：先看遗忘次数，再看谁更久没碰过（时间戳小的排前面），保证顺序稳定
    arr.sort(function (a, b) {
      if (b.w !== a.w) return b.w - a.w;
      if (b.it.f !== a.it.f) return b.it.f - a.it.f;
      return (a.it.last || 0) - (b.it.last || 0);
    });
    return arr;
  }

  // 一遍数出「待复习」和「总条数」，按数据版本缓存：同一份数据被问多少次都只数一遍
  function recountReview() {
    var items = ST.review.items, p = 0, t = 0, k;
    for (k in items) { t++; if (!items[k].done) p++; }
    RVPEND = p; RVTOT = t; RVVER = STEP;
  }
  function reviewPendingCount() { if (RVVER !== STEP) recountReview(); return RVPEND; }
  function reviewTotalCount() { if (RVVER !== STEP) recountReview(); return RVTOT; }

  // 本轮要复习的词条：取权重最高的前 REVIEW_BATCH 个（这就是「每次复习不超过 20 个」的落点）
  function reviewQueue() {
    var ranked = reviewRanked(), out = [];
    for (var i = 0; i < ranked.length && i < REVIEW_BATCH; i++) {
      var it = ranked[i].it;
      out.push({
        w: it.w, m: it.m, wl: ranked[i].k, p: it.p || '', e: it.e || '',
        src: [REVIEW_ID], rev: true
      });
    }
    return out;
  }

  // 条目太多了就瘦身：先淘汰已消化的，再淘汰权重低的
  function pruneReview() {
    var items = ST.review.items;
    var keys = Object.keys(items);
    if (keys.length <= MAX_REVIEW) return;
    var now = Date.now();
    keys.sort(function (a, b) {
      var x = items[a], y = items[b];
      if (!!x.done !== !!y.done) return x.done ? -1 : 1;
      return reviewWeight(x, now) - reviewWeight(y, now);
    });
    keys.slice(0, keys.length - MAX_REVIEW).forEach(function (k) { delete items[k]; });
  }

  // 答「不记得」：收录 / 累加遗忘次数，并把它重新放回复习队列
  function reviewCollect(item) {
    var k = item.wl || (item.w || '').toLowerCase();
    if (!k || !item.w || !item.m) return null;
    var now = Date.now();
    var it = ST.review.items[k];
    if (!it) {
      it = ST.review.items[k] = {
        w: item.w, m: item.m, p: item.p || '', e: item.e || '',
        f: 0, ok: 0, done: false, added: now, last: now
      };
    }
    it.w = item.w;
    it.m = item.m;
    if (item.p) it.p = item.p;
    if (item.e) it.e = item.e;
    it.f++;                                        // 遗忘次数 +1：权重随之抬高
    it.ok = 0;                                      // 又忘了，连续记住清零
    it.done = false;                                // 已消化的重新回到复习队列
    it.last = now;
    pruneReview();
    reviewChanged();
    return it;
  }

  // 答「记得」：连续记住 +1，够次数就算消化（权重自然降下来）
  function reviewPass(item) {
    var k = item.wl || (item.w || '').toLowerCase();
    var it = k ? ST.review.items[k] : null;
    if (!it) return false;
    it.ok = (it.ok || 0) + 1;
    it.last = Date.now();
    var cleared = false;
    if (!it.done && it.ok >= REVIEW_DONE_OK) { it.done = true; cleared = true; }
    reviewChanged();
    return cleared;
  }

  function reviewChanged() {
    touchData();          // 词书相关缓存（含复习本这一本）全部失效
    dropCache(REVIEW_ID);
    saveReviewSoon();
  }

  // 撤销用：记下这个词进复习本之前的模样
  function reviewSnapshot(k) {
    var it = k ? ST.review.items[k] : null;
    return it ? JSON.parse(JSON.stringify(it)) : null;
  }

  function reviewRestore(k, snap) {
    if (!k) return;
    var has = Object.prototype.hasOwnProperty.call(ST.review.items, k);
    // 撤销的这一步本来就没动过复习本，别白跑一次缓存失效和存盘
    if (!snap && !has) return;
    if (snap) ST.review.items[k] = snap; else delete ST.review.items[k];
    reviewChanged();
  }

  // 复习本作为一本「动态词书」参与勾选与合并：只有被选中且有待复习内容时才出现
  function reviewBook() {
    return {
      id: REVIEW_ID, virtual: true, name: '复习本',
      fileName: '（动态收录）', sheetName: '遗忘词自动收录',
      count: reviewPendingCount(), importedAt: 0
    };
  }

  function normalizeBook(b) {
    b.id = b.id || uid();
    b.name = clean(b.name) || clean(b.sheetName) || '未命名词书';
    b.mapping = Object.assign({ w: 0, m: 1, p: -1, e: -1 }, b.mapping || {});
    b.grid = Array.isArray(b.grid) ? b.grid : [];
    b.headers = Array.isArray(b.headers) && b.headers.length ? b.headers : [];
    if (!b.headers.length) {
      var n = 1;
      b.grid.forEach(function (r) { if (r.length > n) n = r.length; });
      for (var i = 0; i < n; i++) b.headers.push('第 ' + (i + 1) + ' 列');
    }
    // count 在导入 / 改列 / 迁移时已经算好并落盘了，重新读盘时直接用它：
    // 不必为了几百上千行的表格在每次打开网页时再全表扫一遍。
    // （只有确实缺这个字段的旧数据才现算。）
    b.count = (typeof b.count === 'number' && b.count >= 0)
      ? b.count
      : countWords(b.grid, !!b.hasHeader, b.mapping);
    b.importedAt = b.importedAt || Date.now();
    return b;
  }

  function loadStore() {
    var raw = null;
    try { raw = localStorage.getItem(LS_BOOKS); } catch (e) {}
    if (raw) {
      try {
        var d = JSON.parse(raw);
        if (d && d.books && d.books.length) {
          ST.books = d.books.map(normalizeBook);
          (d.selected || []).forEach(function (id) { ST.selected[id] = true; });
          // 覆盖进度：新版本存在单独的键（danci.prog.v1）里，旧版本塞在词书表里。
          // 两份都读、逐本并集（同一本书两边都有就合并，谁都不丢），读完把词书表里那份副本清掉。
          // 注意不能「新键里有这本就不管旧键」——半升级状态下新键可能只有零星几条，
          // 那样旧键里更完整的那份进度会被整个遮蔽掉。
          var prog = readProgStore();
          var legacy = !!(d.prog && typeof d.prog === 'object');
          if (legacy) {
            if (!prog) prog = {};
            Object.keys(d.prog).forEach(function (id) {
              var old = d.prog[id];
              if (!old || typeof old.length !== 'number' || !old.length) return;
              var cur = prog[id];
              if (!cur || typeof cur.length !== 'number' || !cur.length) { prog[id] = old; return; }
              var seen = Object.create(null), add = [];
              cur.forEach(function (k) { if (k) seen[k] = 1; });
              old.forEach(function (k) { if (k && !seen[k]) { seen[k] = 1; add.push(k); } });
              if (add.length) prog[id] = cur.concat(add);
            });
          }
          if (prog) {
            var alive = Object.create(null);
            ST.books.forEach(function (b) { alive[b.id] = true; });
            Object.keys(prog).forEach(function (id) {
              if (!alive[id] || !prog[id] || !prog[id].length) return;
              var m = Object.create(null);
              prog[id].forEach(function (k) { if (k) m[k] = 1; });
              ST.prog[id] = m;
            });
            PROGVER++;
          }
          pruneSelection();
          // 旧数据：进度已经搬到新键，让下一次写盘把词书表里那份多余的 prog 去掉
          if (legacy) { SAVED_VER = -1; SAVED_SEL = null; saveStore(); }
          return;
        }
      } catch (e) {}
    }
    migrateOldLibrary();
    pruneSelection();
  }

  // 把旧版「单本词书」数据升级成词书库（旧文件缓存过的工作表各成一本）
  function migrateOldLibrary() {
    var raw = null;
    try { raw = localStorage.getItem(LS_OLD); } catch (e) {}
    if (!raw) return;
    try {
      var d = JSON.parse(raw);
      var sheets = d && d.sheets ? d.sheets : {};
      var names = Object.keys(sheets);
      names.forEach(function (name) {
        var rows = normalizeGrid(sheets[name]);
        var a = analyzeRows(rows);
        if (!a || !a.count) return;
        var mp = (name === d.sheetName && d.mapping) ? d.mapping : a.mapping;
        a.mapping = Object.assign({}, a.mapping, mp);
        a.count = countWords(rows, a.hasHeader, a.mapping);
        if (!a.count) return;
        ST.books.push({
          id: uid(),
          name: names.length > 1 ? name : (d.fileName || name).replace(RE_EXT, ''),
          fileName: d.fileName || '（旧数据）',
          sheetName: name,
          sheetCount: names.length,
          grid: rows,
          hasHeader: a.hasHeader,
          headers: a.headers,
          mapping: a.mapping,
          count: a.count,
          importedAt: d.ts || Date.now()
        });
      });
      if (ST.books.length) {
        ST.selected[ST.books[0].id] = true;
        saveStore();
      }
      localStorage.removeItem(LS_OLD);
    } catch (e) {}
  }

  function pruneSelection() {
    var ids = {};
    ST.books.forEach(function (b) { ids[b.id] = true; });
    Object.keys(ST.selected).forEach(function (id) { if (!ids[id] && id !== REVIEW_ID) delete ST.selected[id]; });
    // 复习本不属于词书列表，单独判断：空了的复习本没必要再勾着
    if (ST.selected[REVIEW_ID] && !reviewPendingCount()) delete ST.selected[REVIEW_ID];
    if (!Object.keys(ST.selected).length && ST.books.length) ST.selected[ST.books[0].id] = true;
    touchData();
  }

  // 把 ST.settings 反映到设置面板的控件上（开机读盘、导入备份后共用同一套回填逻辑）
  function syncSettingsUI() {
    if (!ST.settings.collapsed || typeof ST.settings.collapsed !== 'object') ST.settings.collapsed = {};
    el.optShuffle.checked = !!ST.settings.shuffle;
    // 重排方式：备份文件里可能是别的值，认不出来就退回默认的「随机」
    el.selRequeue.value = REQUEUE_OK[ST.settings.requeue] ? ST.settings.requeue : 'random';
    // 每本每轮上限：存的值如果在选项里对不上（老数据 / 手改过 / 备份里是别的值），退回默认 50
    var bs = batchSize();
    el.selBatch.value = String(bs);
    if (el.selBatch.value !== String(bs)) {
      ST.settings.batch = DEFAULT_BATCH;
      el.selBatch.value = String(DEFAULT_BATCH);
    }
    // 发音引擎：把存下来的选择回填到面板上（真正切换引擎由下面的 bootSpeakEngine 负责）
    renderSpeakEngine();
  }

  function loadSettings() {
    try {
      var raw = localStorage.getItem(LS_SET);
      if (raw) Object.assign(ST.settings, JSON.parse(raw));
    } catch (e) {}
    syncSettingsUI();
  }

  function saveSettings() {
    try { localStorage.setItem(LS_SET, JSON.stringify(ST.settings)); } catch (e) {}
  }

  /* ---------------- 学习统计：读写 ---------------- */
  function loadStats() {
    var raw = null;
    try { raw = localStorage.getItem(LS_STATS); } catch (e) {}
    if (!raw) return;
    try {
      var d = JSON.parse(raw);
      if (!d || !d.days) return;
      ST.stats = {
        v: 1,
        days: d.days || {},
        books: d.books || {},
        words: d.words || {}
      };
      STATS_VER++;
    } catch (e) {}
  }

  // 词级别的记录容易越攒越多，超出上限时淘汰最久没碰过的
  function pruneWordStats() {
    var keys = Object.keys(ST.stats.words);
    if (keys.length <= MAX_WORD_STAT) return;
    keys.sort(function (a, b) { return (ST.stats.words[a].t || 0) - (ST.stats.words[b].t || 0); });
    keys.slice(0, keys.length - MAX_WORD_STAT).forEach(function (k) { delete ST.stats.words[k]; });
  }

  function saveStats() {
    pendingStats = false;
    pruneWordStats();
    try {
      localStorage.setItem(LS_STATS, JSON.stringify(ST.stats));
      return true;
    } catch (e) {
      toast('学习统计保存失败（本地存储已满），可以先清空部分词书');
      return false;
    }
  }

  function saveStatsSoon() {
    pendingStats = true;
    scheduleWrite('statsTimer', function () { if (pendingStats) saveStats(); });
  }

  /* ---------------- 导出 / 导入备份 ----------------
     备份的目标是「换设备 / 清浏览器数据后能原样接着背」，所以本机存的六类数据全都装进来：
       books     词书库（含导入的表格内容，以及在内置编辑里改过的列映射 / 冲突修正）
       selected  勾选状态（哪些词书参与背词）
       prog      覆盖进度（每本词书已经过了一遍哪些词）
       review    复习本词表（哪些词还没拿下）
       stats     学习统计（含热力图每天的学习用时 d.t）
       settings  用户设置（乱序 / 提示 / 重排 / 每本每轮上限 / 分组折叠）
     词书原 Excel 也一并打包：用户在内置编辑里改过的内容不会回写原文件，只留原始
     Excel 是还原不出来的；不装的话，复习本和统计里的词条还会变成没有归属的孤儿数据。 */
  // 统计里的日期键：既要挡掉「2026-13-99」这种看着像日期实则没有的键（会被算进累计天数），
  // 也要顺带挡掉 '__proto__' —— 这类键会被当成对象的属性名，直接赋值会改掉原型
  var RE_DAY_KEY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  // 已过一遍的词条总数（跨所有词书），只用于备份摘要里的一句话
  function progTotalCount() {
    var n = 0;
    Object.keys(ST.prog).forEach(function (id) { n += Object.keys(ST.prog[id]).length; });
    return n;
  }

  function clampInt(v, min) {
    var n = Math.floor(+v);
    if (!isFinite(n) || n < min) return min;
    return n;
  }

  function backupSummaryText() {
    return '词书 ' + ST.books.length + ' 本（勾选 ' + Object.keys(ST.selected).length + '） · 背词进度 ' +
      progTotalCount() + ' 词 · 复习本 ' + reviewTotalCount() + ' 条（待复习 ' + reviewPendingCount() +
      '） · 学习记录 ' + Object.keys(ST.stats.books).length + ' 本词书 / ' +
      Object.keys(ST.stats.days).length + ' 天 / ' +
      Object.keys(ST.stats.words).length + ' 个词条';
  }

  function renderBackup() {
    el.backupSummary.textContent = '当前可导出：' + backupSummaryText() + '。';
  }

  /* ---------------- 发音引擎：用网页内置的，还是用电脑 / 手机内置的 ----------------
     这里只负责「选择 + 说明 + 试听」，真正的切换交给 WordCardSpeech.setEngine()，
     三档设置映射到它已有的取值上（见上面 SPEAK_ENGINE_FORCE 的说明）。
     设置存 ST.settings.speakEngine，跟着「数据备份」一起走，
     导入的备份里如果是个认不出来的值，就退回 'auto'（见 sanitizeSettings）。 */
  function speakEnginePref() {
    var v = ST.settings ? ST.settings.speakEngine : null;
    return SPEAK_ENGINE_MODES.indexOf(v) >= 0 ? v : 'auto';
  }

  // 本机语音实际走的是哪条路：安卓壳子给了桥接就是原生 TTS，其它浏览器是 Web Speech
  function systemEngineKind() {
    if (bridgeObj()) return 'native';
    return WEB_OK ? 'web' : 'none';
  }

  function speakModeText(mode) {
    if (mode === 'local') return '网页内置语音';
    if (mode === 'native') return '本机语音（安卓原生 TTS）';
    if (mode === 'web') return '本机语音（浏览器 speechSynthesis）';
    return '没有可用的发音引擎';
  }
  function speakEngineText(pref) {
    return pref === 'local' ? '网页内置语音'
      : (pref === 'system' ? (systemEngineKind() === 'native' ? '本机语音（安卓原生 TTS）' : '本机语音（系统朗读）')
        : '自动选择');
  }

  /* 把设置落到引擎上，并把当前实际生效的结果写回面板。
     用在「用户换档」和「导入备份」这两个时机：这时用户刚明确表达了选择，
     就该立刻锁死；真不可用的话 currentMode 自己会退到别的引擎，不会点了没反应。 */
  function applySpeakEngine() {
    if (typeof window.WordCardSpeech === 'undefined' || !window.WordCardSpeech) return;
    var want = speakEnginePref();
    try { window.WordCardSpeech.setEngine(SPEAK_ENGINE_FORCE[want]); } catch (e) {}
    renderSpeakEngine();
  }

  /* 开机时用。和上面分开是因为「自动选择」在开机这一刻不能锁死：
     网页内置语音要等资源装载完才可用，锁死会让它装载好之后也切不回来。
     所以这里只摆优先级（SPEAK_FORCE），由 currentMode 按当时的可用情况去选；
     显式选了某一档的用户，优先级本身就会一直压着内置语音，不必额外锁。 */
  function bootSpeakEngine() {
    SPEAK_FORCE = SPEAK_ENGINE_FORCE[speakEnginePref()];
    renderSpeakEngine();
  }

  function renderSpeakEngine() {
    if (!el.speakEngineHint) return;
    // 本机语音具体是原生 TTS 还是 speechSynthesis，标签跟着实际探测结果走
    var sysRadio = el.speakEngineGroup
      ? el.speakEngineGroup.querySelector('input[name="speakEngine"][value="system"]')
      : null;
    if (sysRadio && sysRadio.parentNode && el.speakSystemLabel) {
      var small = el.speakSystemLabel.querySelector('small');
      if (small) small.textContent = systemEngineKind() === 'native' ? '交给安卓系统 TTS 朗读' : '交给系统 / 浏览器的朗读功能';
    }

    var pref = speakEnginePref();
    if (el.speakEngineGroup) {
      var inputs = el.speakEngineGroup.querySelectorAll('input[name="speakEngine"]');
      for (var i = 0; i < inputs.length; i++) inputs[i].checked = (inputs[i].value === pref);
    }

    var actual = SPEAK_MODE || currentMode();
    var bits = [], warn = false;
    bits.push('当前设置：' + speakEngineText(pref) + '｜正在使用：' + speakModeText(actual));
    if (pref === 'local' && actual !== 'local') {
      warn = true;
      bits.push('网页内置语音还没装载好或用不了，暂时改用本机语音；它装载完成后会自动切回来。');
    } else if (pref === 'system' && actual === 'local') {
      warn = true;
      bits.push('这台设备没找到可用的系统朗读功能，暂时改用网页内置语音。');
    } else if (actual === 'none') {
      warn = true;
      bits.push('这台设备没有可用的朗读功能，卡片上的发音按钮会隐藏。');
    }
    if (actual === 'local' && typeof window.WCTTSLocal !== 'undefined' && window.WCTTSLocal && window.WCTTSLocal.voice) {
      bits.push('音色：' + window.WCTTSLocal.voice + '。');
    }
    el.speakEngineHint.textContent = bits.join(' ');
    el.speakEngineHint.classList.toggle('is-warn', warn);
  }

  /* 状态栏曾经有一个显示 / 隐藏的开关（安卓版专有，挂在「自定义」模块里）。
     已经移除：现在状态栏**始终显示**，由原生侧恒定留出顶部空白，
     网页侧不需要任何配套代码，也不再有 ST.settings.statusBar 这个设置项。
     移除原因见 MainActivity.setUpSystemBars() 的注释。 */

  // 试听：正在读就先停；否则用当前引擎读当前这个词（没在背词就读「发音测试」）
  function testSpeak() {
    if (isReadingNow()) { stopSpeak(); return; }
    var text = displayedWord();
    if (!text) text = speakable(ST.current && ST.current.w ? ST.current.w : '');
    var sample = text || 'pronunciation';
    var ok = readText(sample);
    if (ok) toast('试听（' + speakModeText(SPEAK_MODE) + '）：' + sample);
    else toast('当前引擎没能开始朗读，换一档试试');
  }

  function buildBackup() {
    return {
      kind: BACKUP_KIND,
      v: BACKUP_VER,
      app: '单词卡 · 本地背单词',
      exportedAt: Date.now(),
      summary: {
        books: ST.books.length,
        selected: Object.keys(ST.selected).length,
        prog: progTotalCount(),
        review: reviewTotalCount(),
        reviewPending: reviewPendingCount(),
        statBooks: Object.keys(ST.stats.books).length,
        days: Object.keys(ST.stats.days).length,
        words: Object.keys(ST.stats.words).length,
        ms: statsTotal().ms
      },
      books: ST.books,
      selected: Object.keys(ST.selected),
      prog: progPlain(),
      review: { v: 1, items: ST.review.items },
      stats: ST.stats,
      settings: ST.settings
    };
  }

  /* ---------------- 保存文件 ----------------
     网页版：`<a download>` + Blob URL。
     APK 里：必须走原生（AndroidTTS.saveFile）。原因是 WebView 不处理
     `<a download>` 这种下载 —— 它把点击当成一次导航，默认 WebViewClient
     对 blob: 既不加载也不报错，点「导出备份」在 APK 里表现为**完全没反应**，
     连这里的 catch 都不会进（a.click() 自己不会抛）。 */

  /** 是否在 APK 壳子里跑（壳子会注入 AndroidTTS.saveFile） */
  function nativeSaveAvailable() {
    return !!(window.AndroidTTS && typeof window.AndroidTTS.saveFile === 'function');
  }

  /** 把二进制转成 base64（分块，避免大数组一次性展开把调用栈撑爆） */
  function bytesToBase64(bytes) {
    var CHUNK = 0x8000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += CHUNK) {
      var sub = bytes.subarray ? bytes.subarray(i, i + CHUNK) : bytes.slice(i, i + CHUNK);
      parts.push(String.fromCharCode.apply(null, sub));
    }
    return btoa(parts.join(''));
  }

  /** UTF-8 文本 → base64 */
  function textToBase64(text) {
    var utf8 = unescape(encodeURIComponent(text));
    var bytes = new Uint8Array(utf8.length);
    for (var i = 0; i < utf8.length; i++) bytes[i] = utf8.charCodeAt(i) & 0xff;
    return bytesToBase64(bytes);
  }

  /* 体积上限：base64 后是要穿过 JS→原生桥的字符串，过大的话
     在部分设备上会触发字符串长度限制而静默失败。2 MB 的原始数据
     大约对应 2.7 MB 的 base64，已经远超正常备份（实测几十 KB）。
     超了就直接告诉用户，而不是让他等一个永远不会来的保存框。 */
  var SAVE_MAX_BYTES = 2 * 1024 * 1024;

  /**
   * 统一入口：能在壳子里存就走原生，否则回退网页下载。
   * @param {string} fileName
   * @param {string|Uint8Array} data  文本或二进制
   * @param {string} mime
   * @param {string} [textForWeb]     二进制时给网页版 fallback 用的原始文本（可省略）
   */
  function saveFile(fileName, data, mime, textForWeb) {
    mime = mime || 'application/json;charset=utf-8';

    if (nativeSaveAvailable()) {
      var b64, size;
      if (typeof data === 'string') {
        size = data.length;
        b64 = textToBase64(data);
      } else {
        size = data.length;
        b64 = bytesToBase64(data);
      }
      if (size > SAVE_MAX_BYTES) {
        toast('内容太大（' + Math.round(size / 1024) + ' KB），超过 ' +
          (SAVE_MAX_BYTES / 1024 / 1024) + ' MB 无法导出');
        return false;
      }
      try {
        window.AndroidTTS.saveFile(fileName, b64, mime);
      } catch (err) {
        toast('导出失败：' + ((err && err.message) || '调用系统保存失败'));
        return false;
      }
      /* 真正的结果由原生回调 window.WordCardSave.onResult 告知 ——
         用户还要在系统选择器里挑位置，这里不能提前报「已导出」。 */
      ST.savePending = fileName;
      return true;
    }

    // 网页版：沿用原来的下载
    if (typeof data === 'string') {
      downloadText(fileName, data, mime);
    } else if (textForWeb != null) {
      downloadText(fileName, textForWeb, mime);
    } else {
      downloadBlob(fileName, new Blob([data], { type: mime }));
    }
    return true;
  }

  /* 原生保存结束的回调（成功 / 取消 / 失败） */
  window.WordCardSave = {
    onResult: function (json) {
      var r = null;
      try { r = JSON.parse(json); } catch (e) { r = null; }
      var name = ST.savePending || '文件';
      ST.savePending = null;
      if (r && r.ok) toast('已保存 ' + name);
      else toast('未保存：' + ((r && r.reason) || '操作已取消'));
    }
  };

  // 下载：优先用 Blob URL；环境不支持时退回 data URI，保证任何浏览器都导得出来
  function downloadBlob(fileName, blob) {
    var a = document.createElement('a');
    a.download = fileName;
    a.style.display = 'none';
    var url = '';
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      url = URL.createObjectURL(blob);
      a.href = url;
    }
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (url) setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function downloadText(fileName, text, mime) {
    mime = mime || 'application/json;charset=utf-8';
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof Blob === 'function') {
      downloadBlob(fileName, new Blob([text], { type: mime }));
      return;
    }
    var a = document.createElement('a');
    a.download = fileName;
    a.style.display = 'none';
    a.href = 'data:' + mime + ',' + encodeURIComponent(text);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // 复习本条目：字段不全的丢掉，数字钳到合法范围——外面的文件不该把复习本带坏
  function sanitizeReview(src) {
    var out = Object.create(null);
    if (!src || typeof src !== 'object') return out;
    Object.keys(src).forEach(function (k) {
      var it = src[k];
      if (!it || typeof it !== 'object') return;
      var w = clean(it.w), m = clean(it.m);
      if (!w || !m) return;
      var key = clean(k).toLowerCase() || w.toLowerCase();
      if (protoKey(key)) return;
      var added = clampInt(it.added, 0) || Date.now();
      out[key] = {
        w: w, m: m, p: clean(it.p), e: clean(it.e),
        f: clampInt(it.f, 1),            // 收录时遗忘次数至少是 1
        ok: clampInt(it.ok, 0),
        done: !!it.done,
        added: added,
        last: clampInt(it.last, 0) || added
      };
    });
    return out;
  }

  function sanitizeStats(src) {
    var out = newStats();
    var days = (src && src.days) || {}, books = (src && src.books) || {}, words = (src && src.words) || {};
    Object.keys(days).forEach(function (k) {
      var v = days[k];
      if (!RE_DAY_KEY.test(k) || !v || typeof v !== 'object') return;   // 日期格式不对的直接不要
      // t 是这一天的学习用时（毫秒），热力图悬浮提示与「累计用时」都靠它，必须一起带过来
      out.days[k] = {
        a: clampInt(v.a, 0), o: clampInt(v.o, 0), m: clampInt(v.m, 0), r: clampInt(v.r, 0),
        t: clampInt(v.t, 0)
      };
    });
    Object.keys(books).forEach(function (k) {
      var v = books[k];
      if (!v || typeof v !== 'object' || protoKey(k)) return;
      out.books[k] = { n: clean(v.n), a: clampInt(v.a, 0), o: clampInt(v.o, 0), m: clampInt(v.m, 0), t: clampInt(v.t, 0) };
    });
    Object.keys(words).forEach(function (k) {
      var v = words[k];
      if (!v || typeof v !== 'object' || protoKey(k)) return;
      var w = clean(v.w);
      if (!w) return;
      out.words[k] = { w: w, m: clean(v.m), s: clampInt(v.s, 0), f: clampInt(v.f, 0), t: clampInt(v.t, 0) };
    });
    return out;
  }

  /* ---- 词书库 / 覆盖进度 / 设置 的清洗 ----
     备份文件来自外部，进来的一切都当不可信：不合格的词书整本丢掉、id 去重、
     进度只留形状正确的键、设置只认白名单里的字段。 */

  // 同一份 Excel 工作表的稳定标识，合并导入时用来认出「这本书本机已经有了」
  function bookFileKey(b) {
    return (b.fileName && b.sheetName) ? b.fileName + '\u0000' + b.sheetName : '';
  }

  // 词书 id / 进度键都会直接当对象的键用，这几个名字会动到原型链（给 __proto__ 赋值等于改原型），
  // 外面来的备份文件里出现它们一律换掉或丢掉
  function badKey(k) { return k === '__proto__' || k === 'constructor' || k === 'prototype'; }

  // 统计 / 复习本的键是「单词或词书名」，constructor、prototype 都是正经单词不能拦，
  // 只有 __proto__ 是非挡不可的
  function protoKey(k) { return k === '__proto__'; }

  function sanitizeBooks(src) {
    var out = [];
    if (!Array.isArray(src)) return out;
    var seenId = Object.create(null);
    src.forEach(function (raw) {
      if (!raw || typeof raw !== 'object' || raw.virtual) return;   // 动态词书（复习本）不落库
      var grid = normalizeGrid(raw.grid);
      if (!grid.length) return;
      var m = raw.mapping || {};
      var mp = {
        w: clampInt(m.w, -1),
        m: clampInt(m.m === undefined ? 1 : m.m, -1),
        p: clampInt(m.p, -1),
        e: clampInt(m.e, -1)
      };
      if (mp.w < 0 || mp.m < 0) return;                             // 没有英文列 / 中文列，这本用不了
      var count = countWords(grid, !!raw.hasHeader, mp);
      if (!count) return;
      var b = normalizeBook({
        id: clean(raw.id),
        name: clean(raw.name) || clean(raw.sheetName),
        fileName: clean(raw.fileName),
        sheetName: clean(raw.sheetName),
        sheetCount: clampInt(raw.sheetCount, 1),
        grid: grid,
        hasHeader: !!raw.hasHeader,
        headers: Array.isArray(raw.headers) ? raw.headers.map(clean) : [],
        mapping: mp,
        count: count,
        importedAt: clampInt(raw.importedAt, 0)
      });
      if (badKey(b.id)) b.id = uid();
      // id 撞车（文件内部重复）就丢掉后一本：宁可少一本，也不让两本书抢同一份进度
      if (seenId[b.id]) return;
      seenId[b.id] = 1;
      if (!b.importedAt) b.importedAt = Date.now();
      out.push(b);
    });
    return out;
  }

  // 覆盖进度：{ bookId: [词键…] }，只留非空键并去重
  function sanitizeProg(src) {
    var out = Object.create(null);
    if (!src || typeof src !== 'object' || Array.isArray(src)) return out;
    Object.keys(src).forEach(function (rawId) {
      var id = clean(rawId), arr = src[rawId];
      if (!id || badKey(id) || !Array.isArray(arr)) return;
      var keys = [], seen = Object.create(null);
      arr.forEach(function (k) {
        var key = clean(k);
        if (!key || seen[key]) return;
        seen[key] = 1;
        keys.push(key);
      });
      if (keys.length) out[id] = keys;
    });
    return out;
  }

  var REQUEUE_OK = { random: 1, end: 1, front: 1 };

  // 设置：只认这几个字段，别让外面的文件往 ST.settings 里塞奇怪的东西
  /* 注意：老备份里可能带着 hint（「允许看词性提示」）这个字段 ——
     该功能已去掉，这里不再接收，它会被安静地丢掉，不影响导入。 */
  function sanitizeSettings(src) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
    var out = {};
    if (typeof src.shuffle === 'boolean') out.shuffle = src.shuffle;
    if (REQUEUE_OK[src.requeue]) out.requeue = src.requeue;
    // 发音引擎：只认这三档，别的（老备份没有这一项，或手改过）一律退回自动
    out.speakEngine = SPEAK_ENGINE_MODES.indexOf(src.speakEngine) >= 0 ? src.speakEngine : 'auto';
    var batch = Math.floor(+src.batch);
    if (isFinite(batch) && batch >= 0) out.batch = batch;
    if (src.collapsed && typeof src.collapsed === 'object' && !Array.isArray(src.collapsed)) {
      var collapsed = {};
      Object.keys(src.collapsed).forEach(function (k) { if (src.collapsed[k]) collapsed[clean(k)] = true; });
      out.collapsed = collapsed;
    }
    return Object.keys(out).length ? out : null;
  }

  /* 解析并清洗备份文件。每块各认各的，缺哪块就跳过哪块：
     既能读 v1 的老备份（当时只有复习本 + 统计），也兼容只含某一块的片段文件。
     has* 记的是「文件里到底有没有这一块」，覆盖导入时据此决定动不动本机的对应数据。 */
  function parseBackup(text) {
    var d;
    try { d = JSON.parse(text); } catch (e) { throw new Error('不是有效的 JSON 文件'); }
    if (!d || typeof d !== 'object' || Object.prototype.toString.call(d) === '[object Array]') {
      throw new Error('文件内容不是备份数据');
    }
    if (d.kind && d.kind !== BACKUP_KIND) throw new Error('这不是「单词卡」导出的备份文件');
    var revSrc = d.review || (d.items ? d : null);
    var statSrc = d.stats || (d.days ? d : null);
    var books = sanitizeBooks(d.books);
    var prog = sanitizeProg(d.prog);
    var settings = sanitizeSettings(d.settings);
    if (!revSrc && !statSrc && !books.length && !Object.keys(prog).length && !settings) {
      throw new Error('文件里没有任何可以导入的数据');
    }
    return {
      review: revSrc ? sanitizeReview(revSrc.items || revSrc) : null,
      stats: statSrc ? sanitizeStats(statSrc) : null,
      books: books,
      hasBooks: hasOwn(d, 'books'),
      selected: Array.isArray(d.selected) ? d.selected.map(clean).filter(Boolean) : [],
      hasSelected: hasOwn(d, 'selected'),
      prog: prog,
      hasProg: hasOwn(d, 'prog'),
      settings: settings
    };
  }

  // 合并复习本：遗忘次数取多的（两边忘过都算数），其余字段跟随「最近一次」的那一侧
  function mergeReview(src) {
    var dst = ST.review.items, added = 0, kept = 0;
    Object.keys(src).forEach(function (k) {
      var b = src[k], a = dst[k];
      if (!a) { dst[k] = b; added++; return; }
      var newer = (b.last || 0) >= (a.last || 0) ? b : a;
      dst[k] = {
        w: newer.w, m: newer.m,
        p: newer.p || a.p || b.p, e: newer.e || a.e || b.e,
        f: Math.max(a.f || 1, b.f || 1),
        ok: newer.ok || 0,
        done: !!newer.done,
        added: Math.min(a.added || 0, b.added || 0) || newer.added,
        last: Math.max(a.last || 0, b.last || 0)
      };
      kept++;
    });
    return { added: added, kept: kept };
  }

  // 合并统计：同一格两边的次数相加（真背了两遍就该算两遍），学习用时同样相加，
  // 最后作答时间取近的
  function mergeStats(src) {
    var dst = ST.stats, a, b;
    Object.keys(src.days).forEach(function (k) {
      b = src.days[k]; a = dst.days[k];
      if (!a) { dst.days[k] = b; return; }
      a.a += b.a; a.o += b.o; a.m += b.m; a.r += b.r;
      a.t = (a.t || 0) + (b.t || 0);
    });
    Object.keys(src.books).forEach(function (k) {
      b = src.books[k]; a = dst.books[k];
      if (!a) { dst.books[k] = b; return; }
      if (b.n) a.n = b.n;
      a.a += b.a; a.o += b.o; a.m += b.m;
      a.t = Math.max(a.t || 0, b.t || 0);
    });
    Object.keys(src.words).forEach(function (k) {
      b = src.words[k]; a = dst.words[k];
      if (!a) { dst.words[k] = b; return; }
      if (b.w) a.w = b.w;
      if (b.m) a.m = b.m;
      a.s += b.s; a.f += b.f;
      a.t = Math.max(a.t || 0, b.t || 0);
    });
  }

  /* 合并词书：本机已经有同一本书就不重复导入，只记下「备份里的 id → 本机 id」的映射，
     这样备份里那份进度 / 勾选照样能落到对的词书上（两边 id 不同也不怕）。
     认「同一本书」先看 id，再看是不是同一份 Excel 的同一张表（fileName + sheetName）。 */
  function mergeBooks(src) {
    var byId = Object.create(null), byFile = Object.create(null), remap = Object.create(null);
    ST.books.forEach(function (b) {
      byId[b.id] = b;
      var fk = bookFileKey(b);
      if (fk) byFile[fk] = b;
    });
    var added = 0, kept = 0;
    src.forEach(function (b) {
      var fk = bookFileKey(b);
      var same = byId[b.id] || (fk ? byFile[fk] : null);
      if (same) {
        // 留着本机那份：用户可能在内置编辑里改过列映射 / 修正过冲突，不能被备份里的旧内容盖掉
        remap[b.id] = same.id;
        kept++;
        return;
      }
      ST.books.push(b);
      byId[b.id] = b;
      if (fk) byFile[fk] = b;
      remap[b.id] = b.id;
      added++;
    });
    return { remap: remap, added: added, kept: kept };
  }

  // 合并进度：逐本并集，返回新记下的词条数
  function mergeProg(src, remap) {
    var added = 0;
    Object.keys(src).forEach(function (id) {
      var cur = progMap(remap[id] || id, true);
      src[id].forEach(function (k) { if (!cur[k]) { cur[k] = 1; added++; } });
    });
    return added;
  }

  // 进度里可能留着「这本书本机没有」的键（只带进度不带词书的备份、词书被删过），
  // 进度条本来就只认在册词书，这里顺手清掉，别让它一直躺在存储里
  function pruneProg() {
    var alive = Object.create(null);
    ST.books.forEach(function (b) { alive[b.id] = true; });
    Object.keys(ST.prog).forEach(function (id) { if (!alive[id]) delete ST.prog[id]; });
  }

  /* 落库 + 立刻写盘 + 重画受影响的视图；返回一句可以直接丢进提示的摘要。
     覆盖 = 文件里有哪块就把本机那块整个换掉（文件里没有的块一动不动，免得顺手删掉别处的数据）；
     合并 = 词书去重后追加，进度 / 勾选并集，复习本按遗忘次数取多的，统计逐项相加。 */
  function applyBackup(parsed, mode) {
    var replace = mode === 'replace';
    var parts = [];
    var remap = Object.create(null);

    // 1) 词书库（体积最大的一块，先落地，后面的进度 / 勾选才有书可挂）。
    //    文件里的词书整批都没通过校验（0 本）时不当真，宁可不动本机的词书库，
    //    也不能因为一个坏文件把用户攒的词书清空。
    if (replace && parsed.hasBooks && parsed.books.length) {
      ST.books = parsed.books;
      parsed.books.forEach(function (b) { remap[b.id] = b.id; });
      parts.push('词书 ' + ST.books.length + ' 本');
    } else if (parsed.books.length) {
      var mb = mergeBooks(parsed.books);
      remap = mb.remap;
      parts.push('新增词书 ' + mb.added + ' 本' + (mb.kept ? '（已有 ' + mb.kept + ' 本未动）' : ''));
    }

    // 2) 覆盖进度：键要跟着上面的 id 映射走
    if (parsed.hasProg) {
      if (replace) ST.prog = {};
      var pn = mergeProg(parsed.prog, remap);
      PROGVER++;                       // 进度变了，进度条要重算、下次写盘要重写
      parts.push('背词进度 +' + pn + ' 词');
    }

    // 3) 勾选状态
    if (parsed.hasSelected) {
      if (replace) ST.selected = {};
      parsed.selected.forEach(function (id) {
        ST.selected[id === REVIEW_ID ? id : (remap[id] || id)] = true;
      });
      touchSel();
      parts.push('勾选 ' + Object.keys(ST.selected).length + ' 项');
    }

    // 4) 复习本
    if (parsed.review) {
      if (replace) ST.review.items = parsed.review; else mergeReview(parsed.review);
      // 条数是按「数据版本 STEP」缓存的，这里没走 reviewChanged() 就直接改了 items，
      // 缓存还算「新鲜」，必须先手动重数一次，否则报出来的是导入前的旧条数
      recountReview();
      parts.push('复习本 ' + RVTOT + ' 条');
    }

    // 5) 学习统计（含热力图每天的学习用时 d.t）
    if (parsed.stats) {
      if (replace) ST.stats = parsed.stats; else mergeStats(parsed.stats);
      parts.push('学习记录 ' + Object.keys(ST.stats.days).length + ' 天');
    }

    // 6) 设置。合并时也以文件为准：这几项就是个开关，没有「合一半」的说法；
    //    只有「分组折叠」是逐本的开关，两边的并集才对（本机折着的、备份里折着的都保持折着）
    if (parsed.settings) {
      var keepCollapsed = replace ? null : Object.assign({}, ST.settings.collapsed);
      Object.assign(ST.settings, parsed.settings);
      if (keepCollapsed) ST.settings.collapsed = Object.assign(keepCollapsed, parsed.settings.collapsed || {});
      syncSettingsUI();
      applySpeakEngine();      // 备份里的发音引擎选择要立刻生效，不能等下次开页面
      parts.push('设置');
    }

    pruneSelection();        // 词书 / 复习本变了，勾选跟着收拾干净
    pruneProg();
    pruneReview();
    STATS_VER++;             // 统计内容变了，热力图等要重画
    touchData();
    saveStore();             // 导入是明确的一次性动作，直接落盘，不再等防抖
    saveSettings();
    saveReview();
    saveStats();
    renderLibrary();
    renderStats();
    return parts.length ? parts.join(' · ') : '没有可导入的内容';
  }

  function dayStat(k, create) {
    var d = ST.stats.days[k];
    if (!d && create) d = ST.stats.days[k] = { a: 0, o: 0, m: 0, r: 0 };
    return d;
  }

  function dayActive(k) {
    var d = ST.stats.days[k];
    return !!d && (d.a > 0 || d.r > 0);
  }

  // 记录一次「记得 / 不记得」，返回可用于撤销的回执
  function statAnswer(item, isYes) {
    var now = Date.now();
    var k = todayKey();
    var day = dayStat(k, true);
    day.a++;
    if (isYes) day.o++; else day.m++;

    var wkey = item.wl || (item.w || '').toLowerCase();
    if (wkey) {
      var ws = ST.stats.words[wkey] || (ST.stats.words[wkey] = { w: item.w, m: item.m, s: 0, f: 0, t: 0 });
      ws.w = item.w;
      ws.m = item.m;
      ws.s++;
      if (!isYes) ws.f++;
      ws.t = now;
    }

    var bid = (item.src && item.src[0]) || '';
    if (bid) {
      var bs = ST.stats.books[bid] || (ST.stats.books[bid] = { n: '', a: 0, o: 0, m: 0, t: 0 });
      var book = bookById(bid);
      if (book) bs.n = book.name;
      bs.a++;
      if (isYes) bs.o++; else bs.m++;
      bs.t = now;
    }

    STATS_VER++;
    saveStatsSoon();
    return { day: k, wkey: wkey, bid: bid, o: isYes ? 1 : 0, m: isYes ? 0 : 1 };
  }

  // 撤销上一张时，把刚才记的统计也退回去
  function statUndo(rec) {
    if (!rec) return;
    var day = ST.stats.days[rec.day];
    if (day) {
      day.a = Math.max(0, day.a - 1);
      if (rec.o) day.o = Math.max(0, day.o - 1);
      if (rec.m) day.m = Math.max(0, day.m - 1);
    }
    var ws = rec.wkey ? ST.stats.words[rec.wkey] : null;
    if (ws) {
      ws.s = Math.max(0, ws.s - 1);
      if (rec.m) ws.f = Math.max(0, ws.f - 1);
      if (ws.s <= 0) delete ST.stats.words[rec.wkey];
    }
    var bs = rec.bid ? ST.stats.books[rec.bid] : null;
    if (bs) {
      bs.a = Math.max(0, bs.a - 1);
      if (rec.o) bs.o = Math.max(0, bs.o - 1);
      if (rec.m) bs.m = Math.max(0, bs.m - 1);
    }
    STATS_VER++;
    saveStatsSoon();
  }

  function statRound(ms) {
    var day = dayStat(todayKey(), true);
    day.r++;
    day.t = (day.t || 0) + (ms > 0 ? ms : 0);
    STATS_VER++;
    saveStatsSoon();
  }

  /* ---------------- 表格分析 ---------------- */
  function normalizeGrid(grid) {
    var out = [];
    (grid || []).forEach(function (r) {
      if (!r) return;
      var arr = [];
      var last = -1;
      for (var i = 0; i < r.length && i < MAX_COLS; i++) {
        var v = clean(r[i]);
        arr.push(v);
        if (v !== '') last = i;
      }
      if (last < 0) return;              // 整行为空，丢掉
      out.push(arr.slice(0, last + 1));
    });
    return out;
  }

  function maxCols(rows) {
    var n = 0;
    rows.forEach(function (r) { if (r.length > n) n = r.length; });
    return n;
  }

  function detectMapping(headers, n) {
    var score = function (i, keys) {
      var h = (headers[i] || '').toLowerCase();
      var s = 0;
      keys.forEach(function (k) { if (h.indexOf(k) >= 0) s = Math.max(s, k.length); });
      return s;
    };
    var best = { w: -1, m: -1, p: -1, e: -1 };
    var sw = -1, sm = -1, sp = -1, se = -1;
    for (var i = 0; i < n; i++) {
      var a = score(i, WORD_KEYS), b = score(i, MEAN_KEYS), c = score(i, POS_KEYS), d = score(i, EX_KEYS);
      if (a > sw) { sw = a; best.w = i; }
      if (b > sm) { sm = b; best.m = i; }
      if (c > sp) { sp = c; best.p = i; }
      if (d > se) { se = d; best.e = i; }
    }
    if (best.w < 0) best.w = 0;
    if (best.m < 0) best.m = n > 1 ? 1 : 0;
    if (best.m === best.w && n > 1) best.m = best.w === 0 ? 1 : 0;
    return best;
  }

  function analyzeRows(rows) {
    if (!rows || !rows.length) return null;
    var first = rows[0].map(clean);
    var hasHeader = first.some(function (h) {
      var low = h.toLowerCase();
      return WORD_KEYS.concat(MEAN_KEYS, POS_KEYS, EX_KEYS).some(function (k) {
        return h.indexOf(k) >= 0 || (low.length > 1 && low === k);
      });
    });
    var n = maxCols(rows);
    var headers = [];
    for (var i = 0; i < n; i++) {
      var t = clean(rows[0][i]);
      headers.push((hasHeader && t) ? t : '第 ' + (i + 1) + ' 列');
    }
    var mapping = detectMapping(headers, n);
    return {
      rows: rows, hasHeader: hasHeader, headers: headers, mapping: mapping,
      count: countWords(rows, hasHeader, mapping)
    };
  }

  function countWords(rows, hasHeader, mp) {
    if (!rows || !rows.length || !mp || mp.w < 0 || mp.m < 0) return 0;
    var data = hasHeader ? rows.slice(1) : rows;
    var seen = {}, n = 0;
    data.forEach(function (r) {
      var w = clean(r[mp.w]), m = clean(r[mp.m]);
      if (!w || !m) return;
      var k = w.toLowerCase();
      if (seen[k]) return;
      seen[k] = 1; n++;
    });
    return n;
  }

  function buildWords(book) {
    var mp = book.mapping;
    var pm = mp.p, em = mp.e;
    var data = book.hasHeader ? book.grid.slice(1) : book.grid.slice();
    var seen = Object.create(null), out = [];
    data.forEach(function (r) {
      var w = clean(r[mp.w]), m = clean(r[mp.m]);
      if (!w || !m) return;
      var k = w.toLowerCase();
      /* 同一本词书里重复出现的英文词条：背词时只认第一条释义（口径和 countWords 一致），
         但把后面那些释义收进 alt。只留第一条会让「后面那些释义」凭空消失——
         用户在词书库里搜反而不该搜不到，所以搜索会连 alt 一起找。 */
      var hit = seen[k];
      if (hit) {
        if (m !== hit.m && hit.alt.indexOf(m) < 0) hit.alt.push(m);
        return;
      }
      // wl 是小写形式，搜索时直接用，省掉每次按键对全部词条重复 toLowerCase
      var item = {
        w: w, m: m, wl: k, alt: [],
        p: pm >= 0 ? clean(r[pm]) : '',
        e: em >= 0 ? clean(r[em]) : ''
      };
      seen[k] = item;
      out.push(item);
    });
    out.forEach(function (x) { if (!x.alt.length) x.alt = null; });   // 没重复的常见情形不留空数组
    return out;
  }

  /* ---------------- 词书库渲染 ---------------- */
  function bookById(id) {
    if (id === REVIEW_ID) return reviewBook();   // 动态词书不在列表里，但统计等地方要能按 id 找到它
    if (IVER !== STEP || !ICACHE) {
      var idx = Object.create(null);
      for (var i = 0; i < ST.books.length; i++) idx[ST.books[i].id] = ST.books[i];
      ICACHE = idx;
      IVER = STEP;
    }
    return ICACHE[id] || null;
  }

  // 已勾选的词书：按「词书版本 + 勾选版本」缓存，两者都没变时直接复用同一份结果
  function selectedBooks() {
    if (BVER === STEP && BSVER === SELVER && BCACHE) return BCACHE;
    var out = [];
    // 复习本排最前：多本合并时重复词以它（最新收录的释义）为准
    if (ST.selected[REVIEW_ID] && reviewPendingCount() > 0) out.push(reviewBook());
    for (var i = 0; i < ST.books.length; i++) {
      if (ST.selected[ST.books[i].id]) out.push(ST.books[i]);
    }
    BCACHE = out;
    BVER = STEP;
    BSVER = SELVER;
    return out;
  }

  // 词条解析结果缓存：搜索与合并都会用到，避免反复解析整张表
  function wordsOf(b) {
    // 动态词书的内容随时在变（权重、遗忘次数），每次都现算，不进缓存
    if (b.virtual) return reviewQueue();
    if (!WCACHE[b.id]) WCACHE[b.id] = buildWords(b);
    return WCACHE[b.id];
  }

  function dropCache(id) {
    if (id) {
      delete WCACHE[id];
      delete CFCOUNT[id];
    } else {
      WCACHE = {};
      CFCOUNT = {};
    }
  }

  /* ---------------- 查重：同一本词书内部的冲突 ----------------
     两类冲突：
       A 同一个英文（忽略大小写 / 空格 / 首尾标点）挂着不止一种中文意思
         —— 背词时按首条取用，后面的释义会被静默丢掉；
       B 同一个中文意思挂着不止一个英文
         —— 题目一样、答案却不同，容易背混。
     英文和中文都完全一样的纯重复词条不算冲突：它只是重复，信息没有丢失。
     归一化只做「大小写、空白、常见全半角标点」的整理，不改动文字本身。 */
  var RE_EDGE_HEAD = /^[^\p{L}\p{N}]+/u;
  var RE_EDGE_TAIL = /[^\p{L}\p{N}]+$/u;

  // 去掉首尾的空白与标点（只保留字母、数字、汉字），「苹果。」「（苹果）」都归到「苹果」
  function normEdge(s) {
    return s.replace(RE_EDGE_HEAD, '').replace(RE_EDGE_TAIL, '');
  }
  // 英文：忽略大小写、把连续空白折成一个空格
  function normWord(s) {
    return normEdge(s.toLowerCase().replace(RE_WS, ' ').trim());
  }
  // 中文：忽略所有空白与大小写（汉字不受影响，夹带的英文释义也能对齐）
  function normMean(s) {
    return normEdge(s.toLowerCase().replace(RE_WS, ''));
  }

  /* 扫一遍整张表，列出互相冲突的词条。只走一遍、每个词条只判一次。
     ov 是「编辑窗口里改过但还没保存」的内容（'表格行号:角色' -> 新值）：
     传进来就按改过之后的样子判重，编辑窗口里改一处、冲突表马上就少一处。 */
  var CF_HEAD = 2;   // 有表头时，表格第 1 行是表头，数据从第 2 行开始
  function scanConflicts(book, mp, ov) {
    var data = book.hasHeader ? book.grid.slice(1) : book.grid;
    var base = book.hasHeader ? CF_HEAD : 1;
    var items = [], wmap = Object.create(null), mmap = Object.create(null), i;
    for (i = 0; i < data.length; i++) {
      var r = data[i];
      if (!r) continue;
      var row = book.hasHeader ? i + 1 : i;    // 表格里的行下标，写回内容时用它
      var w = mp.w >= 0 ? clean(r[mp.w]) : '';
      var m = mp.m >= 0 ? clean(r[mp.m]) : '';
      if (ov) {
        if (ov[row + ':w'] !== undefined) w = clean(ov[row + ':w']);
        if (ov[row + ':m'] !== undefined) m = clean(ov[row + ':m']);
      }
      if (!w || !m) continue;
      var nw = normWord(w), nm = normMean(m);
      if (!nw || !nm) continue;
      var it = {
        line: i + base, row: row,   // line 是给人看的表格行号，row 用来写回表格
        w: w, m: m, nw: nw, nm: nm, why: []
      };
      items.push(it);
      (wmap[nw] || (wmap[nw] = [])).push(it);
      (mmap[nm] || (mmap[nm] = [])).push(it);
    }

    var out = [];
    // kind='w'：按英文分组，比中文有几种；kind='m'：按中文分组，比英文有几个
    function mark(map, kind, otherKey) {
      for (var k in map) {
        var g = map[k];
        if (g.length < 2) continue;
        var uniq = Object.create(null), vals = [], a;
        for (a = 0; a < g.length; a++) {
          var v = g[a][otherKey];
          if (uniq[v]) continue;
          uniq[v] = 1;
          vals.push(kind === 'w' ? g[a].m : g[a].w);
        }
        if (vals.length < 2) continue;      // 纯重复：同一个词、同一个意思
        for (a = 0; a < g.length; a++) {
          var it2 = g[a];
          // nk 是归一化后的分组键，items 是这一组的全部词条（编辑窗口要摊开来看）
          it2.why.push({ kind: kind, key: kind === 'w' ? it2.w : it2.m, nk: k,
            n: vals.length, vals: vals, items: g });
          if (!it2.hit) { it2.hit = 1; out.push(it2); }
        }
      }
    }
    mark(wmap, 'w', 'nm');
    mark(mmap, 'm', 'nw');

    // 同一组冲突排在一起，前后相邻，改的时候一眼能看全
    out.sort(function (a, b) {
      var ka = a.why[0].kind + a.why[0].key.toLowerCase();
      var kb = b.why[0].kind + b.why[0].key.toLowerCase();
      if (ka < kb) return -1;
      if (ka > kb) return 1;
      return a.line - b.line;
    });
    return out;
  }

  // 冲突条数：词书库每行都要读，按词书 id 记一份，内容变了由 dropCache 清掉
  function conflictCount(b) {
    if (!b || b.virtual) return 0;      // 复习本是动态的，不参与查重
    if (CFCOUNT[b.id] === undefined) CFCOUNT[b.id] = scanConflicts(b, b.mapping).length;
    return CFCOUNT[b.id];
  }

  // 多本合并：同一个英文词只保留第一次出现的释义，并记下来源词书
  // 结果按数据版本缓存：勾选 / 词书没变时，统计页与开始背词都不必重算
  function mergedWords() {
    if (MVER === STEP && MSVER === SELVER && MCACHE) return MCACHE;
    var seen = Object.create(null), out = [];
    selectedBooks().forEach(function (b) {
      wordsOf(b).forEach(function (x) {
        var k = x.wl || x.w.toLowerCase();
        if (seen[k]) {
          if (seen[k].src.indexOf(b.id) < 0) seen[k].src.push(b.id);
          if (x.rev) seen[k].rev = true;   // 复习本收录过的词，即使来自普通词书也按复习词处理
          return;
        }
        var item = { w: x.w, m: x.m, wl: k, p: x.p, e: x.e, src: [b.id], rev: !!x.rev };
        seen[k] = item;
        out.push(item);
      });
    });
    MCACHE = out;
    MVER = STEP;
    MSVER = SELVER;
    return out;
  }

  /* ---- 分类：按导入时的来源文件分组 ---- */
  function groupKeyOf(b) { return b.fileName || '（未知来源）'; }

  function groupedBooks() {
    if (GVER === STEP && GCACHE) return GCACHE;
    var map = Object.create(null), out = [];
    ST.books.forEach(function (b) {
      var k = groupKeyOf(b);
      var g = map[k];
      if (!g) { g = map[k] = { key: k, books: [] }; out.push(g); }
      g.books.push(b);
    });
    GCACHE = out;
    GVER = STEP;
    return out;
  }

  /* ---- 搜索：词书名 / 文件名 / 工作表名 / 词条 ---- */
  // 同词异义被合并进 alt 的释义，搜索时同样算命中，不然那些词条像被吞掉了
  function altHit(alt, q) {
    if (!alt) return false;
    for (var i = 0; i < alt.length; i++) { if (alt[i].indexOf(q) >= 0) return true; }
    return false;
  }

  function matchBook(b, q) {
    if (!q) return { ok: true, hits: 0 };
    if (b.name.toLowerCase().indexOf(q) >= 0) return { ok: true, hits: 0 };
    if ((b.fileName || '').toLowerCase().indexOf(q) >= 0) return { ok: true, hits: 0 };
    if ((b.sheetName || '').toLowerCase().indexOf(q) >= 0) return { ok: true, hits: 0 };
    var ws = wordsOf(b), hits = 0;
    for (var i = 0; i < ws.length; i++) {
      var x = ws[i];
      if ((x.wl || x.w.toLowerCase()).indexOf(q) >= 0 || x.m.indexOf(q) >= 0 || altHit(x.alt, q)) {
        hits++;
        if (hits > 20) break;
      }
    }
    return { ok: hits > 0, hits: hits };
  }

  function bookActions(b, gi, total) {
    var acts = document.createElement('div');
    acts.className = 'book-actions';
    var list = [['up', '↑', '上移', gi === 0], ['down', '↓', '下移', gi === total - 1]];
    // 分批背的词书：行内直接给一个「继续背 / 重背」的入口，省得再来回勾选
    var bsz = batchSize();
    if (bsz && !b.virtual) {
      var cs = coverStat(b);
      if (cs.total > bsz) {
        var left = cs.total - cs.done;
        var label, hint;
        if (!cs.done) {
          label = '背这本';
          hint = '只勾这一本，开始背它的第一批（最多 ' + Math.min(bsz, cs.total) + ' 词）';
        } else if (left > 0) {
          label = '继续背';
          hint = '只勾这一本，接着背它还没过一遍的 ' + Math.min(bsz, left) + ' 词';
        } else {
          label = '重背';
          hint = '这本已经全部过完一遍，点这里从头再背一遍';
        }
        list.push(['batch', label, hint, false]);
      }
    }
    list.push(['edit', '编辑', '编辑', false], ['del', '删除', '删除', false]);
    list.forEach(function (a) {
      var btn = document.createElement('button');
      btn.dataset.act = a[0];
      btn.title = a[2];
      if (a[0] === 'up' || a[0] === 'down') {
        btn.className = 'iconbtn';
        btn.textContent = a[1];
      } else {
        btn.className = 'btn tiny ghost' + (a[0] === 'del' ? ' danger' : '');
        btn.textContent = a[1];
      }
      btn.disabled = !!a[3];
      acts.appendChild(btn);
    });
    return acts;
  }

  function buildBookRow(b, hits, gi, total, idxOf) {
    var li = document.createElement('li');
    li.className = 'book' + (ST.selected[b.id] ? ' is-selected' : '');
    li.dataset.id = b.id;

    var lab = document.createElement('label');
    lab.className = 'book-check';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!ST.selected[b.id];
    cb.addEventListener('change', function () { toggleSelect(b.id, cb.checked); });
    lab.appendChild(cb);
    li.appendChild(lab);

    var main = document.createElement('div');
    main.className = 'book-main';
    var title = document.createElement('div');
    title.className = 'book-title';
    var idx = document.createElement('span');
    idx.className = 'book-index';
    idx.textContent = String(idxOf[b.id] + 1).padStart(2, '0');
    var name = document.createElement('span');
    name.className = 'book-name';
    name.textContent = b.name;
    title.appendChild(idx);
    title.appendChild(name);

    // 查重冲突标记：这本词书内部有自相矛盾的地方，点「编辑」就能改
    var cf = conflictCount(b);
    if (cf) {
      var cfTag = document.createElement('span');
      cfTag.className = 'cf-tag';
      cfTag.textContent = '冲突 ' + cf;
      cfTag.title = '《' + b.name + '》里有 ' + cf + ' 条互相冲突的词条：' +
        '同一个英文挂着不同的中文意思，或同一个中文意思挂着不同的英文。' +
        '点右侧「编辑」可以在弹出的窗口里直接改。';
      title.appendChild(cfTag);
    }

    main.appendChild(title);

    var meta = document.createElement('p');
    meta.className = 'book-meta';
    meta.textContent = '工作表「' + b.sheetName + '」· ' + b.count + ' 词 · ' + timeAgo(b.importedAt) +
      (hits ? ' · 命中 ' + (hits > 20 ? '20+ 个' : hits + ' 个') + '词条' : '');
    main.appendChild(meta);

    // 分批背的词书：把覆盖进度直接画在行里，一眼能看出还剩多少词
    var bsz = batchSize();
    if (bsz && !b.virtual) {
      var cs = coverStat(b);
      if (cs.total > bsz) {
        var prog = document.createElement('div');
        prog.className = 'book-prog';
        var pbar = document.createElement('span');
        pbar.className = 'prog-bar';
        var pfill = document.createElement('i');
        pfill.style.width = Math.round(cs.done / cs.total * 100) + '%';
        pbar.appendChild(pfill);
        var ptxt = document.createElement('span');
        ptxt.className = 'prog-text';
        ptxt.textContent = !cs.done
          ? '还没开始 · 共 ' + cs.total + ' 词（每轮最多 ' + bsz + ' 词）'
          : (cs.rest
            ? '已背 ' + cs.done + '/' + cs.total + ' · 还剩 ' + cs.rest + ' 词'
            : '已全部过完一遍（' + cs.total + ' 词）· 点「重背」从头再来');
        prog.appendChild(pbar);
        prog.appendChild(ptxt);
        main.appendChild(prog);
      }
    }
    li.appendChild(main);
    li.appendChild(bookActions(b, gi, total));
    return li;
  }

  function buildGroup(g, items, q, idxOf) {
    var collapsed = !!ST.settings.collapsed[g.key] && !q;
    var li = document.createElement('li');
    li.className = 'book-group' + (collapsed ? ' is-collapsed' : '');
    li.dataset.group = g.key;

    var head = document.createElement('div');
    head.className = 'group-head';
    head.dataset.gact = 'toggle';
    head.title = collapsed ? '点击展开分类' : '点击收起分类';

    var caret = document.createElement('span');
    caret.className = 'group-caret';
    caret.textContent = '▼';
    head.appendChild(caret);

    var check = document.createElement('label');
    check.className = 'group-check';
    check.dataset.gact = 'stop';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.gact = 'check';
    var picked = items.filter(function (it) { return !!ST.selected[it.b.id]; }).length;
    cb.checked = picked === items.length;
    cb.indeterminate = picked > 0 && picked < items.length;
    cb.title = '勾选 / 取消勾选整个分类';
    check.appendChild(cb);
    head.appendChild(check);

    var name = document.createElement('span');
    name.className = 'group-name';
    name.textContent = g.key;
    head.appendChild(name);

    var meta = document.createElement('span');
    meta.className = 'group-meta';
    var words = 0, hits = 0;
    items.forEach(function (it) { words += it.b.count; hits += it.hits; });
    meta.textContent = '（' + (q && items.length < g.books.length
      ? '显示 ' + items.length + '/' + g.books.length + ' 本'
      : g.books.length + ' 本') + ' · ' + words + ' 词）';
    head.appendChild(meta);

    var push = document.createElement('span');
    push.className = 'push';
    head.appendChild(push);

    if (q && hits) {
      var badge = document.createElement('span');
      badge.className = 'group-mini';
      badge.textContent = '命中 ' + (hits > 20 ? '20+ 个' : hits + ' 个') + '词条';
      head.appendChild(badge);
    }
    li.appendChild(head);

    var ul = document.createElement('ul');
    ul.className = 'group-books';
    var frag = document.createDocumentFragment();
    for (var i = 0; i < items.length; i++) {
      frag.appendChild(buildBookRow(items[i].b, items[i].hits, i, g.books.length, idxOf));
    }
    ul.appendChild(frag);
    li.appendChild(ul);
    return li;
  }

  var REVIEW_SHOW = 8;   // 面板里最多列几个待复习词，剩下的用一行提示带过

  /* ---------------- 复习本面板：让「收录了什么、下次复习谁」一眼可见 ---------------- */
  var revSig = '';
  function renderReviewBook() {
    var pending = reviewPendingCount();
    var total = reviewTotalCount();
    var picked = ST.selected[REVIEW_ID] ? 1 : 0;

    // 内容和上一次完全一样（比如只是在词书库的搜索框里敲字、或从统计页返回）就不重画：
    // 句尾带分钟刻度，保证「刚刚 / N 分钟前」这类相对时间和权重跟全量重建一样新鲜。
    var sig = STEP + '|' + picked + '|' + pending + '|' + total + '|' + Math.floor(Date.now() / 60000);
    if (sig === revSig && el.reviewList.firstChild) return;
    revSig = sig;

    // 排序只在这块真的要重画时才做：reviewRanked 是整表排序，能省就省
    var ranked = reviewRanked();
    var take = Math.min(pending, REVIEW_BATCH);

    el.reviewCount.textContent = String(pending);
    /* 复习本的勾选框已从界面上移除（它不再参与「勾选合并成一轮」），
       元素不存在，所以要判空再写。
       保留 ST.selected[REVIEW_ID] 这套状态不动 —— 它还被
       allSelectedBooks() / updateSummary() 读着，
       而且老用户的 localStorage 里可能存着这个标记；
       贸然删掉反而会让「已合并」的历史状态和界面对不上。
       留空判断而不是删代码，是为了让 idx 里那两个引用点都不会抛错。 */
    if (el.reviewPick) {
      el.reviewPick.checked = !!picked;
      el.reviewPick.disabled = pending <= 0;
    }

    el.reviewMeta.textContent = total
      ? '收录 ' + total + ' 个 · 待复习 ' + pending + ' 个' +
        (total - pending > 0 ? ' · 已消化 ' + (total - pending) + ' 个' : '')
      : '收录 0 个 · 待复习 0 个';

    el.reviewNote.textContent = pending
      ? '按「遗忘次数 × 隔了几天 ÷ 连续记住次数」算权重，每次最多取 ' + REVIEW_BATCH +
        ' 个；连着答对 ' + REVIEW_DONE_OK + ' 次算「消化」，先退出队列。'
      : '背词时点「不记得」的词会自动收进来；忘得越多、隔得越久，越早被抽到复习。';

    el.reviewList.innerHTML = '';
    if (!pending) {
      var li0 = document.createElement('li');
      li0.className = 'reviewbook-empty';
      li0.textContent = '复习本还是空的——背词时点到「不记得」的词，这里会自动收录。';
      el.reviewList.appendChild(li0);
    } else {
      var frag = document.createDocumentFragment();
      ranked.slice(0, REVIEW_SHOW).forEach(function (r) { frag.appendChild(buildReviewRow(r)); });
      el.reviewList.appendChild(frag);
      if (ranked.length > REVIEW_SHOW) {
        var more = document.createElement('li');
        more.className = 'reviewbook-more';
        more.textContent = '另外还有 ' + (ranked.length - REVIEW_SHOW) + ' 个在排队，从高权重往下依次抽。';
        el.reviewList.appendChild(more);
      }
    }

    el.btnReviewStart.textContent = '开始复习（' + REVIEW_BATCH + ' 词）';
    el.btnReviewStart.disabled = !pending;
    el.btnReviewClear.disabled = !total;
    el.reviewTip.textContent = pending
      ? '本轮将抽出 ' + take + ' 个' + (ST.selected[REVIEW_ID] ? ' · 已和所选词书合并' : '')
      : '暂无待复习内容';
  }

  function buildReviewRow(r) {
    var it = r.it;
    var li = document.createElement('li');
    li.className = 'reviewbook-item' + (it.f >= 3 ? ' is-heavy' : '');
    li.title = '遗忘 ' + it.f + ' 次 · 最近一次 ' + (timeAgo(it.last) || '刚刚') +
      ' · 当前权重 ' + r.w.toFixed(2);

    var w = document.createElement('span');
    w.className = 'rb-w';
    w.textContent = it.w;

    var m = document.createElement('span');
    m.className = 'rb-m';
    m.textContent = it.m;

    var tags = document.createElement('span');
    tags.className = 'rb-tags';
    var t1 = document.createElement('span');
    t1.className = 'rb-tag rb-forget';
    t1.textContent = '忘了 ' + it.f + ' 次';
    tags.appendChild(t1);
    if (it.ok > 0) {
      var t2 = document.createElement('span');
      t2.className = 'rb-tag rb-ok';
      t2.textContent = '连对 ' + it.ok + ' 次';
      tags.appendChild(t2);
    }
    var t3 = document.createElement('span');
    t3.className = 'rb-tag rb-weight';
    t3.textContent = '权重 ' + r.w.toFixed(1);
    tags.appendChild(t3);

    li.appendChild(w);
    li.appendChild(m);
    li.appendChild(tags);
    return li;
  }

  var libSig = '';
  function renderLibrary() {
    renderReviewBook();   // 复习本的内容随时在变（权重、遗忘次数），每次进词书库都重画一遍
    /* 背景词放在记忆化判断**之前**：
       它只关心「池子变没变」（内部按 STEP 号自己判），
       若放到后面，从统计页返回词书库时会因为整块被跳过而不再刷新。
       放进来的代价只是几次比较，不做任何 DOM 写入。 */
    renderHeroWord();
    var q = ST.query;
    var groups = groupedBooks();
    var shown = 0, hits = 0, shownWords = 0, allWords = 0;

    // 数据、搜索词、分类收起状态都没变时（比如从统计页返回词书库），整块跳过重建。
    // 末尾带上“分钟”刻度：行内“刚刚 / N 分钟前”会随时间变，保证它和全量重建一样新鲜。
    var sig = STEP + '|' + q + '|' + Object.keys(ST.settings.collapsed).join(',') + '|' + Math.floor(Date.now() / 60000) +
      '|' + PROGVER + '|' + batchSize();
    if (sig === libSig && el.bookList.firstChild) { updateSummary(); return; }
    libSig = sig;

    // 预先算好每本词书的序号，避免渲染每一行都做一次 indexOf
    var idxOf = Object.create(null);
    ST.books.forEach(function (b, i) { allWords += b.count; idxOf[b.id] = i; });
    el.bookCount.textContent = String(ST.books.length);

    var frag = document.createDocumentFragment();
    groups.forEach(function (g) {
      var items = [];
      g.books.forEach(function (b) {
        var m = matchBook(b, q);
        if (m.ok) { items.push({ b: b, hits: m.hits }); hits += m.hits; }
      });
      if (!items.length) return;
      shown += items.length;
      items.forEach(function (it) { shownWords += it.b.count; });
      frag.appendChild(buildGroup(g, items, q, idxOf));
    });
    el.bookList.innerHTML = '';
    el.bookList.appendChild(frag);

    el.emptyState.hidden = ST.books.length > 0;
    el.libEmpty.hidden = !(ST.books.length > 0 && q && !shown);
    el.btnSearchClear.hidden = !q;

    if (q) {
      el.searchInfo.innerHTML = shown
        ? '匹配 <b>' + shown + '</b> 本词书 · ' + shownWords + ' 词' +
          (hits ? ' · 其中 <b>' + (hits > 20 ? '20+' : hits) + '</b> 个词条命中' : '')
        : '没有匹配的词书';
    } else {
      el.searchInfo.textContent = ST.books.length
        ? '共 ' + ST.books.length + ' 本词书 · ' + allWords + ' 词条 · 分 ' + groups.length + ' 个来源文件'
        : '';
    }

    updateSummary();
  }

  function updateSummary() {
    var sel = selectedBooks();
    var words = mergedWords().length;
    var txt = '已选 ' + sel.length + ' 本 · ' + words + ' 词条' + (sel.length > 1 ? '（已合并去重）' : '');
    // 分批背：把这一轮实际放进去多少词说清楚，免得以为「怎么不是全部」
    var plan = batchPlan();
    var n = plan.length ? planWords(plan).length : 0;
    if (n && n !== words) txt += ' · 本轮 ' + n + ' 词';
    el.selSummary.textContent = txt;
    var off = !sel.length || !words;
    el.btnStart.disabled = off;
    // 状态没变就不重复写内联样式，省掉一次样式重算
    if (updateSummary._off !== off) {
      updateSummary._off = off;
      el.btnStart.style.opacity = off ? .5 : 1;
      el.btnStart.style.cursor = off ? 'not-allowed' : 'pointer';
    }
  }
  updateSummary._off = null;

  function toggleSelect(id, on) {
    if (on) ST.selected[id] = true; else delete ST.selected[id];
    touchSel();
    var li = el.bookList.querySelector('.book[data-id="' + id + '"]');
    if (li) li.classList.toggle('is-selected', !!on);
    syncGroupHead();
    updateSummary();
    saveStoreSoon();
  }

  // 让分类的复选框跟着组内单本的选择状态走（先汇总一遍，再回填组头）
  function syncGroupHead() {
    var stat = Object.create(null);
    for (var i = 0; i < ST.books.length; i++) {
      var b = ST.books[i];
      var key = groupKeyOf(b);
      var s = stat[key] || (stat[key] = { total: 0, picked: 0 });
      s.total++;
      if (ST.selected[b.id]) s.picked++;
    }
    var nodes = el.bookList.querySelectorAll('.book-group');
    for (var j = 0; j < nodes.length; j++) {
      var node = nodes[j];
      var cb = node.querySelector('.group-check input');
      if (!cb) continue;
      var t = stat[node.dataset.group];
      var total = t ? t.total : 0, picked = t ? t.picked : 0;
      cb.checked = total > 0 && picked === total;
      cb.indeterminate = picked > 0 && picked < total;
    }
  }

  function toggleGroup(key) {
    if (ST.settings.collapsed[key]) delete ST.settings.collapsed[key];
    else ST.settings.collapsed[key] = true;
    saveSettings();
    renderLibrary();
  }

  function setAllCollapsed(on) {
    if (on) groupedBooks().forEach(function (g) { ST.settings.collapsed[g.key] = true; });
    else ST.settings.collapsed = {};
    saveSettings();
    renderLibrary();
    toast(on ? '已收起全部分类' : '已展开全部分类');
  }

  // 勾选状态变了之后，只把已经渲染出来的行同步一下，不整块重建列表
  function syncRowSelection() {
    var rows = el.bookList.querySelectorAll('.book');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var on = !!ST.selected[row.dataset.id];
      row.classList.toggle('is-selected', on);
      var cb = row.querySelector('.book-check input');
      if (cb) cb.checked = on;
    }
    syncGroupHead();
    updateSummary();
  }

  function setGroupSelect(key, on) {
    var hit = 0;
    groupedBooks().forEach(function (g) {
      if (g.key !== key) return;
      g.books.forEach(function (b) {
        if (on) ST.selected[b.id] = true; else delete ST.selected[b.id];
        hit++;
      });
    });
    if (!hit) return;
    touchSel();
    saveStoreSoon();
    syncRowSelection();
    toast(on ? '已选中《' + key + '》的 ' + hit + ' 本词书' : '已取消《' + key + '》的勾选');
  }

  function setQuery(v) {
    ST.query = clean(v).toLowerCase();
    renderLibrary();
  }

  function setSelectAll(on) {
    ST.selected = {};
    if (on) ST.books.forEach(function (b) { ST.selected[b.id] = true; });
    touchSel();
    saveStore();
    syncRowSelection();
  }

  // 排序只在同一个分类内移动（↑ ↓ 不跨分组）
  function moveBook(id, dir) {
    var i = -1;
    for (var k = 0; k < ST.books.length; k++) { if (ST.books[k].id === id) { i = k; break; } }
    var j = i + dir;
    if (i < 0 || j < 0 || j >= ST.books.length) return;
    if (groupKeyOf(ST.books[i]) !== groupKeyOf(ST.books[j])) return;
    var t = ST.books[i]; ST.books[i] = ST.books[j]; ST.books[j] = t;
    touchData();
    saveStore();
    renderLibrary();
  }

  function deleteBook(id) {
    var b = bookById(id);
    if (!b) return;
    if (!confirm('删除词书《' + b.name + '》？\n（只删除网页里的这本，不会动你电脑上的 Excel 文件）')) return;
    ST.books = ST.books.filter(function (x) { return x.id !== id; });
    delete ST.selected[id];
    delete ST.prog[id];      // 词书都没了，它的覆盖进度也没必要留着
    PROGVER++;
    dropCache(id);
    pruneSelection();
    saveStore();
    renderLibrary();
    toast('已删除《' + b.name + '》');
  }

  function deleteSelected() {
    var sel = selectedBooks();
    if (!sel.length) { toast('还没有勾选词书'); return; }
    if (!confirm('删除已勾选的 ' + sel.length + ' 本词书？\n（只删除网页里的，不会动你电脑上的 Excel 文件）')) return;
    ST.books = ST.books.filter(function (b) { return !ST.selected[b.id]; });
    Object.keys(ST.selected).forEach(function (id) { delete ST.prog[id]; });   // 连带删掉它们的覆盖进度
    PROGVER++;
    ST.selected = {};
    dropCache();
    pruneSelection();
    saveStore();
    renderLibrary();
    toast('已删除 ' + sel.length + ' 本词书');
  }

  /* ---------------- Excel 解析库：按需加载 ----------------
     libs/xlsx.full.min.js 有 900 多 KB，占首屏脚本开销的九成以上，而它只在
     「导入文件」和「内置示例词书」两条路径上才用得到。所以不再放进 <script> 同步加载，
     改成第一次真要解析时才拉；拉取期间来的请求先排队，拉好后按序执行。
     首屏画完（浏览器空闲）会预取一次，用户真去点「添加文件」时它通常已经就位。 */
  var XLSX_URL = 'libs/xlsx.full.min.js';
  var xlsxLoading = false, xlsxFailed = false, xlsxQueue = [];

  function xlsxReady() { return typeof window.XLSX !== 'undefined'; }

  function whenXlsx(fn) {
    if (xlsxReady()) { fn(); return; }
    if (xlsxFailed) { toast('缺少 Excel 解析库（' + XLSX_URL + '）'); return; }
    xlsxQueue.push(fn);
    if (xlsxLoading) return;
    xlsxLoading = true;
    var s = document.createElement('script');
    s.src = XLSX_URL;
    s.onload = function () {
      xlsxLoading = false;
      if (!xlsxReady()) { xlsxFailed = true; xlsxQueue = []; toast('缺少 Excel 解析库（' + XLSX_URL + '）'); return; }
      var q = xlsxQueue;
      xlsxQueue = [];
      for (var i = 0; i < q.length; i++) q[i]();
    };
    s.onerror = function () {
      xlsxLoading = false;
      xlsxFailed = true;
      xlsxQueue = [];
      toast('缺少 Excel 解析库（' + XLSX_URL + '）');
    };
    document.head.appendChild(s);
  }

  /* ---------------- 读取文件 → 选择工作表 ---------------- */
  function pickFile() {
    whenXlsx(function () {});   // 预取：文件对话框还开着的时候，库就下好了
    el.fileInput.value = '';
    el.fileInput.click();
  }

  function readFile(file) {
    whenXlsx(function () { parseFile(file); });
  }

  function parseFile(file) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    var isText = ext === 'csv' || ext === 'txt';
    var fr = new FileReader();
    fr.onerror = function () { toast('文件读取失败，请重试'); };
    fr.onload = function () {
      var wb;
      try {
        if (isText) {
          var buf = fr.result;
          var text = new TextDecoder('utf-8').decode(buf);
          if (RE_BAD_CHAR.test(text)) {
            try { text = new TextDecoder('gbk').decode(buf); } catch (e) {}
          }
          wb = XLSX.read(text, { type: 'string' });
        } else {
          wb = XLSX.read(new Uint8Array(fr.result), { type: 'array' });
        }
      } catch (e) {
        toast('这个文件读不出来，请确认是 Excel 或 CSV');
        return;
      }
      if (!wb || !wb.SheetNames || !wb.SheetNames.length) { toast('文件里没有找到工作表'); return; }
      collectSheets(wb, file.name);
    };
    fr.readAsArrayBuffer(file);
  }

  function collectSheets(wb, fileName) {
    var sheets = [];
    wb.SheetNames.forEach(function (n) {
      var grid = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, blankrows: false, defval: '' });
      var a = analyzeRows(normalizeGrid(grid));
      sheets.push({
        name: n,
        analysis: a,                                    // 可能为 null（空表）
        mapping: a ? Object.assign({}, a.mapping) : { w: 0, m: 1, p: -1, e: -1 },
        checked: !!(a && a.count)
      });
    });
    if (!sheets.length) { toast('这个文件里没有可用的工作表'); return; }
    ST.pending = { fileName: fileName, sheets: sheets };
    openSheetModal();
  }

  function openSheetModal() {
    var p = ST.pending;
    var usable = p.sheets.filter(function (s) { return s.analysis; }).length;
    el.sheetModalFile.textContent = p.fileName + ' · 共 ' + p.sheets.length + ' 个工作表，已识别 ' + usable +
      ' 张。勾选要导入的（每张会成为一本独立词书，可分别调整列）：';
    renderSheetList();
    el.sheetModal.hidden = false;
  }

  function renderSheetList() {
    var wrap = el.sheetList;
    var frag = document.createDocumentFragment();
    ST.pending.sheets.forEach(function (s, idx) {
      var row = document.createElement('div');
      row.className = 'sheet-row' + (s.analysis ? '' : ' is-empty');

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'sheet-check';
      cb.checked = !!s.checked;
      cb.disabled = !s.analysis;
      cb.addEventListener('change', function () {
        s.checked = cb.checked;
        row.classList.toggle('is-picked', cb.checked);
        syncSheetAll();
      });
      row.appendChild(cb);

      var info = document.createElement('div');
      info.className = 'sheet-info';
      var nm = document.createElement('p');
      nm.className = 'sheet-name';
      nm.textContent = s.name;
      var mt = document.createElement('p');
      mt.className = 'sheet-meta';
      mt.textContent = s.analysis
        ? (s.analysis.rows.length + ' 行数据 · 识别到 ' + countWords(s.analysis.rows, s.analysis.hasHeader, s.mapping) + ' 个词条' +
           (s.analysis.hasHeader ? ' · 表头：' + s.analysis.headers.slice(0, 4).join(' / ') : ' · 未识别到表头'))
        : '空表，已跳过';
      info.appendChild(nm);
      info.appendChild(mt);
      row.appendChild(info);

      var maps = document.createElement('div');
      maps.className = 'sheet-map';
      if (s.analysis) {
        [['w', '英文列'], ['m', '中文列'], ['p', '词性列']].forEach(function (f) {
          var lab = document.createElement('label');
          lab.className = 'mini-field';
          var sp = document.createElement('span');
          sp.textContent = f[1];
          var sel = document.createElement('select');
          var none = document.createElement('option');
          none.value = '-1';
          none.textContent = '不指定';
          sel.appendChild(none);
          s.analysis.headers.forEach(function (h, i) {
            var o = document.createElement('option');
            o.value = String(i);
            o.textContent = h;
            sel.appendChild(o);
          });
          sel.value = String(s.mapping[f[0]]);
          sel.addEventListener('change', function () {
            s.mapping[f[0]] = parseInt(sel.value, 10);
            mt.textContent = s.analysis.rows.length + ' 行数据 · 识别到 ' +
              countWords(s.analysis.rows, s.analysis.hasHeader, s.mapping) + ' 个词条' +
              (s.analysis.hasHeader ? ' · 表头：' + s.analysis.headers.slice(0, 4).join(' / ') : ' · 未识别到表头');
          });
          lab.appendChild(sp);
          lab.appendChild(sel);
          maps.appendChild(lab);
        });
      }
      row.appendChild(maps);

      row.classList.toggle('is-picked', !!s.checked);
      row.addEventListener('click', function (e) {
        if (!s.analysis) return;
        if (e.target.closest('select, button, input')) return;
        cb.checked = !cb.checked;
        s.checked = cb.checked;
        row.classList.toggle('is-picked', cb.checked);
        syncSheetAll();
      });
      frag.appendChild(row);
    });
    wrap.innerHTML = '';
    wrap.appendChild(frag);
    syncSheetAll();
  }

  function syncSheetAll() {
    var usable = ST.pending.sheets.filter(function (s) { return s.analysis; });
    var picked = usable.filter(function (s) { return s.checked; });
    el.sheetAll.checked = usable.length > 0 && picked.length === usable.length;
    el.sheetAll.indeterminate = picked.length > 0 && picked.length < usable.length;
  }

  function closeSheetModal() {
    el.sheetModal.hidden = true;
    ST.pending = null;
  }

  function confirmSheetImport() {
    var p = ST.pending;
    if (!p) return;
    var picked = p.sheets.filter(function (s) { return s.checked && s.analysis; });
    if (!picked.length) { toast('至少勾选一张有内容的工作表'); return; }

    var multi = p.sheets.length > 1;
    var baseName = p.fileName.replace(RE_EXT, '');
    var created = [];
    var totalWords = 0;

    picked.forEach(function (s) {
      var a = s.analysis;
      var exist = ST.books.filter(function (b) {
        return b.fileName === p.fileName && b.sheetName === s.name;
      })[0];

      if (exist) {
        if (confirm('《' + exist.name + '》之前已经导入过了，要覆盖它吗？\n确定 = 用新内容覆盖，取消 = 另外存一本')) {
          exist.grid = a.rows;
          exist.hasHeader = a.hasHeader;
          exist.headers = a.headers;
          exist.mapping = Object.assign({}, s.mapping);
          exist.count = countWords(a.rows, a.hasHeader, s.mapping);
          exist.importedAt = Date.now();
          dropCache(exist.id);
          created.push(exist);
          totalWords += exist.count;
          return;
        }
      }

      var book = {
        id: uid(),
        name: multi ? s.name : baseName,
        fileName: p.fileName,
        sheetName: s.name,
        sheetCount: p.sheets.length,
        grid: a.rows,
        hasHeader: a.hasHeader,
        headers: a.headers,
        mapping: Object.assign({}, s.mapping),
        count: countWords(a.rows, a.hasHeader, s.mapping),
        importedAt: Date.now()
      };
      if (!book.name) book.name = '未命名词书';
      if (exist) book.name += '（副本）';
      ST.books.push(book);
      created.push(book);
      totalWords += book.count;
    });

    ST.selected = {};
    created.forEach(function (b) { ST.selected[b.id] = true; });
    touchData();
    var saved = saveStore();
    renderLibrary();
    closeSheetModal();
    toast('已导入 ' + created.length + ' 本词书（' + totalWords + ' 词条），已自动勾选' +
      (saved ? '' : '；但本地存储已满，刷新后可能丢失'));
  }

  /* ---------------- 编辑词书 ---------------- */
  function fillEditSelects(book) {
    [el.editW, el.editM, el.editP, el.editE].forEach(function (sel, k) {
      var key = ['w', 'm', 'p', 'e'][k];
      sel.innerHTML = '';
      var none = document.createElement('option');
      none.value = '-1';
      none.textContent = (key === 'w' || key === 'm') ? '— 请选择 —' : '— 不指定 —';
      sel.appendChild(none);
      book.headers.forEach(function (h, i) {
        var o = document.createElement('option');
        o.value = String(i);
        o.textContent = h;
        sel.appendChild(o);
      });
      sel.value = String(book.mapping[key]);
    });
  }

  function readEditMapping() {
    return {
      w: parseInt(el.editW.value, 10),
      m: parseInt(el.editM.value, 10),
      p: parseInt(el.editP.value, 10),
      e: parseInt(el.editE.value, 10)
    };
  }

  /* ---- 编辑窗口里的查重面板 ----
     把互相冲突的词条摊开，直接在框里改成一致的内容；
     改动先攒在 ST.cfEdits 里（'表格行号:w' / '表格行号:m' -> 新值），点「保存」才写回表格。 */

  // 表格里这一格原本的内容，用来判断「是不是又改回原样了」
  function cfOrig(book, row, role, mp) {
    var r = book.grid[row];
    var col = role === 'w' ? mp.w : mp.m;
    return (r && col >= 0) ? clean(r[col]) : '';
  }

  // 这一格现在该显示什么：改过就显示改过的，没改就显示原本的
  function cfCell(row, role, raw) {
    var ov = ST.cfEdits;
    if (ov) {
      var v = ov[row + ':' + role];
      if (v !== undefined) return v;
    }
    return raw;
  }

  // 把改好的内容写回表格（只动被改过的那几行），返回改了几格
  function applyCfEdits(book, mp) {
    var ov = ST.cfEdits, n = 0;
    if (!ov) return 0;
    Object.keys(ov).forEach(function (k) {
      var p = k.split(':');
      var row = parseInt(p[0], 10);
      var col = p[1] === 'w' ? mp.w : mp.m;
      var r = book.grid[row];
      if (!r || col < 0) return;
      if (clean(r[col]) === clean(ov[k])) return;
      var next = r.slice();          // 换一份新行，不就地改原来那行
      while (next.length <= col) next.push('');
      next[col] = ov[k];
      book.grid[row] = next;
      n++;
    });
    return n;
  }

  function renderEditConflicts() {
    var book = bookById(ST.editingId);
    var mp = readEditMapping();
    // 列表本身也带着「还没保存的改动」一起算：改一处，下面就少一处
    var list = (book && mp.w >= 0 && mp.m >= 0) ? scanConflicts(book, mp, ST.cfEdits) : [];

    // 按冲突点分组（归一化后的英文 / 中文相同的就是一组），组内前后相邻
    var groups = [], seen = Object.create(null);
    list.forEach(function (it) {
      it.why.forEach(function (wy) {
        var gk = wy.kind + '|' + wy.nk;
        if (seen[gk]) return;
        seen[gk] = 1;
        groups.push({ kind: wy.kind, key: wy.key, n: wy.n, items: wy.items });
      });
    });

    el.cfList.innerHTML = '';
    el.cfHead.hidden = el.cfPanel.hidden = !groups.length;
    if (!groups.length) return;
    el.cfCount.textContent = list.length + ' 条词条 · ' + groups.length + ' 处冲突';

    var frag = document.createDocumentFragment();
    groups.forEach(function (g) {
      var box = document.createElement('div');
      box.className = 'cf-group';

      var head = document.createElement('div');
      head.className = 'cf-group-head';
      var kind = document.createElement('span');
      kind.className = 'cf-kind';
      kind.textContent = g.kind === 'w' ? '同词异义' : '异词同义';
      var desc = document.createElement('span');
      desc.className = 'cf-desc';
      desc.textContent = g.kind === 'w'
        ? '同一个英文「' + g.key + '」对上了 ' + g.n + ' 种中文意思'
        : '同一个中文意思「' + g.key + '」对上了 ' + g.n + ' 个英文';
      head.appendChild(kind);
      head.appendChild(desc);
      box.appendChild(head);

      // 这一组里大多数是哪个值，就把它当「标准」，跟它不一样的那几格才是要改的，标出来
      var vkey = g.kind === 'w' ? 'nm' : 'nw';    // 变的是哪一边：按英文分组时变中文，反之亦然
      var oddRole = g.kind === 'w' ? 'm' : 'w';   // 对应到输入框的哪一栏
      var tally = Object.create(null), refV = '', refN = -1, q;
      for (q = 0; q < g.items.length; q++) {
        var vv = g.items[q][vkey];
        tally[vv] = (tally[vv] || 0) + 1;
      }
      for (q = 0; q < g.items.length; q++) {
        if (tally[g.items[q][vkey]] > refN) { refN = tally[g.items[q][vkey]]; refV = g.items[q][vkey]; }
      }

      g.items.forEach(function (it) {
        var odd = it[vkey] !== refV;
        var rw = document.createElement('div');
        rw.className = 'cf-row' + (odd ? ' is-odd' : '');

        var ln = document.createElement('span');
        ln.className = 'cf-line';
        ln.textContent = '第 ' + it.line + ' 行';
        rw.appendChild(ln);

        [['m', it.m], ['w', it.w]].forEach(function (c) {
          var inp = document.createElement('input');
          inp.type = 'text';
          inp.className = 'cf-input' + (odd && c[0] === oddRole ? ' is-odd' : '');
          inp.placeholder = c[0] === 'm' ? '中文意思' : '英文';
          inp.dataset.cfRow = String(it.row);
          inp.dataset.cfRole = c[0];
          inp.value = cfCell(it.row, c[0], c[1]);
          rw.appendChild(inp);
        });
        box.appendChild(rw);
      });
      frag.appendChild(box);
    });
    el.cfList.appendChild(frag);
  }

  function renderEditPreview() {
    var book = bookById(ST.editingId);
    if (!book) return;
    var mp = readEditMapping();
    var head = book.hasHeader ? 1 : 0;
    var tb = el.editPreview.querySelector('tbody');
    tb.innerHTML = '';
    var data = book.hasHeader ? book.grid.slice(1) : book.grid.slice();
    var shown = 0;
    for (var i = 0; i < data.length && shown < 10; i++) {
      // 预览也跟着「还没保存的改动」走，改完一眼就能看到
      var w = mp.w >= 0 ? clean(cfCell(i + head, 'w', data[i][mp.w])) : '';
      var m = mp.m >= 0 ? clean(cfCell(i + head, 'm', data[i][mp.m])) : '';
      if (!w || !m) continue;
      var tr = document.createElement('tr');
      [String(shown + 1), m, w, mp.p >= 0 ? clean(data[i][mp.p]) : '—'].forEach(function (t) {
        var td = document.createElement('td');
        td.textContent = t;
        tr.appendChild(td);
      });
      tb.appendChild(tr);
      shown++;
    }
    if (!shown) {
      var tr2 = document.createElement('tr');
      var td2 = document.createElement('td');
      td2.colSpan = 4;
      td2.style.color = '#8d8478';
      td2.textContent = (mp.w < 0 || mp.m < 0) ? '请先选择英文列与中文列' : '这几列里没有读到有效词条';
      tr2.appendChild(td2);
      tb.appendChild(tr2);
    }
    el.editCount.textContent = '识别到 ' + countWords(book.grid, book.hasHeader, mp) + ' 个词条';
  }

  function openEdit(id) {
    var book = bookById(id);
    if (!book) return;
    ST.editingId = id;
    ST.cfEdits = {};          // 新开一次编辑，查重面板里的「未保存改动」从零开始
    el.editName.value = book.name;
    el.editMeta.textContent = '来源：' + book.fileName + ' · 工作表「' + book.sheetName + '」· 导入于 ' + timeAgo(book.importedAt);
    fillEditSelects(book);
    renderEditPreview();
    renderEditConflicts();
    el.editModal.hidden = false;
    el.editName.focus();
  }

  function closeEdit() {
    el.editModal.hidden = true;
    ST.editingId = null;
    ST.cfEdits = null;        // 关掉就丢弃没保存的改动
  }

  function saveEdit() {
    var book = bookById(ST.editingId);
    if (!book) return;
    var mp = readEditMapping();
    if (mp.w < 0 || mp.m < 0) { toast('英文列和中文列都要选'); return; }
    var count = countWords(book.grid, book.hasHeader, mp);
    if (!count) { toast('这几列里没有读到有效词条，请改一下列的选择'); return; }

    // 校验通过之后，再把查重面板里改好的内容写回表格，
    // 接着重算词条数并清缓存，词书库那一行的冲突标记就会跟着更新 / 消失
    var fixed = applyCfEdits(book, mp);
    if (fixed) count = countWords(book.grid, book.hasHeader, mp);

    // 列映射或词条内容变了，词表的键也跟着变，旧进度对不上新词表 —— 干脆清掉，从头再背
    var contentChanged = fixed > 0 || count !== book.count ||
      JSON.stringify(book.mapping) !== JSON.stringify(mp);

    book.name = clean(el.editName.value) || book.name;
    book.mapping = mp;
    book.count = count;
    if (contentChanged) clearProg(book.id);
    dropCache(book.id);
    touchData();
    saveStore();
    renderLibrary();
    closeEdit();
    toast('已保存《' + book.name + '》' + (fixed ? '，改了 ' + fixed + ' 处冲突' : ''));
  }

  /* ---------------- 一轮背词 ---------------- */
  function startRound(onlyId) {
    var words, names, books, plan = null;
    if (onlyId === REVIEW_ID) {
      // 「开始复习（20 词）」：只背复习本里权重最高的那批，不受勾选状态影响
      words = reviewQueue();
      if (!words.length) { toast('复习本里暂时没有要复习的词'); return; }
      names = '复习本';
      books = [reviewBook()];
      ST.roundNote = '（复习本每次最多 ' + REVIEW_BATCH + ' 词）';
    } else {
      plan = batchPlan();
      // 已经全部过完一遍的词书：这一轮从头再背，先把它的进度清零
      var restarted = [];
      plan.forEach(function (p) {
        if (!p.restart) return;
        clearProg(p.book.id);
        restarted.push(p.book.name);
      });
      // 清零要马上落盘：万一这一轮一张都没答就关页面，下次打开也不该又显示「已过完一遍」
      if (restarted.length) saveStoreSoon();
      words = planWords(plan);
      if (!words.length) { toast('先勾选至少一本有内容的词书'); return; }
      books = selectedBooks();
      names = books.map(function (b) { return b.name; }).join(' + ');
      var bs = batchSize();
      ST.roundNote = (bs && plan.some(function (p) { return p.batch && p.words.length >= bs; }))
        ? '（每本每轮最多 ' + bs + ' 词）' : '';
      /* 原来这里会弹「《x》已全部过完一遍，这次从头再背」/「本轮共 N 词」。
         这两条都是「本轮开始的说明」，而同样的信息背词界面自己会显示：
         HUD 第二行就是「词书名 · 共 N 词（每本每轮最多 M 词）」（ST.roundNote）。
         所以直接不弹，不再有提示框。 */
    }
    ST.credit = plan ? creditFrom(plan) : Object.create(null);
    ST.roundNames = names;
    ST.round += 1;
    ST.total = words.length;
    ST.revRound = 0;      // 本轮有几个词来自复习本
    ST.revCleared = 0;    // 本轮有几个词被「消化」掉
    ST.queue = words.map(function (x, i) {
      // src 记录这个词条来自哪些词书，统计时用来归到具体词书
      if (x.rev) ST.revRound++;
      return { id: i, w: x.w, m: x.m, wl: x.wl || x.w.toLowerCase(), p: x.p, e: x.e, src: x.src || [], forgot: 0, rev: !!x.rev };
    });
    if (ST.settings.shuffle) shuffle(ST.queue);
    ST.mastered = [];
    ST.repeats = 0;
    ST.firstTry = 0;
    ST.undoStack = [];
    ST.startAt = Date.now();
    ST.roundLogged = false;
    ST.answered = false;
    ST.current = ST.queue[0] || null;

    el.hudRound.textContent = String(ST.round);
    el.roundBooks.textContent = ST.roundNames + ' · 共 ' + ST.total + ' 词' + (ST.roundNote || '');
    el.brandSub.textContent = '第 ' + ST.round + ' 轮 · ' + books.length + ' 本词书';
    el.btnBackHome.hidden = false;
    show('study');
    /* 先锁高度再渲染第一张卡：顺序反了的话第一张会先按自然高度画出来、
       下一帧才被压到锁定高度，开局抖一下。
       show('study') 必须在锁定之前 —— 背词页隐藏时量不到真实宽度。 */
    lockCardHeight(ST.queue);
    /* 描边路径要按模块的实际宽高生成，所以也放在 show('study') 之后 ——
       隐藏时 clientWidth/clientHeight 都是 0，生成的路径会退化成空。 */
    buildHudRingPath();
    renderCard();
  }

  function renderCard() {
    if (!ST.current) { finish(); return; }
    stopSpeak();                 // 换到下一张卡，上一张的读音立刻掐掉
    ST.answered = false;
    el.answer.hidden = true;
    el.stamp.hidden = true;
    /* 换卡先收起「完整内容」与溢出态。不重置的话，上一张溢出的卡留下的
       is-overflow 会继续挂在卡片上，把这张的单词和例句莫名截断。 */
    el.wordcard.classList.remove('is-overflow');
    if (el.btnFullText) el.btnFullText.hidden = true;
    el.wordText.innerHTML = '';
    el.controlsAsk.hidden = false;
    el.controlsNext.hidden = true;
    el.cardHintFlag.textContent = ST.current.forgot > 0 ? '重考 ' + ST.current.forgot + ' 次' : '';

    var resolved = ST.total - ST.queue.length;
    el.cardIndex.textContent = '第 ' + (resolved + 1) + ' 张 · 共 ' + ST.total + ' 张';
    el.meaning.textContent = ST.current.m;

    /* 词性显示在「中文意思」下方，始终可见 —— 提问时是提示，揭示后是补充说明，
       两个阶段都该在，所以这里只管内容、不管显隐（揭示时不再收起来）。
       没有词性的词条（表格里那一列空着）整行隐藏，不留空档。
       原来这里管的是一枚「提示 · 看词性」按钮的显隐，那个功能已去掉。 */
    var pos = ST.current.p || '';
    el.wordPos.textContent = pos;
    el.wordPos.hidden = !pos;

    restartCardAnims();
    /* 描边路径按模块实测尺寸生成；放在这里是因为「这一屏刚刚布局完」——
       开局那次调用可能在字体/进度文字把模块撑到最终宽度之前就跑掉了，
       那时算出来的宽度偏小，误差全堆在右边（左边贴合、右边缩在里面）。
       每翻一张卡都补一次，尺寸没变时 buildHudRingPath() 内部会直接返回。 */
    buildHudRingPath();
    updateHud();
    notifyNative();   // 门禁刚关上，把这个状态告诉原生（壳子据此熄灭自己的发音入口）
  }

  /* 上一次生成路径时用的模块尺寸。用来跳过无意义的重复生成 ——
     renderCard() 每翻一张卡都会调一次 buildHudRingPath()，而绝大多数时候
     模块尺寸根本没变，没必要每次都重设 d（重设 d 会让描边重新渲染一次）。 */
  var RING_W = 0, RING_H = 0;

  /**
   * 生成 HUD 描边进度那条圆角矩形路径。
   *
   * 为什么要在 JS 里生成：模块宽高是流式的（跟着视口走），
   * 圆角矩形的 d 必须按实测尺寸算才能贴合。SVG 本身不设 viewBox，
   * 1 个用户单位 = 1 CSS px，所以直接把 getBoundingClientRect() 的
   * 宽高拿来用即可，不需要任何缩放换算。
   *
   * **这个函数必须「幂等且随时可调」**：路径是按某一刻的实测宽高算出来的
   * 静态字符串，一旦模块后来又变了尺寸而没重新生成，就会看到
   * 「左边贴合、右边缩在里面」这种单边偏移 ——
   * 因为宽度算小了，而路径是从左边开始画的，误差全堆在右边。
   * 所以除了窗口 resize，下面这几个时机也都要调（见各自的调用点）：
   * 开局、每次翻卡、ResizeObserver 报尺寸变化。
   *
   * 两个关键尺寸：
   *   · inset = 半个线宽（CSS 里 stroke-width:3 → 1.5px）。
   *     描边是以路径为中心向两侧各画半个线宽的；路径贴边的话朝外那 1.5px
   *     会被模块的 overflow:hidden 裁掉，画出来只有一半粗。
   *   · r = 模块的圆角半径减掉 inset，才是路径这一圈的圆角半径 ——
   *     路径整体内缩了，圆角也要跟着收，否则弧线会比模块的边框凸出来。
   *
   * 路径从**上边中点**起笔、顺时针一圈，这样一个单位的 dashoffset
   * 正好让进度从上边中点向两侧长出去，视觉上最自然。
   * 用 A（椭圆弧）而不是 C：半径相等时 A 画出来就是正圆角。
   */
  function buildHudRingPath() {
    var hud = el.hud;
    var track = el.hudRingTrack;
    if (!hud || !track || !el.hudRingBar) return;
    /* 用 getBoundingClientRect() 而不是 clientWidth/clientHeight：
       后者是**取整过的整数**（模块实测 341.17 → clientWidth 341），
       拿它算路径会让右边、下边各短掉一个不到 1px 的零头 ——
       在 dpr=1 的网页版上这点零头正好看得出来。 */
    var box = hud.getBoundingClientRect();
    var w = box.width;
    var h = box.height;
    if (!w || !h) return;
    /* 尺寸没变就不重设 d：这个函数会被频繁调用（每次翻卡），
       重复 setAttribute('d') 会让描边白白重绘一次。 */
    if (w === RING_W && h === RING_H) return;
    RING_W = w;
    RING_H = h;

    var INSET = 1.5;                    // = stroke-width / 2
    var x0 = INSET, y0 = INSET;
    var x1 = w - INSET, y1 = h - INSET;
    // 从模块的 border-radius 反推路径的圆角半径
    var radius = parseFloat(getComputedStyle(hud).borderTopLeftRadius) || 0;
    var r = Math.max(0, Math.min(radius - INSET, (x1 - x0) / 2, (y1 - y0) / 2));
    var midX = (x0 + x1) / 2;

    var d =
      'M ' + midX + ' ' + y0 +
      ' H ' + (x1 - r) +
      ' A ' + r + ' ' + r + ' 0 0 1 ' + x1 + ' ' + (y0 + r) +
      ' V ' + (y1 - r) +
      ' A ' + r + ' ' + r + ' 0 0 1 ' + (x1 - r) + ' ' + y1 +
      ' H ' + (x0 + r) +
      ' A ' + r + ' ' + r + ' 0 0 1 ' + x0 + ' ' + (y1 - r) +
      ' V ' + (y0 + r) +
      ' A ' + r + ' ' + r + ' 0 0 1 ' + (x0 + r) + ' ' + y0 +
      ' H ' + midX + ' Z';

    track.setAttribute('d', d);
    el.hudRingBar.setAttribute('d', d);
  }

  /* 描边路径必须跟着模块的尺寸走。
     为什么不能只靠 window 的 resize：
     路径是按模块某一刻的实测宽高算出来的**静态 d 字符串**，模块之后
     再变尺寸而没重新生成，就会看到「左边贴合、右边缩在里面」——
     宽度算小了，而路径从左边起笔，误差全堆在右边。
     窗口 resize 只是「模块变尺寸」的其中一种原因：网页版上换个宽度、
     字体加载完、进度文字从「0%」变成「26%」把那一行撑宽，都可能让模块
     变尺寸而 window 上根本没有 resize 事件。
     用 ResizeObserver 直接盯模块本身，任何原因导致的尺寸变化都能跟上。 */
  if (window.ResizeObserver && el.hud) {
    var hudRO = new ResizeObserver(function () {
      /* 只盯宽高，避免 ResizeObserver 因为其它观察项反复触发 */
      buildHudRingPath();
    });
    hudRO.observe(el.hud);
  }

  function updateHud() {
    var done = ST.mastered.length;
    el.hudRemain.textContent = String(ST.queue.length);
    el.hudDone.textContent = String(done);
    el.hudRepeat.textContent = String(ST.repeats);
    var p = ST.total ? done / ST.total : 0;
    /* 描边进度：path 上写了 pathLength="100"，周长已是 100，
       所以偏移量直接用 (1-p)*100 —— 既不用 getTotalLength()，
       也不用按圆角矩形公式手算周长（2*(w-2r)+2*(h-2r)+2πr）。 */
    if (el.hudRingBar) {
      el.hudRingBar.style.strokeDashoffset = String((1 - p) * 100);
      /* 0% 时用**透明度**藏起来，不用 display/hidden ——
         这是关键：display:none → inline 会让浏览器把元素当成「刚插入」，
         把 stroke-dashoffset 的过渡整段跳过（实测：删掉 hidden 与改
         dashoffset 写在同一帧，计算结果从 100px 直接跳到 75px，
         描边以 25% 的长度凭空蹦出来，没有任何生长过程）。
         改成常驻 + opacity:0 之后，透明度与长度会一起过渡，
         首次得题时描边是「一边变长一边淡入」地长出来的。
         opacity:0 的元素连同它在 0% 时可能残留的那一个抗锯齿像素
         一起完全不可见，所以原来那个「0% 冒出一个点」的问题也仍然解决。 */
      el.hudRingBar.style.opacity = p > 0 ? '1' : '0';
    }
    el.ringText.textContent = Math.round(p * 100) + '%';
  }

  var answerKbd = null;

  function revealWord(isYes) {
    var c = ST.current;
    el.meaning.textContent = c.m;
    el.wordText.innerHTML = '';
    var frag = document.createDocumentFragment();
    var w = c.w, i = 0;
    for (var k = 0; k < w.length; k++) {
      var ch = w.charAt(k);
      if (ch === ' ') { frag.appendChild(document.createTextNode(' ')); continue; }
      var sp = document.createElement('span');
      sp.textContent = ch;
      sp.style.animationDelay = (i * 24) + 'ms';
      frag.appendChild(sp);
      i++;
    }
    el.wordText.appendChild(frag);
    el.wordExample.textContent = c.e || '';
    el.wordExample.hidden = !c.e;
    el.answer.hidden = false;
    el.stamp.hidden = false;
    el.stamp.classList.toggle('is-miss', !isYes);
    el.stampText.textContent = isYes ? '✓ 记得' : '↻ 再背一次';
    el.controlsAsk.hidden = true;
    el.controlsNext.hidden = false;
    el.btnNext.textContent = ST.queue.length ? '下一个' : '看看成绩';
    // 复用同一个 kbd 节点，避免每张卡都重建一次
    if (!answerKbd) { answerKbd = document.createElement('kbd'); answerKbd.textContent = '空格'; }
    el.btnNext.appendChild(answerKbd);
    /* 内容铺好之后判一次有没有放不下 —— 必须放在这里而不是更早：
       上面几行刚把 answer 显示出来、把文字写进去，此刻的 scrollHeight
       才是真实的内容高度。早一步量到的还是空内容。 */
    detectCardOverflow();
    notifyNative();   // 词已经展示出来，门禁打开，通知原生可以读了
  }

  function answer(isYes) {
    if (ST.answered || !ST.current) return;
    ST.answered = true;
    var c = ST.current;
    var rec = statAnswer(c, isYes);      // 顺手记一笔学习统计
    var marks = [];                      // 这张卡新记下的覆盖进度，撤销时按它精确回滚

    // 复习本联动：先留一份这个词进复习本之前的模样，撤销时好原样还原
    var revKey = c.wl || (c.w || '').toLowerCase();
    var revSnap = reviewSnapshot(revKey);

    ST.undoStack.push({
      queue: ST.queue.slice(),
      mastered: ST.mastered.slice(),
      repeats: ST.repeats,
      firstTry: ST.firstTry,
      prevForgot: c.forgot,
      stat: rec,
      revKey: revKey,
      revSnap: revSnap,
      revCleared: ST.revCleared,
      progMarks: marks
    });
    if (ST.undoStack.length > 60) ST.undoStack.shift();

    ST.queue.shift();
    if (isYes) {
      if (c.forgot === 0) ST.firstTry++;
      ST.mastered.push(c);
      // 覆盖进度：答「记得」才算这本词书的这个词过了一遍（只认本轮真的背到的词）
      var key = c.wl || (c.w || '').toLowerCase();
      for (var s = 0; s < (c.src || []).length; s++) {
        var bid = c.src[s];
        if (ST.credit && ST.credit[bid] && ST.credit[bid][key] && markDone(bid, key)) {
          marks.push({ id: bid, key: key });
        }
      }
      if (marks.length) saveStoreSoon();
      // 答「记得」：连续记住 +1，够次数就判为「消化」，先从复习队列里退下去
      if (reviewPass(c)) ST.revCleared++;
    } else {
      c.forgot++;
      ST.repeats++;
      reviewCollect(c);                  // 答「不记得」：自动收录 / 遗忘次数 +1，权重随之抬高
      var mode = ST.settings.requeue;
      if (mode === 'front') ST.queue.unshift(c);
      else if (mode === 'end') ST.queue.push(c);
      else ST.queue.splice(Math.min(ST.queue.length, 3 + Math.floor(Math.random() * 4)), 0, c);
    }
    revealWord(isYes);
    updateHud();
  }

  function nextCard() {
    if (!ST.answered) return;
    if (!ST.queue.length) { finish(); return; }
    ST.current = ST.queue[0];
    renderCard();
  }

  function undo() {
    var snap = ST.undoStack.pop();
    if (!snap) { toast('没有可撤销的步骤'); return; }
    ST.queue = snap.queue;
    ST.mastered = snap.mastered;
    ST.repeats = snap.repeats;
    ST.firstTry = snap.firstTry;
    statUndo(snap.stat);
    reviewRestore(snap.revKey, snap.revSnap);   // 复习本的收录 / 遗忘次数跟着一起回滚
    if (typeof snap.revCleared === 'number') ST.revCleared = snap.revCleared;
    // 覆盖进度也跟着回滚：只删掉「正是这一张卡新记下的」那些键
    if (snap.progMarks && snap.progMarks.length) {
      snap.progMarks.forEach(function (mk) {
        var m = ST.prog[mk.id];
        if (m && m[mk.key]) { delete m[mk.key]; PROGVER++; }
      });
      saveStoreSoon();
    }
    ST.current = ST.queue[0] || null;
    if (!ST.current) { finish(); return; }
    if (typeof snap.prevForgot === 'number') ST.current.forgot = snap.prevForgot;
    renderCard();
  }

  function finish() {
    var ms = Date.now() - ST.startAt;
    if (!ST.roundLogged) { ST.roundLogged = true; statRound(ms); }
    el.doneRound.textContent = String(ST.round);
    el.doneTotal.textContent = String(ST.total);
    el.doneFirst.textContent = String(ST.firstTry);
    el.doneRate.textContent = (ST.total ? Math.round(ST.firstTry / ST.total * 100) : 0) + '%';
    el.doneTime.textContent = fmtTime(ms);
    // 分批背的词书：成绩单上把覆盖进度说清楚，方便直接接着背下一批
    var bs = batchSize(), progParts = [];
    if (bs) {
      selectedBooks().forEach(function (b) {
        if (b.virtual) return;
        var cs = coverStat(b);
        if (cs.total <= bs) return;
        progParts.push('《' + b.name + '》' + cs.done + '/' + cs.total +
          (cs.rest ? '，还剩 ' + cs.rest + ' 词，点「继续背」接着背' : '，已全部过完一遍'));
      });
    }
    el.doneSub.textContent = '共 ' + ST.total + ' 个词条，重考 ' + ST.repeats + ' 次，' +
      (ST.total ? '平均每个词看了 ' + (1 + ST.repeats / ST.total).toFixed(1) + ' 次。' : '') +
      (progParts.length ? ' 覆盖进度：' + progParts.join('；') + '。' : '');
    el.doneBooks.textContent = '词书：' + (ST.roundNames || '—');

    // 这一轮里有多少是「复习本」的词，顺便报一下还剩多少待复习
    if (ST.revRound > 0) {
      var left = reviewPendingCount();
      el.doneReview.hidden = false;
      el.doneReview.textContent = '本轮有 ' + ST.revRound + ' 个词来自复习本' +
        (ST.revCleared ? '，其中 ' + ST.revCleared + ' 个连着答对已「消化」' : '') +
        '；复习本还剩 ' + left + ' 个待复习' +
        (left > REVIEW_BATCH ? '（下次先抽权重最高的 ' + REVIEW_BATCH + ' 个）' : '') + '。';
    } else {
      el.doneReview.hidden = true;
      el.doneReview.textContent = '';
    }

    var forgot = ST.mastered.filter(function (x) { return x.forgot > 0; })
      .sort(function (a, b) { return b.forgot - a.forgot; });
    var okList = ST.mastered.filter(function (x) { return x.forgot === 0; });
    el.doneForgotCount.textContent = String(forgot.length);
    el.doneMasteredCount.textContent = String(okList.length);
    fillList(el.doneForgotList, forgot, true);
    fillList(el.doneMasteredList, okList, false);

    ST.current = null;
    show('done');
  }

  function fillList(ul, arr, showTimes) {
    ul.innerHTML = '';
    if (!arr.length) {
      var li0 = document.createElement('li');
      li0.className = 'empty';
      // showTimes 那一栏是「需要重点复习」，空的说明一个词都没忘过；
      // 另一栏是「已经拿下」，空的说明没有一次就过的词。两句话别写反了。
      li0.textContent = showTimes ? '本轮没有需要重点复习的词，全部一次就记住，厉害。' : '本轮没有一次就记住的词。';
      ul.appendChild(li0);
      return;
    }
    var frag = document.createDocumentFragment();
    arr.forEach(function (x) {
      var li = document.createElement('li');
      var a = document.createElement('span');
      a.className = 'wl-en';
      a.textContent = x.w;
      var mid = document.createElement('span');
      mid.style.flex = '1';
      var b = document.createElement('span');
      b.className = 'wl-cn';
      b.textContent = x.m;
      li.appendChild(a);
      li.appendChild(mid);
      li.appendChild(b);
      if (showTimes) {
        var t = document.createElement('span');
        t.className = 'wl-times';
        t.textContent = '忘了 ' + x.forgot + ' 次';
        li.appendChild(t);
      }
      frag.appendChild(li);
    });
    ul.appendChild(frag);
  }

  /* ---------------- 学习统计：渲染 ---------------- */
  var WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

  function statsTotal() {
    var t = { a: 0, o: 0, m: 0, r: 0, ms: 0, days: 0 };
    Object.keys(ST.stats.days).forEach(function (k) {
      var d = ST.stats.days[k];
      if (!d || !(d.a > 0 || d.r > 0)) return;
      t.days++;
      t.a += d.a || 0;
      t.o += d.o || 0;
      t.m += d.m || 0;
      t.r += d.r || 0;
      t.ms += d.t || 0;
    });
    return t;
  }

  function computeStreak() {
    var cur = todayKey();
    if (!dayActive(cur)) {
      cur = shiftDay(cur, -1);
      if (!dayActive(cur)) return 0;
    }
    var n = 0;
    while (dayActive(cur)) { n++; cur = shiftDay(cur, -1); }
    return n;
  }

  function computeLongest() {
    var keys = Object.keys(ST.stats.days).filter(function (k) { return dayActive(k); }).sort();
    var best = 0, run = 0, prev = null;
    keys.forEach(function (k) {
      run = (prev && shiftDay(prev, 1) === k) ? run + 1 : 1;
      if (run > best) best = run;
      prev = k;
    });
    return best;
  }

  function durationParts(ms) {
    var min = Math.round(ms / 60000);
    if (min < 60) return [String(min), '分钟'];
    return [(min / 60).toFixed(min < 600 ? 1 : 0), '小时'];
  }

  function statCard(num, unit, label, cls) {
    var box = document.createElement('div');
    box.className = 'stat-card';
    var n = document.createElement('span');
    n.className = 'stat-num' + (cls ? ' ' + cls : '');
    n.textContent = String(num);
    if (unit) {
      var u = document.createElement('i');
      u.textContent = unit;
      n.appendChild(u);
    }
    var l = document.createElement('span');
    l.className = 'stat-label';
    l.textContent = label;
    box.appendChild(n);
    box.appendChild(l);
    return box;
  }

  function renderStatCards() {
    var t = statsTotal();
    var streak = computeStreak();
    var longest = computeLongest();
    var rate = t.a ? Math.round(t.o / t.a * 100) : 0;
    var dur = durationParts(t.ms);

    var frag = document.createDocumentFragment();
    [
      [String(t.days), '天', '累计打卡', ''],
      [String(streak), '天', '当前连续', 'is-jade'],
      [String(longest), '天', '最长连续', ''],
      [String(t.a), '次', '累计背词', 'is-jade'],
      [String(t.o), '次', '一次就记住', ''],
      [rate + '%', '', '一次通过率', 'is-red'],
      [dur[0], dur[1], '累计用时', '']
    ].forEach(function (c) {
      frag.appendChild(statCard(c[0], c[1], c[2], c[3]));
    });
    el.statGrid.innerHTML = '';
    el.statGrid.appendChild(frag);

    if (!t.days) {
      el.statsSub.textContent = '还没有学习记录。先去背一轮，这里就会长出你的热力图。';
    } else {
      el.statsSub.textContent = '已坚持 ' + t.days + ' 天，完成 ' + t.r + ' 轮，共看过 ' + t.a +
        ' 张卡片，平均每天 ' + (t.a / t.days).toFixed(1) + ' 张。';
    }
  }

  function heatLevelFn() {
    var vals = [];
    Object.keys(ST.stats.days).forEach(function (k) {
      var v = (ST.stats.days[k] || {}).a || 0;
      if (v > 0) vals.push(v);
    });
    vals.sort(function (a, b) { return a - b; });
    var max = vals.length ? vals[vals.length - 1] : 0;
    var t1 = 1, t2 = 2, t3 = 3;
    if (max > 0) {
      t1 = Math.max(1, Math.ceil(max * 0.25));
      t2 = Math.max(t1 + 1, Math.ceil(max * 0.5));
      t3 = Math.max(t2 + 1, Math.ceil(max * 0.75));
    }
    return function (v) {
      if (!v) return 0;
      if (v <= t1) return 1;
      if (v <= t2) return 2;
      if (v <= t3) return 3;
      return 4;
    };
  }

  /* 热力图。同一个函数画两处，只是窗口长度不同：
       · 统计页正文里 = 最近两个月（HEAT_DAYS_MAIN）
       · 「看一年」弹窗里 = 最近一年（HEAT_DAYS_YEAR）
     两个目标各有自己的签名缓存，互不干扰。 */
  var heatSig = '';
  var heatSigYear = '';

  function renderHeatmapInto(days, wrap, rangeEl, subEl, sigKey) {
    var today = new Date();
    today.setHours(0, 0, 0, 0);

    var cols = days.length / 7;
    var tk = todayKey();
    // 窄屏用更小的格子，尽量一屏放下整段时间
    var CSIZE = (window.innerWidth && window.innerWidth <= 720) ? 10 : 12;

    // 布局与统计数据都没变（例如重复打开统计页、窗口宽度没变的 resize）就直接复用，不做重复重建
    var sig = cols + '|' + CSIZE + '|' + days[0] + '|' + days[days.length - 1] + '|' + STATS_VER;
    if (sigKey === 'year') {
      if (sig === heatSigYear && wrap.firstChild) return;
      heatSigYear = sig;
    } else {
      if (sig === heatSig && wrap.firstChild) return;
      heatSig = sig;
    }

    var level = heatLevelFn();

    // 星期标签（0 是周日，和 GitHub 一样只标周一/三/五）
    var weekdays = document.createElement('div');
    weekdays.className = 'heat-weekdays';
    ['', '一', '', '三', '', '五', ''].forEach(function (txt) {
      var s = document.createElement('span');
      s.textContent = txt;
      weekdays.appendChild(s);
    });

    var main = document.createElement('div');
    main.className = 'heat-main';

    var months = document.createElement('div');
    months.className = 'heat-months';
    months.style.gridTemplateColumns = 'repeat(' + cols + ', ' + CSIZE + 'px)';
    var lastMonth = -1;
    for (var c = 0; c < cols; c++) {
      var first = days[c * 7];
      if (!first) continue;
      var mon = parseDay(first).getMonth();
      if (mon === lastMonth) continue;
      lastMonth = mon;
      var ml = document.createElement('span');
      ml.className = 'heat-month';
      ml.style.gridColumn = String(c + 1);
      ml.textContent = (mon + 1) + ' 月';
      months.appendChild(ml);
    }

    var grid = document.createElement('div');
    grid.className = 'heat-grid';
    grid.style.gridTemplateColumns = 'repeat(' + cols + ', ' + CSIZE + 'px)';
    wrap.style.setProperty('--cell', CSIZE + 'px');
    var best = 0, bestDay = '';
    days.forEach(function (k) {
      var cell = document.createElement('div');
      cell.className = 'heat-cell';
      if (!k) {
        cell.classList.add('is-void');
        grid.appendChild(cell);
        return;
      }
      var v = (ST.stats.days[k] || {}).a || 0;
      if (v > best) { best = v; bestDay = k; }
      cell.classList.add('lv' + level(v));
      if (k === tk) cell.classList.add('is-today');
      cell.dataset.day = k;
      grid.appendChild(cell);
    });

    main.appendChild(months);
    main.appendChild(grid);
    wrap.innerHTML = '';
    wrap.appendChild(weekdays);
    wrap.appendChild(main);

    var n = days.length;
    var from = days[0] || shiftDay(tk, -(n - 1));
    rangeEl.textContent = (n >= 360 ? '最近一年' : '最近两个月') + '（' +
      parseDay(from).getFullYear() + ' 年 ' + fmtDay(from) + ' 至今）';
    subEl.textContent = best
      ? '每一格是一天，颜色越深背得越多；最深的一天是 ' + fmtDay(bestDay) + '，背了 ' + best + ' 张。'
      : '每一格是一天，颜色越深表示那天背的词越多。';
  }

  /** 生成从 start 到 today 的连续日键，并补满最后一列（7 的倍数）。 */
  function buildHeatDays(start) {
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var days = [], d = new Date(start);
    while (d <= today) { days.push(dayKey(d)); d.setDate(d.getDate() + 1); }
    while (days.length % 7) days.push('');               // 补满最后一列
    return days;
  }

  /** 起点：从今天往前推 n-1 天，再对齐到周日那一列。 */
  function heatStart(n) {
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var start = new Date(today);
    start.setDate(start.getDate() - (n - 1));
    start.setDate(start.getDate() - start.getDay());     // 对齐到周日那列
    return start;
  }

  function renderHeatmap() {
    renderHeatmapInto(
      buildHeatDays(heatStart(HEAT_DAYS)),
      el.heatWrap, el.heatRange, el.heatSub, 'main'
    );
  }

  function renderHeatmapYear() {
    if (!el.heatWrapFull) return;
    renderHeatmapInto(
      buildHeatDays(heatStart(HEAT_DAYS_YEAR)),
      el.heatWrapFull, el.heatModalRange, el.heatModalSub, 'year'
    );
  }

  function heatTipHtml(k) {
    var d = ST.stats.days[k];
    var head = '<b>' + fmtDay(k) + '</b> <span class="tip-dim">周' + WEEK_CN[parseDay(k).getDay()] + '</span>';
    if (!d || !(d.a > 0 || d.r > 0)) return head + '<br><span class="tip-dim">这天没有背词</span>';
    var html = head + '<br>背词 <b>' + (d.a || 0) + '</b> 张 · 一次记住 <b>' + (d.o || 0) +
      '</b> · 忘了 <b>' + (d.m || 0) + '</b>';
    if (d.r) {
      var dp = durationParts(d.t || 0);
      html += '<br>完成 <b>' + d.r + '</b> 轮 · 用时 ' + dp[0] + ' ' + dp[1];
    }
    return html;
  }

  function showHeatTip(k, cell) {
    el.heatTip.innerHTML = heatTipHtml(k);
    el.heatTip.hidden = false;
    var r = cell.getBoundingClientRect();
    var w = el.heatTip.offsetWidth, h = el.heatTip.offsetHeight;
    var left = Math.max(12, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 12));
    var top = r.top - h - 10;
    if (top < 12) top = r.bottom + 10;
    el.heatTip.style.left = left + 'px';
    el.heatTip.style.top = top + 'px';
  }

  /* ---- 最近 N 天的柱子图 ----
     同一段代码画两处：统计页面板里是 7 天，弹窗里是 14 天。
     两处的柱子都按「天」等分容器宽度，所以 14 天那一份天然比 7 天窄 ——
     7 天刚好铺满，14 天就需要横向滚动（见 CSS 的 .trend.is-wide）。
     这样弹窗里能看到和面板里完全一样的图形语言，不必为弹窗另做一套。 */
  function buildTrendKeys(days) {
    var keys = [], cur = todayKey();
    for (var i = days - 1; i >= 0; i--) keys.push(shiftDay(cur, -i));
    return keys;
  }

  function trendValue(k) {
    return (ST.stats.days[k] || {}).a || 0;
  }

  /* 把一组日期画成柱子，返回 { frag, sum }。
     柱高按这一组自己的最高值归一 —— 面板和弹窗各算各的，
     因为「7 天里的最高值」和「14 天里的最高值」不是同一个数；
     共用会让两边的柱子高度对不上同一天的实际情况。
     代价是两次渲染里同一个数的柱子可能不一样高，但那本来就不是一屏，
     各自在各自的坐标系里读得通就够了。 */
  function buildTrendFrag(keys, cur) {
    var max = 1, sum = 0;
    keys.forEach(function (k) {
      var v = trendValue(k);
      sum += v;
      if (v > max) max = v;
    });

    var frag = document.createDocumentFragment();
    keys.forEach(function (k) {
      var v = trendValue(k);
      var d = parseDay(k);
      var col = document.createElement('div');
      col.className = 'trend-col' + (k === cur ? ' is-today' : '');

      var val = document.createElement('span');
      val.className = 'trend-val';
      val.textContent = v ? String(v) : '';

      var wrap = document.createElement('div');
      wrap.className = 'trend-bar-wrap';
      var bar = document.createElement('div');
      bar.className = 'trend-bar' + (v ? '' : ' is-zero');
      bar.style.height = Math.max(2, Math.round(v / max * 100)) + '%';
      bar.title = fmtDay(k) + ' · 背词 ' + v + ' 张';
      wrap.appendChild(bar);

      var day = document.createElement('span');
      day.className = 'trend-day';
      day.textContent = (d.getMonth() + 1) + '/' + d.getDate();

      col.appendChild(val);
      col.appendChild(wrap);
      col.appendChild(day);
      frag.appendChild(col);
    });

    return { frag: frag, sum: sum };
  }

  /* 统计页面板：最近 7 天。这一块整块是按钮（#btnTrendOpen），
     点它打开 14 天的弹窗，所以这里只负责画图与更新文字，不挂事件。 */
  function renderTrend() {
    var cur = todayKey();
    var week = buildTrendFrag(buildTrendKeys(7), cur);
    el.trendWrap.innerHTML = '';
    el.trendWrap.appendChild(week.frag);

    var twoWeeks = buildTrendFrag(buildTrendKeys(14), cur);
    el.trendWrapFull.innerHTML = '';
    el.trendWrapFull.appendChild(twoWeeks.frag);

    el.trendSub.textContent = week.sum
      ? '近 7 天一共背了 ' + week.sum + ' 张卡片'
      : '近 7 天还没有记录';
    el.trendModalSub.textContent = twoWeeks.sum
      ? '近 14 天一共背了 ' + twoWeeks.sum + ' 张卡片'
      : '近 14 天还没有记录';

    /* 原来这里会判一次「要不要显示左右滑动提示」。
       滑动指示条已全部去掉（弹窗里横向滚动时没有提示条、滚动条也不画），
       所以这里不再需要同步。 */
  }

  /* ---------------- 背景词：词书库顶栏下方随机展示一个词条 ----------------
     取代了原来那堆装饰性封面：内容换成词书里真实存在的词条，
     显示英文 / 词性 / 中文 / 例句，整块可点，点了换一个。

     取值口径：**所有导入的词书**，不只是勾选的那些 ——
     勾选随时会变（全不选、只留一本），而这块是常驻的背景内容，
     跟着勾选变来变去会让人以为词书丢了。
     注：复习本是动态词书（没有 grid），所以只遍历 ST.books，不含它。 */
  var HERO_POOL = null, HERO_POOL_VER = -1;
  var HERO_ORDER = null, HERO_AT = 0, HERO_CUR = null;

  function heroWordPool() {
    /* STEP 是「词书数据结构版本号」，导入 / 编辑 / 删除都会让它 +1。
       它没变时复用上次的池子，避免每次进词书库都把所有词书的表重解析一遍。 */
    if (HERO_POOL && HERO_POOL_VER === STEP) return HERO_POOL;
    var pool = [];
    ST.books.forEach(function (b) {
      var ws = wordsOf(b);
      if (!ws) return;
      for (var i = 0; i < ws.length; i++) {
        var x = ws[i];
        if (x && x.w && x.m) pool.push(x);
      }
    });
    HERO_POOL = pool;
    HERO_POOL_VER = STEP;
    return pool;
  }

  /* 洗牌：池子变化时做一次，之后按顺序取。
     直接用 Math.random() 抽的话，同一个词可能连着出现好几次 ——
     洗牌后顺序取能保证「一轮之内不重复」。 */
  function reshuffleHero() {
    HERO_ORDER = heroWordPool().slice();
    for (var i = HERO_ORDER.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = HERO_ORDER[i]; HERO_ORDER[i] = HERO_ORDER[j]; HERO_ORDER[j] = t;
    }
    HERO_AT = 0;
  }

  function renderHeroWord() {
    if (!el.heroWord) return;                 // 元素不在（理论上不会）
    var pool = heroWordPool();
    if (!pool.length) {
      /* 还没导入任何词书：整块收起，不留一个空壳在页面上 */
      el.heroWord.hidden = true;
      HERO_CUR = null;
      return;
    }
    if (!HERO_ORDER || HERO_ORDER.length !== pool.length) reshuffleHero();
    if (HERO_AT >= HERO_ORDER.length) { reshuffleHero(); }
    var item = HERO_ORDER[HERO_AT++];
    HERO_CUR = item;

    el.heroWord.hidden = false;
    el.heroWordEn.textContent = item.w || '';
    el.heroWordCn.textContent = item.m || '';

    /* 词性和例句都是可选的列（mapping 里是 -1 就没这一列），
       缺哪一条就把那一行收起来，而不是留一行空白 */
    var pos = (item.p || '').trim();
    if (pos) { el.heroWordPos.textContent = pos; el.heroWordPos.hidden = false; }
    else { el.heroWordPos.hidden = true; }

    var ex = (item.e || '').trim();
    if (ex) { el.heroWordEx.textContent = ex; el.heroWordEx.hidden = false; }
    else { el.heroWordEx.hidden = true; }
  }

  /* 点一下换一个。用 click 而不是 pointerdown：
     这块是 <button>，click 才是它的激活语义，键盘回车 / 空格也走这条路。 */
  if (el.heroWord) {
    el.heroWord.addEventListener('click', renderHeroWord);
  }

  function renderBookStats() {
    var rows = [], seen = Object.create(null);
    ST.books.forEach(function (b) {
      var st = ST.stats.books[b.id];
      var cs = coverStat(b);
      seen[b.id] = true;
      rows.push({
        name: b.name, from: groupKeyOf(b),
        a: st ? st.a : 0, o: st ? st.o : 0, gone: false,
        cov: cs.done, tot: cs.total, batch: !!batchSize() && cs.total > batchSize()
      });
    });
    Object.keys(ST.stats.books).forEach(function (id) {
      if (seen[id]) return;
      var st = ST.stats.books[id];
      // 复习本是一本动态词书，不在列表里，但它的作答记录要照常出现，别标成「已删除」
      if (id === REVIEW_ID) {
        rows.push({ name: '复习本', from: '动态收录', a: st.a, o: st.o, gone: false });
        return;
      }
      rows.push({ name: st.n || '（未命名词书）', from: '已从词书库删除', a: st.a, o: st.o, gone: true });
    });
    rows.sort(function (a, b) { return (b.a - a.a) || (a.name > b.name ? 1 : -1); });

    el.bookStats.innerHTML = '';
    if (!rows.length) {
      var empty = document.createElement('li');
      empty.className = 'mastery-empty';
      empty.textContent = '词书库还是空的，导入一本词书再开始吧。';
      el.bookStats.appendChild(empty);
      return;
    }

    // 背过的排在前面；还没背过的只展示前几本，其余归并成一行，避免刷屏
    var started = rows.filter(function (r) { return r.a > 0; });
    var idle = rows.filter(function (r) { return !r.a; });
    var showIdle = started.length ? idle.slice(0, 3) : idle;
    var list = started.slice(0, 12).concat(showIdle);

    var frag = document.createDocumentFragment();
    list.forEach(function (r) {
      var rate = r.a ? Math.round(r.o / r.a * 100) : 0;
      var li = document.createElement('li');
      li.className = 'mastery-item' + (r.a ? '' : ' is-empty');

      var top = document.createElement('div');
      top.className = 'mastery-top';
      var nm = document.createElement('span');
      nm.className = 'mastery-name';
      nm.textContent = r.name;
      nm.title = r.from + ' · ' + r.name;
      var num = document.createElement('span');
      num.className = 'mastery-num';
      num.textContent = r.a ? (rate + '% · 背过 ' + r.a + ' 次') : '还没背过';
      // 覆盖进度：这本词书里过了一遍多少个词（分批背的词书才有意义）
      if (r.tot) {
        var cov = document.createElement('span');
        cov.className = 'mastery-cov';
        cov.textContent = '覆盖 ' + r.cov + '/' + r.tot;
        cov.title = '这本词书里已经答过「记得」、算过了一遍的词：' + r.cov + ' / ' + r.tot + '。' +
          (r.batch ? '词数超过每轮 ' + batchSize() + ' 词的上限，是分批背的。' : '');
        num.appendChild(document.createTextNode(' · '));
        num.appendChild(cov);
      }
      top.appendChild(nm);
      top.appendChild(num);

      var bar = document.createElement('div');
      bar.className = 'mastery-bar';
      var fill = document.createElement('span');
      fill.style.width = (r.a ? rate : 0) + '%';
      bar.appendChild(fill);

      li.appendChild(top);
      li.appendChild(bar);
      frag.appendChild(li);
    });

    var hidden = rows.length - list.length;
    if (hidden > 0) {
      var tail = document.createElement('li');
      tail.className = 'mastery-empty';
      tail.textContent = '另外还有 ' + hidden + ' 本词书还没开始背。';
      frag.appendChild(tail);
    }
    el.bookStats.appendChild(frag);
  }

  function renderHardWords() {
    var list = Object.keys(ST.stats.words)
      .map(function (k) { return ST.stats.words[k]; })
      .filter(function (w) { return w && w.f > 0; })
      .sort(function (a, b) { return (b.f - a.f) || (b.s - a.s); });

    el.hardCount.textContent = String(list.length);
    fillList(el.hardWords, list.slice(0, 12).map(function (w) {
      return { w: w.w, m: w.m, forgot: w.f };
    }), true);
  }

  var statsSig = '';
  function renderStats() {
    renderSpeakEngine();   // 「发音引擎」那块要看当前实际生效的引擎，每次都刷一下
    // 统计数据与词书列表都没变（例如反复打开统计页）就整块跳过，省掉一次无意义的 DOM 重排；
    // 带上今天日期，保证跨天后“当前连续 / 热力图范围”等按日期算的数值不会被跳过。
    var sig = STATS_VER + '|' + STEP + '|' + ST.books.length + '|' + todayKey() +
      '|' + PROGVER + '|' + batchSize();
    if (sig === statsSig) return;
    statsSig = sig;
    renderStatCards();
    renderHeatmap();
    renderTrend();
    renderBookStats();
    renderHardWords();
    renderBackup();          // 面板里那句「当前可导出：…」跟着最新数据走
  }

  function openStats() {
    renderStats();
    show('stats');
  }

  /* ---------------- 事件绑定 ---------------- */
  el.btnPick.addEventListener('click', pickFile);
  el.dropzone.addEventListener('click', function (e) {
    if (e.target.closest('.btn') || e.target.closest('a')) return;
    // 正在选中文字时不弹文件框，避免误触
    var sel = '';
    try { sel = String(window.getSelection ? window.getSelection() : ''); } catch (err) {}
    if (sel) return;
    pickFile();
  });
  el.fileInput.addEventListener('change', function () {
    if (this.files && this.files[0]) readFile(this.files[0]);
  });

  ['dragenter', 'dragover'].forEach(function (ev) {
    document.addEventListener(ev, function (e) {
      e.preventDefault();
      if (el.screenLibrary.classList.contains('is-active')) {
        if (!el.dropzone.classList.contains('is-over')) el.dropzone.classList.add('is-over');
      }
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    document.addEventListener(ev, function (e) {
      e.preventDefault();
      if (ev === 'dragleave' && el.dropzone.contains(e.relatedTarget)) return;
      el.dropzone.classList.remove('is-over');
    });
  });
  document.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && el.screenLibrary.classList.contains('is-active')) readFile(f);
  });

  el.btnDemo.addEventListener('click', function () {
    whenXlsx(function () {
      var wb = XLSX.utils.book_new();
      var aoa = [['英文单词/词组', '中文意思', '词性', '例句']].concat(DEMO);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '示例词书');
      collectSheets(wb, '内置示例词书.xlsx');
    });
  });

  /* 「下载模板」：模板用 SheetJS 现造现下，不依赖目录里任何静态文件——
     这样无论是本地目录打开、打包成单个 HTML，还是直接分享给别人，都不会点出 404。 */
  el.btnTemplate.addEventListener('click', function () {
    whenXlsx(function () {
      var aoa = [['英文单词/词组', '中文意思', '词性', '例句']].concat(DEMO.slice(0, 5));
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 18 }, { wch: 30 }, { wch: 10 }, { wch: 46 }];
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '词书模板');
      var buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      /* 和「导出备份」走同一个入口：壳子里交给原生另存为，
         网页版仍然直接用 Blob 下载。Uint8Array 是本就是二进制，
         所以不像文本那样还要给一个 textForWeb 的退路。 */
      var ok = saveFile('词书模板.xlsx',
        buf instanceof Uint8Array ? buf : new Uint8Array(buf),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      if (ok && !nativeSaveAvailable()) {
        toast('模板已下载：第一行是表头，照着往下填就行');
      } else if (ok) {
        toast('模板已导出：第一行是表头，照着往下填就行');
      }
    });
  });

  el.bookList.addEventListener('click', function (e) {
    // 分类标题：收起 / 展开；分类复选框交给 change 处理
    var gact = e.target.closest('[data-gact]');
    if (gact) {
      if (gact.dataset.gact === 'toggle') {
        var gnode = gact.closest('.book-group');
        if (gnode) toggleGroup(gnode.dataset.group);
      }
      return;
    }
    var btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    var li = e.target.closest('.book');
    if (!li) return;
    var id = li.dataset.id;
    var act = btn.dataset.act;
    if (act === 'up') moveBook(id, -1);
    else if (act === 'down') moveBook(id, 1);
    else if (act === 'batch') startBatch(id);
    else if (act === 'edit') openEdit(id);
    else if (act === 'del') deleteBook(id);
  });

  el.bookList.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.dataset || t.dataset.gact !== 'check') return;
    var gnode = t.closest('.book-group');
    if (gnode) setGroupSelect(gnode.dataset.group, t.checked);
  });

  /* 搜索 */
  /* 搜索：整块重渲染实测只有 1~2 ms（几十本词书的量级），所以直接跟着按键走，
     不必再等 140 ms 防抖——那 140 ms 是纯粹的延迟，不是省下来的开销。
     词书特别多时（超过 SEARCH_PLAIN_MAX 本）才退回防抖，保证极端情况下打字不卡。 */
  var searchApply = function () {
    if (ST.books.length > SEARCH_PLAIN_MAX) {   // 极端情况：退回防抖
      clearTimeout(ST.searchTimer);
      var v = el.libSearch.value;
      ST.searchTimer = setTimeout(function () { setQuery(v); }, SEARCH_DEBOUNCE);
      return;
    }
    setQuery(el.libSearch.value);
  };
  el.libSearch.addEventListener('input', function (e) {
    if (e && e.isComposing) return;   // 拼音组词中间态先不重排，等 compositionend
    searchApply();
  });
  el.libSearch.addEventListener('compositionend', searchApply);
  el.libSearch.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      el.libSearch.value = '';
      setQuery('');
    }
  });
  el.btnSearchClear.addEventListener('click', function () {
    el.libSearch.value = '';
    setQuery('');
    el.libSearch.focus();
  });

  /* 分类收起 / 展开 */
  el.btnGroupExpand.addEventListener('click', function () { setAllCollapsed(false); });
  el.btnGroupCollapse.addEventListener('click', function () { setAllCollapsed(true); });

  /* 学习统计 */
  el.btnStats.addEventListener('click', function () {
    if (el.screenStudy.classList.contains('is-active') && ST.current) {
      if (!confirm('去看统计？本轮进度不会保存。')) return;
      ST.current = null;
      ST.queue = [];
    }
    openStats();
  });
  el.btnDoneStats.addEventListener('click', openStats);
  /* 「返回词书库」这个按钮已经移除（统计页底部有悬浮底栏、完成页有自己的返回），
     所以这里加了存在性判断。留着这段而不是删掉，是为了让「万一以后又加回来」
     时行为还在；不加判断会直接 TypeError 把后面所有初始化都带崩。 */
  if (el.btnBackLibFromStats) {
    el.btnBackLibFromStats.addEventListener('click', function () {
      renderLibrary();
      show('library');
    });
  }
  el.btnStatsReset.addEventListener('click', function () {
    if (!confirm('清空全部学习统计？\n（只清学习记录，词书不受影响，清空后无法恢复）')) return;
    ST.stats = newStats();
    STATS_VER++;            // 标记统计已变，让依赖它的视图（热力图等）重新绘制
    saveStats();
    renderStats();
    toast('学习统计已清空');
  });

  /* 数据备份：把本机六类数据（词书库 / 勾选 / 覆盖进度 / 复习本 / 学习统计 / 设置）
     一起导出成一个 JSON；导入分「合并」和「覆盖」两种 */
  el.btnExport.addEventListener('click', function () {
    var name = '单词卡备份-' + todayKey().replace(/-/g, '') + '.json';
    var ok;
    try {
      ok = saveFile(name, JSON.stringify(buildBackup(), null, 2), 'application/json;charset=utf-8');
    } catch (err) {
      toast('导出失败：' + ((err && err.message) || '无法生成备份内容'));
      return;
    }
    if (!ok) return;   // saveFile 已经提示过原因
    renderBackup();
    /* 网页版在 saveFile 里就已经触发了下载，这里补一句提示；
       壳子里要等原生回调（用户还要在系统选择器里挑保存位置）。 */
    if (!nativeSaveAvailable()) toast('已导出 ' + name);
  });

  function pickImportFile(mode) {
    ST.importMode = mode;
    el.importFile.value = '';   // 清一下，才能连着导同一个文件
    el.importFile.click();
  }

  el.btnImportMerge.addEventListener('click', function () { pickImportFile('merge'); });
  el.btnImportReplace.addEventListener('click', function () { pickImportFile('replace'); });

  el.importFile.addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (!f) return;
    var mode = ST.importMode || 'merge';
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try {
        parsed = parseBackup(String(reader.result || ''));
      } catch (err) {
        toast('导入失败：' + ((err && err.message) || '文件读不出来'));
        return;
      }
      // 让用户先看清「文件里到底有什么」再决定，避免一紧张点了覆盖
      var bits = [];
      if (parsed.hasBooks) bits.push('词书 ' + parsed.books.length + ' 本');
      if (parsed.hasSelected) bits.push('勾选状态 ' + parsed.selected.length + ' 项');
      if (parsed.hasProg) {
        var progN = 0;
        Object.keys(parsed.prog).forEach(function (id) { progN += parsed.prog[id].length; });
        bits.push('背词进度 ' + progN + ' 词');
      }
      if (parsed.review) bits.push('复习本 ' + Object.keys(parsed.review).length + ' 条词条');
      if (parsed.stats) {
        // 顺带把「在里面学了多久」算给用户看：热力图的日用时相加就是累计用时
        var dayMs = 0;
        Object.keys(parsed.stats.days).forEach(function (k) { dayMs += parsed.stats.days[k].t || 0; });
        var dpart = durationParts(dayMs);
        bits.push('学习记录 ' + Object.keys(parsed.stats.books).length + ' 本词书 / ' +
          Object.keys(parsed.stats.days).length + ' 天 / ' +
          Object.keys(parsed.stats.words).length + ' 个词条，累计学了 ' + dpart[0] + ' ' + dpart[1]);
      }
      if (parsed.settings) bits.push('设置');
      var head = '文件里有：' + bits.join('，') + '。\n\n' +
        (mode === 'replace'
          ? '覆盖导入：文件里有哪块就整个换掉本机那块，文件里没有的块保持不动。\n' +
            '注意词书会被换成文件里那份，本机多出来的词书连同它的背词进度一起消失，且无法撤销——' +
            '建议先「导出备份」留一份当前的。'
          : '合并导入：词书按「同一份 Excel 的同一张表」去重后追加，背词进度 / 勾选取并集，' +
            '复习本按遗忘次数取多的，学习记录按天逐项相加（学习用时也相加，同一份文件别导两次，会翻倍），' +
            '设置以文件为准。');
      if (!confirm(head + '\n\n确定继续？')) return;
      var after = applyBackup(parsed, mode);
      toast((mode === 'replace' ? '已覆盖为：' : '已合并为：') + after);
    };
    reader.onerror = function () { toast('文件读取失败，换个文件再试'); };
    reader.readAsText(f, 'utf-8');
  });

  /* 热力图：悬浮 / 点击查看某天明细 */
  el.heatWrap.addEventListener('mouseover', function (e) {
    var cell = e.target.closest('.heat-cell');
    if (!cell || !cell.dataset.day) { el.heatTip.hidden = true; return; }
    showHeatTip(cell.dataset.day, cell);
  });
  el.heatWrap.addEventListener('mouseleave', function () { el.heatTip.hidden = true; });
  el.heatWrap.addEventListener('click', function (e) {
    var cell = e.target.closest('.heat-cell');
    if (cell && cell.dataset.day) showHeatTip(cell.dataset.day, cell);
  });
  // 滚动时收起悬浮提示；已经收起就不再重复写值，省掉滚动过程中的无谓样式失效。
  // 用 passive 声明「不会阻止默认滚动」，浏览器就不必等这个回调跑完再滚动。
  window.addEventListener('scroll', function () { if (!el.heatTip.hidden) el.heatTip.hidden = true; },
    { capture: true, passive: true });
  // 视口宽度变化时重排热力图（格子尺寸会跟着变）
  var heatResizeTimer = null;
  window.addEventListener('resize', function () {
    el.heatTip.hidden = true;
    if (!el.screenStats.classList.contains('is-active')) return;
    clearTimeout(heatResizeTimer);
    heatResizeTimer = setTimeout(function () {
      if (!el.screenStats.classList.contains('is-active')) return;
      /* 先把签名清掉再重画。签名里虽然含 CSIZE，但当宽度跨过 720px 那一档时
         CSIZE 变了、签名理应不同 —— 问题在于「没跨档但容器宽变了」时
         签名不变，会命中缓存直接 return。清掉最省事，重画本身很便宜。 */
      heatSig = '';
      heatSigYear = '';
      renderHeatmap();
    }, 200);
  });

  el.btnSelectAll.addEventListener('click', function () { setSelectAll(true); });
  el.btnSelectNone.addEventListener('click', function () { setSelectAll(false); });
  el.btnDeleteSelected.addEventListener('click', deleteSelected);

  el.optShuffle.addEventListener('change', function () { ST.settings.shuffle = this.checked; saveSettings(); });
  el.selRequeue.addEventListener('change', function () { ST.settings.requeue = this.value; saveSettings(); });
  el.selBatch.addEventListener('change', function () {
    var n = parseInt(this.value, 10);
    ST.settings.batch = isFinite(n) && n >= 0 ? n : DEFAULT_BATCH;
    saveSettings();
    touchSel();          // 取词计划跟着变，勾选类的缓存重算
    renderLibrary();     // 进度条可能要出现 / 消失
  });

  el.btnStart.addEventListener('click', function () {
    if (el.btnStart.disabled) return;
    startRound();
  });

  /* 发音引擎（统计页最下面）：换一档立刻生效，并记住选择 */
  if (el.speakEngineGroup) {
    el.speakEngineGroup.addEventListener('change', function (e) {
      var t = e.target;
      if (!t || t.name !== 'speakEngine') return;
      ST.settings.speakEngine = SPEAK_ENGINE_MODES.indexOf(t.value) >= 0 ? t.value : 'auto';
      saveSettings();
      applySpeakEngine();
    });
  }
  if (el.btnSpeakTest) el.btnSpeakTest.addEventListener('click', testSpeak);

  /* 复习本（动态词书）：一键只复习它 / 清空重来。
     标题左侧那个「并入普通复习流」的勾选框已从界面上移除，
     所以这里的事件绑定也要判空 —— 元素不存在时直接跳过。 */
  if (el.reviewPick) {
    el.reviewPick.addEventListener('change', function () {
      if (this.checked) ST.selected[REVIEW_ID] = true; else delete ST.selected[REVIEW_ID];
      touchSel();
      updateSummary();
      saveStoreSoon();
    });
  }

  el.btnReviewStart.addEventListener('click', function () {
    if (!reviewPendingCount()) { toast('复习本还是空的，背词时点「不记得」的词会自动收进来'); return; }
    // 只是「单独复习一遍」，不顺手改动勾选状态，免得和词书库里的选择打架
    startRound(REVIEW_ID);
  });

  el.btnReviewClear.addEventListener('click', function () {
    var n = reviewTotalCount();
    if (!n) { toast('复习本本来就是空的'); return; }
    if (!confirm('清空复习本？收录的 ' + n + ' 个词条连同遗忘次数都会删掉，不可恢复。')) return;
    ST.review.items = Object.create(null);
    delete ST.selected[REVIEW_ID];
    reviewChanged();
    renderLibrary();
    toast('复习本已清空');
  });

  /* 工作表选择弹窗 */
  el.sheetAll.addEventListener('change', function () {
    var on = this.checked;
    ST.pending.sheets.forEach(function (s) { if (s.analysis) s.checked = on; });
    renderSheetList();
  });
  el.btnSheetOk.addEventListener('click', confirmSheetImport);
  el.btnSheetCancel.addEventListener('click', closeSheetModal);
  el.btnSheetClose.addEventListener('click', closeSheetModal);
  el.sheetModal.addEventListener('click', function (e) { if (e.target === el.sheetModal) closeSheetModal(); });

  /* 编辑词书弹窗 */
  [el.editW, el.editM, el.editP, el.editE].forEach(function (sel) {
    sel.addEventListener('change', function () {
      // 换了英文 / 中文列，之前按旧列改的内容就对不上了，先作废再重新判重
      if (sel === el.editW || sel === el.editM) { ST.cfEdits = {}; renderEditConflicts(); }
      renderEditPreview();
    });
  });

  /* 查重面板：改完一格（失焦 / 回车）立刻按新内容重新判重，改一处就少一处 */
  el.cfList.addEventListener('change', function (e) {
    var inp = e.target;
    var role = (inp && inp.dataset) ? inp.dataset.cfRole : null;
    if (role !== 'w' && role !== 'm') return;
    var book = bookById(ST.editingId);
    if (!book) return;
    var row = parseInt(inp.dataset.cfRow, 10);
    // 改回原样、或者清空（真要删词条请回 Excel 改），都当作没动过
    if (!clean(inp.value) || clean(inp.value) === cfOrig(book, row, role, readEditMapping())) {
      delete ST.cfEdits[row + ':' + role];
    } else {
      ST.cfEdits[row + ':' + role] = inp.value;
    }
    renderEditConflicts();
    renderEditPreview();
  });

  el.btnEditSave.addEventListener('click', saveEdit);
  el.btnEditCancel.addEventListener('click', closeEdit);
  el.btnEditClose.addEventListener('click', closeEdit);
  el.btnEditDelete.addEventListener('click', function () {
    var id = ST.editingId;
    closeEdit();
    if (id) deleteBook(id);
  });
  el.editModal.addEventListener('click', function (e) { if (e.target === el.editModal) closeEdit(); });

  /* 背词页 */
  el.btnYes.addEventListener('click', function () { answer(true); });
  el.btnNo.addEventListener('click', function () { answer(false); });
  el.btnNext.addEventListener('click', nextCard);
  el.btnUndo.addEventListener('click', undo);
  // 「下一个」旁边的撤销按钮：与按 U 完全一致（同一个 undo）
  el.btnUndoStep.addEventListener('click', undo);

  /* 原来这里绑的是「提示 · 看词性」按钮：点一下在按钮上展开词性、再点收起。
     该功能已去掉 —— 词性现在直接显示在「中文意思」下方，始终可见。 */

  /* 发音：点一下读，正在读的时候再点一下就是停 */
  el.btnSpeak.addEventListener('click', speakWord);

  if (WEB_OK && typeof window.speechSynthesis.addEventListener === 'function') {
    // 音色表是异步填的，首次调用常常是空数组；填好后清掉缓存，下次点击重新挑
    window.speechSynthesis.addEventListener('voiceschanged', function () { speakVoice = null; });
  }

  SPEAK_MODE = currentMode();
  syncSpeakButton();
  if (SPEAK_MODE === 'none') {
    /* 有些 APK 壳子是在页面脚本跑完之后才把桥接对象注入进来的，
       所以不立刻把按钮藏死，过一会儿再确认一次。 */
    setTimeout(function () {
      SPEAK_MODE = currentMode();
      syncSpeakButton();
    }, 1200);
  }

  el.btnQuit.addEventListener('click', function () {
    if (confirm('结束本轮？本轮进度不会保存。')) {
      ST.current = null;
      ST.queue = [];
      finish();
    }
  });
  /* 同上：背词界面底部的「返回词书库」也已移除（顶部已有控件） */
  if (el.btnBackLib) {
    el.btnBackLib.addEventListener('click', function () {
      renderLibrary();
      show('library');
    });
  }

  el.btnAgain.addEventListener('click', function () { startRound(); });
  el.btnBackLibrary.addEventListener('click', function () {
    renderLibrary();
    show('library');
  });
  el.btnNewFile.addEventListener('click', function () {
    renderLibrary();
    show('library');
    pickFile();
  });
  el.btnBackHome.addEventListener('click', function () {
    renderLibrary();
    show('library');
  });

  el.btnHelp.addEventListener('click', function () { el.helpModal.hidden = false; });
  el.btnCloseHelp.addEventListener('click', function () { el.helpModal.hidden = true; });
  el.helpModal.addEventListener('click', function (e) {
    if (e.target === el.helpModal) el.helpModal.hidden = true;
  });

  /* ---- 最近 14 天弹窗 ----
     打开前先重画一遍：统计数据随时可能变（刚背完一轮就切到统计页），
     而且弹窗隐藏时量不到 scrollWidth，滚动提示必须等显示之后再判。 */
  function openTrend() {
    if (!el.trendModal) return;
    renderTrend();
    el.trendModal.hidden = false;
    el.btnTrendOpen.setAttribute('aria-expanded', 'true');
    if (el.btnTrendClose) el.btnTrendClose.focus();
  }
  function closeTrend() {
    if (!el.trendModal || el.trendModal.hidden) return;
    el.trendModal.hidden = true;
    el.btnTrendOpen.setAttribute('aria-expanded', 'false');
    /* 焦点还给触发它的那块面板，键盘用户不会「掉到页面开头」 */
    el.btnTrendOpen.focus();
  }

  /* 用 click 而不是 pointerdown：面板是 <button>，click 才是它的「激活」语义，
     键盘回车/空格触发的也是 click，两处行为自然统一。 */
  el.btnTrendOpen.addEventListener('click', openTrend);
  el.btnTrendClose.addEventListener('click', closeTrend);
  /* 点遮罩（而不是弹窗内容）关闭，和其它几个弹窗一致 */
  el.trendModal.addEventListener('click', function (e) {
    if (e.target === el.trendModal) closeTrend();
  });
  /* 原来这里还有一条 resize 监听，用来重判「要不要显示左右滑动提示」。
     滑动指示条已全部去掉，这条监听随之删掉。 */

  /* ---- 最近一年热力图弹窗 ----
     和「最近 14 天」那套是同一个模式：正文里只放一段（这里是两个月），
     完整版放进二级弹窗，横向可滚。
     热力图比趋势图宽得多（一年约 53 列），所以弹窗里外面套一层 overflow-x:auto。
     滑动指示条已全部去掉，所以这里不再有「要不要显示提示」的逻辑。 */
  function openHeat() {
    if (!el.heatModal) return;
    renderHeatmapYear();
    el.heatModal.hidden = false;
    if (el.btnHeatOpen) el.btnHeatOpen.setAttribute('aria-expanded', 'true');
    if (el.btnHeatClose) el.btnHeatClose.focus();
  }

  function closeHeat() {
    if (!el.heatModal || el.heatModal.hidden) return;
    el.heatModal.hidden = true;
    if (el.btnHeatOpen) {
      el.btnHeatOpen.setAttribute('aria-expanded', 'false');
      /* 焦点还给触发它的那个按钮，键盘用户不会「掉到页面开头」 */
      el.btnHeatOpen.focus();
    }
  }

  if (el.btnHeatOpen) el.btnHeatOpen.addEventListener('click', openHeat);
  if (el.btnHeatClose) el.btnHeatClose.addEventListener('click', closeHeat);
  if (el.heatModal) {
    el.heatModal.addEventListener('click', function (e) {
      if (e.target === el.heatModal) closeHeat();
    });
  }
  /* 注意：这里**不**再加一个 resize 监听去重画年视图 ——
     上面那个统一的 resize 处理（heatResizeTimer）已经会清掉 heatSigYear
     并在统计页可见时重画正文。年视图的宽度也依赖视口，所以弹窗开着时
     由它顺带重画即可，多挂一个监听只会让同一次 resize 画两遍。 */

  if (el.btnFullText) el.btnFullText.addEventListener('click', openFullText);
  if (el.btnFullTextClose) el.btnFullTextClose.addEventListener('click', closeFullText);
  if (el.fullTextModal) {
    el.fullTextModal.addEventListener('click', function (e) {
      if (e.target === el.fullTextModal) closeFullText();
    });
  }
  /* 宽度变化后要重算锁定高度：卡片宽度变了，例句的折行数跟着变，
     沿用旧高度可能把内容裁掉或留一大片空白。防抖 200ms，
     和热力图那条 resize 处理同一档（拖动窗口时不会每帧都强制布局）。 */
  var cardResizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(cardResizeTimer);
    cardResizeTimer = setTimeout(function () {
      if (!el.screenStudy.classList.contains('is-active')) return;
      if (!ST.queue || !ST.queue.length) return;
      lockCardHeight(ST.queue);
      /* 模块宽高变了，描边路径要重新生成（圆角和边框都得重新贴合） */
      buildHudRingPath();
      /* 高度变了，溢出与否也可能翻转；已揭示的卡要重判一次 */
      if (!el.answer.hidden) detectCardOverflow();
    }, 200);
  });

  /* ---------------- 返回上一层（Esc 与系统返回键共用） ----------------
     从最上面那一层往下关：弹窗 → 背词页回词书库。
     返回 true 表示「这一下已经被消化掉了」，调用方不该再做别的动作。

     为什么抽成函数：Esc 键和手机的系统返回手势要做同一件事
     （see window.WordCardNav 与 MainActivity 的 onBackPressedDispatcher），
     两处各写一份迟早会漂移。 */
  function closeTopLayer() {
    el.heatTip.hidden = true;
    if (!el.sheetModal.hidden) { closeSheetModal(); return true; }
    if (!el.editModal.hidden) { closeEdit(); return true; }
    /* 「完整内容」是最浅的一层（答题中途临时打开），先关它 */
    if (el.fullTextModal && !el.fullTextModal.hidden) { closeFullText(); return true; }
    if (el.heatModal && !el.heatModal.hidden) { closeHeat(); return true; }
    /* 趋势弹窗要排在 helpModal 之前判：它层级更「浅」（是最后打开的），
       先关它才符合「关掉最上面那个」的直觉。 */
    if (el.trendModal && !el.trendModal.hidden) { closeTrend(); return true; }
    if (!el.helpModal.hidden) { el.helpModal.hidden = true; return true; }
    /* 背词页 / 成绩页 / 统计页：回到词书库。
       和这些页面各自的返回按钮（btnBackHome / btnBackLibrary /
       btnBackLibFromStats）走同一条路，手势和按钮的行为保持一致。 */
    if (el.screenStudy.classList.contains('is-active')) {
      /* 退出本轮：本轮进度本来就不会保存（见 btnQuit 的 confirm 文案） */
      ST.current = null;
      ST.queue = [];
      renderLibrary();
      show('library');
      return true;
    }
    if (el.screenDone && el.screenDone.classList.contains('is-active')) {
      renderLibrary();
      show('library');
      return true;
    }
    if (el.screenStats && el.screenStats.classList.contains('is-active')) {
      renderLibrary();
      show('library');
      return true;
    }
    return false;
  }

  /* ---------------- 对外 API：window.WordCardNav ----------------
     给原生壳子处理系统返回手势用（Android 的返回键 / 侧滑返回）。
     为什么不让原生自己看 URL 或猜屏幕：页面是单文件应用、不产生历史记录，
     webView.canGoBack() 永远是 false，原生那边拿不到任何「现在在哪一层」的信息。
     所以由页面回答两个问题：
       snapshot() —— 现在在哪一层（纯字符串，evaluateJavascript 拿得到）
       back()     —— 执行一次返回；返回 'exited' 表示「已经没有上一层了」，
                     壳子据此进入「再按一次退出」的确认流程。 */
  window.WordCardNav = {
    version: '1.0.0',
    /* 当前所在层：'study' | 'library' | 'done' | 'stats' | 'modal' */
    snapshot: function () {
      if (el.sheetModal && !el.sheetModal.hidden) return 'modal';
      if (el.editModal && !el.editModal.hidden) return 'modal';
      if (el.fullTextModal && !el.fullTextModal.hidden) return 'modal';
      if (el.heatModal && !el.heatModal.hidden) return 'modal';
      if (el.trendModal && !el.trendModal.hidden) return 'modal';
      if (el.helpModal && !el.helpModal.hidden) return 'modal';
      if (el.screenStudy.classList.contains('is-active')) return 'study';
      if (el.screenDone && el.screenDone.classList.contains('is-active')) return 'done';
      if (el.screenStats && el.screenStats.classList.contains('is-active')) return 'stats';
      return 'library';
    },
    /* 执行一次返回。返回 true = 还有上一层（已消化）；false = 到最外层了 */
    back: function () { return closeTopLayer(); }
  };

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeTopLayer();
      return;
    }
    if (e.target && RE_FIELD_TAG.test(e.target.tagName)) return;
    if (!el.screenStudy.classList.contains('is-active')) return;

    if (!ST.answered) {
      if (e.key === '1' || e.key === 'ArrowLeft') { e.preventDefault(); answer(false); }
      else if (e.key === '2' || e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); answer(true); }
      /* H 键原来是「展开词性提示」，该功能已去掉（词性现在常驻显示） */
    } else if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
      e.preventDefault();
      nextCard();
    }
    if (e.key === 'u' || e.key === 'U') { e.preventDefault(); undo(); }
    if (e.key === 's' || e.key === 'S') { e.preventDefault(); speakWord(); }
  });

  /* 关页 / 切到后台前，把还在等空闲时机的改动立刻写盘，避免丢数据 */
  window.addEventListener('beforeunload', flushSaves);
  window.addEventListener('pagehide', flushSaves);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushSaves();
  });

  /* ---------------- 启动 ---------------- */
  loadSettings();
  bootSpeakEngine();     // 按存下来的选择摆好优先级（内置语音装载完会自己接管）
  loadStore();
  loadStats();
  loadReview();
  renderLibrary();
  // Excel 解析库是首屏之后按需加载的，首屏这一刻它本来就不在，不必报错。
  // 这里改成：等浏览器空闲时先悄悄预取一次，用户第一次「添加文件」时通常已经就位。
  scheduleIdle(function () { whenXlsx(function () {}); });
})();
