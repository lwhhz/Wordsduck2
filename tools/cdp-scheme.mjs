// 验证「外观模式」滑块：三档点击后 html 上的 data-scheme、以及实际算出来的背景色。
// 用法：node cdp-scheme.mjs

const CDP = 'http://localhost:9222';
const PAGE = 'file:///C:/Users/Administrator/Downloads/Wordsduck2/index.html';

async function targetWs() {
  const list = await (await fetch(CDP + '/json/list')).json();
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('没有 page target');
  return page.webSocketDebuggerUrl;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
        });
      },
      close: () => ws.close(),
    });
    ws.onerror = () => reject(new Error('ws error'));
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    };
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const c = await connect(await targetWs());
await c.send('Page.enable');
await c.send('Runtime.enable');

async function evalJs(expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

// 每次都用系统浅色起步，这样"强制暗"的效果才看得出来
await c.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'light' }],
});
await c.send('Page.navigate', { url: PAGE });
await sleep(1800);

const probe = `(() => {
  const root = document.documentElement;
  const body = getComputedStyle(document.body);
  const box = document.getElementById('schemeSlider');
  const opts = box ? [...box.querySelectorAll('.mode-opt')] : [];
  return {
    schemeAttr: root.getAttribute('data-scheme'),
    sliderMode: box ? box.getAttribute('data-mode') : null,
    bodyBg: body.backgroundColor,
    bodyColor: body.color,
    checked: opts.filter(o => o.getAttribute('aria-checked') === 'true').map(o => o.dataset.scheme),
    tabbable: opts.filter(o => o.tabIndex === 0).map(o => o.dataset.scheme),
    thumbTransform: (() => {
      const t = box && box.querySelector('.mode-thumb');
      return t ? getComputedStyle(t).transform : null;
    })(),
  };
})()`;

async function clickMode(mode) {
  await evalJs(`(() => {
    const b = document.querySelector('#schemeSlider .mode-opt[data-scheme="${mode}"]');
    if (!b) throw new Error('no button ' + ${JSON.stringify(mode)});
    b.click();
    return true;
  })()`);
  // 圆钮的位移过渡是 250ms（--md-dur-medium），等足 900ms 再读，
  // 否则拿到的是过渡中途的 matrix，看不出最终落点
  await sleep(900);
  return evalJs(probe);
}

// 进页面第一件事：清掉上次留下的 mode，保证从「跟随系统」开始
await evalJs('localStorage.removeItem("danci.profile.v1"); true');
await c.send('Page.navigate', { url: PAGE });
await sleep(1800);

console.log('--- 系统=浅色，清空存储后的初始状态（应为 auto）---');
console.log(JSON.stringify(await evalJs(probe), null, 2));

for (const m of ['dark', 'light', 'auto']) {
  const v = await clickMode(m);
  console.log('\n--- 点击「' + m + '」---');
  console.log('  data-scheme 属性 :', v.schemeAttr);
  console.log('  slider data-mode :', v.sliderMode);
  console.log('  body 背景 / 文字 :', v.bodyBg, '/', v.bodyColor);
  console.log('  aria-checked     :', v.checked.join(','));
  console.log('  Tab 停靠         :', v.tabbable.join(','));
  console.log('  圆钮 transform   :', v.thumbTransform);
}

// 持久化验证：把 mode 写进存储，刷新后应自动恢复
await evalJs(`(() => {
  const raw = JSON.parse(localStorage.getItem('danci.profile.v1') || '{}');
  raw.mode = 'dark';
  localStorage.setItem('danci.profile.v1', JSON.stringify(raw));
  return true;
})()`);
await c.send('Page.navigate', { url: PAGE });
await sleep(1800);
const p = await evalJs(probe);
console.log('\n--- 存储里 mode=dark，刷新后 ---');
console.log('  data-scheme:', p.schemeAttr, '| slider:', p.sliderMode, '| body 背景:', p.bodyBg);

// 再验一次：系统深色 + 强制亮，必须仍是亮色
await c.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'dark' }],
});
await c.send('Page.navigate', { url: PAGE });
await sleep(1800);
const d0 = await evalJs(probe);
console.log('\n--- 系统=深色，初始（auto，应为深色）---');
console.log('  data-scheme:', d0.schemeAttr, '| body 背景:', d0.bodyBg);
const d1 = await clickMode('light');
console.log('--- 系统=深色 + 点「亮色」（必须变亮）---');
console.log('  data-scheme:', d1.schemeAttr, '| body 背景:', d1.bodyBg);

c.close();
