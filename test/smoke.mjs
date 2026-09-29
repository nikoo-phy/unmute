// 冒烟测试：以**真扩展**的方式把本目录加载进 Edge，跑一遍加载链路和界面，
// 顺带重新生成 docs/screenshot.png。
//
//   node test/smoke.mjs
//
// 为什么必须真加载：manifest 是否合法、service worker 起不起得来、
// MV3 的 CSP 下四个外链脚本能不能按序跑、扩展专属接线（chrome.permissions /
// chrome.runtime）拿不拿得到 —— 这些在普通网页里全测不出来。
//
// 需要本机装了 Edge。装在别处就设环境变量 CP_EDGE 指向 msedge.exe。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = ROOT.split(path.sep).join('/');
const EDGE = process.env.CP_EDGE
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
if (!fs.existsSync(EDGE)) { console.error('✗ 没找到 Edge：' + EDGE + '\n  设 CP_EDGE 指到 msedge.exe'); process.exit(1); }

const PORT = 9471, PROFILE = path.join(os.tmpdir(), 'cp-smoke-' + Date.now());
const sleep = ms => new Promise(r => setTimeout(r, ms));

const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--disable-extensions-except=' + EXT, '--load-extension=' + EXT,
  'about:blank'], { stdio: 'ignore' });

let pass = 0, fail = 0;
const chk = (n, ok, d) => { console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? '  — ' + d : ''}`); ok ? pass++ : fail++; };
const targets = () => fetch(`http://127.0.0.1:${PORT}/json`).then(r => r.json());

try {
  // ⚠ 必须认准 sw.js。浏览器里通常还装着别的扩展，随便挑一个 chrome-extension:// 的
  //   service_worker 会挑到别人的（实测挑中过 background.rollup.js），后面全错。
  let ts = [];
  for (let i = 0; i < 40; i++) {
    try { ts = await targets(); } catch {}
    if (ts.some(t => String(t.url).endsWith('/sw.js'))) break;
    await sleep(500);
  }
  const sw = ts.find(t => t.type === 'service_worker' && String(t.url).endsWith('/sw.js'));
  const id = sw ? String(sw.url).split('/')[2] : null;

  console.log('【1】加载');
  chk('service worker 起来了（manifest 合法）', !!sw, sw ? sw.url : '没找到');
  if (!id) throw new Error('扩展没加载起来，后面的检查没有意义');
  console.log('    扩展 id = ' + id);

  // service worker 的 onInstalled 会自动开一个 app.html。它比 sw 本身晚一点起来，
  // 所以要重新取 target 列表，不能拿刚才那份快照（会假报「没自动开」）。
  let auto = null;
  for (let i = 0; i < 20 && !auto; i++) {
    try { ts = await targets(); auto = ts.find(t => String(t.url) === `chrome-extension://${id}/app.html`); } catch {}
    if (!auto) await sleep(400);
  }
  chk('装好后自动开了应用页', !!auto, auto ? auto.url : '没自动开');

  const page = auto || ts.find(t => t.type === 'page');
  const w = new WebSocket(page.webSocketDebuggerUrl);
  let n = 0; const pend = new Map(); const errs = [];
  w.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errs.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errs.push(m.params.entry.text);
  });
  await new Promise(r => w.addEventListener('open', r));
  const send = (m, p = {}) => new Promise(res => { const i = ++n; pend.set(i, res); w.send(JSON.stringify({ id: i, method: m, params: p })); });
  const js = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;

  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `chrome-extension://${id}/app.html` });
  await sleep(2500);

  console.log('\n【2】扩展环境下的界面');
  chk('无未捕获 JS 错误', errs.length === 0, errs.slice(0, 2).join(' | '));
  chk('四个脚本都跑起来了',
    await js('typeof buildTranslate==="function" && typeof S==="object" && typeof CFG==="object" && typeof callModel==="function"'));
  chk('界面骨架在', await js('!!document.querySelector("header") && !!document.getElementById("rows")'));
  chk('跑的是扩展版后端', await js('API.standalone') === true);
  chk('拿得到扩展 API', await js('!!(window.chrome && chrome.runtime && chrome.runtime.id)'));
  chk('自检面板标了扩展版',
    String(await js(`document.getElementById('selfcheck').textContent`)).includes('扩展'));
  chk('首次打开弹了设置面板', await js(`document.getElementById('setup').classList.contains('on')`));

  console.log('\n【3】术语表');
  const glosN = await js('Object.keys(DEFAULT_GLOSSARY).length');
  chk('载入 600+ 条', glosN >= 600, glosN + ' 条');
  chk('只挑当前文本里出现的词注入',
    await js(`Object.keys(filterGlossary(DEFAULT_GLOSSARY,['the two-step flow model'])).length`) > 0
    && await js(`Object.keys(filterGlossary(DEFAULT_GLOSSARY,['nothing relevant here'])).length`) === 0);
  chk('大小写与空格写法都能命中',
    await js(`Object.keys(filterGlossary(DEFAULT_GLOSSARY,['two step flow'])).includes('two-step flow')`));

  console.log('\n【4】答题 / 总结 / 导出');
  chk('buildAnswer 在', await js('typeof buildAnswer==="function"'));
  chk('buildSummary 在', await js('typeof buildSummary==="function"'));
  chk('docx 生成器能出字节',
    await js('typeof buildDocx({title:"x",meta:[],blocks:[]}).length') === 'number');

  console.log('\n【5】麦克风诊断');
  chk('listMics 在', await js('typeof listMics==="function"'));
  chk('认得出环回设备、不误伤正常设备',
    await js(`isVirtualMic('立体声混音 (Realtek)')===true && isVirtualMic('Microphone Array')===false`));

  // 顺手重新生成 README 用的截图。段落是异步落地的，所以分两步：先喂文本，再回填译文。
  await js(`document.getElementById('setup').classList.remove('on');
            feedFinal('So the two-step flow model basically says that media messages do not hit audiences directly.');
            feedFinal('They go through opinion leaders first, people who pay more attention and consume more media.');
            feedFinal('Okay so what do you all think about that?');`);
  await sleep(900);
  await js(`S.running = true;
            const zh = ['两级传播模型说白了就是：媒体信息不会直接打到受众身上。',
                        '它们先经过意见领袖这一层。这些人更关注媒体，看的听的也更多。',
                        '好，那你们大家怎么看这个？'];
            S.paras.forEach((p, i) => { p.status = 'done'; p.zh = zh[i] || ''; });
            if (S.paras[2]) S.paras[2].q = true;
            renderAll();
            const e = document.getElementById('empty'); if (e) e.style.display = 'none';`);
  await sleep(700);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(ROOT, 'docs', 'screenshot.png'), Buffer.from(shot.result.data, 'base64'));
  console.log('\n  已重新生成 docs/screenshot.png');

  console.log('\n' + '='.repeat(52));
  console.log(`通过 ${pass}/${pass + fail}`);
  try { child.kill(); } catch {}
  await sleep(300);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error('✗ 测试崩了：', e);
  try { child.kill(); } catch {}
  process.exit(1);
}
