/* 扩展专属接线。这一份**不在** 课堂同传.html 里，由 build-ext.mjs 注入。
   放在最后加载，所以可以用 app.js 已经定义好的顶层符号（dg / CFG…）。 */
(function () {
  // 只有真的跑在扩展里才标记。/ext/app.html 也可以当普通网页打开（我就是这么测的），
  // 那种情况下不该自称"扩展版"，否则自检面板会误导排查方向。
  const isExt = !!(window.chrome && chrome.runtime && chrome.runtime.id);
  if (!isExt) return;

  // ---- 让自检面板说清"这是扩展版"，不然排查时分不清跑的是网页版还是扩展版 ----
  // ⚠ 必须延后一拍：app.js 里的 init() 用 `$('selfcheck').innerHTML = …` 整块重写，
  //   直接在这里 append 只是"碰巧"排在它后面（因为现在 init 在赋值前没有 await）。
  //   一旦以后 init 里多一个 await，这行就会被抹掉。setTimeout 不依赖运气。
  // ⚠ 文案刻意**不叫**「运行方式」：init 已经有一行「运行方式：📄 单文件版（不需要
  //   本地服务）」，而那句在扩展里依然是对的（确实没有本地服务）。两行同名会看着自相矛盾。
  setTimeout(function () {
    try {
      const el = document.getElementById('selfcheck');
      if (el) {
        const d = document.createElement('div');
        d.style.padding = '4px 0';
        d.textContent = '扩展：🧩 以浏览器扩展方式运行（id ' + chrome.runtime.id + '）';
        el.appendChild(d);
      }
      if (typeof dg === 'function') dg('· 扩展版，id ' + chrome.runtime.id);
    } catch (e) {}
  }, 0);

  // ---- 模型 API 的域名授权 ----
  // 默认域名已在 manifest 的 host_permissions 里，开箱即用。只有在改了 Base URL 时才需要
  // 当场申请：chrome.permissions.request 必须在**用户手势**里调用，所以这里用捕获阶段
  // 监听，抢在设置面板自己的 handler 之前跑，且第一个 await 就调 request——
  // 中间多插一个 await（哪怕只是 permissions.contains）手势就失效了。
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('#cfg-save');
    if (!btn || !window.chrome || !chrome.permissions) return;
    const base = ((document.getElementById('cfg-base') || {}).value || '').trim();
    let origin;
    try { origin = new URL(base).origin + '/*'; } catch (err) { return; }
    chrome.permissions.request({ origins: [origin] })
      .then(ok => { if (typeof dg === 'function') dg((ok ? '· 已授权 ' : '✗ 未授权 ') + origin); })
      .catch(err => { if (typeof dg === 'function') dg('✗ 域名授权失败：' + err.message); });
  }, true);
})();
