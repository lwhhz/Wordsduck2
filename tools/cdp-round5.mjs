// 验证任务1（清空统计位置）与任务2（卡片高度固定 + 溢出截断 + 完整内容）
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

console.log('=== 任务1：统计页头部顺序（应为 大字 → 小字 → 清空统计）===');
console.log(await ev(`(() => {
  document.getElementById('btnStats').click();
  const head = document.querySelector('.stats-head');
  return [...head.children].map(el => ({
    标签: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''),
    文字: (el.textContent || '').trim().slice(0, 12),
    top: Math.round(el.getBoundingClientRect().top),
  }));
})()`));

console.log('\n=== 任务2：先看克隆测量的效果（字段是否存在）===');
console.log(await ev(`(() => ({
  wordcard存在: !!document.getElementById('wordcard'),
  btnFullText存在: !!document.getElementById('btnFullText'),
  fullTextModal存在: !!document.getElementById('fullTextModal'),
  answer存在: !!document.getElementById('answer'),
}))()`));

ws.close();
