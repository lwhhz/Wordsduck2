// 验证本轮四项改动
const CDP = 'http://localhost:9222';
const PAGE = 'file:///C:/Users/Administrator/Downloads/Wordsduck2/index.html';

const list = await (await fetch(CDP + '/json/list')).json();
const t = list.find(x => x.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const send = (m, p) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
});
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    const { res, rej } = pend.get(m.id); pend.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
};
await new Promise(r => ws.onopen = r);
const ev = async x => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
  return r.result.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 411, height: 900, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: PAGE });
await sleep(2200);

console.log('=== 任务1 主题色圆点的对勾颜色（应全为白色）===');
console.log(await ev(`(() => {
  const out = [];
  document.querySelectorAll('.theme-swatch').forEach(s => {
    const cs = getComputedStyle(s, '::after');
    out.push({ 主题: s.dataset.themeName || s.dataset.theme, 对勾色: cs.color, 内容: cs.content });
  });
  return out;
})()`));

console.log('\n=== 任务2 四个按钮尺寸（应两组一致）===');
console.log(await ev(`(() => {
  document.getElementById('screen-study').classList.add('is-active');
  document.getElementById('controlsAsk').hidden = false;
  document.getElementById('controlsNext').hidden = false;
  const g = s => { const r = document.querySelector(s).getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) }; };
  const no = g('#btnNo'), yes = g('#btnYes'), next = g('#btnNext'), undo = g('#btnUndoStep');
  return { 不记得: no, 记得: yes, 下一个: next, 撤销: undo,
    第一组与下一个同尺寸: no.w === next.w && no.h === next.h,
    第二组与撤销同尺寸: yes.w === undo.w && yes.h === undo.h };
})()`));

console.log('\n=== 任务2b / 3b 两个「返回词书库」是否已移除 ===');
console.log(await ev(`(() => ({
  btnBackLib: !!document.getElementById('btnBackLib'),
  btnBackLibFromStats: !!document.getElementById('btnBackLibFromStats'),
  完成页的btnBackLibrary还在: !!document.getElementById('btnBackLibrary'),
}))()`));

console.log('\n=== 任务3a 统计页标题字号是否与主页大字一致 ===');
console.log(await ev(`(() => {
  document.getElementById('screen-stats').classList.add('is-active');
  const hero = document.querySelector('.brand-text h1');
  const h2 = document.querySelector('.stats-head h2');
  const sub = document.getElementById('statsSub');
  const sign = document.querySelector('.brand-sign');
  const cs = e => { const c = getComputedStyle(e); return { size: c.fontSize, weight: c.fontWeight, lh: c.lineHeight }; };
  return {
    '主页大字': cs(hero), '统计页大字': cs(h2),
    '两者一致': cs(hero).size === cs(h2).size && cs(hero).weight === cs(h2).weight,
    '主页小字': cs(sign), '统计页小字': cs(sub),
    '小字一致': cs(sign).size === cs(sub).size,
    '学习统计 kicker 已移除': !document.querySelector('.stats-head .report-kicker'),
  };
})()`));

console.log('\n=== 任务3c 清空统计的颜色（应是 error 红，且随主题色不变）===');
console.log(await ev(`(() => {
  const b = document.getElementById('btnStatsReset');
  const read = () => { const c = getComputedStyle(b); return { color: c.color, bg: c.backgroundColor }; };
  const before = read();
  document.documentElement.setAttribute('data-theme', 'pink');
  const after = read();
  document.documentElement.removeAttribute('data-theme');
  return { 默认主题: before, 换成粉色主题后: after, '不跟主题色': before.bg === after.bg };
})()`));

console.log('\n=== 任务3d 热力图：正文窗口 + 一年弹窗 ===');
console.log(await ev(`(() => {
  const cells = document.querySelectorAll('#heatWrap .heat-cell:not(.is-void)');
  const days = [...cells].map(c => c.dataset.day).filter(Boolean);
  const cols = getComputedStyle(document.querySelector('#heatWrap .heat-grid')).gridTemplateColumns.split(' ').length;
  return {
    正文格子数: cells.length,
    正文列数: cols,
    正文范围文案: document.getElementById('heatRange').textContent,
    '看一年按钮存在': !!document.getElementById('btnHeatOpen'),
    弹窗初始隐藏: document.getElementById('heatModal').hidden,
  };
})()`));

await ev(`document.getElementById('btnHeatOpen').click(); true`);
await sleep(700);
console.log(await ev(`(() => {
  const cells = document.querySelectorAll('#heatWrapFull .heat-cell:not(.is-void)');
  const cols = getComputedStyle(document.querySelector('#heatWrapFull .heat-grid')).gridTemplateColumns.split(' ').length;
  const box = document.getElementById('heatWrapFull').parentNode;
  const cs = getComputedStyle(document.getElementById('heatModal'));
  return {
    弹窗已开: !document.getElementById('heatModal').hidden,
    弹窗格子数: cells.length,
    弹窗列数: cols,
    弹窗范围文案: document.getElementById('heatModalRange').textContent,
    可横向滚动: box.scrollWidth > box.clientWidth,
    ariaExpanded: document.getElementById('btnHeatOpen').getAttribute('aria-expanded'),
    弹窗宽度: Math.round(document.querySelector('#heatModal .modal-box').getBoundingClientRect().width),
    视口宽: window.innerWidth,
  };
})()`));

// Esc 关闭
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
await sleep(400);
console.log('\n=== Esc 关闭弹窗 ===');
console.log(await ev(`({ 已关闭: document.getElementById('heatModal').hidden,
  ariaExpanded: document.getElementById('btnHeatOpen').getAttribute('aria-expanded') })`));

ws.close();
