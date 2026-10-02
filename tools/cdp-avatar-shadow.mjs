// 用 CDP 直接读「头像的 computed box-shadow」，分别在浅色 / 深色下取值。
// 这样不靠肉眼看截图，能直接确认：
//   浅色 = 中性黑阴影（不含主题色的 rgb 分量偏向）
//   深色 = 白色微光
// 用法：node cdp-avatar-shadow.mjs

const CDP = 'http://localhost:9222';
const PAGE = 'file:///C:/Users/Administrator/Downloads/Wordsduck2/index.html';

async function targetWs() {
  const list = await (await fetch(CDP + '/json/list')).json();
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('没有可用的 page target');
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
    ws.onerror = e => reject(new Error('ws error'));
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    };
  });
}

const PROBE = `(() => {
  const seal = document.querySelector('.library-hero .brand-seal');
  if (!seal) return { error: 'no .library-hero .brand-seal' };
  const cs = getComputedStyle(seal);
  const root = getComputedStyle(document.documentElement);
  return {
    prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
    boxShadow: cs.boxShadow,
    size: cs.width + ' x ' + cs.height,
    token: root.getPropertyValue('--md-avatar-shadow').trim(),
    avatarCurrentShadow: (() => {
      const a = document.querySelector('.avatar-current');
      return a ? getComputedStyle(a).boxShadow : null;
    })(),
  };
})()`;

const c = await connect(await targetWs());
await c.send('Page.enable');
await c.send('Runtime.enable');

async function read(scheme) {
  await c.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  });
  await c.send('Page.navigate', { url: PAGE });
  // 等加载完
  await new Promise(r => setTimeout(r, 1800));
  const r = await c.send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
  return r.result.value;
}

for (const scheme of ['light', 'dark']) {
  const v = await read(scheme);
  console.log('=== prefers-color-scheme: ' + scheme + ' ===');
  console.log('  prefersDark      :', v.prefersDark);
  console.log('  --md-avatar-shadow:', v.token);
  console.log('  头像 box-shadow   :', v.boxShadow);
  console.log('  头像尺寸          :', v.size);
  console.log('  .avatar-current   :', v.avatarCurrentShadow);
  console.log('');
}

c.close();
