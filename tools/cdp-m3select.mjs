// 验证自定义下拉：接管、弹出 M3 菜单、选中回写、派发 change、禁用态、编辑弹窗里的那四个。
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
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
  return r.result.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
await send('Page.navigate', { url: PAGE });
await sleep(2000);

console.log('=== 1) 接管情况 ===');
console.log(await ev(`(() => {
  const all = [...document.querySelectorAll('select')];
  return {
    总数: all.length,
    已接管: all.filter(s => s.dataset.m3select === '1').length,
    trigger数: document.querySelectorAll('.m3sel-trigger').length,
    ids: all.map(s => s.id),
  };
})()`));

console.log('\n=== 2) trigger 文字是否等于当前选中项 ===');
console.log(await ev(`(() => {
  const out = {};
  ['selRequeue','selBatch'].forEach(id => {
    const s = document.getElementById(id);
    const w = s.closest('.m3sel');
    out[id] = {
      selectValue: s.value,
      selectText: s.options[s.selectedIndex].text,
      triggerText: w.querySelector('.m3sel-value').textContent,
      shown: getComputedStyle(w.querySelector('.m3sel-trigger')).display,
      selectOpacity: getComputedStyle(s).opacity,
    };
  });
  return out;
})()`));

console.log('\n=== 3) 点开「不记得的词」，检查弹出的是不是自定义菜单 ===');
await ev(`document.querySelector('#selRequeue').closest('.m3sel').querySelector('.m3sel-trigger').click(); true`);
await sleep(500);
console.log(await ev(`(() => {
  const menu = document.querySelector('.m3sel-menu');
  if (!menu) return { 菜单: '没有弹出' };
  const cs = getComputedStyle(menu);
  return {
    菜单存在: true,
    挂在body下: menu.parentElement === document.body,
    项数: menu.querySelectorAll('.m3sel-opt').length,
    项文字: [...menu.querySelectorAll('.m3sel-opt-text')].map(e => e.textContent),
    选中项: [...menu.querySelectorAll('.m3sel-opt')].filter(b=>b.classList.contains('is-selected')).map(b=>b.textContent.trim()),
    背景: cs.backgroundColor,
    圆角: cs.borderRadius,
    阴影: cs.boxShadow.slice(0, 60),
    位置: cs.position,
    ariaExpanded: document.querySelector('#selRequeue').closest('.m3sel').querySelector('.m3sel-trigger').getAttribute('aria-expanded'),
    原生select是否还可见: getComputedStyle(document.getElementById('selRequeue')).opacity,
  };
})()`));

console.log('\n=== 4) 选第二项「排到本轮队尾」，看是否回写 + 派发 change + 关闭 ===');
console.log(await ev(`(() => {
  window.__changed = [];
  const s = document.getElementById('selRequeue');
  s.addEventListener('change', () => window.__changed.push(s.value));
  const menu = document.querySelector('.m3sel-menu');
  menu.querySelectorAll('.m3sel-opt')[1].click();
  return {
    selectValue: s.value,
    triggerText: s.closest('.m3sel').querySelector('.m3sel-value').textContent,
    派发的change: window.__changed,
    菜单是否已关: !document.querySelector('.m3sel-menu'),
    ariaExpanded: s.closest('.m3sel').querySelector('.m3sel-trigger').getAttribute('aria-expanded'),
  };
})()`));

console.log('\n=== 5) 程序直接赋值 .value（app.js 的做法）后 trigger 是否跟着更新 ===');
console.log(await ev(`(() => {
  const s = document.getElementById('selBatch');
  s.value = '100';
  return { 赋值后立即: s.closest('.m3sel').querySelector('.m3sel-value').textContent };
})()`));
await sleep(400);
console.log(await ev(`(() => {
  const s = document.getElementById('selBatch');
  return { 等200ms后: s.closest('.m3sel').querySelector('.m3sel-value').textContent };
})()`));

console.log('\n=== 6) innerHTML 重建 option（编辑弹窗的做法）后 trigger 是否更新 ===');
console.log(await ev(`(() => {
  const s = document.getElementById('editW');
  const w = s.closest('.m3sel');
  const before = w.querySelector('.m3sel-value').textContent;
  s.innerHTML = '<option value="-1">— 请选择 —</option><option value="0">英文单词</option><option value="1">中文意思</option>';
  s.value = '1';
  return { 重建前: before };
})()`));
await sleep(400);
console.log(await ev(`(() => {
  const s = document.getElementById('editW');
  return { 重建后trigger: s.closest('.m3sel').querySelector('.m3sel-value').textContent };
})()`));

console.log('\n=== 7) Esc 关闭 ===');
await ev(`document.querySelector('#selBatch').closest('.m3sel').querySelector('.m3sel-trigger').click(); true`);
await sleep(300);
const opened = await ev(`!!document.querySelector('.m3sel-menu')`);
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
await sleep(300);
console.log({ 打开成功: opened, Esc后已关: !(await ev(`!!document.querySelector('.m3sel-menu')`)) });

ws.close();
