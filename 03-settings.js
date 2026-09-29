/* ==== 设置面板的交互 ==== */
(function(){
  const $ = id => document.getElementById(id);
  const setup = $('setup');
  function open(showClose){
    const c = CFG;
    $('cfg-base').value = c.base; $('cfg-model').value = c.model;
    $('cfg-key').value = c.key || '';
    $('cfg-gloss').value = JSON.stringify(c.glossary || DEFAULT_GLOSSARY, null, 1);
    $('cfg-close').style.display = showClose ? '' : 'none';
    $('cfg-save').textContent = showClose ? '保存' : '保存并开始';
    msg('', '');
    setup.classList.add('on');
  }
  function msg(t, k){ const m = $('cfg-msg'); m.textContent = t; m.className = k || ''; }
  function collect(){
    let gloss;
    try { gloss = JSON.parse($('cfg-gloss').value || '{}'); }
    catch (e) { throw new Error('术语表不是合法 JSON：' + e.message); }
    return {
      base: $('cfg-base').value.trim() || 'https://api.deepseek.com/anthropic',
      model: $('cfg-model').value.trim() || 'deepseek-flash',
      key: $('cfg-key').value.trim(),
      glossary: gloss,
    };
  }
  $('cfg-gloss-reset').onclick = () => {
    $('cfg-gloss').value = JSON.stringify(DEFAULT_GLOSSARY, null, 1);
    msg('已恢复默认术语表（还要点保存才生效）', '');
  };
  $('cfg-test').onclick = async () => {
    let c; try { c = collect(); } catch (e) { return msg(e.message, 'bad'); }
    if (!c.key) return msg('先填 API Key', 'bad');
    const before = CFG; CFG = c;                       // 临时切过去试
    msg('正在测试…', '');
    try {
      const out2 = await callModel('只回复两个字：可以', '测试', 20);
      msg('连接正常 ✓ 模型返回：' + out2.text.slice(0, 20), 'ok');
    } catch (e) {
      msg('失败：' + e.message, 'bad');
    } finally { CFG = before; }
  };
  $('cfg-save').onclick = () => {
    let c; try { c = collect(); } catch (e) { return msg(e.message, 'bad'); }
    if (!c.key) return msg('还差 API Key 没填', 'bad');
    CFG = c; saveConfig(c);
    setup.classList.remove('on');
    if (typeof dg === 'function') dg('· 配置已保存，模型 ' + c.model);
  };
  $('cfg-close').onclick = () => setup.classList.remove('on');
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && setup.classList.contains('on') && $('cfg-close').style.display !== 'none')
      setup.classList.remove('on');
  });
  window.__cpOpenSetup = () => open(true);
  // 顶栏加一个「设置」按钮
  const bar = document.querySelector('header');
  if (bar){
    const b = document.createElement('button');
    b.id = 'btn-setup'; b.textContent = '设置'; b.title = '模型配置与术语表';
    b.onclick = () => open(true);
    bar.insertBefore(b, bar.querySelector('#btn-hide') || null);
  }
  // 浏览器不对的话，说清楚——Firefox / Safari 没有语音识别，整个功能就不存在
  const hasSR = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  const isChromium = /Edg|Chrome/.test(navigator.userAgent);
  if (!hasSR || !isChromium){
    const warn = document.createElement('div');
    warn.style.cssText = 'background:#FBEAE6;border:1px solid #B33A2B;border-radius:10px;'
      + 'padding:14px 16px;margin-bottom:20px;font-size:13.5px;line-height:1.8;color:#8F3524';
    warn.innerHTML = '<b>⚠️ 这个浏览器用不了</b><br>'
      + '语音识别只有 <b>Edge</b> 和 <b>Chrome</b> 有。现在这个是 '
      + (isChromium ? 'Chromium 内核但缺语音识别' : '其他浏览器（Firefox / Safari 都不行）')
      + '。<br>请把文件拖进 Edge 或 Chrome 再打开。';
    document.querySelector('.sbox').insertBefore(warn, document.querySelector('.sbox .lead').nextSibling);
  }

  /* 首次打开（还没配过 key）就把设置面板弹出来。
     ⚠ 这一句比想象的脆：面板元素在、open() 手动调也完全正常，
       但加载时那一次在**某些环境**下就是不生效（实测：无头浏览器里复现）。
       与其追根因，不如多试几次把它兜住——第一次打开必须看到这个面板，
       否则会以为软件坏了。只要还没配 key、面板还没开，就一直重试到 3 秒。 */
  (function tryOpen(n){
    if (CFG.key || setup.classList.contains('on')) return;   // 已经开了或已配过，收工
    try { open(false); } catch (e) { if (typeof dg === 'function') dg('· 设置面板打开失败：' + e.message); }
    if (n < 6 && !setup.classList.contains('on')) setTimeout(() => tryOpen(n + 1), 120 * (n + 1));
  })(0);
})();