# 课堂同传 · Class Copilot

把「听不清、跟不上」的英文授课课堂，变成**能读**的课堂。

英文原文实时上屏（不到 1 秒），中文翻译晚几秒跟上。老师向全班提问时，那段会被标出来，
按一个键就给你一句能直接念出口的发言。浏览器扩展，装完点一下图标就能用。

A browser extension that puts real-time bilingual subtitles on screen during English-taught
lectures. The English transcript lands within a second; the Chinese translation follows a few
seconds later. When the lecturer puts a question to the room, press one key and you get something
you can actually say out loud.

![许可 MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Manifest V3](https://img.shields.io/badge/manifest-v3-brightgreen.svg)
![仅 Edge / Chrome](https://img.shields.io/badge/browser-Edge%20%7C%20Chrome-orange.svg)

![界面](docs/screenshot.png)

---

## English

### Why

The bottleneck in an English-taught lecture is rarely comprehension — it's **hearing**. Terms come
fast, some accents take a few weeks to tune into, and one missed sentence can cost you the next two
minutes. This extension turns the audio into text on screen, so the parts you missed become parts
you can simply read.

Chinese is the second line, not the first. English gives you *speed*; Chinese gives you *accuracy*
when a term or a whole clause doesn't land.

### Features

- **English transcript in under a second** — the browser's own speech recognition, streaming.
- **Chinese translation a few seconds behind** — batched 5–15 seconds at a time and sent with the
  previous four paragraphs as context, so terminology and pronouns stay consistent. It can afford to
  be slower than the English, because you only look at it when you need it.
- **Rolling summary cards** — every few minutes, the last stretch is condensed into a card in the
  side rail. After class, the cards are the skeleton of the lecture.
- **Speakable answers, on demand** — when a question is put to the room, that paragraph gets
  flagged. Press `A` for a short answer you can say immediately, `Shift+A` to expand. Built only
  from what was actually said in class; it will not invent experience you don't have.
- **Floating subtitle window** — pop the subtitles into their own always-on-top window and put it
  anywhere, including over full-screen slides.
- **Glossary** — 600+ terms across a dozen disciplines, forced through as fixed translations. Only
  the terms actually present in the current batch are sent, so the table can grow without costing
  anything per request. Edit it in the settings panel; add your own course's jargon.
- **Microphone diagnostics** — tells you which device the recognizer is actually using, and flags
  the classic silent failure where Windows is feeding it a loopback device (Stereo Mix) instead of
  the room.
- **One-key hide** — `Esc` collapses everything to a small pill. Useful in a seminar where a wall of
  text is not what you want on screen.
- **Export** — the whole lecture to Markdown or Word, summaries first.

### Install

Requires **Edge or Chrome** (speech recognition uses the Web Speech API, which Firefox and Safari
don't implement).

1. Download this repository (Code → Download ZIP, or `git clone`).
2. Open `edge://extensions` or `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select this folder.
5. Click the extension icon — the app opens in a tab. Pin it to the toolbar if you like.

On first run you'll be asked for an API key. The default endpoint is DeepSeek's:
register at `platform.deepseek.com`, create a key, and paste it in. A single lecture costs a few
cents. The key is stored in the extension's own storage and goes nowhere except the endpoint you
configured. Any Anthropic-compatible Messages API works — change the Base URL in settings, and the
extension will ask for permission for that origin at that moment.

### Keyboard

| Key | Action |
|---|---|
| `Space` | Start / pause |
| `A` | Generate a short answer (say it now) |
| `Shift`+`A` | Generate a longer answer (takes a few seconds more) |
| `P` | Floating subtitle window |
| `O` | Toggle always-on-top |
| `H` | Past lectures |
| `R` | Collapse the side rail |
| `Esc` | Hide everything (press again to come back) |
| `↑` `↓` `PgUp` `PgDn` | Scroll back |
| `Home` | Jump to the latest |
| `C` / `E` | Toggle Chinese / English |
| `[` `]` | English font size |
| `-` `=` | Chinese font size |

### Accuracy is mostly a microphone problem

If the transcript is turning into nonsense, the problem is almost always the audio, not the model.
Laptop microphones at the back of a lecture hall simply do not deliver enough signal-to-noise.

Open **日志 → 检查麦克风** in the app. It shows which device is in use and measures two levels:

| Peak at 50 cm | What it means |
|---|---|
| > −18 dB | Microphone is fine — look elsewhere |
| −35 to −18 dB | Too quiet. Sit closer, or raise the input level |
| < −35 dB | Essentially no signal. Recognition will produce garbage |

Sitting in the front three rows plus a cheap USB omnidirectional microphone changes everything.
The panel also warns you when the default input is a **loopback device** — that one is fatal and
completely invisible in the subtitles, because the recognizer hears what the computer is playing
rather than the room.

### Privacy

The API key stays in the extension's own storage. Nothing is sent to any server other than the
model endpoint you configure, and there is no analytics, no telemetry, no account.

Be aware, though: **both speech recognition and translation are online.** Recognition runs on the
browser vendor's servers (Microsoft for Edge, Google for Chrome); translation runs on your model
endpoint. Lecture content therefore reaches both. Recording a lecture has its own rules in some
places — worth checking before you rely on this.

### Project structure

| File | What it is |
|---|---|
| `manifest.json` | Extension manifest (MV3) |
| `sw.js` | Service worker — opens or refocuses the app tab |
| `app.html` | UI shell and styles |
| `01-core-api.js` | Prompts and JSON contracts, the zero-dependency `.docx` writer, and the request/parse layer |
| `02-app.js` | The front end: subtitles, recognition scheduling, translation batching, answers, floating window |
| `03-settings.js` | Settings panel — model config and glossary |
| `04-ext-boot.js` | Extension-specific wiring: origin permission requests, self-check labelling |

MV3 forbids inline scripts, which is why the logic is split across four files loaded in order.

### Development

There is no build step. The files in this repository *are* the extension — edit them and reload the
extension from `edge://extensions`.

`test/smoke.mjs` loads the extension into Edge for real (headless) and checks the parts you can't
check from a plain page: that the manifest is valid, the service worker starts, the four scripts run
under MV3's CSP, the extension APIs are reachable, the UI boots, the glossary filters correctly, and
the microphone diagnostics recognise a loopback device. It also regenerates the screenshot above.

```bash
node test/smoke.mjs
```

It needs Edge installed; point `CP_EDGE` at `msedge.exe` if yours is elsewhere.

### Design notes

**The English line is real-time; the Chinese line is asynchronous.** The tempting alternative is to
delay the whole stream by ten seconds so every sentence can be translated in full. That's backwards:
the sentence you missed was spoken seconds ago, and in a delayed stream it hasn't appeared yet. Two
independent lines — one for speed, one for accuracy — and neither blocks the other. Because the
Chinese can afford to lag, it can be a large model with context and terminology handling instead of
a latency-chasing streaming call.

**A paragraph is the only unit of alignment.** English and Chinese hang off the same object, so the
two never drift apart. The Chinese simply arrives later and fills in.

**Timers run in a Web Worker.** Browsers throttle `setTimeout` in hidden tabs to roughly once per
second, and to once a minute after five minutes hidden — which breaks paragraph flushing,
translation scheduling and stall detection. Measured here: a 20 ms main-thread timer drops to
1.2 ticks/second when hidden; the same timer in a Worker stays above 60.

**The recognizer can die silently** — no error, no `onend`, just no more results. So there's a
watchdog that forces a restart after a minute of silence, plus a faster path when the tab regains
visibility.

**The floating window is two window types, not one with a toggle.** Picture-in-Picture is always on
top and has no toggle; a normal popup is not on top, and also has no toggle. So you get both, and a
button that switches between them.

### License

MIT — see [LICENSE](LICENSE).

---

## 中文

### 它解决什么

英文授课的课上，卡住你的通常不是**理解**，是**听**。术语一个接一个，老师的口音要几周才顺耳，
漏掉一句可能就丢掉后面两分钟。这个扩展把声音变成屏幕上的文字——没跟上的那些，直接读就行。

中文是第二行，不是第一行。英文给**速度**，中文给**准确度**：某个术语或整句没听懂时再看它。

### 功能

- **英文原文不到 1 秒上屏** —— 用浏览器自带的语音识别，流式。
- **中文翻译晚几秒** —— 一次攒 5–15 秒的量，带着前 4 段的原文和译文一起发，术语和指代前后一致。
  它可以慢，因为你只在需要时才看它。
- **滚动小结** —— 每隔几分钟把刚才那段整理成一张卡片，堆在右侧栏。课后再看，就是整节课的骨架。
- **要就能说的发言** —— 老师向全班提问时，那段会被标出来。按 `A` 出短答（几秒内能开口），
  `Shift+A` 出长答。弹药只来自课堂里真讲过的内容，不会编造你没有的经历。
- **悬浮字幕窗** —— 把字幕单独弹一个窗口，可以放到任何位置，包括盖在全屏课件上。
- **术语表** —— 600 多条，横跨十几个学科，表里有的强制按表翻。只挑**当前这批文本里真出现**的词
  发过去，所以表加多大都不会增加每次请求的开销。设置面板里直接改，把自己课上的黑话加进去。
- **麦克风诊断** —— 告诉你识别器实际在用哪一支，并且会揪出那个隐形的致命故障：
  Windows 把环回设备（立体声混音）当成默认输入。
- **一键隐藏** —— `Esc` 收成一个小胶囊。研讨课上不想满屏文字时很管用。
- **导出** —— 整节课导出成 Markdown 或 Word，小结排在最前面。

### 安装

需要 **Edge 或 Chrome**（语音识别走 Web Speech API，Firefox 和 Safari 没有）。

1. 下载本仓库（Code → Download ZIP，或 `git clone`）。
2. 打开 `edge://extensions` 或 `chrome://extensions`。
3. 打开**开发人员模式**。
4. 点**加载解压缩的扩展**，选中这个文件夹。
5. 点扩展图标，应用会在新标签页打开。可以固定到工具栏。

第一次打开会让你填 API Key，默认走 DeepSeek：去 `platform.deepseek.com` 注册、建一个 key、
粘进去。一节课几毛钱。key 只存在扩展自己的存储里，除了你配置的那个端点不发往任何地方。

任何兼容 Anthropic Messages API 的端点都能用——在设置里改 Base URL，扩展会当场申请那个域名的权限。

### 快捷键

| 键 | 干什么 |
|---|---|
| `空格` | 开始 / 暂停 |
| `A` | 生成短答（马上能念） |
| `Shift`+`A` | 生成长答（多等几秒，展开讲） |
| `P` | 悬浮字幕窗 |
| `O` | 置顶 / 取消置顶 |
| `H` | 听课记录 |
| `R` | 收起右侧栏 |
| `Esc` | 一键隐藏（再按回来） |
| `↑` `↓` `PgUp` `PgDn` | 回看 |
| `Home` | 回到最新 |
| `C` / `E` | 单独开关中文 / 英文 |
| `[` `]` | 调英文大小 |
| `-` `=` | 调中文大小 |

### 准不准，八成看麦克风

字幕变成通篇胡话时，问题几乎总在音频，不在模型。笔记本内置麦在教室后排的信噪比根本不够。

打开应用里的 **日志 → 检查麦克风**，它会显示当前用的是哪一支，并测两个电平：

| 50 厘米处的峰值 | 说明 |
|---|---|
| > −18 dB | 麦克风够用，问题在别处 |
| −35 ~ −18 dB | 声音偏小，坐近点或调高输入音量 |
| < −35 dB | 基本没收到声音，识别必然全是乱码 |

坐前三排 + 一个便宜的 USB 全向麦，差别非常大。面板还会在默认输入是**环回设备**时警告你——
那个是致命的，而且从字幕上完全看不出来，因为识别器听到的是电脑在放什么，不是老师在讲什么。

### 隐私

API Key 只存在扩展自己的存储里。除了你配置的模型端点，不向任何服务器发送任何东西；
没有统计、没有埋点、没有账号。

但要知道：**识别和翻译都要联网**。语音识别走浏览器厂商的服务器（Edge 走微软、Chrome 走谷歌），
翻译走你配的那个模型端点。也就是说课堂内容会到这两个地方。另外上课录音在有些地方是有规定的，
值得先确认一下。

### 目录结构

| 文件 | 是什么 |
|---|---|
| `manifest.json` | 扩展清单（MV3） |
| `sw.js` | Service worker —— 打开或切回应用标签页 |
| `app.html` | 界面骨架与样式 |
| `01-core-api.js` | prompt 与 JSON 契约、零依赖的 `.docx` 生成器、拼请求 / 解析返回 |
| `02-app.js` | 前端主体：字幕、识别调度、翻译批处理、答题、悬浮窗 |
| `03-settings.js` | 设置面板 —— 模型配置与术语表 |
| `04-ext-boot.js` | 扩展专属接线：域名授权、自检面板标注 |

MV3 禁止内联脚本，所以逻辑拆成四个文件按序加载。

### 开发

**没有构建步骤。** 仓库里这些文件就是扩展本身，改完在 `edge://extensions` 里点一下重新加载即可。

`test/smoke.mjs` 会把扩展**真的加载进 Edge**（无头），检查那些在普通网页里测不到的东西：
manifest 合不合法、service worker 起不起得来、四个脚本在 MV3 的 CSP 下能不能跑、
扩展 API 拿不拿得到、界面起不起得来、术语表筛得对不对、麦克风诊断认不认得出环回设备。
顺带重新生成上面那张截图。

```bash
node test/smoke.mjs
```

需要本机装了 Edge；装在别处就设 `CP_EDGE` 指向 `msedge.exe`。

### 几个设计取舍

**英文实时、中文异步。** 另一种做法是让整条字幕流落后十秒，好让每句话都拿到完整翻译。
方向是反的：你没跟上的那句话是几秒前说的，整体延迟的话它**还没显示**。
两条独立的线，一条给速度、一条给准确度，互不阻塞。中文能慢，才有余量上大模型、
带上下文、按术语表精翻，而不是抢延迟做流式。

**段落是唯一的对齐单元。** 英文和中文挂在同一个对象上，两栏不会错位。中文晚到，到了补上。

**计时器跑在 Web Worker 里。** 浏览器会把隐藏标签页的 `setTimeout` 节流到约 1 次/秒
（隐藏满 5 分钟再降到约 1 次/分钟），落段时机、翻译调度、假死检测全都会垮。
本项目实测：主线程 20ms 计时器前台 50 次/秒、后台掉到 1.2；同样的计时器放进 Worker，
后台仍有 60 次以上。

**识别引擎会静默假死** —— 不报错、也不触发 `onend`，就是再也不出结果。所以有一个看门狗，
超过一分钟没有任何结果就强制重启；切回标签页时还有一条更快的通路。

**悬浮窗是两种窗口，不是一种加开关。** 画中画天生永远置顶、没有开关；普通弹窗不置顶、
也没有开关。所以两种都给，用一个按钮互切。

### 许可

MIT，见 [LICENSE](LICENSE)。
