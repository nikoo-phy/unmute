
'use strict';
const $ = id => document.getElementById(id);
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
/* ============================================================ 后端接口层
   本地版通过 /api/* 找 server.mjs；**单文件分享版**在 window.__CP_API 里给了一份
   浏览器内实现（见 build-standalone.mjs）。两边接口同名同形，所以下面所有业务
   代码两边完全一样，不需要任何 if。 */
const postJson = (p, b) => fetch(p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b)
}).then(r => r.json());

const API = window.__CP_API || {
  standalone: false, canImport: true,
  translate: b => postJson('/api/translate', b),
  answer: b => postJson('/api/answer', b),
  summary: b => postJson('/api/summary', b),
  warm: () => postJson('/api/warm', {}),
  exportMd: b => postJson('/api/export', b),
  exportDocx: async b => {
    const r = await fetch('/api/export-docx', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b)
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || ('HTTP ' + r.status)); }
    return { ok: true, bytes: await r.arrayBuffer(), saved: r.headers.get('x-saved-as') };
  },
  courses: () => fetch('/api/courses').then(r => r.json()),
  importNotes: b => postJson('/api/import', b),
  sessions: () => fetch('/api/sessions').then(r => r.json()),
  session: id => fetch('/api/session?id=' + encodeURIComponent(id)).then(r => r.json()),
};

const SEAL_CHARS = 45;        // 攒够这么多字符才落段（Web Speech 的 final 常是 "Yeah," 这种碎片）
const SEAL_MAX_MS = 5000;     // 但最久 5 秒必须落段，否则长时间不翻译
const BATCH_MAX = 6;          // 一次最多翻几段
const MAX_TRIES = 3;          // 一段最多重试几次，超过就标错，避免死循环
/* 识别器多久没更新 interim 就认定它卡住了（只刷临时文本、不吐 final）。
   见 onBgTick 的第 ③ 步。5 秒是实测调出来的：正常说话时 interim 一直在变，
   真卡住时能几十秒纹丝不动。 */
const INTERIM_STUCK_MS = 5000;
/* 识别引擎多久没有任何 onresult 就判定它假死（见 onBgTick 第 ④ 步）。
   60 秒是权衡：太短会在老师停下来让学生思考时误重启，太长用户就要干等。
   真静音不会误触发——教室里不可能这么安静，而且引擎自己会报 no-speech。 */
const REC_STALL_MS = 60000;
/* 上面那个「提升」的标记保留多久。引擎可能分几次补吐 final，
   留个窗口把重复片段吃掉；超时就退休，免得误伤很久以后真说的话。 */
const PROMOTE_DEDUPE_MS = 90000;

const S = {
  running:false, rec:null, wantListen:false, netRetries:0, listening:false,
  txWanted:false,      // 有 pending 段落等着翻；由后台 ticker 消费（见「后台计时器」那段）
  bgTicks:0,           // 后台计时器跳了多少次（诊断/测试用）
  lastLat:0,           // 最近一次翻译耗时（ms），用来提示「网络慢」
  rail:400,            // 右栏宽度，可拖可点
  logQ:[],             // 待发送的日志事件（攒批，见 flushLog）
  paras:[], seq:0, nodes:new Map(),
  hold:'', holdSince:0, interim:'', interimAt:0, promotedText:'', promotedAt:0,
  recStartedAt:0, stallAt:0, stallRestarts:0,   // 识别引擎看门狗（见 onBgTick ④）
  hiddenAt:0,                                   // 页面切到后台的时刻
  translating:false,
  sessionId:null, startedAt:0, elapsed:0, pausedMs:0, pauseAt:0,
  follow:true, show:{en:true, zh:true}, fs:{en:15.5, zh:23},
  summaries:[], sumBuf:[], sumBusy:false, sumAuto:true,
  float:null, floatFs:{en:14, zh:20},   // 悬浮窗自己的字号，和主窗口分开
  stats:{paras:0, chars:0, errs:0, translated:0, latSum:0, latN:0, answers:0},
  answer:null,          // {loading, forId, question, isQuestion, data, error, long}
  answers:[],           // 本次会话已经生成过的发言，用来防重复、去模板、接追问
  micOk:false, micErr:null, hardError:false, svcRetries:0,
  // 麦克风诊断（见「输入设备」那段）＋识别退避状态（见 scheduleRestart）。
  // ⚠ recStartedAt 上游已经有了（看门狗在用），这里**不要**重复声明。
  // ⚠ 掉线计数复用上游的 netRetries，不要再加一个 netErrors —— 两个计数器会打架。
  //   retryDelay 只能是 0：RETRY_BASE_MS 定义在识别层（本对象之后），
  //   在这里引用会踩 const 的暂时性死区；用到的地方都写了 `|| RETRY_BASE_MS`。
  micId:'', micLabel:'', micCount:0, micDiag:null, micNagAt:'',
  retryTimer:null, retryDelay:0, downSince:0,
  recorder:null, micStream:null, recChunks:0,
  diagLines:[]
};

/* ============================================================ 上课时间轴
   时间戳要扣掉暂停的部分，否则用户中途暂停一次，导出 markdown 里的 [MM:SS]
   跟用户笔记里的时间就对不上了。所有 t0/t1/延迟 都必须走这两个函数。 */
function relMs(ts){ return ts - S.startedAt - S.pausedMs; }
function relNow(){
  return Date.now() - S.startedAt - S.pausedMs - (S.pauseAt ? Date.now() - S.pauseAt : 0);
}

/* ============================================================ 诊断 */
function dg(msg){
  const t = new Date().toTimeString().slice(0,8);
  S.diagLines.push(t + '  ' + msg);
  if (S.diagLines.length > 400) S.diagLines.shift();
  const el = $('diag');
  if (el) { el.textContent = S.diagLines.join('\n'); el.scrollTop = el.scrollHeight; }
}
function toast(msg, kind){
  const t = $('toast');
  t.textContent = msg; t.className = kind || '';
  t.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.style.display = 'none'; }, kind === 'bad' ? 6000 : 3200);
}
window.onerror = (m, src, ln) => { dg('✗ JS 错误 ' + m + ' @' + (src||'').split('/').pop() + ':' + ln); };
window.addEventListener('unhandledrejection', e => { dg('✗ 未处理的 Promise 拒绝 ' + (e.reason && e.reason.message || e.reason)); });

/* ============================================================ 识别层
   ⚠ 这一整块是**唯一**该被替换掉的部分（见 CLAUDE.md「第二步」）。
   换云端 ASR 时只重写 buildRec/startListening，喂文字的入口 feedInterim/feedFinal 不动。 */
/* ---- 麦克风权限：必须在识别之前主动拿 ----
   SpeechRecognition.start() **不会**主动弹权限框，权限没给就静默报 not-allowed，
   界面上看起来像「点了没反应」。所以先用 getUserMedia 把权限要到手，
   这一步浏览器**一定**会弹框。2026-09-22 就是因为漏了这一步，
   用户点了开始没反应，而 onend 又把错误状态盖成了「已停止」，完全看不出原因。 */
async function ensureMic(){
  if (S.micOk) return true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    S.micErr = 'no-mediaDevices';
    dg('✗ 没有 navigator.mediaDevices（页面不是安全上下文？）');
    return false;
  }
  // ⚠ 别每次都去开设备。getUserMedia → 立刻 stop → 再 start() 识别，
  //   这个「快开快关」会让 Chromium 的音频处理（AGC/降噪）状态乱掉，
  //   之后识别拿到的音频可能更差——表现就是「听不清、漏句子」。
  //   权限已经给过就直接信它，一次设备都不碰。
  try {
    if (navigator.permissions && navigator.permissions.query){
      const p = await navigator.permissions.query({ name: 'microphone' });
      if (p.state === 'granted'){ S.micOk = true; S.micErr = null; dg('✓ 权限已授予（未触碰设备）'); return true; }
    }
  } catch (e) { dg('· permissions.query 不可用：' + e.message); }

  try {
    const st = await navigator.mediaDevices.getUserMedia({ audio: true });
    S.micLabel = (st.getAudioTracks()[0] || {}).label || '(未知设备)';
    st.getTracks().forEach(t => t.stop());
    S.micOk = true; S.micErr = null;
    dg('✓ 麦克风权限已拿到：' + S.micLabel);
    return true;
  } catch (e) {
    S.micOk = false; S.micErr = e.name || 'unknown';
    dg('✗ 拿不到麦克风：' + S.micErr + ' — ' + (e.message || ''));
    return false;
  }
}
const MIC_HELP = {
  NotAllowedError: '麦克风权限被拒了。<br>・看地址栏左边那个<b>锁形/摄像头图标</b> → 把「麦克风」改成<b>允许</b><br>・然后刷新页面（F5）再点开始<br>・如果 Edge 设置里 <code>edge://settings/content/microphone</code> 把 127.0.0.1 拉黑了，也要解掉',
  NotFoundError: '系统里没找到麦克风。<br>・Windows 会记住插过又拔掉的设备（蓝牙耳机、USB 麦），这时「默认设备」可能指向一个已经不在的东西<br>・设置 → 系统 → 声音 → 输入，确认里面有一支是「已连接」的，并选成默认<br>・笔记本自带的那支（一般显示成「麦克风阵列」之类）通常一直可用，优先选它',
  NotReadableError: '麦克风被别的程序占着。<br>・关掉腾讯会议 / 微信 / 录音机之类正在用麦的程序<br>・或者把那个程序里的麦克风输入关掉<br>・蓝牙耳机连上时也可能抢麦，先断开试试',
  'no-mediaDevices': '这个页面拿不到麦克风接口。<br>・必须用 <b>Edge 或 Chrome</b> 打开，而且地址必须是 127.0.0.1（不要用局域网 IP）',
  SpeechService: '麦克风是好的，是<b>语音识别服务</b>拒绝了——这跟麦克风权限是两回事。<br>・先确认能联网（识别走浏览器厂商的服务器）<br>・还是不行就重启浏览器，或者换 Chrome 试试<br>・公司/学校的网络策略有可能拦掉识别服务',
  unknown: '麦克风打不开，原因不明。看下面的诊断日志。'
};
function showMicError(){
  const help = MIC_HELP[S.micErr] || MIC_HELP.unknown;
  const who = S.micLabel ? '<br>· 识别器要用的设备是：<b>' + esc(S.micLabel) + '</b>' : '';
  $('sysbar').innerHTML = '⚠️ <b>麦克风没打开，所以识别不到声音</b>' + who + '<br>' + help;
  $('sysbar').classList.add('on');
  setStatus('bad', '麦克风没开');
}
function clearSysBar(){ $('sysbar').classList.remove('on'); $('sysbar').innerHTML = ''; }

/* ---- 输入设备：识别器到底在用哪一支 ----
   ⚠ 一条绕不过去的硬限制：Web Speech 的识别器**没有 deviceId 参数**，永远只用
   Windows 的默认输入设备。所以这个页面**不可能**「选麦克风」——真想用某一支，
   只能在 Windows 里把它设成默认。这里能做的是把那个默认**显示出来**，让「用错设备」
   从一个隐形故障变成看得见的红灯。

   常见的一个坑：「立体声混音（Stereo Mix）」也是一支活跃的输入设备。
   它一旦被设成默认，识别器听到的就是**电脑在放什么**，不是老师在讲什么。 */
const RE_VIRTUAL = /混音|立体声|stereo\s*mix|what\s*u\s*hear|loopback|wave\s*out|virtual\s+audio|虚拟|cable\s*output|voicemeeter|soundflower/i;
function isVirtualMic(label){ return RE_VIRTUAL.test(String(label || '')); }

/** 输入设备清单。不打开设备，所以随时能跑，也不会打乱识别器的音频处理状态。
    没授权时 label 是空串，这时只报个数，不硬猜名字。 */
async function listMics(){
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  let ds = [];
  try { ds = await navigator.mediaDevices.enumerateDevices(); }
  catch (e) { dg('✗ enumerateDevices 失败：' + e.message); return []; }
  // ⚠ 没授权时 Chromium 会返回**一个** deviceId 为空串的匿名占位条目。
  //   留着它会把「读不到设备」伪装成「有 1 支设备」，名字也是假的。直接丢掉，
  //   这样「读不到」就诚实地表现为空列表。
  return ds.filter(d => d.kind === 'audioinput' && d.deviceId)
    .map(d => ({
      // Chromium 还会额外塞两个合成条目 default / communications，它们指向
      // 「Windows 现在默认给我哪一支」——那才是识别器真正会用的设备。
      id: d.deviceId,
      sys: d.deviceId === 'default' || d.deviceId === 'communications',
      label: d.label || '(未授权，拿不到名字)'
    }));
}

/** Chromium 的合成条目名字形如「默认 - 设备名 (…)」，去掉前缀还原成本名。 */
function stripDefaultPrefix(label){
  return String(label || '')
    .replace(/^\s*(默认设备|默认|default|communications?|通信设备|通信)\s*[-–—:：]\s*/i, '')
    .trim();
}

/** 不打开设备地问：识别器现在会用哪一支。每次「开始」前刷新一次。 */
async function probeDefaultMic(){
  const all = await listMics();
  S.micCount = all.filter(m => !m.sys).length;
  if (!all.length){
    dg('· 读不到输入设备清单（多半是还没授权），这次不猜默认设备');
    return null;
  }
  const d = all.find(m => m.id === 'default') || all.find(m => m.id === 'communications');
  // 没有合成条目就只能靠最近一次实测到的名字，且**标明它可能过期**——
  // 默认设备被换掉恰恰是这个功能要抓的事，不能拿旧名字冒充「当前」。
  if (!d){ dg('· 枚举里没有 default/communications 合成条目，默认设备只能靠实测'); return null; }
  const name = stripDefaultPrefix(d.label) || d.label;
  if (name !== S.micLabel){ S.micLabel = name; dg('🎙 Windows 默认输入：' + name); }
  return name;
}

/** 设备清单：拿到的那一支标「在用」，环回设备标红。测电平和打不开两处共用。 */
function devListHtml(curLabel, curId, reals){
  const items = (reals || []).map(m => {
    const cur = (curId && m.id === curId) || (!curId && m.label === curLabel);
    const risky = isVirtualMic(m.label);
    return '<li class="' + (risky ? 'risky' : cur ? 'cur' : '') + '">'
      + '<span class="tag">' + (risky ? '环回' : cur ? '在用' : '备用') + '</span>'
      + '<span>' + esc(m.label) + '</span></li>';
  }).join('');
  return '<div id="micdev"><div class="nm">识别器在用：<b>' + esc(curLabel || '(未知)') + '</b></div>'
    + (curId ? '<div class="sub">' + esc(curId) + '</div>' : '')
    + (items ? '<ul id="miclist">' + items + '</ul>' : '')
    + '</div>';
}

/* ---- 麦克风电平表 ----
   用来分辨三件**修法完全不同**的事：
     ① 麦克风压根没开 / 被别的程序占着  → 换设备，或关掉抢麦的程序
     ② 开着，但收不到几米外的老师       → 内置阵列的物理极限，只能靠近或加外接麦
     ③ 收到了，但识别器在胡说           → 问题在识别引擎，不是收音
   2026-09-22 用户报「识别不准」时，靠这个才能定位，不然只能猜。

   测法分两段，这是关键：先在 50 厘米处说，证明**麦克风本身是活的**；再退到 3–5 米
   像老师讲课那样说，看它还剩下多少。只有前者没有后者，就说明这**不是软件问题**——
   笔记本内置阵列收几米外的人本来就是这个水平，再调代码也没用，得从位置或设备下手。 */
async function micCheck(){
  const box = $('miccheck');
  box.innerHTML = '<div style="color:var(--dim-2)">正在打开麦克风…（浏览器可能会问权限）</div>';

  const reals = (await listMics()).filter(m => !m.sys);
  let st;
  // 用 {audio:true} 而不是显式去开/关 EC 和降噪：要测的必须是识别器实际会拿到的那条流。
  try { st = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e){
    box.innerHTML = '<div style="color:var(--rust)">打不开麦克风：' + esc(e.name) + '</div>'
      + '<div style="color:var(--dim);margin-top:6px">' + (MIC_HELP[e.name] || MIC_HELP.unknown) + '</div>'
      + (reals.length > 1 ? devListHtml('(打不开)', '', reals) : '');
    dg('✗ 测电平取流失败 ' + e.name);
    return;
  }

  const track = st.getAudioTracks()[0] || {};
  let set = {};
  try { set = (track.getSettings && track.getSettings()) || {}; } catch (e) {}
  const label = track.label || S.micLabel || '(未知设备)';
  S.micLabel = label; S.micId = set.deviceId || '';
  dg('🎙 实际打开的设备：' + label + ' / ' + (set.deviceId || '?'));

  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC){
    st.getTracks().forEach(t => t.stop());
    box.innerHTML = devListHtml(label, set.deviceId, reals)
      + '<div style="color:var(--rust);margin-top:10px">这个浏览器没有 Web Audio，测不了电平。</div>';
    return;
  }
  const ac = new AC(), an = ac.createAnalyser();
  an.fftSize = 2048;
  ac.createMediaStreamSource(st).connect(an);
  const buf = new Float32Array(an.fftSize);

  const NEAR_MS = 4000, TOTAL_MS = 14000;
  const t0 = Date.now();
  let peakNear = -100, peakFar = -100, nNear = 0, nFar = 0, voiceNear = 0, voiceFar = 0;

  // 把 Chromium 实际给到的音频参数摊出来：采样率/声道不对、降噪开着收不到远场，
  // 这两件事都会让「麦克风看起来正常但识别就是不行」，而它们只在 getSettings 里看得见。
  const settings = '采样率 ' + (set.sampleRate || '?') + ' Hz　声道 ' + (set.channelCount || '?')
    + '　回声消除 ' + (set.echoCancellation ? '开' : '关')
    + '　降噪 ' + (set.noiseSuppression ? '开' : '关')
    + '　自动增益 ' + (set.autoGainControl ? '开' : '关');

  box.innerHTML = devListHtml(label, set.deviceId, reals)
    + '<div style="font-size:11.5px;color:var(--dim-2);font-family:var(--f-mono);'
    + 'margin:10px 0 0;line-height:1.6;word-break:break-all">' + esc(settings) + '</div>'
    + '<div id="micphase" style="margin:12px 0 6px;font-size:13px;color:var(--ink-2)"></div>'
    + '<div style="height:12px;background:var(--bg-sink);border:1px solid var(--line);border-radius:6px;overflow:hidden">'
    + '<i id="micbar" style="display:block;height:100%;width:0%;background:var(--jade-2);transition:width .06s"></i></div>'
    + '<div id="micnum" style="color:var(--dim-2);font:11.5px var(--f-mono);margin-top:6px"></div>'
    + '<div id="micverdict" style="margin-top:11px"></div>';

  const timer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-8);
    const elapsed = Date.now() - t0;
    const far = elapsed > NEAR_MS;
    if (far){ nFar++; if (db > peakFar) peakFar = db; if (db > -50) voiceFar++; }
    else    { nNear++; if (db > peakNear) peakNear = db; if (db > -45) voiceNear++; }

    const bar = $('micbar'), num = $('micnum'), ph = $('micphase');
    // -70…0 dB 铺满整条；识别器的下限大约在 -40 dB 上下，所以过线才变绿。
    if (bar){
      bar.style.width = Math.max(0, Math.min(100, (db + 70) / 70 * 100)).toFixed(0) + '%';
      bar.style.background = db > -40 ? 'var(--jade-2)' : 'var(--gold-2)';
    }
    if (num) num.textContent = '当前 ' + db.toFixed(0) + ' dB　峰值 ' + (far ? peakFar : peakNear).toFixed(0) + ' dB';
    if (ph){
      const left = Math.max(0, Math.ceil((TOTAL_MS - elapsed) / 1000));
      ph.textContent = far
        ? '② 退到 3–5 米，像老师讲课那样正常说话（还剩 ' + left + ' 秒）'
        : '① 先离麦克风 50 厘米，正常说几句话（还剩 ' + left + ' 秒）';
    }
    if (elapsed > TOTAL_MS) finish();
  }, 80);

  function finish(){
    clearInterval(timer);
    try { st.getTracks().forEach(t => t.stop()); } catch (e) {}
    try { ac.close(); } catch (e) {}
    const v = $('micverdict');
    if (v) v.innerHTML = micVerdict(label, peakNear, peakFar, voiceFar / Math.max(1, nFar));
    S.micDiag = { label, id: S.micId, near: peakNear, far: peakFar, at: Date.now() };
    try { localStorage.setItem('cp-mic', JSON.stringify(S.micDiag)); } catch (e) {}
    dg('🎙 电平：近讲峰值 ' + peakNear.toFixed(0) + ' dB　远讲峰值 ' + peakFar.toFixed(0)
      + ' dB　有效人声帧 近 ' + (voiceNear / Math.max(1, nNear) * 100).toFixed(0)
      + '% / 远 ' + (voiceFar / Math.max(1, nFar) * 100).toFixed(0) + '%');
  }
}

/** 把两段电平翻译成一句能照着做的事。 */
function micVerdict(label, near, far, vFar){
  const say = (cls, html) => '<span style="color:var(--' + cls + ')">' + html + '</span>';
  if (isVirtualMic(label)){
    return say('rust', '❌ 用的是环回设备（' + esc(label) + '）。它录下来的是<b>电脑在放什么</b>，'
      + '不是老师在讲什么，识别出来必然全是乱码。')
      + '<br>改回来：设置 → 系统 → 声音 → 输入 → 选你真正要用的那支（笔记本自带的通常叫「麦克风阵列」）。';
  }
  if (near <= -45){
    return say('rust', '❌ 连 50 厘米处都几乎没有电平（近讲峰值 ' + near.toFixed(0) + ' dB）。')
      + '按顺序排掉：① 这支麦在 Windows 里被静音或音量是 0；'
      + '② 被别的程序占着（腾讯会议 / 微信 / 录音机）；③ 物理静音开关或遮挡。'
      + '<br>这个状态下识别必然全是乱码，调别的地方都没用。';
  }
  if (far <= -50){
    return say('gold-2', '⚠️ 麦克风本身是活的（近讲峰值 ' + near.toFixed(0) + ' dB），'
      + '但 3–5 米外基本收不到（远讲峰值 ' + far.toFixed(0) + ' dB）。')
      + '<br>这不是软件问题，是笔记本内置阵列的物理极限。三个办法，按代价排：'
      + '<br>① 把电脑往讲台方向挪，别塞在包里或贴在屏幕后面；'
      + '<br>② 声音设置里点进这支麦的<b>属性 → 级别</b>，把<b>麦克风加强</b>拉高；'
      + '<br>③ 接一支外接麦（USB 麦或领夹麦），再在声音设置里把它设成默认输入。'
      + '<br>不处理的话识别会大段大段地漏，而且漏得没有规律——最难事后补。';
  }
  if (far > -40 && vFar > 0.15){
    return say('jade', '✅ 远场也收得到（远讲峰值 ' + far.toFixed(0) + ' dB，'
      + '有效人声帧 ' + (vFar * 100).toFixed(0) + '%）。收音这一环没问题；'
      + '如果识别还在胡说，那是识别引擎那边的事，不是麦克风。');
  }
  return say('gold-2', '⚠️ 远场偏弱（远讲峰值 ' + far.toFixed(0) + ' dB，有效人声帧 '
    + (vFar * 100).toFixed(0) + '%）。说话能听见，但识别会漏句。'
    + '尽量坐前面一点，或者调高麦克风加强。');
}

/* ---- 开始前的静默检查 ----
   不打开设备（避免打乱识别器的音频处理状态），只用枚举接口问「Windows 现在默认给我
   哪一支」，再拿上次测出的电平结论提醒。环回设备**每次**都提醒——那个是致命的，
   而且从字幕上完全看不出来；远场偏弱每天最多提醒一次，否则每次暂停续开都弹一遍
   就变成噪音，谁都不会看。 */
async function micPreflight(){
  const name = await probeDefaultMic();
  if (name && isVirtualMic(name)){
    $('sysbar').innerHTML = '⚠️ <b>识别器正在用「' + esc(name) + '」当麦克风</b>——'
      + '这是环回设备，它听到的是<b>电脑在放什么</b>，不是老师在讲什么。<br>'
      + '改回来：设置 → 系统 → 声音 → 输入 → 选你真正要用的那支，然后重新点开始。';
    $('sysbar').classList.add('on');
    dg('⚠ 默认输入是环回设备：' + name);
    return;
  }
  const d = S.micDiag;
  const today = new Date().toISOString().slice(0, 10);
  if (d && d.far <= -50 && S.micNagAt !== today){
    S.micNagAt = today;
    try { localStorage.setItem('cp-mic-nag', today); } catch (e) {}
    $('sysbar').innerHTML = '⚠️ <b>上次测出「' + esc(d.label) + '」在 3–5 米外基本收不到声音</b>'
      + '（远讲峰值 ' + d.far.toFixed(0) + ' dB），识别大概率会漏句。<br>'
      + '把电脑往讲台方向挪、或在声音设置里调高<b>麦克风加强</b>，'
      + '然后「日志 → 检查麦克风」重测一次。';
    $('sysbar').classList.add('on');
    dg('⚠ 上次远场电平偏低：' + d.far.toFixed(0) + ' dB');
  }
}

/* ---- 识别掉线的退避重开 ----
   上游的看门狗（onBgTick 第 ④ 步）管的是「引擎静默假死、连 onend 都不触发」；
   这一段管的是另一半：**onend 触发了，但重开失败**。两者互补，缺一个都会漏。
   上游原来在这里只写了一句 `catch (e) { dg('↻ 续开失败') }` —— 也就是 start() 抛一次
   异常就当场认输、再也不重试，而 start() 在 Chromium 里抛异常很常见。一次瞬时失败
   就等于整节课没了。改成退避重试，只有连续 GIVEUP_MS 都起不来才停下。

   另一处：上游的放弃条件是 `netRetries > 3`，而计数**只在出了 final 结果时才清零**。
   老师在放 PPT、或一段安静时间没有 final，计数就只增不减 → 攒够 4 次永久停。
   现在判据换成**上一次识别会话活了多久**：活过 HEALTHY_MS 就算健康过，状态清零。
   这才对——出不出 final 跟连接健不健康没关系，活得久才是真信号。 */
const HEALTHY_MS = 30000;    // 一次会话活过这么久，就算健康
const RETRY_BASE_MS = 400;   // 重开退避 0.4 → 0.8 → 1.6 → …（有上限）
const RETRY_MAX_MS = 8000;
const GIVEUP_MS = 90000;     // 连续 90 秒都起不来才放弃，并且把状态留在界面上

function clearDown(){
  S.downSince = 0; S.netRetries = 0; S.retryDelay = RETRY_BASE_MS;
}

/** 退避重开。抛异常必须**继续**重试——一次瞬时失败不能等于整节课没了。 */
function scheduleRestart(){
  if (!S.wantListen || !S.running) return;
  if (!S.downSince) S.downSince = Date.now();
  const downFor = Date.now() - S.downSince;
  if (downFor > GIVEUP_MS){
    S.wantListen = false;
    dg('✗ 连续 ' + Math.round(downFor / 1000) + ' 秒没能恢复识别，先停下。'
      + '已识别的文字都在，不会丢。想接着听就再点一次「继续」。');
    setStatus('bad', '识别中断');
    return;
  }
  const wait = S.retryDelay || RETRY_BASE_MS;
  dg('   ↻ ' + (wait / 1000).toFixed(1) + 's 后重开识别（已断 ' + Math.round(downFor / 1000) + 's）');
  clearTimeout(S.retryTimer);
  S.retryTimer = setTimeout(() => {
    S.retryTimer = null;
    if (!S.wantListen || !S.running) return;
    try { S.rec.start(); dg('   ▶ 重开成功'); }
    catch (e){
      dg('   ✗ 重开抛错：' + e.message);
      S.retryDelay = Math.min(RETRY_MAX_MS, (S.retryDelay || RETRY_BASE_MS) * 2);
      scheduleRestart();
    }
  }, wait);
}

function buildRec(){
  const rec = new SR();
  rec.lang = 'en-GB'; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;

  // 每次真的起来都重置会话起点。scheduleRestart 是直接调 rec.start() 的，
  // 不走 startListening，所以只在那里记时间的话，健康度会一直拿最初那次去算。
  // ⚠ 同时把 lastResultAt 清 0：看门狗（onBgTick 第 ④ 步）写的是
  //   `S.lastResultAt || S.recStartedAt`，清 0 才能让它fallback到本次会话起点。
  rec.onstart = () => {
    S.recStartedAt = Date.now(); S.lastResultAt = 0;
    dg('▶ 识别 onstart'); setStatus('live','正在听');
  };
  rec.onaudiostart = () => dg('   onaudiostart（麦克风供流）');
  rec.onspeechstart = () => dg('   onspeechstart');
  rec.onresult = e => {
    let fin = '', itr = '';
    for (let i = e.resultIndex; i < e.results.length; i++){
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) fin += t + ' '; else itr += t;
    }
    // 出结果 = 音频链路和云端都是活的。在**任何**结果（含 interim）上清退避状态，
    // 而不是等 final：final 可能几十秒才来（老师在放 PPT），中间任何一次掉线
    // 都会把计数越积越大，最后被误判成「连续掉线过多」而永久停下。
    clearDown();
    // ⚠ 上游漏了这一行：lastResultAt 被**两处**依赖（onBgTick 的看门狗、
    //   visibilitychange 回来后的复查），但全文件从来没有给它赋过值。
    //   结果就是两处判据都拿 undefined 当基准 —— 看门狗于是每 60 秒无条件重建
    //   一次识别器（哪怕一切正常），而切页面回来自查也永远判定为「没有结果」。
    S.lastResultAt = Date.now();
    if (fin) feedFinal(fin);
    feedInterim(itr);
  };
  rec.onerror = e => {
    dg('✗ onerror: ' + e.error + (e.message ? ' — ' + e.message : ''));
    if (e.error === 'no-speech') return;   // 教室里没人说话，正常
    if (e.error === 'network'){
      S.netRetries++;
      dg('   network（听了太久，已累计 ' + S.netRetries + ' 次）。已识别内容不会丢。');
      return;
    }
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed'){
      // 识别服务偶尔会抽一下（尤其 file:// 打开时）。先给它两次机会，
      // 别一拒就停——但也不能无限重试，那样会变成刷屏。
      if (S.svcRetries < 2 && S.running){
        S.svcRetries++;
        dg('· 识别服务拒绝第 ' + S.svcRetries + ' 次，2 秒后重试');
        setTimeout(() => { if (S.running && S.wantListen) startListening(); }, 2000);
        return;
      }
      // 给了机会还是不行，就是硬错误：不再自动续开，状态留在界面上
      S.wantListen = false;
      S.hardError = true;
      // ⚠ 这里**千万别**把 S.micOk 打回 false。
      //   识别引擎报的 not-allowed 和「麦克风权限」是两回事：micOk 为 true
      //   说明麦克风本来就拿到了，那就是识别服务的问题。一旦在这里清掉 micOk，
      //   下次点「开始」又会去调 getUserMedia → **又弹一次权限框**，来回循环。
      //   2026-09-23 分享版上「反复弹权限」就是这么来的。
      S.micErr = S.micOk ? 'SpeechService' : (S.micErr || 'NotAllowedError');
      stopRun();          // 先收摊，再贴错误条——反过来的话 stopRun 会把提示覆盖掉
      showMicError();
    }
    if (e.error === 'audio-capture'){
      S.wantListen = false; S.hardError = true; S.micErr = 'NotFoundError';
      stopRun();
      showMicError();
    }
  };
  /* 掉线不能丢内容：先把手上的文字落段，再决定重开 */
  rec.onend = () => {
    S.listening = false;
    flushHold(true);
    // 上一次会话活够久 → 链路本来是健康的，这次结束只是正常的会话轮换
    if (S.recStartedAt && Date.now() - S.recStartedAt > HEALTHY_MS) clearDown();
    if (!S.wantListen || !S.running){
      // ⚠ 别在这里无条件 setStatus：onerror 刚设的「麦克风没开」会被盖成「已停止」，
      //   界面看起来像正常停止，用户根本不知道出了什么事。
      if (S.running && !S.hardError) setStatus('ok','已停止');
      return;
    }
    scheduleRestart();
  };
  return rec;
}
function startListening(){
  if (!SR) { toast('这个浏览器不支持语音识别。用 Edge 或 Chrome 打开。', 'bad'); return; }
  clearTimeout(S.retryTimer); S.retryTimer = null;
  if (S.rec){ try { S.rec.onend = S.rec.onerror = null; S.rec.abort(); } catch(e){} S.rec = null; }
  // ⚠ 这里**不能**清 svcRetries —— 清了的话「重试两次就放弃」永远数不到两次，
  //   会变成无限重试。它只在用户主动点开始时清（见 startRun）。
  clearDown();
  S.rec = buildRec();
  // 看门狗（onBgTick 第 ④ 步）的基准。lastResultAt 也一并清 0，
  // 否则上一次会话留下的旧时间戳会让看门狗一上来就判定「假死」、立刻又重启一次。
  S.recStartedAt = Date.now(); S.lastResultAt = 0;
  S.wantListen = true; S.listening = true;
  try { S.rec.start(); dg('start() lang=' + S.rec.lang); setStatus('live','正在听'); }
  catch (e){
    // 首次 start() 就抛错也要走退避重试，而不是把「正在听」挂在界面上骗人
    dg('start() 抛错：' + e.message + '，稍后重试');
    setStatus('busy', '正在重开…');
    scheduleRestart();
  }
}
function stopListening(){
  S.wantListen = false; S.listening = false;
  clearTimeout(S.retryTimer); S.retryTimer = null;   // 别让暂停之后还有僵尸重开
  if (S.rec){ try { S.rec.stop(); } catch(e){} }
  flushHold(true);
}
/* ---- 喂文字的两个入口（ASR 与其余部分之间的缝）---- */
function feedInterim(t){
  if (S.interim === t) return;          // 没变就什么都不做（含 interimAt 的计时）
  S.interim = t || '';
  // 记下「最后变化时刻」。识别器有时候会长时间不吐 final，只反复刷 interim，
  // 这时要靠它判断「卡住了」，见 onBgTick。
  S.interimAt = S.interim ? Date.now() : 0;
  renderOpen();
}
function feedFinal(t){
  let s = String(t || '').replace(/\s+/g, ' ').trim();
  if (!s) return;
  // 这段文字可能刚被「interim 提升」落过段了，别再落一次。
  // 现实里引擎补吐的 final 通常是「已落过的内容 + 新内容」，而且**只差个标点**
  // （我们提升的是无标点的 interim，引擎后来给的是带标点的 final）。
  // 所以按最长公共前缀去重，而不是判断首尾包含。
  if (S.promotedText && Date.now() - S.promotedAt < PROMOTE_DEDUPE_MS){
    const p = S.promotedText;
    let k = 0;
    while (k < s.length && k < p.length && s[k] === p[k]) k++;
    if (k >= 12 || p.includes(s) || s.includes(p)){
      const rest = (k >= 12 ? s.slice(k) : '').trim();
      // 剩下的部分如果没什么实质内容（比如只多了一个句号），整段丢掉
      s = rest.replace(/[^A-Za-z0-9一-鿿]/g, '').length < 8 ? '' : rest;
      // ⚠ 这里**不清空**标记：引擎可能分几次补吐，留着它继续吃后面的重复片段。
    } else {
      S.promotedText = '';          // 完全不相干的新内容，标记退休
    }
    if (!s) return;
  }
  if (!S.hold) S.holdSince = Date.now();
  S.hold = (S.hold + ' ' + s).trim();
  S.interim = ''; S.interimAt = 0;
  if (S.hold.length >= SEAL_CHARS) flushHold(false); else renderOpen();
}
/* 把 hold 里的文字落成一个段落 */
function flushHold(force){
  const en = S.hold.trim();
  if (!en) { S.hold = ''; S.holdSince = 0; renderOpen(); return; }
  if (!force && en.length < SEAL_CHARS) return;
  const p = {
    id: ++S.seq, en, zh:'', status:'pending', tries:0,
    t0: relMs(S.holdSince || Date.now()) / 1000,
    t1: relMs(Date.now()) / 1000
  };
  S.paras.push(p);
  S.stats.paras++; S.stats.chars += en.length;
  S.hold = ''; S.holdSince = 0;
  S.sumBuf.push(p.id);      // 攒着给滚动总结用
  logEvent({ type:'para', sessionId:S.sessionId, id:p.id, t0:p.t0, t1:p.t1, en:p.en });
  renderPara(p);
  // 明度层级会随新段落整体上移，所以最后三段都要重画一次
  for (let i = Math.max(0, S.paras.length - 3); i < S.paras.length - 1; i++) renderPara(S.paras[i]);
  renderOpen();
  scrollDown();     // 新段落落地就立刻跟上，不等那一秒的 tick（否则内容会先掉到折叠线以下）
  queueSummary();
  scheduleTranslate();
  renderFloat();
}
/* ============================================================ 后台计时器
   ⚠⚠ 这段是整个 app 最容易踩的坑，别动。

   页面被隐藏之后（最小化窗口 / 切到别的应用 / 切到别的标签页），浏览器会把
   **主线程的 setTimeout / setInterval 节流到约 1 次/秒**，隐藏满 5 分钟后
   进一步降到**约 1 次/分钟**。2026-09-23 实测：
       主线程 20ms 计时器：前台 50 次/秒 → 后台 1.2 次/秒（掉 40 倍）
       Web Worker 里同样的计时器：前台 61 次/秒 → 后台 67~165 次/秒（不受影响）

   而这个 app 有两处关键循环原本跑在主线程上，所以一最小化就「看起来停了」：
     · 兜底落段 —— 老师慢慢说话、单句攒不到 45 字符时，全靠它落地
     · 翻译调度 —— 这是**唯一**触发 runTranslate 的路径

   所以把这两件事挪进 Worker。跳 250ms 一次，够用，也不费电。
   （顺带实测：Worker 在 file:// 页面里也能建，所以分享版同样受用。） */
let bgTicker = null;
function onBgTick(){
  S.bgTicks++;                    // 只是给诊断和测试看的，没别的用
  const now = Date.now();

  // ⓪ 先把悬浮窗刷了。
  //   临时文本只调 renderOpen()（主页面那个），原本没调 renderFloat()，
  //   于是主页面一藏起来，弹窗只能靠主线程那个被节流的计时器刷新 ——
  //   表现就是「整段话翻译出来才跳一次，中间不动」。
  //   放在 tick 里就绕开了节流。
  if (S.float) renderFloat();
  // 日志攒批：每几秒发一次，不在热路径上单独发请求
  if (now - lastLogFlush > LOG_FLUSH_MS){ lastLogFlush = now; flushLog(false); }
  saveHistorySnapshot(false);   // 分享版靠它在本地留档（本地版是空操作）
  // ① 兜底落段。必须传 true —— 传 false 会被 flushHold 里的长度检查挡掉。
  if (S.hold && S.holdSince && now - S.holdSince > SEAL_MAX_MS) flushHold(true);
  // ② 翻译调度。只要有 pending 段落、而且当前没在翻，就推一把。
  if (S.txWanted && S.running && !S.translating){
    S.txWanted = false;
    runTranslate();
  }
  // ④ 识别引擎看门狗 —— 这是最要命的一种故障。
  //    引擎会**静默死掉**：`onend` 不触发、也不报错，就是再也不出任何结果。
  //    因为不触发 onend，我们的「自动续开」根本没被叫醒，只能干等。
  //    2026-09-24 真实数据：18:17:27 → 18:20:08 整整 **161 秒**一个字都没有，
  //    然后自己缓过来了。用户说「切了一次页面就没声音了」就是这么来的——
  //    切页面/最小化很容易把识别引擎搞成这种假死状态。
  //    判据：还在运行、还在 listening，但超过 REC_STALL_MS 没有任何 onresult。
  //    真静音不会触发它——教室里不可能这么安静，而且引擎自己会报 no-speech。
  if (S.running && S.listening && S.recStartedAt){
    const since = S.lastResultAt || S.recStartedAt;
    if (now - since > REC_STALL_MS){
      dg('⚠ 识别引擎超过 ' + Math.round(REC_STALL_MS / 1000) + ' 秒没有任何结果，判定假死，强制重启');
      S.stallRestarts = (S.stallRestarts || 0) + 1;
      if (!S.stallAt || now - S.stallAt > 10000){ S.stallAt = now; startListening(); }
      else { dg('   ↻ 刚重启过，等它一会儿'); }
    }
  }

  // ③ 识别器卡住时的兜底：它有时候长时间只刷 interim、不吐 final，
  //    而落段只认 final —— 结果界面上就一句临时文本永远变不成段落，
  //    翻译/总结/答题全都触发不了。2026-09-23 实测：60 秒里引擎吐了
  //    21~81 次 onresult，却只 finalize 出 1~2 段。
  //    判据用「interim 多久没变化」而不是「攒了多久」，因为还在变说明
  //    识别器还在干活，不该打扰它。
  if (S.running && S.interim && S.interimAt && now - S.interimAt > INTERIM_STUCK_MS){
    const stuck = S.interim;
    S.interim = ''; S.interimAt = 0;
    S.promotedText = stuck; S.promotedAt = now;   // 等引擎真吐 final 时用它去重
    dg('· 识别器 ' + Math.round(INTERIM_STUCK_MS / 1000) + 's 没定稿，先把这段落地：' + stuck.slice(0, 40));
    if (!S.hold) S.holdSince = Date.now();
    S.hold = (S.hold + ' ' + stuck).trim();
    flushHold(true);                 // 强制落地，否则又攒着不动
  }
}
try {
  const src = 'let n=0; setInterval(function(){ n++; postMessage(n); }, 250);';
  bgTicker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  bgTicker.onmessage = onBgTick;
} catch (e) {
  // Worker 建不起来（极老的浏览器 / 某些企业策略）就退回主线程：
  // 功能一样，只是最小化之后会变慢。至少不能整个瘫掉。
  bgTicker = null;
  setInterval(onBgTick, 250);
}
function bgTickerNote(){
  return bgTicker ? '✓ 后台计时器用 Worker（切到别的窗口也不会停）'
    : '⚠ 后台计时器退回主线程（最小化后可能变慢）';
}

/* ============================================================ 翻译层（异步，不阻塞英文） */
/** 只举旗，真正的调用交给 Worker 的 tick。
    主线程的 setTimeout 在页面隐藏后会被节流到 1 次/秒、乃至 1 次/分钟，
    翻译就会「看起来停了」——所以这里**不用**定时器。 */
function scheduleTranslate(){ S.txWanted = true; }
async function runTranslate(){
  if (S.translating || !S.running) return;
  const pend = S.paras.filter(p => p.status === 'pending' && p.tries < MAX_TRIES);
  if (!pend.length) return;

  const batch = pend.slice(0, BATCH_MAX);
  const first = S.paras.indexOf(batch[0]);
  const context = S.paras.slice(Math.max(0, first - 4), first)
    .filter(p => p.zh).map(p => ({ en: p.en, zh: p.zh }));

  S.translating = true;
  setStatusBusy(true);
  const t0 = Date.now();
  try {
    const j = await API.translate({ items: batch.map(p => ({ id:p.id, en:p.en })), context });
    if (!j.ok) throw new Error(j.error || '未知错误');

    // 按 id 对齐回填。**绝不按数组顺序填** —— 模型换序时会整体错位。
    for (const it of (j.items || [])){
      const p = S.paras.find(x => x.id === it.id);
      if (!p) continue;
      p.zh = it.zh; p.status = 'done'; p.q = !!it.q;
      const lat = relMs(Date.now()) / 1000 - p.t1;
      S.stats.translated++;
      S.stats.latSum += lat; S.stats.latN++; S.lastLat = lat * 1000;
      logEvent({ type:'para_zh', sessionId:S.sessionId, id:p.id, zh:p.zh, q:p.q, latency_ms: Math.round(lat * 1000) });
      if (p.q){ dg('❓ 第 ' + p.id + ' 段是提问：' + p.en.slice(0, 60)); }
      renderPara(p);
    }
    for (const id of (j.missing || [])){
      const p = S.paras.find(x => x.id === id);
      if (p){ p.tries++; dg('⚠ 第 ' + p.id + ' 段漏译，重试 ' + p.tries + '/' + MAX_TRIES); }
    }
    if (j.raw) dg('⚠ 翻译返回不是 JSON：' + j.raw.slice(0, 160));
    dg('✓ 翻 ' + (j.items||[]).length + ' 段 / ' + (Date.now()-t0) + 'ms');
  } catch (e) {
    for (const p of batch) p.tries++;
    S.stats.errs++;
    dg('✗ 翻译失败：' + e.message);
    if (S.stats.errs === 3) toast('翻译连续失败，先看英文原文，稍后会自动重试。', 'bad');
  }
  S.translating = false;
  setStatusBusy(false);
  renderStats();
  markErrored();
  renderFloat();
  if (S.paras.some(p => p.status === 'pending' && p.tries < MAX_TRIES)) scheduleTranslate();
}
function markErrored(){
  for (const p of S.paras){
    if (p.status === 'pending' && p.tries >= MAX_TRIES){ p.status = 'error'; renderPara(p); }
  }
}

/* ============================================================ 渲染 */
function esc(s){ return String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
let openNode = null;

function makeParaNode(p){
  const d = document.createElement('div');
  d.className = 'para';
  d.innerHTML = '<div class="en"></div><div class="zh"></div>'
    + '<div class="pending" style="display:none"></div>'
    + '<div class="qbar" style="display:none"><span class="qchip">⚡ 答题</span></div>';
  // 处理器只挂一次，renderPara 是反复跑的，不要在里面重复挂
  const chip = d.querySelector('.qchip');
  if (chip) chip.onclick = () => askAnswer(p.id);
  return d;
}
function renderPara(p){
  let n = S.nodes.get(p.id);
  if (!n){ n = makeParaNode(p); S.nodes.set(p.id, n); $('rows').appendChild(n); }
  n.querySelector('.en').textContent = p.en;
  n.querySelector('.zh').textContent = p.zh || '';
  const pd = n.querySelector('.pending');
  if (p.status === 'error'){ pd.style.display = ''; pd.textContent = '（这段翻译没成功，看英文）'; }
  else if (p.zh){ pd.style.display = 'none'; }
  else { pd.style.display = ''; pd.textContent = '翻译中…'; }
  // 老师抛给全班的提问：给一个能点的「答题」入口
  const qb = n.querySelector('.qbar');
  if (qb) qb.style.display = p.q ? '' : 'none';
  const chip = n.querySelector('.qchip');
  if (chip){
    const used = S.answer && S.answer.forId === p.id;
    chip.className = 'qchip' + (used ? ' done' : '');
    chip.textContent = used ? '⚡ 已生成' : '⚡ 答题';
  }
  n.classList.toggle('no-zh', !p.zh || !S.show.zh);
  n.classList.toggle('no-en', !S.show.en);
  n.classList.toggle('err', p.status === 'error');
  n.classList.toggle('isq', !!p.q);
  // 层级靠明度：最新一段最亮，倒二稍暗，其余统一退后。不画任何框。
  const idx = S.paras.indexOf(p), N = S.paras.length;
  n.classList.toggle('recent1', idx === N - 1);
  n.classList.toggle('recent2', idx === N - 2);
  return n;
}
/* 正在说的那段：文字还在变，单独一个节点，永远排在最后 */
function renderOpen(){
  const txt = (S.hold + ' ' + S.interim).trim();
  const list = $('rows');
  if (!txt){
    if (openNode){ openNode.remove(); openNode = null; }
    return;
  }
  if (!openNode){
    openNode = document.createElement('div');
    openNode.className = 'para open no-zh';
    openNode.innerHTML = '<div class="en"></div>';
    list.appendChild(openNode);
  }
  list.appendChild(openNode);   // 永远排最后
  const en = openNode.querySelector('.en');
  en.innerHTML = '<span class="listen"></span>' + esc(S.hold ? S.hold + ' ' : '')
    + (S.interim ? '<span class="live">' + esc(S.interim) + '</span>' : '');
  openNode.classList.toggle('no-en', !S.show.en);
}
function renderAll(){
  const l = $('list'), keepFollow = S.follow;
  suppressScroll = true;        // 重建期间 scrollTop 归零，别让那次 scroll 事件打掉「跟随」
  $('rows').innerHTML = '';
  S.nodes.clear(); openNode = null;
  for (const p of S.paras) renderPara(p);
  renderOpen();
  // 等这一帧的布局落定，把滚动位置恢复到该在的地方，再解禁
  requestAnimationFrame(() => {
    if (keepFollow && l) l.scrollTop = l.scrollHeight;
    suppressScroll = false;
  });
}
function renderStats(){
  const lat = S.stats.latN ? Math.round(S.stats.latSum / S.stats.latN) : null;
  // 2026-09-24 实测：装软件那阵子带宽被占满，单次翻译从 ~800ms 涨到 4~9 秒，
  // 看起来像卡死。把「最近一次有多慢」显式摆出来，用户就能分辨
  // 「网络被占了」和「程序坏了」，不用干等。
  const slow = S.lastLat > 4000;
  const verySlow = S.lastLat > 9000;
  $('foot-stats').innerHTML = S.stats.paras
    ? `${S.stats.paras} 段 · 已译 ${S.stats.translated}`
      + (lat != null ? ` · 中译延迟 ~${lat}s` : '')
      + (slow ? ` · <span style="color:var(--${verySlow ? 'rust' : 'gold'})">`
          + (verySlow ? '网络很慢，翻译在排队' : '翻译变慢（多半是网络被占）') + '</span>' : '')
      + (S.stats.errs ? ` · <span style="color:var(--rust)">错误 ${S.stats.errs}</span>` : '')
    : '';
}
function setStatus(kind, text){
  $('dot').className = 'dot ' + (kind || '');
  $('status').textContent = text;
}
let busy = false;
function setStatusBusy(b){
  busy = b;
  if (S.running) setStatus(b ? 'busy' : 'live', b ? '翻译中' : '正在听');
}

/* 跟随 / 回看：用户往上滚之后必须停止自动滚动，否则回看时会被新内容顶走 */
/* ⚠ 重建列表（renderAll）会把 scrollTop 打回 0，浏览器**异步**抛出一个 scroll 事件。
   那个事件跑到下面的监听里，算出「离底部还有很远」→ 把 S.follow 打成 false，
   于是一整块内容都不再自动跟着走。用户报的「时不时不自动向下」就是这个。
   所以在重建期间用一个标志把监听屏蔽掉。 */
let suppressScroll = false;

/* 用户自己的滚动手势（滚轮 / 触摸 / 拖滚动条）。
   只有手势能**关掉**跟随。没有手势的 scroll 事件——重建列表、贴底、
   浏览器滚动锚定——一律不算用户在回看，别动跟随状态。 */
let userScrollAt = 0;
const markScrollGesture = () => { userScrollAt = Date.now(); };
for (const ev of ['wheel', 'touchstart', 'touchmove', 'pointerdown'])
  $('list').addEventListener(ev, markScrollGesture, { passive: true });

/* 「看到最新了吗」的判据是**最后一段露出来了没有**，不是量到滚动条底部。
   #list 底部有 88px padding（`padding:22px 0 88px`）。量几何底部的话，
   用户把最新一行滑到眼前时距离还是 88px，超过 60 的容差 —— 跟随回不来，
   只能一路滑进那片空白里才恢复。
   2026-09-28 用户报的「不自动跟着字幕往下」就是它：课上只要中途滚过一次
   （回看一眼、手滑一下），之后画面就停在旧内容上，每看一段都要再滑一次。 */
function atLiveEdge(){
  const last = $('rows').lastElementChild;
  if (!last) return true;
  return last.getBoundingClientRect().bottom <= $('list').getBoundingClientRect().bottom + 8;
}

$('list').addEventListener('scroll', () => {
  if (suppressScroll) return;              // 程序自己导致的滚动，不算用户在回看
  // 最新一段露出来了：不管是谁滚的，都该继续跟着走，顺手贴底，
  // 省掉「最新一行已经看得见、但离底还有 88px 空白」那段别扭的距离。
  if (atLiveEdge()){
    if (!S.follow){ S.follow = true; scrollDown(); }
    $('foot-status').textContent = S.running ? '跟随中' : '待机';
    return;
  }
  // 最新内容还在视野之下：只有用户的手势才算「用户要回看」，其余忽略、保持原状
  if (Date.now() - userScrollAt > 800) return;
  S.follow = false;
  $('foot-status').textContent = '回看中 · Home 回到最新';
});
function scrollDown(){
  if (!S.follow) return;
  const el = $('list');
  el.scrollTop = el.scrollHeight;
}

/* 内容高度一直在变：段落落地、中文译文填进来、「翻译中…」那行消失……
   每一次都可能把视野甩到折叠线以下。光靠每秒 tick 里滚一次不够及时
   （实测重建之后能差出 84px，正好一段的距离）。
   用 ResizeObserver 盯住内容列，只要还在跟随就立刻贴到底。
   它不会自己触发自己——改 scrollTop 不影响内容高度。 */
if (window.ResizeObserver){
  try {
    new ResizeObserver(() => { if (S.follow) scrollDown(); }).observe($('rows'));
  } catch (e) { dg('· ResizeObserver 没起来：' + e.message); }
}

/* 每秒重绘一次「当前段」和计时；不在 scroll 事件里做，避免抖动 */
setInterval(() => {
  if (S.sessionId && S.startedAt){
    S.elapsed = Math.floor(Math.max(0, relNow()) / 1000);
    const m = Math.floor(S.elapsed / 60), s = S.elapsed % 60;
    $('clock').textContent = String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
  }
  renderOpen();
  if (S.float) renderFloat();
  scrollDown();
}, 1000);

/* 切回前台时补一次。
   Worker 的计时器不受节流影响，所以数据和翻译一直是跟得上的；
   但**渲染**跑在主线程上，后台期间会被压到 1 次/秒，界面可能落后。
   回到前台时重画一遍，把这段时间的落差一次补上。 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden){
    S.hiddenAt = Date.now();
    dg('· 页面切到后台（Worker 计时器照常跑）');
    return;
  }
  const away = S.hiddenAt ? Date.now() - S.hiddenAt : 0;
  S.hiddenAt = 0;
  dg('· 页面切回前台（离开 ' + Math.round(away / 1000) + ' 秒）');
  renderAll();               // 它自己会把滚动位置恢复好
  scheduleTranslate();

  /* 切页面最容易把识别引擎搞成假死 —— 2026-09-24 实测：切一次页面之后
     整整 161 秒没有出过任何结果，而且 onend 不触发，自动续开根本没被叫醒。
     所以别等看门狗那 60 秒：离开过一阵、回来 2.5 秒还是一个结果都没有，
     就直接重启引擎。只在「真的离开过 >5 秒」时才查，避免正常停顿被误判。 */
  if (S.running && S.listening && away > 5000){
    const before = S.lastResultAt;
    setTimeout(() => {
      if (!S.running || !S.listening) return;
      if (S.lastResultAt === before){
        dg('⚠ 离开 ' + Math.round(away / 1000) + ' 秒后回来仍无结果，主动重启识别引擎');
        startListening();
      }
    }, 2500);
  }
});

/* ============================================================ 录音（可选，默认关）
   和识别共用麦克风，同时开会干扰识别质量（english-speaking 里踩过）。
   按 60 秒切片上传，不把整节课堆在内存里。 */
function startRecorder(){
  navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:true, noiseSuppression:true } })
    .then(st => {
      S.micStream = st;
      try {
        S.recorder = new MediaRecorder(st);
        S.recorder.ondataavailable = e => {
          if (!e.data || !e.data.size) return;
          S.recChunks++;
          const n = S.sessionId + '-p' + String(S.recChunks).padStart(3,'0');
          fetch('/api/audio?name=' + n, { method:'POST', body: e.data })
            .then(r => r.json()).then(j => dg('● 录音片段已存 ' + j.file)).catch(() => {});
        };
        S.recorder.start(60000);
        dg('● 录音开始（每 60 秒切片上传）');
      } catch (e) { dg('录音不可用 ' + e.message); }
    }).catch(e => dg('录音取流失败 ' + e.name));
}
function stopRecorder(){
  if (S.recorder && S.recorder.state !== 'inactive'){ try { S.recorder.stop(); } catch(e){} }
  S.recorder = null;
  if (S.micStream){ S.micStream.getTracks().forEach(t => t.stop()); S.micStream = null; }
}

/* ============================================================ 开始 / 暂停 */
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
function toggleRun(){
  if (S.running) stopRun(); else startRun().catch(e => { dg('✗ startRun 抛错 ' + e.message); stopRun(); });
}
async function startRun(){
  // 正在看历史的时候点「开始」= 回到当前再开课。不这样的话新录的内容
  // 会灌进历史数据里，两边搅在一起。
  if (S.history) exitHistory();
  // ⚠ 麦克风没拿到就**绝不进入运行态**。否则界面显示「正在听」但一句都识别不到，
  //   用户的体验就是「点了没反应」。先要权限，要不到就停在原地并说清楚为什么。
  const ok = await ensureMic();
  if (!ok){
    $('btn-run').textContent = '开始';
    $('btn-run').classList.add('on');
    $('empty').style.display = '';
    showMicError();
    return;
  }
  clearSysBar();
  S.hardError = false;
  // 静默问一次「Windows 现在默认给我哪一支」。不打开设备，所以不会影响上面刚放掉的
  // 权限流程；只在「上次测出收不到远场」或「默认设备变成了环回设备」时才弹提示条。
  micPreflight().catch(() => {});

  if (!S.sessionId){
    S.sessionId = uid();
    S.startedAt = Date.now();
    logEvent({ type:'session_start', sessionId:S.sessionId, course: $('course').value.trim() || null });
    renderTarget(); logSessionMeta();    // 名字拆成 course/week/label 也记一笔，历史列表要靠它显示标题
  } else if (S.pauseAt){
    S.pausedMs += Date.now() - S.pauseAt;   // 暂停的时长不算进上课时间
    S.pauseAt = 0;
    scheduleTranslate();                    // 暂停前卡住的段落，继续之后要接着翻
  }
  S.running = true;
  S.svcRetries = 0;          // 用户主动开始的，重新给识别服务两次机会
  // 兜底：runTranslate 见到 !S.running 会直接返回且**不会重试**。
  // 万一段落是在 ensureMic 还没完成时落盘的（首帧抢跑），这里补一次。
  scheduleTranslate();
  S.follow = true;
  $('btn-run').textContent = '暂停';
  $('btn-run').classList.remove('on');
  // ⚠ 单文件分享版会把「导入课程笔记」按钮整个删掉，所以这里不能直接摸 .disabled，
  //   否则空指针会让整个 startRun 中断，表现是「点开始没反应」。
  for (const id of ['btn-md', 'btn-word', 'btn-import']){
    const b = $(id); if (b) b.disabled = false;
  }
  $('empty').style.display = 'none';
  $('foot-status').textContent = '跟随中';
  startListening();
  if ($('opt-record').checked) startRecorder();
  warmCache();          // 把 system prompt 的 KV cache 建好，首个答案能省 1–2 秒
  dg('▶ 开始会话 ' + S.sessionId);
}
function stopRun(){
  S.running = false;
  if (S.pauseAt === 0) S.pauseAt = Date.now();
  stopListening();
  stopRecorder();
  $('btn-run').textContent = '继续';
  $('btn-run').classList.add('on');
  $('foot-status').textContent = '已暂停';
}
/* ---- 日志：攒批发送 ----
   原来是每落一段就单独发一个请求，长时间跑会积压甚至整段丢失
   （2026-09-24 实测：页面产出 240 段，服务端只收到 131 条 para 事件）。
   改成进队列、由后台 ticker 每几秒批量发一次，失败就放回队列下次重发。
   请求数从「每段一个」降到「每几秒一个」，也不容易再被节流影响。 */
const LOG_FLUSH_MS = 4000, LOG_MAX_Q = 600;
let lastLogFlush = 0;
function logEvent(ev){
  if (API.standalone) return;     // 分享版没有后端；诊断面板里的记录已经够了
  S.logQ.push(ev);
  if (S.logQ.length > LOG_MAX_Q) S.logQ.splice(0, S.logQ.length - LOG_MAX_Q);
}
/** sync=true 只在页面即将关闭时用：那时候只有 keepalive 能保证发得出去。 */
function flushLog(sync){
  if (API.standalone || !S.logQ.length) return;
  const batch = S.logQ.splice(0, S.logQ.length);
  const opts = {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: batch })
  };
  if (sync) opts.keepalive = true;
  fetch('/api/log', opts)
    .then(r => r.text())                       // 一定要读掉 body，别留悬着的请求
    .catch(() => { S.logQ = batch.concat(S.logQ).slice(-LOG_MAX_Q); });
}

/* ============================================================ 快速答题
   触发是**手动**的（按 A 或点段落下方的「⚡答题」）。不做自动弹窗：
   用户真正需要的时刻自己知道，而自动弹窗会在 90 分钟里干扰上百次。
   自动那部分只做到「给提问打个标记」为止。 */
/* 老师这句话是哪一类。分对类型才答得对——用户 2026-09-24 的数据里，
   老师问一个具体动作，回答却给抽象定义，就是没分类直接生成造成的。 */
const ASK_LABEL = {
  definition: "要定义", opinion: "要评价", example: "要例子",
  followup: "追问", open: "开放讨论"
};

async function askAnswer(paraId, long){
  if (!S.paras.length){ toast('还没有内容——先开始录音，等老师讲几句'); return; }

  // 没指定就找最近一个被标为提问的段落；一个都没有，就退化成「对刚才这段说点什么」
  let target = null;
  if (paraId != null) target = S.paras.find(p => p.id === paraId);
  if (!target) target = [...S.paras].reverse().find(p => p.q);
  const isQuestion = !!target;
  if (!target) target = S.paras[S.paras.length - 1];

  const idx = S.paras.indexOf(target);
  // 上下文取提问**之前**的段落——提问本身单独走 question 字段，不要重复塞进 context
  const context = S.paras.slice(Math.max(0, idx - 12), idx)
    .filter(p => p.en).map(p => ({ en: p.en, zh: p.zh }));

  const question = isQuestion ? target.en : '';

  /* ---- 用户自己的历史：这三样是「防重复 / 去模板 / 接追问」的原料 ----
     2026-09-24 实测：16 次生成里 14 次开场是同一句式、5 次同一个结尾；
     同一个问题被用户连按 2–3 次，答案只换了几个词。所以必须记住答过什么。 */
  const key = question.trim();
  const prev = key ? S.answers.find(a => a.question === key) : null;
  const last = S.answers[S.answers.length - 1];
  const usedOpeners = [];
  for (const a of S.answers.slice(-6)){
    const s = a.say_en || [];
    if (s[0]) usedOpeners.push(s[0].slice(0, 80));
    if (s.length > 1) usedOpeners.push(s[s.length - 1].slice(0, 80));
  }
  if (prev && !long) toast('这题你刚答过，这次换个角度', 'ok');

  S.answer = {
    loading: true, forId: target.id, question, isQuestion, long: !!long,
    again: !!prev, data: null, error: null
  };
  $('answer').classList.add('on');
  renderAnswer(); renderFloat();
  // 段落上的 chip 要从「⚡答题」变成「⚡已生成」
  if (S.nodes.has(target.id)) renderPara(S.paras[idx]);

  const t0 = Date.now();
  try {
    const j = await API.answer({
      question, context, sessionId: S.sessionId, long: !!long,
      prevAnswer: prev ? (prev.say_en || []) : null,   // 同一题上一次的答案 → 强制换角度
      lastAnswer: last ? (last.say_en || []) : null,   // 最近一次发言 → followup 时接住它
      usedOpeners,                                     // 用过的开场结尾 → 一律避开
    });
    if (!j.ok) throw new Error(j.error || '生成失败');
    S.answer.loading = false;
    S.answer.data = j.data;
    S.stats.answers++;
    // 记进历史，供下一次去重/去模板/接追问
    S.answers.push({
      question: key, say_en: j.data.say_en || [], say_zh: j.data.say_zh || [],
      angle_zh: j.data.angle_zh || '', ask_type: j.data.ask_type || '', long: !!long
    });
    if (S.answers.length > 20) S.answers.shift();
    dg('⚡ 答题 ' + (Date.now() - t0) + 'ms' + (j.data.parse_error ? '（解析失败）' : ''));
  } catch (e) {
    S.answer.loading = false;
    S.answer.error = e.message;
    dg('✗ 答题失败 ' + e.message);
  }
  renderAnswer(); renderFloat();
}
function renderAnswer(){
  const a = S.answer, box = $('a-body');
  if (!a){ box.innerHTML = ''; return; }
  if (a.loading){
    box.innerHTML = '<div class="await"><span class="aspin"></span>正在组织…（约 2 秒）</div>';
    return;
  }
  if (a.error){
    box.innerHTML = '<div class="awarn">生成失败：' + esc(a.error)
      + '<br><br>先看英文原文答，或者按「重新生成」再试一次。</div>';
    return;
  }
  const d = (a.data || {});
  let h = '<div class="qline">'
    + '<div class="k">' + (a.isQuestion ? '老师问的是' : '现在的局面')
      + (ASK_LABEL[d.ask_type] ? '<span class="kind' + (a.again ? ' again' : '') + '">'
          + ASK_LABEL[d.ask_type] + (a.again ? ' · 换角度' : '') + '</span>' : '')
      + '</div>'
    + '<div class="qen">' + esc(a.question || '老师刚讲完一段，没有明确问句——你可以主动接话') + '</div>';
  if (d.what_zh || d.angle_zh){
    h += '<div class="meta">'
      + (d.what_zh ? '<div>他在问什么　<b>' + esc(d.what_zh) + '</b></div>' : '')
      + (d.angle_zh ? '<div>可以怎么接　<b>' + esc(d.angle_zh) + '</b></div>' : '')
      + '</div>';
  }
  h += '</div>';

  if (d.stall_en){
    h += '<div class="asec"><div class="k">先用这句拖一下</div><div class="stall">' + esc(d.stall_en) + '</div></div>';
  }
  if ((d.say_en || []).length){
    const n = d.say_en.length;
    h += '<div class="asec"><div class="k">可以直接念'
      + (a.long ? '（展开版）' : '') + '</div><div class="say">'
      + d.say_en.map((s, i) => {
          const zh = (d.say_zh || [])[i] || '';
          return '<div class="ln"><span class="n">' + (i + 1) + '</span><span class="t">'
            + (zh ? '<span class="zh">' + esc(zh) + '</span>' : '')
            + '<span class="en">' + esc(s) + '</span></span></div>';
        }).join('')
      + '</div>'
      + '<div class="hintline">中文是「你脑子里的那个意思」，不是直译——先看中文确认对不对，再念英文。</div>'
      + '</div>';
  }
  if (d.extend_en){
    h += '<div class="asec"><div class="k">如果被继续追问</div><div class="aext">' + esc(d.extend_en) + '</div></div>';
  }
  if (d.avoid_zh){
    h += '<div class="asec"><div class="k">别踩的坑</div><div class="awarn">' + esc(d.avoid_zh) + '</div></div>';
  }
  if (d.parse_error){
    h += '<div class="asec"><div class="k">原始返回（没能解析成结构化）</div><div class="aext">'
      + esc(d.raw || '') + '</div></div>';
  }
  box.innerHTML = h;
  box.scrollTop = 0;
}
function closeAnswer(){
  $('answer').classList.remove('on');
  const id = S.answer && S.answer.forId;
  S.answer = null;
  if (id != null){ const p = S.paras.find(x => x.id === id); if (p) renderPara(p); }
  renderFloat();
}
/* ============================================================ 一键隐藏
   之前的版本只藏了 main/footer，顶栏 7 个按钮全在，等于没藏；
   而恢复入口是一个 14px、50% 透明、色值贴着底色的暗点，等于没有。
   现在全部收掉，只留一个看得清的胶囊说明怎么回来。 */
function toggleHidden(force){
  const on = force === undefined ? !document.body.classList.contains('hidden') : !!force;
  document.body.classList.toggle('hidden', on);
  dg(on ? '· 已隐藏（Esc 恢复）' : '· 已恢复');
}

/* ============================================================ 滚动总结
   每攒够一段课堂内容就梳理一次，卡片从新到旧堆在右栏。
   课后再看就是整节课的骨架——这是这个 app 最终要交付的东西。 */
const SUM_MIN_SEC = 70;      // 攒够这么多秒的课堂内容
const SUM_MIN_PARAS = 5;     // 且至少这么多段
const SUM_RETRY_MS = 60000;  // 失败后隔多久才再试，不要每次落段都去撞

function queueSummary(){
  if (!S.running || S.sumBusy || !S.sumAuto) return;
  if (S.sumBuf.length < SUM_MIN_PARAS) return;
  const first = S.paras.find(p => p.id === S.sumBuf[0]);
  const last = S.paras.find(p => p.id === S.sumBuf[S.sumBuf.length - 1]);
  if (!first || !last) return;
  if (last.t1 - first.t0 < SUM_MIN_SEC) return;
  if (S.sumFailAt && Date.now() - S.sumFailAt < SUM_RETRY_MS) return;
  runSummary();
}

async function runSummary(){
  if (S.sumBusy) return;
  const ids = S.sumBuf.slice();
  const items = ids.map(id => S.paras.find(p => p.id === id)).filter(Boolean);
  if (!items.length) return;
  S.sumBusy = true;
  const card = { id: 'sm' + Date.now(), t0: items[0].t0, t1: items[items.length - 1].t1, loading: true, data: null, error: null };
  S.summaries.push(card);
  renderSummary();
  const t0 = Date.now();
  try {
    const prev = S.summaries.length > 1 ? (S.summaries[S.summaries.length - 2].data || {}).topic_zh : null;
    const j = await API.summary({ sessionId: S.sessionId, items: items.map(p => ({ en: p.en, zh: p.zh })),
      prev: prev || null, t0: card.t0, t1: card.t1 });   // t0/t1 必须带上：历史回放要靠它排时间轴
    if (!j.ok) throw new Error(j.error || '总结失败');
    card.loading = false; card.data = j.data;
    // 成功才把 buffer 清掉；失败留着，下次重试
    S.sumBuf = S.sumBuf.filter(id => !ids.includes(id));
    S.sumFailAt = 0;
    dg('· 总结 ' + items.length + ' 段 / ' + (Date.now() - t0) + 'ms');
  } catch (e) {
    card.loading = false; card.error = e.message;
    S.sumFailAt = Date.now();
    dg('✗ 总结失败 ' + e.message);
  }
  S.sumBusy = false;
  renderSummary();
}

function fmtClock(sec){
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
function renderSummary(){
  if (!S.summaries.length) return;                 // 没内容时保留空态文案
  const html = S.summaries.slice().reverse().map(c => {   // 最新在最上面，不用滚
    // 早期会话没记 t0/t1（那时还没加），两个都是 0 就别硬显示 00:00 – 00:00
    const t = (c.t1 > 0) ? (fmtClock(c.t0) + ' – ' + fmtClock(c.t1)) : '';
    if (c.loading) return '<div class="sum"><div class="t">' + t + '</div><div class="loading">正在梳理…</div></div>';
    if (c.error) return '<div class="sum"><div class="t">' + t + '</div>'
      + '<div class="loading" style="color:var(--rust)">没梳理成：' + esc(c.error) + '</div></div>';
    const d = c.data || {};
    return '<div class="sum"><div class="t">' + t + '</div>'
      + '<div class="topic">' + esc(d.topic_zh || '') + '</div>'
      + ((d.points_zh || []).length ? '<ul>' + d.points_zh.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '')
      + ((d.terms || []).length ? '<div class="terms">' + d.terms.map(x => '<span>' + esc(x) + '</span>').join('') + '</div>' : '')
      + '</div>';
  }).join('');
  $('sumlist').innerHTML = html;
  $('sumcnt').textContent = S.summaries.length ? S.summaries.length + ' 段' : '';
}

/* ============================================================ 桌面悬浮窗
   两种形态，**切换要重建窗口**：
     popup  普通浏览器窗口 —— 不置顶。点它才升上来，新开的 app 盖在它上面。**默认用这个**。
     pip    Document PiP —— 永远置顶，且关不掉。

   为什么不用一个窗口切换置顶：实测 `documentPictureInPicture` 的全部能力只有
   `window / onenter / requestWindow` 三个，**没有任何 always-on-top 控制**。
   普通窗口也没有置顶能力。所以只能开两种不同类型的窗口互切，代价是切的时候窗口位置会重置。

   ⚠ PiP 受「用户激活」限制，只能由**主窗口里**的真人点击/按键触发。
     实测在 popup 里点按钮调主窗口的 requestWindow 不会生效（激活按 realm 算），
     所以「置顶」按钮必须留在主窗口顶栏。
     反过来说，悬浮窗自己那个条上的按钮**不需要**用户激活，所以字号可以放在窗里调。 */
const FLOAT_CSS = `
/* 悬浮窗本来是一份**独立抄过去**的配色，所以主窗口换肤它不会跟着变 —— 这里一起换。
   顺手补齐原来漏定义的变量（--bg-2 / --bg-3 / --bg-sink / --jade / --jade-2 /
   --jade-sink / --rust / --rust-sink 全都没定义过），那个「正在听」小圆点其实
   一直拿到的是无效值。 */
:root{--bg:#FAF9F5;--bg-2:#FFFFFF;--bg-3:#F0EEE6;--bg-sink:#F5F4EE;
 --ink:#141413;--ink-2:#3D3D3A;--dim:#6F6E68;--dim-2:#9A988F;
 --line:#E5E2D9;--line-2:#D5D2C7;
 --gold:#D97757;--gold-2:#C15F3C;--gold-sink:#FBEEE8;
 --jade:#4A7C59;--jade-2:#3F6B44;--jade-sink:#EAF1E9;
 --rust:#B33A2B;--rust-sink:#FBEAE6;
 --en:14px;--zh:20px;
 --f-en:"Inter","Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
 --f-zh:"Noto Sans SC","PingFang SC","Microsoft YaHei UI",system-ui,sans-serif;
 --f-ui:"Noto Sans SC","PingFang SC","Microsoft YaHei UI",system-ui,sans-serif}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font-family:var(--f-ui);overflow:hidden}
#float{height:100%;display:flex;flex-direction:column}
#fbar{flex:0 0 auto;display:flex;align-items:center;gap:11px;padding:5px 12px;font-size:11px;
 color:var(--dim-2);border-bottom:1px solid var(--line);letter-spacing:.06em;user-select:none}
#fbar .st{display:flex;align-items:center;gap:6px}
#fbar .st i{width:5px;height:5px;border-radius:50%;background:var(--dim-2);display:block}
#fbar .st.on i{background:var(--jade)}
#fbar .pin{color:var(--gold-2)}
#fbar .sp{margin-left:auto}
#fbar .clk{font-family:Consolas,monospace;font-variant-numeric:tabular-nums}
/* 字号控件：点它不需要用户激活，所以可以住在这个窗里 */
#fbar .fst{display:flex;align-items:center;gap:0;border:1px solid var(--line);border-radius:6px;overflow:hidden}
#fbar .fst span{font-size:10.5px;padding:0 5px 0 7px;color:var(--dim-2)}
#fbar .fst button{border:0;background:transparent;color:var(--dim);font-size:13px;line-height:1;
 padding:2px 7px;cursor:pointer;font-family:var(--f-ui)}
#fbar .fst button:hover{background:rgba(20,20,19,.07);color:var(--ink)}
#fbar .fst b{font-family:Consolas,monospace;font-size:10.5px;color:var(--dim);
 min-width:20px;text-align:center;font-weight:400}
#fbody{flex:1;overflow-y:auto;padding:12px 20px 20px;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
#fbody::-webkit-scrollbar{width:8px}
#fbody::-webkit-scrollbar-thumb{background:var(--line);border-radius:8px}
.p{opacity:.45;margin-bottom:10px}
.p:last-child{opacity:1}
.p .en{font-family:var(--f-en),var(--f-zh);font-size:var(--en);line-height:1.5;color:var(--dim)}
.p .zh{font-family:var(--f-zh);font-size:var(--zh);line-height:1.46;color:var(--ink);margin-top:3px}
.q{font-family:var(--f-en);font-size:13px;color:var(--dim);border-left:2px solid var(--gold);
 padding-left:11px;margin-bottom:11px;line-height:1.5}
.a{font-size:13.5px;color:var(--ink-2);line-height:1.62;margin-bottom:12px}
.k{font-size:10px;letter-spacing:.16em;color:var(--gold-2);text-transform:uppercase;margin:13px 0 6px}
.s{font-family:var(--f-en);font-size:calc(var(--zh) * 0.95);line-height:1.48;color:var(--ink);padding:7px 0;
 border-top:1px dashed rgba(217,119,87,.22)}
.s:first-of-type{border-top:0}
.s .sz{display:block;font-family:var(--f-zh);font-size:calc(var(--zh) * 0.7);
 color:var(--ink-2);margin-bottom:2px;line-height:1.45}
.empty{color:var(--dim-2);font-size:13px;padding:26px 0;text-align:center}
.warn{color:var(--rust,#B33A2B);font-size:13px;line-height:1.7}
`;

/** 悬浮窗自己的字号。和主窗口分开存、分开调——用户要求「单独调整」。 */
const FF = { en: { min: 10, max: 34, step: 1, def: 14 }, zh: { min: 12, max: 56, step: 2, def: 20 } };

function mountFloat(w, mode){
  const d = w.document;
  d.title = '课堂同传 · 悬浮';
  const st = d.createElement('style');
  st.textContent = FLOAT_CSS;
  d.head.appendChild(st);
  d.body.innerHTML = '';

  const root = d.createElement('div');
  root.id = 'float';
  root.innerHTML = '<div id="fbar">'
    + '<span class="st" id="fst"><i></i><span id="fsttext">待机</span></span>'
    + '<span class="pin" id="fpin"></span>'
    + '<span id="ftip" style="color:var(--dim-2)"></span>'
    + '<span class="sp"></span>'
    + '<span class="fst"><span>英</span><button id="fen1">−</button><b id="fenv"></b><button id="fen2">+</button></span>'
    + '<span class="fst"><span>中</span><button id="fzh1">−</button><b id="fzhv"></b><button id="fzh2">+</button></span>'
    + '<span class="clk" id="fclk">00:00</span>'
    + '</div><div id="fbody"></div>';
  d.body.appendChild(root);

  // 处理器挂在主窗口这一侧，点击后在主窗口的 realm 里跑，改的是 S.floatFs。
  // （点这些按钮不需要用户激活，所以可以住在悬浮窗里。置顶那个不行，见文件顶部的说明。）
  const bind = (id, fn) => { const b = d.getElementById(id); if (b) b.onclick = fn; };
  bind('fen1', () => nudgeFloatFont('en', -1));
  bind('fen2', () => nudgeFloatFont('en', +1));
  bind('fzh1', () => nudgeFloatFont('zh', -1));
  bind('fzh2', () => nudgeFloatFont('zh', +1));

  applyFloatFont(w);
  const pin = d.getElementById('fpin');
  if (pin) pin.textContent = mode === 'pip' ? '📌 已置顶' : '未置顶';
  const tip = d.getElementById('ftip');
  if (tip) tip.textContent = mode === 'pip' ? '' : '（要置顶就回主窗口点「置顶」）';
  w.addEventListener('pagehide', () => { if (S.float && S.float.win === w) closeFloat(); });
}

function applyFloatFont(w){
  if (!w || !w.document || !w.document.documentElement) return;
  w.document.documentElement.style.setProperty('--en', S.floatFs.en + 'px');
  w.document.documentElement.style.setProperty('--zh', S.floatFs.zh + 'px');
  const e = w.document.getElementById('fenv'), z = w.document.getElementById('fzhv');
  if (e) e.textContent = S.floatFs.en;
  if (z) z.textContent = S.floatFs.zh;
  try { localStorage.setItem('cp-float-font', JSON.stringify(S.floatFs)); } catch (err) {}
}
function nudgeFloatFont(which, dir){
  const c = FF[which];
  S.floatFs[which] = Math.max(c.min, Math.min(c.max, S.floatFs[which] + dir * c.step));
  // 存档和上屏分开：窗没开的时候也要记住用户调过的值
  try { localStorage.setItem('cp-float-font', JSON.stringify(S.floatFs)); } catch (e) {}
  if (S.float) applyFloatFont(S.float.win);
}
(function loadFloatFont(){
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('cp-float-font') || 'null'); } catch (e) {}
  if (saved){
    if (typeof saved.en === 'number') S.floatFs.en = Math.max(FF.en.min, Math.min(FF.en.max, saved.en));
    if (typeof saved.zh === 'number') S.floatFs.zh = Math.max(FF.zh.min, Math.min(FF.zh.max, saved.zh));
  }
})();

function closeFloat(){
  if (!S.float) return;
  const w = S.float.win;
  S.float = null;
  try { w.close(); } catch (e) {}
  const b = $('btn-float'); if (b) b.classList.remove('on');
  const p = $('btn-pin'); if (p) p.classList.remove('on');
  dg('· 悬浮窗已关');
}

/** mode: 'popup'（不置顶，默认）| 'pip'（永远置顶） */
async function openFloat(mode){
  closeFloat();
  let w;
  if (mode === 'pip'){
    if (!('documentPictureInPicture' in window)){
      toast('这个浏览器不支持置顶悬浮窗（要 Edge / Chrome 116+）。', 'bad');
      dg('✗ 没有 documentPictureInPicture');
      return false;
    }
    try {
      w = await window.documentPictureInPicture.requestWindow({ width: 820, height: 340 });
    } catch (e) {
      const msg = String(e.message || e);
      dg('✗ 置顶窗打不开：' + msg);
      toast(/user activation/i.test(msg)
        ? '浏览器要求这个动作由你亲自点。再点一次「置顶」。'
        : '置顶窗打不开：' + msg, 'bad');
      return false;
    }
  } else {
    w = window.open('', 'cp_float', 'popup=yes,width=820,height=340');
    if (!w){
      toast('弹窗被浏览器拦住了。允许本页弹窗后重试，或者直接用「置顶」。', 'bad');
      dg('✗ window.open 返回 null（被拦）');
      return false;
    }
  }
  S.float = { win: w, mode };
  try { mountFloat(w, mode); }
  catch (e) { dg('✗ 挂载悬浮窗失败：' + e.message); closeFloat(); return false; }
  const b = $('btn-float'); if (b) b.classList.add('on');
  const p = $('btn-pin'); if (p) p.classList.toggle('on', mode === 'pip');
  dg('· 悬浮窗已开（' + (mode === 'pip' ? '置顶' : '不置顶') + '）');
  renderFloat();
  return true;
}

/** 点「悬浮」= 开关。开着就关，关着就用**不置顶**的普通窗口打开。 */
async function toggleFloat(){ if (S.float) closeFloat(); else await openFloat('popup'); }
/** 点「置顶」= 在两种形态之间切。切的时候要重建窗口（浏览器没给取消置顶的 API）。 */
async function togglePin(){
  const mode = S.float ? S.float.mode : null;
  if (mode === 'pip') { await openFloat('popup'); toast('已取消置顶（点它才升到最前）'); }
  else { await openFloat('pip'); toast('已置顶（永远在最前）'); }
}

function renderFloat(){
  if (!S.float || !S.float.win || S.float.win.closed) return;
  const d = S.float.win.document;
  const body = d.getElementById('fbody');
  if (!body) return;
  const clock = ($('clock') && $('clock').textContent) || '00:00';
  const st = d.getElementById('fst'), stt = d.getElementById('fsttext'), clk = d.getElementById('fclk');
  if (st) st.classList.toggle('on', !!S.running);
  if (stt) stt.textContent = S.running ? '正在听' : (S.sessionId ? '已暂停' : '待机');
  if (clk) clk.textContent = clock;

  const a = S.answer;
  if (a && a.loading){
    body.innerHTML = '<div class="empty">正在组织发言…</div>';
    return;
  }
  if (a && a.data){
    const x = a.data;
    body.innerHTML = (a.question ? '<div class="q">' + esc(a.question) + '</div>' : '')
      + (x.angle_zh ? '<div class="a">' + esc(x.angle_zh) + '</div>' : '')
      + ((x.say_en || []).length
        ? '<div class="k">可以直接念</div>'
          + x.say_en.map((s, i) => {
              const zh = (x.say_zh || [])[i] || '';
              return '<div class="s">'
                + (zh ? '<span class="sz">' + esc(zh) + '</span>' : '')
                + esc(s) + '</div>';
            }).join('')
        : '');
    body.scrollTop = 0;
    return;
  }
  const recent = S.paras.slice(-3);
  const open = (S.hold + ' ' + S.interim).trim();
  let h = recent.map(p => '<div class="p"><div class="en">' + esc(p.en) + '</div>'
    + (p.zh ? '<div class="zh">' + esc(p.zh) + '</div>' : '') + '</div>').join('');
  if (open) h += '<div class="p"><div class="en">' + esc(open) + '</div></div>';
  body.innerHTML = h || '<div class="empty">还没有内容</div>';
  body.scrollTop = body.scrollHeight;
}

/** 开课时把两个 system prompt 的 KV cache 建好，之后每个请求的 prefill 命中缓存。 */
function warmCache(){
  API.warm()
    .then(j => {
      const a = j.translate || {}, b = j.answer || {};
      // 预热失败要出声。之前这里全是 '·'，接口 500 了也看不出来，
      // 结果 /api/warm 坏了好几天都没人发现。
      const bad = !a.ok || !b.ok;
      dg((bad ? '✗' : '·') + ' 缓存预热 翻译 ' + (a.ok ? a.ms + 'ms' : ('失败 ' + (a.error || '')))
        + ' | 答题 ' + (b.ok ? b.ms + 'ms' : ('失败 ' + (b.error || ''))));
    })
    .catch(e => dg('✗ 缓存预热失败：' + e.message + '（不影响使用，只是首个答案会慢一点）'));
}

/* ============================================================ 命名 → 归档
   命名框的格式：<课程编号> <周次> [区分词]，例：
     MATH1101 W3          → week3-transcript.docx
     MATH1101 W3 习题课    → 重名时排到 week3-transcript-01-习题课.docx
   解析结果既用来预告「会存到哪」，也直接决定导入时的 course/week/label。 */
let COURSES = [], WEEKS = {};
async function loadCourses(){
  try {
    const j = await API.courses();
    if (j.ok){ COURSES = j.courses || []; WEEKS = j.weeks || {}; }
    dg('· 笔记目录：' + (COURSES.join(' / ') || '（读不到）'));
  } catch (e) { dg('· 课程目录读不到：' + e.message); }
}

function parseName(raw){
  const s = String(raw || '').trim();
  // 课程编号：MATH1101 / MATH 1101 / math1101a（默认按 4 字母 + 4 数字认）
  // ⚠ 后缀字母必须**紧贴**数字、且后面不能再跟数字。否则 "MATH1101 W3" 里的
  //   那个 W 会被当成 MATH1101W 的后缀，课程就解析错了。
  const cm = /([A-Za-z]{4})\s*(\d{4})([A-Za-z])?(?![0-9])/.exec(s);
  const course = cm ? (cm[1] + cm[2] + (cm[3] || '')).toUpperCase() : null;
  // 周次：W3 / w3 / week3 / 第3周。前面的负向断言是防止把 MATH1101 里的数字当成周次。
  let week = null, wmText = '';
  const wm = /(?:^|[^A-Za-z0-9])(?:week|wk|w)\s*0*(\d{1,2})(?![0-9])/i.exec(s);
  const cw = /第\s*0*(\d{1,2})\s*周/.exec(s);
  if (wm){ week = Number(wm[1]); wmText = wm[0]; }
  else if (cw){ week = Number(cw[1]); wmText = cw[0]; }
  // 区分词 = 去掉课程和周次之后剩下的
  let label = s;
  if (cm) label = label.replace(cm[0], ' ');
  if (wmText) label = label.replace(wmText, ' ');
  label = label.replace(/[\s\-_·／/]+/g, ' ').trim().slice(0, 40);
  return { course, week, label };
}

function renderTarget(){
  const el = $('foot-target');
  if (!el) return;
  const raw = $('course').value.trim();
  if (!API.canImport){
    // 单文件分享版：没有本机的笔记目录，这个框退化成「给这段录音起个名字」，
    // 名字只用于导出的文件名和文档标题。
    S.parsed = { course: null, week: null, label: raw.slice(0, 60) };
    el.className = raw ? 'ok' : '';
    el.textContent = raw ? '→ 导出为 ' + raw + '.docx' : '';
    return;
  }
  const p = parseName(raw);
  S.parsed = p;
  el.className = ''; el.textContent = '';
  if (!p.course && p.week == null && !$('course').value.trim()) return;
  if (!p.course){ el.textContent = '✗ 没认出课程编号（形如 MATH1101）'; el.className = 'bad'; return; }
  if (!COURSES.includes(p.course)){
    el.textContent = '✗ 没有「' + p.course + '」这门课（有的是 ' + COURSES.join(' / ') + '）';
    el.className = 'bad'; return;
  }
  if (p.week == null){ el.textContent = '✗ 没认出第几周（写成 W3 或 week3）'; el.className = 'bad'; return; }
  const w = Number(p.week);
  if (!(WEEKS[p.course] || []).includes(w)){
    el.textContent = '⚠ ' + p.course + '\\week' + w + ' 还没建这个文件夹，先去笔记目录里建好';
    el.className = 'warn'; return;
  }
  el.textContent = '→ ' + p.course + '\\week' + w + '\\week' + w + '-transcript.docx'
    + (p.label ? '（重名会排到 -01-' + p.label + '）' : '（重名会自动排号）');
  el.className = 'ok';
}

/** 导出与导入共用的数据包。两边同源，保证 md / docx / 归档内容一致。 */
function sessionPayload(){
  const p = S.parsed || {};
  const mm = Math.floor(S.elapsed / 60), ss = S.elapsed % 60;
  return {
    sessionId: S.sessionId, course: p.course || null, week: p.week, label: p.label || null,
    title: [p.course, p.label].filter(Boolean).join(' ') || '课堂转写',
    duration: `${mm} 分 ${ss} 秒`,
    paras: S.paras,
    // 总结一起带走——课后再看，顶上这几张卡就是整节课的骨架
    summaries: S.summaries.filter(c => !c.loading && !c.error).map(c => ({ t0: c.t0, t1: c.t1, ...c.data }))
  };
}
function downloadBlob(blob, name){
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u; a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { try { URL.revokeObjectURL(u); a.remove(); } catch (e) {} }, 2000);
}
function btnBusy(btn, on){ if (btn){ btn.disabled = on; btn.style.opacity = on ? '.5' : ''; } }

async function exportMd(){
  if (!S.paras.length) { toast('这节课还没有内容'); return; }
  btnBusy($('btn-md'), true);
  try {
    const j = await API.exportMd(sessionPayload());
    if (!j.ok) throw new Error(j.error || '导出失败');
    downloadBlob(new Blob([j.md], { type: 'text/markdown;charset=utf-8' }),
      String(j.file || 'transcript.md').split(/[\\/]/).pop());
    toast('已导出 md（也在 ' + j.file + ' 留了一份）', 'ok');
    dg('✓ 导出 md ' + j.file);
  } catch (e) { toast('导出失败：' + e.message, 'bad'); dg('✗ 导出 md 失败 ' + e.message); }
  btnBusy($('btn-md'), false);
}

async function exportWord(){
  if (!S.paras.length) { toast('这节课还没有内容'); return; }
  btnBusy($('btn-word'), true);
  try {
    const j = await API.exportDocx(sessionPayload());
    const name = (S.parsed && S.parsed.course ? S.parsed.course + '-transcript' : 'transcript') + '.docx';
    downloadBlob(new Blob([j.bytes],
      { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), name);
    toast('已导出 Word' + (j.saved ? '（也在 ' + j.saved + ' 留了一份）' : ''), 'ok');
    dg('✓ 导出 docx ' + (j.saved || ''));
  } catch (e) { toast('导出失败：' + e.message, 'bad'); dg('✗ 导出 docx 失败 ' + e.message); }
  btnBusy($('btn-word'), false);
}

async function importToNotes(){
  if (!S.paras.length) { toast('这节课还没有内容'); return; }
  const p = S.parsed || {};
  if (!p.course || p.week == null){
    toast('先在命名框写清课程和第几周，比如「MATH1101 W3 习题课」', 'bad');
    $('course').focus();
    return;
  }
  btnBusy($('btn-import'), true);
  try {
    const j = await API.importNotes(sessionPayload());
    if (!j.ok) throw new Error(j.error || '导入失败');
    toast('已存到　笔记目录\\' + j.rel, 'ok');
    dg('✓ 导入 ' + j.rel + '（' + j.bytes + ' 字节）');
    loadCourses();   // 目标周现在多了一份转写，重名计数会变
  } catch (e) { toast('导入失败：' + e.message, 'bad'); dg('✗ 导入失败 ' + e.message); }
  btnBusy($('btn-import'), false);
}

/* ============================================================ 听课记录
   用户要的是「以前的课能看到所有内容」：英文、中文、总结、答题，一样不少。
   做法**不是**另做一套渲染，而是把历史会话还原成和实时状态**同构**的数据，
   直接灌进 S.paras / S.summaries / S.answers，把现有渲染全部复用。
   代价是要先存一份现场，退出时再放回去（见 S.backup）。 */
function prettyName(h){
  if (!h) return '未命名';
  return [h.course, h.label].filter(Boolean).join(' ') || '未命名';
}
function histRowHTML(s, curId){
  const dur = Math.max(1, Math.round((new Date(s.last) - new Date(s.first)) / 60000));
  const day = String(s.date || '').slice(5).replace('-', '/');
  const t0 = new Date(s.first).toTimeString().slice(0, 5);
  const t1 = new Date(s.last).toTimeString().slice(0, 5);
  const missing = Math.max(0, s.paras - s.zh);
  return '<div class="hrow' + (s.id === curId ? ' cur' : '') + '" data-id="' + esc(s.id) + '">'
    + '<div class="h1"><span class="hn">' + esc(prettyName(s)) + '</span>'
    + '<span class="hd">' + day + ' ' + t0 + '–' + t1 + ' · ' + dur + ' 分钟</span></div>'
    + '<div class="hm">' + s.paras + ' 段 · ' + s.summaries + ' 张总结 · ' + s.answers + ' 次答题'
    + (missing ? ' · <span class="warn">' + missing + ' 段没译文</span>' : '')
    + '</div></div>';
}
function renderHist(list){
  const box = $('hist-list');
  $('hist-count').textContent = list.length ? list.length + ' 节课' : '';
  if (!list.length){
    box.innerHTML = '<div class="hempty">还没有记录。<br>上完一节课，这里就会出现那节课的全部内容。</div>';
    return;
  }
  const curId = S.history ? S.history.id : (S.backup ? S.backup.sessionId : S.sessionId);
  // 有一堆「未命名」时给一句提示，告诉用户怎么让以后能认出来
  const unnamed = list.filter(s => !s.course && !s.label).length;
  const tip = unnamed >= 3
    ? '<div class="htip">有 ' + unnamed + ' 节课没名字——下次上课前在顶栏命名框里写上课程和周次（如 <kbd>MATH1101 W3</kbd>），这里就能认出来了。</div>'
    : '';
  box.innerHTML = tip + list.map(s => histRowHTML(s, curId)).join('');
  // 用事件委托，不给每行单独挂 handler
  box.onclick = e => {
    let el = e.target;
    while (el && el !== box && !(el.dataset && el.dataset.id)) el = el.parentNode;
    if (el && el.dataset && el.dataset.id) loadSession(el.dataset.id);
  };
}
async function openHist(){
  $('hist').classList.add('on');
  $('hist-list').innerHTML = '<div class="hempty">正在读记录…</div>';
  dg('· 打开听课记录');
  let j = null;
  try { j = await API.sessions(); } catch (e) { dg('✗ 读记录失败：' + e.message); }
  if (!j || !j.ok){
    $('hist-list').innerHTML = '<div class="hempty">读不到记录。<br>'
      + esc((j && j.error) || '本地服务没有响应——确认 server 还在跑') + '</div>';
    return;
  }
  renderHist(j.sessions || []);
}
async function loadSession(sid){
  if (S.running){ toast('正在上课——先按空格暂停，再看以前的课'); return; }
  let j = null;
  try { j = await API.session(sid); } catch (e) { dg('✗ 打开记录失败：' + e.message); }
  if (!j || !j.ok){ toast('打不开这节课：' + ((j && j.error) || '服务没响应'), 'bad'); return; }
  const d = j.data;

  if (!S.backup) S.backup = {           // 第一次进历史：先把现场原样存起来
    sessionId: S.sessionId, startedAt: S.startedAt, elapsed: S.elapsed,
    paras: S.paras, summaries: S.summaries, answers: S.answers,
    stats: S.stats, pausedMs: S.pausedMs, seq: S.seq, hwm: S.promotedText,
  };
  S.history = { id: d.id, date: d.date, course: d.course, label: d.label, first: d.first, last: d.last };

  // 还原成和实时同构的形状，渲染层完全不用改
  S.paras = d.paras.map(p => ({ id: p.id, t0: p.t0, t1: p.t1, en: p.en, zh: p.zh, q: !!p.q, status: 'done' }));
  S.summaries = d.summaries.map((c, i) => ({ id: 'h' + i, t0: c.t0, t1: c.t1, loading: false, data: c }));
  S.answers = d.answers.map(a => ({
    question: a.question, say_en: a.say_en || [], say_zh: a.say_zh || [],
    angle_zh: a.angle_zh || '', ask_type: a.ask_type || 'open',
  }));
  S.seq = S.paras.length;
  S.hold = ''; S.holdSince = 0; S.interim = ''; S.interimAt = 0; S.promotedText = '';
  S.stats = { paras: S.paras.length, chars: 0, errs: 0,
              translated: S.paras.filter(p => p.zh).length, latSum: 0, latN: 0, answers: S.answers.length };
  S.elapsed = d.first && d.last ? Math.round((new Date(d.last) - new Date(d.first)) / 1000) : 0;

  $('hist').classList.remove('on');
  S.follow = true;
  renderAll(); renderSummary(); renderStats();
  showHistBar();
  dg('· 打开历史 ' + d.id + '（' + d.paras.length + ' 段 / ' + d.summaries.length + ' 张总结）');
}
function showHistBar(){
  const h = S.history;
  if (!h) return;
  const day = String(h.date || '').slice(5).replace('-', '/');
  const t0 = h.first ? new Date(h.first).toTimeString().slice(0, 5) : '';
  const t1 = h.last ? new Date(h.last).toTimeString().slice(0, 5) : '';
  $('histbar').innerHTML = '<span>📖 历史记录 · <b>' + esc(prettyName(h)) + '</b> · '
    + day + ' ' + t0 + '–' + t1 + ' · ' + S.paras.length + ' 段</span>'
    + '<span class="sp"></span>'
    + '<button id="hist-back">回到当前</button>';
  $('histbar').classList.add('on');
  $('hist-back').onclick = exitHistory;
}
function exitHistory(){
  if (!S.backup) return;
  Object.assign(S, S.backup);
  S.backup = null; S.history = null;
  $('histbar').classList.remove('on');
  S.follow = true;
  renderAll(); renderSummary(); renderStats();
  dg('· 回到当前会话');
}
/* 分享版没有服务端，历史只能存在浏览器里。本地版不需要（服务端本来就全记着），
   所以这里用 `API.saveSession` 是否存在来判断——两边同一份前端代码。 */
function historySnapshot(){
  if (!S.sessionId || !S.paras.length) return null;
  const p = S.parsed || {};
  const first = S.startedAt ? new Date(S.startedAt).toISOString()
    : new Date(Date.now() - S.elapsed * 1000).toISOString();
  return {
    id: S.sessionId, date: new Date().toISOString().slice(0, 10),
    course: p.course || null, label: p.label || null,
    first, last: new Date().toISOString(),
    paras: S.paras.map(x => ({ id: x.id, t0: x.t0, t1: x.t1, en: x.en, zh: x.zh || '', q: !!x.q })),
    summaries: S.summaries.filter(c => !c.loading && !c.error && c.data)
      .map(c => ({ t0: c.t0, t1: c.t1, topic_zh: c.data.topic_zh, points_zh: c.data.points_zh, terms: c.data.terms })),
    answers: S.answers.map(a => ({ question: a.question, angle_zh: a.angle_zh,
      ask_type: a.ask_type, say_zh: a.say_zh || [], say_en: a.say_en || [] })),
  };
}
let lastSnapshot = 0;
function saveHistorySnapshot(force){
  if (!API.saveSession || S.history) return;    // 看历史时别把历史存成历史
  const now = Date.now();
  if (!force && now - lastSnapshot < 120000) return;   // 两分钟存一次就够
  lastSnapshot = now;
  const snap = historySnapshot();
  if (!snap) return;
  try { API.saveSession(snap); dg('· 已在本机存档（' + snap.paras.length + ' 段）'); }
  catch (e) { dg('· 本机存档失败：' + e.message); }
}

/** 名字改了就在日志里记一笔——不然历史列表里全是「未命名」。
   用户实测就是开始前没填名字框，所以 session_start 里的 course 是 null。 */
let metaTimer = null;
function logSessionMeta(){
  clearTimeout(metaTimer);
  metaTimer = setTimeout(() => {
    if (!S.sessionId) return;
    const p = S.parsed || {};
    logEvent({ type:'session_meta', sessionId: S.sessionId,
               course: p.course || null, week: p.week || null, label: p.label || null });
  }, 1500);
}

/* ============================================================ 交互 */
$('btn-run').onclick = toggleRun;
$('btn-md').onclick = exportMd;
$('btn-word').onclick = exportWord;
$('btn-import').onclick = importToNotes;
$('course').addEventListener('input', () => { renderTarget(); logSessionMeta(); });
$('course').addEventListener('change', () => { renderTarget(); logSessionMeta(); });
$('a-close').onclick = closeAnswer;
$('a-regen').onclick = () => { if (S.answer) askAnswer(S.answer.forId); };
$('btn-hide').onclick = () => toggleHidden(true);
$('showbtn').onclick = () => toggleHidden(false);
$('btn-float').onclick = () => { toggleFloat().catch(e => dg('✗ 悬浮窗 ' + e.message)); };
$('btn-pin').onclick  = () => { togglePin().catch(e => dg('✗ 置顶 ' + e.message)); };
$('btn-rail').onclick = () => {
  const off = document.body.classList.toggle('norail');
  $('btn-rail').classList.toggle('on', !off);
  dg(off ? '· 右侧栏已收' : '· 右侧栏已展开');
};
$('btn-sum-now').onclick = () => {
  if (!S.sumBuf.length) { toast('还没有新内容可以总结'); return; }
  runSummary();
};
$('btn-log').onclick = () => $('diagwrap').classList.toggle('on');
$('btn-hist').onclick = () => { openHist().catch(e => dg('✗ 打开记录失败 ' + e.message)); };
$('hist-close').onclick = () => $('hist').classList.remove('on');
$('hist').addEventListener('click', e => { if (e.target === $('hist')) $('hist').classList.remove('on'); });
$('btn-close-diag').onclick = () => $('diagwrap').classList.remove('on');
$('btn-clear-diag').onclick = () => { S.diagLines = []; $('diag').textContent = '已清空'; };
$('btn-miccheck').onclick = micCheck;
$('btn-copy').onclick = async () => {
  const txt = `[课堂同传诊断 ${new Date().toLocaleString()}]\n` +
    `会话 ${S.sessionId} · 段落 ${S.stats.paras} · 已译 ${S.stats.translated} · 错误 ${S.stats.errs}\n` +
    `识别 ${SR ? '可用' : '不可用'} · 运行中 ${S.running}\n` +
    `输入设备 ${S.micLabel || '(还没读到)'}（${S.micCount || '?'} 支）\n` +
    (S.micDiag
      ? `电平 近讲 ${S.micDiag.near.toFixed(0)}dB / 远讲 ${S.micDiag.far.toFixed(0)}dB（${new Date(S.micDiag.at).toLocaleString()}）\n`
      : '电平 还没测过——「检查麦克风」测一次\n')
    + '\n' + S.diagLines.join('\n');
  try { await navigator.clipboard.writeText(txt); toast('诊断已复制到剪贴板', 'ok'); }
  catch (e) { $('diag').textContent = txt; toast('复制失败，诊断已显示在面板里', 'bad'); }
};
$('btn-zh').onclick = () => { S.show.zh = !S.show.zh; $('btn-zh').classList.toggle('on', S.show.zh); renderAll(); };
$('btn-en').onclick = () => { S.show.en = !S.show.en; $('btn-en').classList.toggle('on', S.show.en); renderAll(); };
/* ---- 左右栏宽度可调 ----
   拖动分隔条改宽度，两端 ‹ › 小步微调（课上不方便精确拖），双击复位。
   宽度存 localStorage，下次打开还是用户调好的。 */
const RAIL = { min: 240, max: 760, step: 40, def: 400 };
function setRail(w, silent){
  const v = Math.max(RAIL.min, Math.min(RAIL.max, Math.round(w)));
  S.rail = v;
  document.documentElement.style.setProperty('--rail', v + 'px');
  try { localStorage.setItem('cp-rail', String(v)); } catch (e) {}
  if (!silent) dg('· 右栏宽度 ' + v + 'px');
  const n = $('rail-narrow'), d = $('rail-wide');
  if (n) n.disabled = v <= RAIL.min;
  if (d) d.disabled = v >= RAIL.max;
}
(function initRail(){
  let saved = null;
  try { saved = Number(localStorage.getItem('cp-rail')); } catch (e) {}
  setRail(Number.isFinite(saved) && saved > 0 ? saved : RAIL.def, true);

  const sp = $('splitter');
  if (!sp) return;
  let dragging = false;
  const move = e => {
    if (!dragging) return;
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    setRail(window.innerWidth - x, true);      // 右栏宽度 = 视口宽 − 指针位置
    e.preventDefault();
  };
  const stop = () => {
    if (!dragging) return;
    dragging = false; sp.classList.remove('dragging');
    dg('· 右栏宽度 ' + S.rail + 'px');
  };
  sp.addEventListener('mousedown', e => {
    if (e.target.tagName === 'BUTTON') return;   // 点按钮时不进入拖拽
    dragging = true; sp.classList.add('dragging'); e.preventDefault();
  });
  sp.addEventListener('touchstart', e => {
    if (e.target.tagName === 'BUTTON') return;
    dragging = true; sp.classList.add('dragging');
  }, { passive: true });
  window.addEventListener('mousemove', move);
  window.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('mouseup', stop);
  window.addEventListener('touchend', stop);
  $('rail-narrow').onclick = () => setRail(S.rail - RAIL.step);
  $('rail-wide').onclick   = () => setRail(S.rail + RAIL.step);
  // 复位给一个看得见的按钮，而不是只靠双击 ——
  // mousedown 里 preventDefault() 会把 dblclick 压掉，双击在这条分隔条上不可靠。
  const rz = $('rail-reset');
  if (rz) rz.onclick = () => { setRail(RAIL.def); toast('右栏宽度已复位'); };
})();

/* ---- 字号：英文和中文各调各的 ----
   用户要英文小、中文大（中文才是用户读的那一行），所以不能绑在一起调。
   存 localStorage，下次打开还是用户调好的大小。 */
const FS = { en: { min: 12, max: 30, step: 0.5, def: 15.5 }, zh: { min: 14, max: 48, step: 1, def: 23 } };
function setFont(which, val, silent){
  const c = FS[which];
  const v = Math.max(c.min, Math.min(c.max, Math.round(val * 10) / 10));
  S.fs[which] = v;
  document.documentElement.style.setProperty('--' + which + '-size', v + 'px');
  const el = $(which + '-val');
  if (el) el.textContent = (v % 1 === 0) ? String(v) : v.toFixed(1);
  $('en-down').disabled = S.fs.en <= FS.en.min;
  $('en-up').disabled   = S.fs.en >= FS.en.max;
  $('zh-down').disabled = S.fs.zh <= FS.zh.min;
  $('zh-up').disabled   = S.fs.zh >= FS.zh.max;
  try { localStorage.setItem('cp-font', JSON.stringify(S.fs)); } catch (e) {}
  if (!silent) dg('字号 ' + which + ' = ' + v + 'px');
}
function nudgeFont(which, dir){ setFont(which, S.fs[which] + dir * FS[which].step); }
$('en-down').onclick = () => nudgeFont('en', -1);
$('en-up').onclick   = () => nudgeFont('en', +1);
$('zh-down').onclick = () => nudgeFont('zh', -1);
$('zh-up').onclick   = () => nudgeFont('zh', +1);
(function loadFont(){
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('cp-font') || 'null'); } catch (e) {}
  const en = saved && typeof saved.en === 'number' ? saved.en : FS.en.def;
  const zh = saved && typeof saved.zh === 'number' ? saved.zh : FS.zh.def;
  setFont('en', en, true); setFont('zh', zh, true);
})();
$('opt-record').onchange = () => {
  if (!$('opt-record').checked) { stopRecorder(); dg('● 录音关'); return; }
  // 单文件/扩展版都没有本地服务，startRecorder 里那个 POST /api/audio 是打不通的：
  // 勾了只会静默失败。更要紧的是它会**和识别抢同一支麦克风**（同一个设备两条客户端流），
  // 识别质量会掉——而识别才是这个 app 的正事。所以这里直接说清楚，不要装作能存。
  if (API.standalone){
    $('opt-record').checked = false;
    toast('这版存不下录音（没有本地服务可接），而且录音和识别同时用麦会降低识别质量。上课保持关闭更好。', 'bad');
    dg('· 单文件/扩展版：录音不可用，已自动取消勾选');
    return;
  }
  if (S.running) startRecorder();
};

document.addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
  if (e.key === 'Escape'){
    toggleHidden();
    if (!document.body.classList.contains('hidden') && typing) e.target.blur();
    e.preventDefault(); return;
  }
  if (typing) return;
  if (e.code === 'Space'){ e.preventDefault(); toggleRun(); }
  else if (e.key === 'Home' || (e.key === 'End')){
    S.follow = true; $('list').scrollTop = $('list').scrollHeight;
    $('foot-status').textContent = S.running ? '跟随中' : '待机';
    e.preventDefault();
  }
  else if (e.key === 'ArrowUp'){ S.follow = false; $('list').scrollTop -= 90; e.preventDefault(); }
  else if (e.key === 'ArrowDown'){ $('list').scrollTop += 90; e.preventDefault(); }
  else if (e.key === 'PageUp'){ S.follow = false; $('list').scrollTop -= $('list').clientHeight - 80; e.preventDefault(); }
  else if (e.key === 'PageDown'){ $('list').scrollTop += $('list').clientHeight - 80; e.preventDefault(); }
  // A = 短答（默认，几秒内能开口）；Shift+A = 长答（开 thinking，展开讲）
  else if (e.key === 'a' || e.key === 'A'){ askAnswer(null, e.shiftKey); }
  else if (e.key === 'p' || e.key === 'P'){ toggleFloat().catch(() => {}); }
  else if (e.key === 'h' || e.key === 'H'){ openHist().catch(() => {}); }
  else if (e.key === 'o' || e.key === 'O'){ togglePin().catch(() => {}); }
  else if (e.key === 'r' || e.key === 'R'){ $('btn-rail').click(); }
  else if (e.key === 'c' || e.key === 'C'){ $('btn-zh').click(); }
  else if (e.key === 'e' || e.key === 'E'){ $('btn-en').click(); }
  // 字号：英文 [ ]，中文 - =（- 和 = 挨着，好记）
  else if (e.key === '['){ nudgeFont('en', -1); }
  else if (e.key === ']'){ nudgeFont('en', +1); }
  else if (e.key === '-'){ nudgeFont('zh', -1); }
  else if (e.key === '='){ nudgeFont('zh', +1); }
});
window.addEventListener('beforeunload', () => {
  if (S.sessionId) logEvent({ type:'session_end', sessionId:S.sessionId, paras:S.stats.paras,
    chars:S.stats.chars, errors:S.stats.errs });
  flushLog(true);        // 页面要关了，只剩 keepalive 发得出去；同步发完剩下的
  saveHistorySnapshot(true);
});

/* ============================================================ 启动自检 */
(async function init(){
  dg('引擎 ' + (SR ? '可用' : '不可用(缺 SpeechRecognition)') + ' · isSecureContext=' + window.isSecureContext);
  // 上次测的电平结论跨会话留着：很少有人每次上课前都去点一次「检查麦克风」，
  // 但「上次收不到远场」这件事必须能在下次开始时提醒到。
  try {
    const m = JSON.parse(localStorage.getItem('cp-mic') || 'null');
    if (m && typeof m.far === 'number'){ S.micDiag = m; S.micLabel = m.label || ''; }
    S.micNagAt = localStorage.getItem('cp-mic-nag') || '';
  } catch (e) {}
  const rows = [];
  rows.push(['语音识别', SR ? '✅ 可用' : '❌ 不可用（换 Edge / Chrome）']);
  rows.push(['后台计时器', bgTickerNote()]);
  rows.push(['安全上下文', window.isSecureContext ? '✅' : '⚠️ 非 https/127.0.0.1 可能拿不到麦克风']);
  if (API.standalone){
    // 单文件分享版：没有本地服务，改成报它自己的配置状态
    const c = (API.config && API.config()) || {};
    rows.push(['运行方式', '📄 单文件版（不需要本地服务）']);
    rows.push(['模型服务', c.key ? '✅ ' + (c.model || '') : '⚠️ 还没填 API Key，点右上角「设置」']);
    rows.push(['术语表', '✅ ' + Object.keys(c.glossary || {}).length + ' 条']);
  } else {
    try {
      const h = await (await fetch('/api/health')).json();
      rows.push(['本地服务', '✅ ' + h.model]);
      rows.push(['术语表', '✅ ' + h.glossary_size + ' 条']);
    } catch (e){ rows.push(['本地服务', '❌ ' + e.message]); }
  }
  $('selfcheck').innerHTML = rows.map(r => `<div style="padding:4px 0">${r[0]}：${r[1]}</div>`).join('');
  for (const r of rows) dg('自检 · ' + r[0] + ' ' + r[1]);

  // 输入设备这一行单独补：enumerateDevices 要等权限，慢一点，别拖住整张自检表。
  // 没授权时 label 全是空串，报出来只会误导，所以那时干脆不报。
  (async () => {
    try {
      if (navigator.permissions && navigator.permissions.query){
        const p = await navigator.permissions.query({ name: 'microphone' });
        if (p.state !== 'granted') return;
      }
      const n = await probeDefaultMic();
      const el = $('selfcheck');
      if (!el || !n) return;
      const d = document.createElement('div');
      d.style.padding = '4px 0';
      d.innerHTML = '输入设备：' + (isVirtualMic(n) ? '❌ ' : '✅ ') + esc(n)
        + (S.micCount > 1 ? '（共 ' + S.micCount + ' 支，识别器只用默认的那支）' : '');
      el.appendChild(d);
    } catch (e) {}
  })();

  // 分享版没有本机的笔记目录，把相关控件收掉，命名框改成普通的录音命名
  if (!API.canImport){
    const bi = $('btn-import');
    if (bi){ bi.remove(); dg('· 单文件版：已隐藏「导入课程笔记」'); }
    const c = $('course');
    if (c){
      c.placeholder = '给这段录音起个名字';
      c.title = '起个名字，导出时用作文件名和文档标题';
    }
  } else {
    await loadCourses();    // 笔记目录：决定命名框能解析出什么
  }
  renderStats();
  renderTarget();
})();
