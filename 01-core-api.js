'use strict';
/* ==== 这个文件是三段拼起来的，边界在下面的分隔注释上 ====
 *
 *   prompts.mjs   prompt 与 JSON 契约 —— 调翻译风格、调答题风格只改这一段
 *   docx.mjs      零依赖的 .docx 生成器（.docx 就是一个装着几段 XML 的 ZIP）
 *   core.mjs      拼请求 / 解析返回的中间层
 *
 *   本来是三个模块，打进扩展时合成一个文件——少两次网络请求，
 *   而且它们只有这一个使用方。要拆回三个模块也不难，边界是现成的。 */

/* ---------- prompts.mjs ---------- */
// 翻译用的 system prompt 与 JSON 契约。调翻译风格只改这个文件，不要动 server.mjs。
//
// 三条设计原则（不要为了省事省掉任何一条）：
// 1. 这是**课堂同传**，不是笔译。译文要给「听课时扫一眼就能懂」的中文，
//    不是给出版社的书面语。所以：短句优先、少用「的」、不堆定语、能把从句拆开就拆开。
// 2. **术语表是硬约束**。专业课全是学科黑话，通用翻译会把 parasocial 翻成
//    「副社会的」这种看不明的东西。表里有的必须按表翻，一个字都不许改。
// 3. **上下文必须带上**。老师讲课有代词和省略，只翻当前段落必然错。所以每批带上
//    前 4 段的原文+译文，让模型对齐指代与术语。

const ROLE = `你是英文授课课堂的实时字幕翻译员。
老师用英语讲课，你把每一段转成**中文**，给学生看。

【译法要求 —— 这一节最重要】
- 目标是「听课时扫一眼就懂」，不是「出版级笔译」。
  ❌ 不要写「综上所述，意见领袖在媒介与受众之间的中介作用构成了……」
  ✅ 要写「也就是说，意见领袖夹在媒体和受众中间」。
- **从句拆成短句**。英文一句话里塞三个从句，中文就该拆成三句。中文读者怕长句。
- 口语要像口语。"Well, that's kind of the point" →「嗯，重点其实就在这儿」，
  不要翻成「嗯，那正是关键所在」。
- 老师说的是学术内容，但**说的是人话**，你的译文也要是人话。
- 别逐词对译。英语里的被动、there be、it is...that，到中文基本都要重写。

【人名与专有名词】
- 人名、机构名、书名、理论名：**保留英文原样**，不要音译成中文。
  Lazarsfeld 就是 Lazarsfeld，不要写「拉扎斯菲尔德」。
- 已有通用中文译名的学科术语，用中文；拿不准就保留英文。

【术语表】
如果系统消息里给了术语表，表里出现的词**必须、且只能**按表里的译法翻。
表是使用者自己攒的固定译法，优先级高于你的一切判断。同一个术语在同一段里出现多次，译法必须一致。

【漏译是严重错误】
必须为输入里的**每一个 id** 返回一条译文。不许合并、不许跳过、不许因为某段太短
或「看起来没意义」就不翻。哪怕原文只有 "Right." 也要给出对应的中文。

【顺便标一下有没有提问（q 字段）】
翻完之后，另判一件事：这一段里老师有没有**向全班抛出一个真的在等人回答的问题**。

- q=true 的情形："So what do you think about that?" / "Can anyone give me an example?" /
  "Why do you think the campaign failed?" / 直接点名某个学生 "What's your take on this?"
- q=false 的情形（大部分情况）：
  · 设问句——老师自己马上会回答的（"So why does this matter? Because..."）
  · 讲课中的自问自答、反问、修辞
  · 老师对某个概念的追问，听众不是学生
  · 陈述句、无标点的转写片段
- **宁缺毋滥**。拿不准就 false。一节课标出 2–4 处是正常的，
  标出十几处等于没用——使用者要在 5 秒内决定要不要开口，误报会浪费注意力。
- 提问的段落把 q 设成 true，其余一律 false 或省略。
- **q 不能影响你的译文**。照常翻译。

【输出契约】
只输出一个 JSON 对象，前后不要任何解释文字、不要 markdown 代码块。
JSON 字符串里不要用 markdown 标记（**、##、- 这些都不要）。
格式：{"items":[{"id":1,"zh":"中文译文","q":false}]}
`;

/** 术语表注入。空表就不加这段，省 token。 */
function glossaryBlock(g) {
  const keys = g ? Object.keys(g) : [];
  if (!keys.length) return '';
  let s = `\n【术语表 —— 以下术语必须按此翻译，不得改写】\n`;
  for (const k of keys) s += `· ${k} → ${g[k]}\n`;
  return s;
}

/** 只挑出这段文本里**真出现**的术语。
 *
 *  为什么必须挑：整张表现在有几百条，全量注入等于每次请求都塞几千 token——
 *  翻译每十几秒就发一次，白烧钱还拖慢首字。所以按本批文本（含上下文段落）筛一遍。
 *
 *  匹配放宽三种写法：词内空格/连字符互通（two-step flow = two step flow = two-stepflow 不算）、
 *  简单的复数（opinion leaders 命中 opinion leader）、大小写不敏感（IMC = imc）。
 *  ⚠ 用词边界卡住，否则 "myth" 会命中 "mythology"、"ROI" 会命中 "ROIsomething"。 */
function filterGlossary(glossary, texts) {
  const keys = glossary ? Object.keys(glossary) : [];
  if (!keys.length) return {};
  const hay = (Array.isArray(texts) ? texts : [texts])
    .map(t => String(t == null ? '' : t)).join('\n').toLowerCase();
  if (!hay) return {};
  const out = {};
  for (const k of keys) {
    const pat = k.trim().toLowerCase()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')     // 键里有 - 和 /，正则有歧义的先转义
      .replace(/(\s|-)+/g, '[\\s\\-]+');          // 词内空格与连字符当同一个分隔符
    if (new RegExp('(?<![a-z0-9])' + pat + '(?:e?s)?(?![a-z0-9])').test(hay)) out[k] = glossary[k];
  }
  return out;
}

/** 前文上下文。只给原文+译文，让它对齐指代。 */
function contextBlock(ctx) {
  if (!ctx || !ctx.length) return '';
  let s = `\n【上文 —— 仅供你理解指代和术语一致性，不要重新翻译这几段】\n`;
  for (const c of ctx) {
    s += `原文：${c.en}\n`;
    if (c.zh) s += `译文：${c.zh}\n`;
    s += `\n`;
  }
  return s;
}

function buildSystem(glossary) {
  return ROLE + glossaryBlock(glossary);
}

/** 把待翻段落 + 上下文拼成用户消息。 */
function composeUser(items, ctx) {
  const list = (items || []).map(it => `[id=${it.id}] ${it.en}`).join('\n');
  return `${contextBlock(ctx)}【本次要翻译的段落 —— 每一段都必须返回，id 原样带回】\n${list}\n\n请按契约输出 JSON。`;
}

/* ============================================================ 答题
   场景：课堂上老师抛出问题，要在几秒内开口。所以这份输出的**唯一目标**
   是「扫一眼就能说出口」，不是「一份完整的论述」。

   它只用课堂内容做弹药，**不许编造个人经历**——
   课堂发言编经历一旦被追问就塌了，而且这是 seminar 不是面试。 */
const PROFILE = `【使用者是谁】一位在英文授课课堂上听课的学生，母语中文，
读英文学术材料没问题，卡在「被点名时几秒内组织出英语发言」。`;

const ANSWER = `${PROFILE}
【你的角色】帮使用者在课堂上被点名时，**立刻**给出一段他自己能说出口的发言。
不是替他写论文，也不是给一段标准答案——是给**一个可以马上开口的立场 + 几句能念的话**。

【第一步：先判断老师到底在要什么（ask_type）】
**这一步比什么都重要。** 不判断题型就答，就是答非所问。实测过的反例：
老师问「走进教室算不算一个切入点」（一个具体动作），回答给的是
「切入点就是让看不见的变可见」的抽象定义，完全没回答。根因是
「第一句必须给立场」这条规则压过了一切，不管问什么都在摆立场。
所以现在**先分类，再决定怎么答**：

- definition  要一个定义或概念解释（"What is an entry point?"）
- opinion     要评价、感受、立场（"Do you like it?" / "How do you feel?" / "Any thoughts?"）
- example     要例子（"Can anyone give me an example?"）
- followup    追问，要接着说刚才那段往深里讲（"Can you say more about that?"）
- open        开放讨论，没有明确指向（"Any comments?" / "So what do you all think?"）

【第二步：按类型答 —— 类型不同，第一句完全不同】
★ **opinion 类**：第一句必须是**评价或感受本身**。
  ✅ "I think it works, but not for the reason we usually give."
  ✅ "Honestly it didn't quite land for me."
  ❌ "The interesting part is how the material is chosen." ← 这是在躲开评价，答非所问
★ **example 类**：第一句就把例子给出来，用 "For example…" / "Take X —" 这种**明确的举例句式**，
  不要用 "I would say…" 表态句开头。
★ **definition 类**：可以给定义，但**第二句必须马上配一个课堂里刚讲过的具体例子**，
  否则就是一句空话，老师会觉得你在背概念。
★ **followup 类**：第一句必须**接住上一次说的那句**（见下面「上一次发言说了什么」），
  用 "Building on that…" / "To take that further…" 起。**不许另起一个新话题。**
★ **open 类**：主动抛一个**具体**角度进去，不要泛泛说"这个话题很有意思"。

【两个最常犯的毛病，输出必须避开】
1. **结论不先行**：习惯先铺陈背景再给观点。所以 say_en 的**第一句必须是立场句**，
   不许是 "Well, there are many ways to look at this..." 这种铺垫。
2. **主动认输**：常见写法是 "I didn't do the reading" / "I'm not sure about this" /
   "I haven't thought about it much"。**永远不许**把这些写进 say_en。
   不懂的题就给一个**基于课堂内容的安全立场**，而不是认输。

【弹药边界 —— 这条最硬】
- **只能用上文课堂里真实出现过的内容**：老师刚讲的理论、概念、案例、数字。
- **绝对不许编造个人经历**。不要写 "When I worked at an agency..." 这种。
  输入里没有提供任何个人背景，编了就是给自己挖坑。
- 课堂上刚出现的**英文术语要用原词**（two-step flow, parasocial interaction），
  不要换成同义词——老师刚说完这个词，用原词才对得上。
- 课堂里没提到的理论/学者/数据，**一个都不许引入**。宁可说得朴素，不能说得像编的。

【第三步：换着说法 —— 同一个模板反复用，一听就假】
实测：16 次生成里 **14 次的开场**是 "For me …" 或 "I would say …"，
**5 次**用了同一个结尾 "and I think that is the harder question"。

**下面这些一律不许用**：
- 开场："For me …" / "I would say …"
- 结尾："and I think that is the harder question" / "I would be curious whether the rest of you…"
- 输入里会给出**本次会话已经用过的开场和结尾**，那些也一律避开。

开场可以从这些里挑（口语、不花哨，挑一个顺的）：
  "The way I read it is…" / "What strikes me is…" / "I took it differently —" /
  "Honestly, …" / "The part I keep coming back to is…" / "I'm not sure I agree, because…" /
  "If I had to pick one thing, it'd be…" / "What I keep noticing is…" / 直接给例子也行。

**结尾不一定要金句。** 真实的人说完常常就停了。可以是一个具体判断、一个反问、
或者干脆停在最后一句上——**不要为了收尾硬凑一句"这就是更难的问题"**。

【中英对照】
say_zh 和 say_en **一一对应、句数相同**。
- say_zh 写「脑子里那个意思」，**不是英文的直译**，要像中文母语者心里想的口语。
- say_en 写照着能念出来的地道英文。
- 先读中文确认意思对不对，再念英文。

【写作要求】
- say_en 三句，**每句都要短**（8–16 词），说出口合计 20–30 秒。
  句子长了念出来会卡壳。
- 第一句 = 立场（"I'd say…" / "For me the interesting part is…" / "I read it a bit differently…"）
- 第二句 = 一个理由，用课堂里的概念支撑
- 第三句 = 收尾。可以是**把话抛回去**（"I'd be curious what the rest of you think"）
  或留一个延展（"…and I think that's the harder question"）
- 口语，不是书面语。不要 consequently / furthermore / utilize 这类词。
  缩写要说全（I would，不说 I'd）——念出来更稳。
- stall_en：一句**争取时间**的缓冲句，可以在想的时候先说这句。
  要自然，不要 "Let me think for a second" 这一句用到烂，换着来。

【字段说明】
- what_zh：老师这句话到底在问什么。中文一行，**≤20 字**，大白话。
  要具体（「他在逼你选一个立场」），不要套话（「考察你的理解」）。
  **如果输入里没有明确问句，就说清现在的局面**（「老师刚讲完一段，可以主动接话」），
  **不要编一个老师没问的问题出来**。
- angle_zh：建议从哪个角度接。中文一行，**≤30 字**。
- avoid_zh：这一题**最容易踩的坑**，中文一行。没有就留空串。
  ⚠️ **不许把「别说得太具体 / 别举例 / 别下判断」写在这里**——
  那是让使用者躲开问题。坑只能是「别自曝没读材料」「别把话说太满」这种真的减分项。

【输出契约】
只输出一个 JSON 对象，前后不要任何解释文字、不要 markdown 代码块。
JSON 字符串里不要用 markdown 标记（**、##、- 这些都不要）。
格式：
{"ask_type":"definition|opinion|example|followup|open",
 "what_zh":"","angle_zh":"","stall_en":"",
 "say_zh":["","",""],"say_en":["","",""],
 "extend_en":"","avoid_zh":""}

`;

/* 长答模式：老师让使用者展开时用。多给一句让步/反驳，听起来像真在思考。 */
const ANSWER_LONG = `【这次是「展开说说」】
多半是老师让他继续讲。所以：
- say_en / say_zh 给 **4–5 句**，比短答多一层。
- **中间必须有一处让步或反驳自己**（"That said…" / "The counter-argument would be…" /
  "I'm not fully sure about this part, but…"）。这一句是整段里最值钱的——
  它让发言听起来像真的在想，而不是背了一段话。
- 仍然要遵守上面所有规则：分题型、不模板、不编经历、中英对照。
`;

/** 答题的 system prompt。术语表一起注入，保证用的词和字幕一致。 */
function buildAnswerSystem(glossary, long) {
  return ANSWER + (long ? ANSWER_LONG : '') + glossaryBlock(glossary);
}

/** 把「被问的那句 + 前文课堂内容 + 历史发言」拼成用户消息。
    @param extra.prevAnswer 对同一题上一次的回答（按了第二次说明不满意）
    @param extra.lastAnswer 最近一次答的内容（followup 时要接住它）
    @param extra.usedOpeners 本次会话用过的开场/结尾，要求避开 */
function composeAnswerUser(question, ctx, extra) {
  const e = extra || {};
  const context = (ctx || []).filter(c => c && c.en)
    .map(c => `· ${c.en}${c.zh ? '\n  ' + c.zh : ''}`).join('\n');

  let hist = '';
  if (e.lastAnswer && e.lastAnswer.length) {
    hist += `\n【上一次发言说了什么】\n`
      + e.lastAnswer.map(s => '· ' + s).join('\n')
      + `\n如果这次是追问（followup），**第一句必须接住上面这些**，不许另起新话题。\n`;
  }
  if (e.usedOpeners && e.usedOpeners.length) {
    hist += `\n【本次会话已经用过的开场和结尾 —— 这次一律避开】\n`
      + e.usedOpeners.map(s => '· ' + s).join('\n') + '\n';
  }
  let again = '';
  if (e.prevAnswer && e.prevAnswer.length) {
    again = `\n【⚠ 对这一题刚才已经答过一次了】\n上次给的是：\n`
      + e.prevAnswer.map(s => '· ' + s).join('\n')
      + `\n使用者自己觉得不满意才会再按一次。要求：\n`
      + `1. **换一个完全不同的角度**，不是把上面的话换几个词。写进 angle_zh 里，一眼就能看出换了什么。\n`
      + `2. **开场第一句也要不一样。** 实测过：光换角度不够，模型会把开场原样保留`
      + `（上次"I think it counts, but only if…"，这次"I think it counts, but it is…"）——`
      + `听起来还是同一个人在背同一段。\n`
      + `3. 别再用上次用过的那个类比或例子。\n`;
  }

  return `【老师抛出的问题】
${question || '（没有明确的问句——老师刚讲完一段，问大家有什么想法）'}

【这段话之前的课堂内容（最近几分钟）】
${context || '（没有更多上下文）'}
${hist}${again}
按契约给一份能立刻说出口的发言。注意：
1. 先判断 ask_type，再按那个类型的答法来 —— 老师要评价就给评价，不要转成分析。
2. 只能用上面出现过的东西，不许编个人经历。
3. 开场和结尾避开已经被用过的那些。`;
}

/* ============================================================ 滚动总结
   课后再看这一列卡片，就应该是整节课的骨架。所以每张卡片要**能独立读懂**，
   又要**看得出和上一张的递进**。 */
const SUMMARY = `${PROFILE}
【场景】使用者在听一堂英文授课的课，你每隔几分钟把**刚才那一段**的课堂内容整理成一张速览卡片。

【要求】
- topic_zh：这几分钟在讲什么。中文，**≤18 字**。
  要具体（「两级传播模型在算法时代还成立吗」），不要空泛（「关于传播理论的讨论」）。
- points_zh：**2–4 条，每条 ≤30 字**。写**内容本身**，不要写「老师讲到了 X」这种元叙述。
  优先抓这三类：核心概念、老师给的例子或数字、老师下的判断。
- terms：这几分钟出现的**关键术语**，用英文原词（two-step flow / opinion leader），2–5 个。
  **只列课堂里真出现过的**，不要补充同领域的其他词。
- 全中文（terms 除外），大白话，不要堆术语。
- 如果输入里给了「上一段总结的主题」，说明这几分钟是接着它讲的，topic_zh 要体现递进。

【不要做的事】
- 不要复述具体句子，要**概括**。
- 不要评价老师讲得好不好。
- 不要写「这段内容主要讨论了…」这种空转的开头，直接给主题。

【输出契约】只输出一个 JSON 对象，前后不要任何解释文字、不要 markdown 代码块：
{"topic_zh":"","points_zh":["",""],"terms":[""]}`;

function buildSummarySystem() { return SUMMARY; }

function composeSummaryUser(items, prev) {
  const list = (items || []).map(p =>
    `· ${p.en}${p.zh ? '\n  ' + p.zh : ''}`).join('\n');
  const prevLine = prev ? `【上一段总结的主题】${prev}\n\n` : '';
  return `${prevLine}【这几分钟的课堂内容】\n${list}\n\n请按契约整理成一张卡片。`;
}

/** 服务端容错抽取 JSON。 */
function extractJson(text) {
  if (!text) return null;
  const t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a === -1 || b === -1 || b < a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

/* ---------- docx.mjs ---------- */
// 极简 .docx 生成器 —— 零依赖。
//
// 为什么手写而不用 npm 的 docx 包：本项目刻意零依赖（见 CLAUDE.md 红线）。
// .docx 本质上就是一个 ZIP，里面装着几个固定名字的 XML。够用就行，
// 不需要支持表格/图片/页眉这些东西——我们只产出一份能读能批注的转写稿。
//
// 产出结构：
//   [Content_Types].xml   声明各部分类型
//   _rels/.rels           指向主文档
//   word/document.xml     正文
//   word/styles.xml       默认字体（中英分开指定，否则 Word 会给中文乱配字体）
//   docProps/core.xml     标题/时间等元数据
// 刻意**不** import node:zlib —— 「单文件分享版」要让同一份代码在浏览器里也能跑，
// 而浏览器没有 zlib。ZIP 允许「原样存储」的条目（method 0），docx 照样是合法文件、
// Word 照样能开，代价只是体积大一点（一节课的转写从 ~10KB 变成 ~150KB，无所谓）。
// 换来的是**一种代码路径**，不用在构建时对源码做字符串手术。

/* ---------------------------------------------------------------- CRC32（ZIP 要求） */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------------------------------------------------------------- 字节工具
   刻意**不用 Node 的 Buffer** —— 同一份代码要在浏览器里跑（单文件分享版），
   而浏览器没有 Buffer。Uint8Array + DataView 两边都有。 */
const ENC = new TextEncoder();
const u8 = x => typeof x === 'string' ? ENC.encode(x)
  : (x instanceof Uint8Array ? x : new Uint8Array(x));
function concatBytes(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
/** 小端写入。Buffer 的 writeUInt32LE 在浏览器里没有，用 DataView 代替。 */
function le16(buf, off, v) { new DataView(buf.buffer, buf.byteOffset + off).setUint16(0, v, true); }
function le32(buf, off, v) { new DataView(buf.buffer, buf.byteOffset + off).setUint32(0, v, true); }

/* ---------------------------------------------------------------- 最小 ZIP 写入
   固定用 1980-01-01 的时间戳：这样同一份内容每次产出的字节完全一样，
   便于比对（Word 自己写的 zip 会带时间戳，每次不同）。 */
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = u8(f.name);
    const raw = u8(f.data);          // method 0 = 原样存储，不压缩（见文件顶部说明）
    const crc = crc32(raw);

    const lh = new Uint8Array(30);
    le32(lh, 0, 0x04034b50);
    le16(lh, 4, 20);                 // version needed
    le16(lh, 6, 0);                  // flags
    le16(lh, 8, 0);                  // method = 0（不压缩）
    le16(lh, 10, 0);                 // mod time
    le16(lh, 12, 0x21);              // mod date = 1980-01-01
    le32(lh, 14, crc);
    le32(lh, 18, raw.length);
    le32(lh, 22, raw.length);
    le16(lh, 26, name.length);
    le16(lh, 28, 0);
    locals.push(lh, name, raw);

    const ch = new Uint8Array(46);
    le32(ch, 0, 0x02014b50);
    le16(ch, 4, 20); le16(ch, 6, 20);
    le16(ch, 8, 0);
    le16(ch, 10, 0);                 // method
    le16(ch, 12, 0); le16(ch, 14, 0x21);
    le32(ch, 16, crc);
    le32(ch, 20, raw.length);
    le32(ch, 24, raw.length);
    le16(ch, 28, name.length);
    le16(ch, 30, 0); le16(ch, 32, 0);
    le16(ch, 34, 0); le16(ch, 36, 0);
    le32(ch, 38, 0);
    le32(ch, 42, offset);
    centrals.push(ch, name);

    offset += lh.length + name.length + raw.length;
  }
  const cd = concatBytes(centrals);
  const end = new Uint8Array(22);
  le32(end, 0, 0x06054b50);
  le16(end, 4, 0); le16(end, 6, 0);
  le16(end, 8, files.length); le16(end, 10, files.length);
  le32(end, 12, cd.length);
  le32(end, 16, offset);
  le16(end, 20, 0);
  return concatBytes([...locals, cd, end]);
}

/* ---------------------------------------------------------------- XML 转义 */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Word 不认裸的控制字符，会把文档判成损坏
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/* ---------------------------------------------------------------- 段落构造
   块类型（够用为止）：
     {h:1|2|3, text}                  标题
     {text, bold, italic, color, size, mono}   正文
     {quote: text}                    引用（左边距）
     {rule:true}                      分隔线
     {space:n}                        空行
============================================================================ */
const PT = n => Math.round(n * 2);   // docx 的字号单位是「半磅」

function runs(block) {
  const rPr = [];
  if (block.bold) rPr.push('<w:b/>');
  if (block.italic) rPr.push('<w:i/>');
  if (block.color) rPr.push(`<w:color w:val="${block.color}"/>`);
  if (block.size) rPr.push(`<w:sz w:val="${PT(block.size)}"/><w:szCs w:val="${PT(block.size)}"/>`);
  if (block.mono) rPr.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
  const props = rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : '';
  return `<w:r>${props}<w:t xml:space="preserve">${esc(block.text)}</w:t></w:r>`;
}

function para(block) {
  if (block.rule) {
    return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D8D0C4"/></w:pBdr>'
      + '<w:spacing w:before="120" w:after="120"/></w:pPr></w:p>';
  }
  const pPr = [];
  if (block.h) {
    const sz = block.h === 1 ? 20 : block.h === 2 ? 15 : 12;
    const col = block.h === 1 ? '1A1614' : '3A322C';
    pPr.push(`<w:spacing w:before="${block.h === 1 ? 0 : 280}" w:after="${block.h === 1 ? 200 : 110}"/>`);
    pPr.push('<w:keepNext/>');
    return '<w:p><w:pPr>' + pPr.join('') + '</w:pPr>'
      + runs({ text: block.text, bold: true, size: sz, color: col }) + '</w:p>';
  }
  pPr.push(`<w:spacing w:before="${block.space ? 0 : 40}" w:after="${block.space ? 0 : 40}" w:line="300" w:lineRule="auto"/>`);
  if (block.quote) pPr.push('<w:ind w:left="420"/>');
  return '<w:p><w:pPr>' + pPr.join('') + '</w:pPr>'
    + (block.quote ? runs({ ...block, text: block.quote, italic: true, color: '6B6058' }) : runs(block))
    + '</w:p>';
}

/* ---------------------------------------------------------------- 主入口 */
function buildDocx({ title, meta = [], blocks = [] }) {
  const body = [
    ...(title ? [para({ h: 1, text: title })] : []),
    ...meta.filter(Boolean).map(t => para({ text: t, size: 9, color: '7A6F66' })),
    ...(title || meta.length ? [para({ rule: true })] : []),
    ...blocks.map(para),
  ].join('');

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>
<w:pgMar w:top="1134" w:right="1418" w:bottom="1134" w:left="1418"/></w:sectPr></w:body></w:document>`;

  // 默认字体分三处指定：ascii/hAnsi 管英文，eastAsia 管中文。
  // 不指定 eastAsia 的话，Word 会给中文配一个它自己挑的字体，中英混排会很脏。
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Cambria" w:hAnsi="Cambria" w:eastAsia="微软雅黑" w:cs="Cambria"/>
<w:sz w:val="21"/><w:szCs w:val="21"/>
<w:color w:val="1A1614"/>
<w:lang w:val="en-GB" w:eastAsia="zh-CN"/>
</w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="60" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>`;

  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${esc(title || '课堂转写')}</dc:title>
<dc:creator>课堂同传</dc:creator>
<cp:lastModifiedBy>课堂同传</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created>
</cp:coreProperties>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: styles },
    { name: 'docProps/core.xml', data: core },
  ]);
}

/* ---------------------------------------------------------------- 转写稿 → docx 块
   和导出 markdown 用同一份数据，保证两边内容一致。 */
function sessionBlocks({ summaries = [], paras = [] }) {
  const blocks = [];
  const mm = s => {
    const v = Math.max(0, Number(s) || 0);
    return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(Math.floor(v % 60)).padStart(2, '0');
  };

  if (summaries.length) {
    blocks.push({ h: 2, text: '这节课讲了什么' });
    for (const c of summaries) {
      blocks.push({ text: `${mm(c.t0)}–${mm(c.t1)}　${c.topic_zh || ''}`, bold: true, size: 11.5 });
      for (const p of (c.points_zh || [])) blocks.push({ text: '· ' + p, size: 10.5 });
      if ((c.terms || []).length) blocks.push({ text: '术语：' + c.terms.join(' · '), size: 9.5, color: '7A6F66' });
      blocks.push({ space: 1 });
    }
    blocks.push({ rule: true });
  }

  for (const p of paras) {
    blocks.push({ text: mm(p.t0), size: 9, color: '9A8F86', mono: true });
    blocks.push({ text: p.en || '', size: 10.5, color: '5A5148' });
    if (p.zh) blocks.push({ text: p.zh, size: 12, bold: false });
    blocks.push({ space: 1 });
  }
  return blocks;
}

/* ---------- core.mjs ---------- */
// 服务端和「单文件分享版」共用的逻辑。
//
// 为什么要有这一层：本地版通过 /api/* 走后端，分享版直接在浏览器里调模型。
// 「拼 prompt」和「解析返回」这两件事两边必须一模一样，否则本地测通了、
// 朋友那边行为不同。所以抽出来，**只此一份**，两边各自只负责「怎么发请求」。
//
// 拆分的接缝：core 出 {system, user} → 调用方去发 → core 收 text 解析回来。





/* ---------------------------------------------------------------- 工具 */
/** 秒 → MM:SS。⚠ 前端传来的 t0/t1 单位是**秒**（已扣掉暂停时间），不是毫秒。 */
function mmss(sec) {
  const s = Math.max(0, Number(sec) || 0);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}

const trim = (v, n) => String(v ?? '').trim().slice(0, n);

/* ---------------------------------------------------------------- 翻译 */
function buildTranslate(glossary, items, ctx) {
  const clean = (Array.isArray(items) ? items : [])
    .filter(it => it && it.id != null && String(it.en || '').trim())
    .slice(0, 12)
    .map(it => ({ id: it.id, en: trim(it.en, 2000) }));
  const context = (Array.isArray(ctx) ? ctx : [])
    .filter(c => c && String(c.en || '').trim())
    .slice(-4)
    .map(c => ({ en: trim(c.en, 800), zh: trim(c.zh, 800) }));
  // 只注入本批（含上下文段落）真出现的术语，别把整张表塞进来
  const g = filterGlossary(glossary,
    clean.map(i => i.en).concat(context.map(c => c.en)));
  return {
    ok: clean.length > 0,
    error: clean.length ? null : '没有要翻译的内容',
    system: buildSystem(g),
    user: clean.length ? composeUser(clean, context) : '',
    ids: clean.map(i => i.id),
  };
}
/** 按 id 回填。**绝不按数组顺序填** —— 模型换序时会整体错位。 */
function parseTranslate(text, ids) {
  const parsed = extractJson(text);
  const back = new Map();
  for (const it of (parsed && Array.isArray(parsed.items)) ? parsed.items : []) {
    const zh = trim(it && it.zh, 4000);
    if (it && it.id != null && zh) back.set(Number(it.id), { zh, q: it.q === true });
  }
  const want = ids || [...back.keys()];
  return {
    items: want.filter(id => back.has(Number(id)))
      .map(id => ({ id, zh: back.get(Number(id)).zh, q: back.get(Number(id)).q })),
    missing: want.filter(id => !back.has(Number(id))),
    parse_error: !parsed,
  };
}

/* ---------------------------------------------------------------- 答题 */
const ASK_TYPES = ['definition', 'opinion', 'example', 'followup', 'open'];
/** 历史发言：上一题的答案（防重复）、上一句发言（接追问）、用过的开场结尾。 */
function answerHistory(x) {
  const arr = v => (Array.isArray(v) ? v : []).filter(s => String(s || '').trim())
    .slice(0, 6).map(s => trim(s, 300));
  return {
    prevAnswer: arr(x && x.prevAnswer),
    lastAnswer: arr(x && x.lastAnswer),
    usedOpeners: arr(x && x.usedOpeners),
  };
}
function buildAnswer(glossary, question, ctx, extra, long) {
  // 上下文给最近 12 段（约 2–4 分钟的讲课量）。再多对这个任务没用，只是烧 token。
  const context = (Array.isArray(ctx) ? ctx : []).filter(c => c && String(c.en || '').trim())
    .slice(-12).map(c => ({ en: trim(c.en, 600), zh: trim(c.zh, 400) }));
  const q = trim(question, 1200);
  // 术语表和翻译那边同一个道理：只注入题目和上下文里真出现的
  const g = filterGlossary(glossary, [q].concat(context.map(c => c.en)));
  return {
    ok: true,
    long: !!long,
    system: buildAnswerSystem(g, long),
    user: composeAnswerUser(q, context, answerHistory(extra)),
  };
}
function parseAnswer(text) {
  const j = extractJson(text);
  const lines = v => (Array.isArray(v) ? v : []).map(s => String(s || '').trim()).filter(Boolean).slice(0, 6);
  const say_en = lines(j && j.say_en);
  let say_zh = lines(j && j.say_zh);
  // 中英句数不一致时截到一样长——前端是按句对照着显示的，错位会很难看
  if (say_zh.length > say_en.length) say_zh = say_zh.slice(0, say_en.length);
  const at = String((j && j.ask_type) || '').trim().toLowerCase();
  const data = {
    ask_type: ASK_TYPES.includes(at) ? at : 'open',
    what_zh: trim(j && j.what_zh, 200),
    angle_zh: trim(j && j.angle_zh, 300),
    stall_en: trim(j && j.stall_en, 300),
    say_zh,
    say_en,
    extend_en: trim(j && j.extend_en, 600),
    avoid_zh: trim(j && j.avoid_zh, 300),
    parse_error: !j,
  };
  if (!say_en.length) { data.parse_error = true; data.raw = String(text || '').slice(0, 400); }
  return data;
}

/* ---------------------------------------------------------------- 总结 */
function buildSummary(items, prev) {
  const clean = (Array.isArray(items) ? items : [])
    .filter(p => p && String(p.en || '').trim())
    .slice(0, 40)
    .map(p => ({ en: trim(p.en, 600), zh: trim(p.zh, 400) }));
  return {
    ok: clean.length > 0,
    error: clean.length ? null : '没有内容可总结',
    system: buildSummarySystem(),
    user: clean.length ? composeSummaryUser(clean, prev ? trim(prev, 60) : null) : '',
  };
}
function parseSummary(text) {
  const j = extractJson(text);
  const data = {
    topic_zh: trim(j && j.topic_zh, 200),
    points_zh: Array.isArray(j && j.points_zh)
      ? j.points_zh.map(s => String(s || '').trim()).filter(Boolean).slice(0, 5) : [],
    terms: Array.isArray(j && j.terms)
      ? j.terms.map(s => String(s || '').trim()).filter(Boolean).slice(0, 6) : [],
    parse_error: !j,
  };
  if (!data.topic_zh) { data.parse_error = true; data.raw = String(text || '').slice(0, 400); }
  return data;
}

/* ---------------------------------------------------------------- 导出 */
function transcriptMarkdown(s) {
  const paras = Array.isArray(s.paras) ? s.paras : [];
  const L = [];
  L.push(`# 课堂转写 · ${s.title || '未命名'}`, '');
  L.push(`- 日期：${s.date || ''}`);
  L.push(`- 时长：${s.duration || '—'}`);
  L.push(`- 段落：${paras.length}`);
  L.push(`- 与课程：${s.course || '未标注'}`, '');
  L.push('> 英文来自浏览器语音识别，可能有听错、漏词、专有名词错误；中文为模型翻译。', '');

  // 骨架放最前面：课后再看，先扫这几张卡就够，细节再往下翻
  const sums = Array.isArray(s.summaries) ? s.summaries : [];
  if (sums.length) {
    L.push('## 这节课讲了什么', '');
    for (const c of sums) {
      L.push(`### ${mmss(c.t0)}–${mmss(c.t1)}　${c.topic_zh || ''}`, '');
      for (const p of (c.points_zh || [])) L.push(`- ${p}`);
      if ((c.terms || []).length) L.push('', `术语：${c.terms.join(' · ')}`);
      L.push('');
    }
    L.push('---', '');
  }
  for (const p of paras) {
    L.push(`### ${mmss(p.t0)}`, '');
    L.push(`**EN**  ${p.en || ''}`, '');
    L.push(`**中**  ${p.zh || '（未翻译）'}`, '');
  }
  return L.join('\n');
}

function transcriptDocx(body) {
  const paras = Array.isArray(body.paras) ? body.paras : [];
  const title = [body.course, body.label].filter(Boolean).join(' ') || body.title || '课堂转写';
  return buildDocx({
    title,
    meta: [
      `日期：${body.date || ''}　时长：${body.duration || '—'}　段落：${paras.length}`
        + (body.course ? `　课程：${body.course}` : ''),
      '英文来自浏览器语音识别，可能有听错、漏词、专有名词错误；中文为模型翻译。',
    ],
    blocks: sessionBlocks({ summaries: body.summaries || [], paras }),
  });
}

/* ============================================================ 分享版的后端
   本地版这一层是 server.mjs，通过 /api/* 说话；分享版直接在浏览器里跑。
   拼 prompt 和解析返回都调用上面 core.mjs 的函数——和本地版**同一份代码**，
   所以两边行为一致。这里只负责「怎么把请求发出去」。 */

const CP_STORE = 'cp-config';
const HIST_STORE = 'cp-history';       // 听课记录（分享版没有服务端，只能存本机）
function loadHist(){
  try { return JSON.parse(localStorage.getItem(HIST_STORE) || '{}'); } catch (e) { return {}; }
}
function loadConfig(){
  try {
    const c = JSON.parse(localStorage.getItem(CP_STORE) || 'null');
    if (c && c.key) return c;
  } catch (e) {}
  return null;
}
function saveConfig(c){ try { localStorage.setItem(CP_STORE, JSON.stringify(c)); } catch (e) {} }

const DEFAULT_GLOSSARY = {"transmedia storytelling":"跨媒介叙事","transmedia":"跨媒介","convergence culture":"融合文化","participatory culture":"参与式文化","remediation":"再媒介化","adaptation":"改编","franchise":"系列 IP","storyworld":"故事世界","canon":"正典","fan fiction":"同人创作","spreadable media":"可扩散媒介","two-step flow":"两级传播","opinion leader":"意见领袖","agenda-setting":"议程设置","priming":"启动效应","cultivation theory":"涵化理论","mainstreaming":"主流化","uses and gratifications":"使用与满足","encoding/decoding":"编码/解码","spiral of silence":"沉默的螺旋","third-person effect":"第三人效果","selective exposure":"选择性接触","gatekeeping":"把关","media ecology":"媒介生态","medium theory":"媒介理论","the medium is the message":"媒介即讯息","global village":"地球村","technological determinism":"技术决定论","mass communication":"大众传播","interpersonal communication":"人际传播","mediated communication":"中介化传播","computer-mediated communication":"计算机中介传播","public sphere":"公共领域","network society":"网络社会","information society":"信息社会","parasocial":"准社会","parasocial interaction":"准社会互动","audience":"受众","fandom":"粉丝社群","active audience":"主动受众","reception analysis":"接受分析","audience research":"受众研究","media literacy":"媒介素养","knowledge gap":"知识沟","digital divide":"数字鸿沟","echo chamber":"回音室","filter bubble":"过滤气泡","hostile media effect":"敌意媒体效应","misinformation":"错误信息","disinformation":"虚假信息","propaganda":"宣传","media convergence":"媒介融合","platformization":"平台化","algorithmic curation":"算法策展","recommendation system":"推荐系统","citizen journalism":"公民新闻","political economy of communication":"传播政治经济学","cultural imperialism":"文化帝国主义","diffusion of innovations":"创新扩散理论","social learning theory":"社会学习理论","elaboration likelihood model":"精细加工可能性模型","cognitive dissonance":"认知失调","source credibility":"信源可信度","inoculation theory":"免疫理论","sleeper effect":"休眠效果","cultural studies":"文化研究","popular culture":"流行文化","mass culture":"大众文化","subculture":"亚文化","counterculture":"反主流文化","cultural capital":"文化资本","habitus":"惯习","symbolic violence":"象征暴力","cultural reproduction":"文化再生产","hegemony":"文化霸权","ideology":"意识形态","false consciousness":"虚假意识","commodity fetishism":"商品拜物教","alienation":"异化","reification":"物化","Frankfurt School":"法兰克福学派","culture industry":"文化工业","aura":"灵光","mechanical reproduction":"机械复制","discourse":"话语","semiotics":"符号学","signifier":"能指","signified":"所指","myth":"神话（巴特意义上的）","representation":"再现","stereotype":"刻板印象","gaze":"凝视","male gaze":"男性凝视","structuralism":"结构主义","post-structuralism":"后结构主义","postmodernism":"后现代主义","deconstruction":"解构","hyperreality":"超真实","simulacrum":"拟像","pastiche":"拼贴戏仿","bricolage":"拼装","identity politics":"身份政治","intersectionality":"交叉性","postcolonialism":"后殖民主义","orientalism":"东方主义","othering":"他者化","hybridity":"混杂性","diaspora":"离散","imagined community":"想象的共同体","globalization":"全球化","glocalization":"全球在地化","cultural appropriation":"文化挪用","essentialism":"本质主义","journalism":"新闻业","news values":"新闻价值","objectivity":"客观性","impartiality":"公正性","source attribution":"消息来源标注","verification":"核实","fact-checking":"事实核查","editorial independence":"编辑独立","press freedom":"新闻自由","censorship":"审查","self-censorship":"自我审查","defamation":"诽谤","libel":"书面诽谤","public interest":"公共利益","investigative journalism":"调查报道","watchdog journalism":"看门狗新闻","tabloidization":"小报化","infotainment":"信息娱乐化","sensationalism":"煽情主义","newsroom":"新闻编辑部","embargo":"禁发期","off the record":"不得引用","press conference":"记者会","media relations":"媒体关系","public relations":"公共关系","corporate communication":"企业传播","crisis communication":"危机传播","crisis management":"危机管理","stakeholder":"利益相关方","stakeholder engagement":"利益相关方沟通","press release":"新闻稿","spokesperson":"发言人","reputation management":"声誉管理","corporate identity":"企业识别","corporate image":"企业形象","corporate social responsibility":"企业社会责任","ESG":"环境、社会与治理","issue management":"议题管理","publicity":"曝光度","lobbying":"游说","investor relations":"投资者关系","internal communication":"内部沟通","employee engagement":"员工敬业度","image repair theory":"形象修复理论","situational crisis communication theory":"情境式危机传播理论","thought leadership":"思想领导力","key message":"核心信息","talking points":"口径要点","media training":"媒体应对培训","integrated marketing communications":"整合营销传播","IMC":"整合营销传播","marketing mix":"营销组合","4Ps":"4P 组合","segmentation":"市场细分","targeting":"目标市场选择","positioning":"定位","brand equity":"品牌资产","brand positioning":"品牌定位","brand persona":"品牌人格","brand architecture":"品牌架构","brand awareness":"品牌知名度","brand loyalty":"品牌忠诚度","brand association":"品牌联想","touchpoint":"触点","consumer journey":"消费者旅程","purchase funnel":"购买漏斗","consumer insight":"消费者洞察","consumer behavior":"消费者行为","perceived value":"感知价值","value proposition":"价值主张","USP":"独特销售主张","AIDA":"注意-兴趣-欲望-行动模型","earned media":"赢得媒体","owned media":"自有媒体","paid media":"付费媒体","share of voice":"声量份额","brand lift":"品牌提升","engagement rate":"互动率","reach":"触达人数","frequency":"触达频次","KOL":"关键意见领袖","KOC":"关键意见消费者","influencer marketing":"网红营销","content marketing":"内容营销","social media marketing":"社交媒体营销","search engine optimization":"搜索引擎优化","native advertising":"原生广告","programmatic advertising":"程序化广告","click-through rate":"点击率","conversion rate":"转化率","customer acquisition cost":"获客成本","customer lifetime value":"客户终身价值","churn":"流失率","customer relationship management":"客户关系管理","net promoter score":"净推荐值","A/B testing":"A/B 测试","attribution":"归因","ROI":"投资回报率","KPI":"关键绩效指标","word of mouth":"口碑","electronic word of mouth":"网络口碑","customer pain point":"用户痛点","market research":"市场调研","focus group":"焦点小组","cognitive load":"认知负荷","working memory":"工作记忆","long-term memory":"长期记忆","selective attention":"选择性注意","anchoring":"锚定效应","confirmation bias":"确认偏误","availability heuristic":"可得性启发","loss aversion":"损失厌恶","prospect theory":"前景理论","bounded rationality":"有限理性","nudge":"助推","self-determination theory":"自我决定理论","intrinsic motivation":"内在动机","extrinsic motivation":"外在动机","growth mindset":"成长型思维","fixed mindset":"固定型思维","flow state":"心流","hierarchy of needs":"需求层次","attachment theory":"依恋理论","emotional intelligence":"情绪智力","empathy":"共情","theory of mind":"心理理论","zone of proximal development":"最近发展区","scaffolding":"支架式教学","stereotype threat":"刻板印象威胁","implicit bias":"内隐偏见","groupthink":"群体思维","conformity":"从众","bystander effect":"旁观者效应","social loafing":"社会懈怠","self-efficacy":"自我效能感","locus of control":"控制点","Big Five":"大五人格","resilience":"心理韧性","burnout":"职业倦怠","social structure":"社会结构","social stratification":"社会分层","social class":"社会阶层","social mobility":"社会流动","social capital":"社会资本","social network":"社会网络","social norm":"社会规范","socialization":"社会化","institution":"制度","bureaucracy":"科层制","rationalization":"理性化","anomie":"失范","division of labour":"分工","modernity":"现代性","risk society":"风险社会","individualization":"个体化","secularization":"世俗化","urbanization":"城市化","gentrification":"绅士化","social inequality":"社会不平等","welfare state":"福利国家","gender":"性别","patriarchy":"父权制","feminism":"女性主义","masculinity":"男性气质","queer theory":"酷儿理论","ethnicity":"族群","racism":"种族主义","marginalization":"边缘化","social exclusion":"社会排斥","collective action":"集体行动","social movement":"社会运动","civil society":"公民社会","public opinion":"民意","microeconomics":"微观经济学","macroeconomics":"宏观经济学","supply and demand":"供给与需求","equilibrium":"均衡","elasticity":"弹性","marginal cost":"边际成本","opportunity cost":"机会成本","sunk cost":"沉没成本","economies of scale":"规模经济","externality":"外部性","public good":"公共品","market failure":"市场失灵","monopoly":"垄断","inflation":"通货膨胀","GDP":"国内生产总值","interest rate":"利率","fiscal policy":"财政政策","monetary policy":"货币政策","game theory":"博弈论","prisoner's dilemma":"囚徒困境","principal-agent problem":"委托代理问题","information asymmetry":"信息不对称","moral hazard":"道德风险","adverse selection":"逆向选择","venture capital":"风险投资","business model":"商业模式","value chain":"价值链","supply chain":"供应链","competitive advantage":"竞争优势","SWOT analysis":"SWOT 分析","PESTLE analysis":"PESTLE 分析","Porter's five forces":"波特五力模型","blue ocean strategy":"蓝海战略","organizational behavior":"组织行为学","organizational culture":"组织文化","organizational structure":"组织结构","hierarchy":"层级","span of control":"管理幅度","decentralization":"分权","leadership":"领导力","transformational leadership":"变革型领导","transactional leadership":"交易型领导","servant leadership":"服务型领导","team dynamics":"团队动力","cross-functional team":"跨职能团队","agile":"敏捷开发","scrum":"Scrum 框架","project management":"项目管理","milestone":"里程碑","deliverable":"交付物","OKR":"目标与关键结果","performance appraisal":"绩效评估","talent management":"人才管理","onboarding":"入职引导","employee turnover":"员工流失率","change management":"变革管理","knowledge management":"知识管理","systems thinking":"系统思维","lean":"精益","total quality management":"全面质量管理","corporate governance":"公司治理","qualitative research":"质性研究","quantitative research":"量化研究","mixed methods":"混合方法","research question":"研究问题","hypothesis":"假设","theoretical framework":"理论框架","conceptual framework":"概念框架","independent variable":"自变量","dependent variable":"因变量","control variable":"控制变量","operationalization":"操作化","validity":"效度","reliability":"信度","internal validity":"内部效度","external validity":"外部效度","generalizability":"可推广性","sampling":"抽样","random sampling":"随机抽样","sample size":"样本量","sampling bias":"抽样偏差","response bias":"作答偏差","questionnaire":"问卷","Likert scale":"李克特量表","semi-structured interview":"半结构化访谈","participant observation":"参与式观察","case study":"个案研究","ethnography":"民族志","grounded theory":"扎根理论","thematic analysis":"主题分析","content analysis":"内容分析","discourse analysis":"话语分析","longitudinal study":"纵向研究","cross-sectional study":"横断面研究","correlation":"相关","causation":"因果","regression analysis":"回归分析","statistical significance":"统计显著性","p-value":"p 值","confidence interval":"置信区间","effect size":"效应量","standard deviation":"标准差","variance":"方差","normal distribution":"正态分布","descriptive statistics":"描述性统计","inferential statistics":"推断性统计","t-test":"t 检验","ANOVA":"方差分析","chi-square test":"卡方检验","factor analysis":"因子分析","data visualization":"数据可视化","peer review":"同行评审","artificial intelligence":"人工智能","machine learning":"机器学习","deep learning":"深度学习","neural network":"神经网络","large language model":"大语言模型","natural language processing":"自然语言处理","computer vision":"计算机视觉","speech recognition":"语音识别","text-to-speech":"语音合成","prompt engineering":"提示词工程","fine-tuning":"微调","training data":"训练数据","dataset":"数据集","algorithm":"算法","algorithmic bias":"算法偏见","black box":"黑箱","hallucination":"幻觉（模型编造）","generative AI":"生成式 AI","diffusion model":"扩散模型","transformer":"Transformer 架构","token":"词元","embedding":"嵌入","inference":"推理","API":"应用程序接口","cloud computing":"云计算","big data":"大数据","data mining":"数据挖掘","database":"数据库","front-end":"前端","back-end":"后端","user interface":"用户界面","user experience":"用户体验","usability":"易用性","accessibility":"无障碍","responsive design":"响应式设计","prototype":"原型","wireframe":"线框图","information architecture":"信息架构","interaction design":"交互设计","human-computer interaction":"人机交互","augmented reality":"增强现实","virtual reality":"虚拟现实","extended reality":"扩展现实","metaverse":"元宇宙","blockchain":"区块链","non-fungible token":"非同质化代币","cryptocurrency":"加密货币","open source":"开源","version control":"版本控制","repository":"代码仓库","cinematography":"摄影（电影）","mise-en-scène":"场面调度","close-up":"特写","long shot":"远景","montage":"蒙太奇","continuity editing":"连续性剪辑","jump cut":"跳切","camera angle":"镜头角度","composition":"构图","rule of thirds":"三分法","colour grading":"调色","diegesis":"叙事世界","diegetic sound":"画内音","non-diegetic sound":"画外音（配乐）","soundtrack":"原声带","voice-over":"旁白","mise en abyme":"套层结构","typography":"字体排印","serif":"衬线","sans-serif":"无衬线","kerning":"字距","leading":"行距","grid system":"网格系统","white space":"留白","visual hierarchy":"视觉层级","logo":"标志","colour palette":"配色方案","motion graphics":"动态图形","storyboard":"分镜脚本","art direction":"艺术指导","creative direction":"创意指导","mood board":"情绪板","narratology":"叙事学","narrative":"叙事","plot":"情节","fabula":"故事层","syuzhet":"叙述层","focalization":"聚焦","point of view":"视角","unreliable narrator":"不可靠叙述者","omniscient narrator":"全知叙述者","free indirect discourse":"自由间接引语","stream of consciousness":"意识流","bildungsroman":"成长小说","genre":"类型","literary canon":"文学正典","metaphor":"隐喻","metonymy":"转喻","symbolism":"象征","motif":"母题","theme":"主题","allegory":"寓言","irony":"反讽","dramatic irony":"戏剧反讽","parody":"戏仿","satire":"讽刺","close reading":"细读","reader-response theory":"读者反应理论","hermeneutics":"诠释学","intertextuality":"互文性","linguistics":"语言学","phonetics":"语音学","phonology":"音系学","morphology":"形态学","syntax":"句法学","semantics":"语义学","pragmatics":"语用学","phoneme":"音位","morpheme":"语素","register":"语域","code-switching":"语码转换","bilingualism":"双语现象","second language acquisition":"第二语言习得","interlanguage":"中介语","corpus":"语料库","sociolinguistics":"社会语言学","speech act":"言语行为","cooperative principle":"合作原则","implicature":"会话含义","politeness theory":"礼貌理论","language ideology":"语言意识形态","epistemology":"认识论","ontology":"本体论","metaphysics":"形而上学","ethics":"伦理学","aesthetics":"美学","empiricism":"经验主义","rationalism":"理性主义","idealism":"唯心主义","materialism":"唯物主义","positivism":"实证主义","phenomenology":"现象学","existentialism":"存在主义","pragmatism":"实用主义","utilitarianism":"功利主义","deontology":"义务论","social contract":"社会契约","determinism":"决定论","paradigm":"范式","paradigm shift":"范式转移","interpretivism":"解释主义","critical theory":"批判理论","dialectic":"辩证法","a priori":"先验的","a posteriori":"后验的","ludology":"游戏学","procedural rhetoric":"程序修辞","mechanics-dynamics-aesthetics":"机制-动态-美学框架","MDA framework":"MDA 框架","game feel":"手感","playtesting":"试玩测试","player agency":"玩家能动性","procedural generation":"程序化生成","emergent gameplay":"涌现式玩法","ludonarrative dissonance":"游戏性与叙事失谐","magic circle":"魔圈","game loop":"游戏循环","game mechanic":"游戏机制","level design":"关卡设计","player experience":"玩家体验","gamification":"游戏化","creativity":"创造力","divergent thinking":"发散思维","convergent thinking":"聚合思维","lateral thinking":"水平思考","design thinking":"设计思维","brainstorming":"头脑风暴","constraint":"约束条件","affordance":"可供性","prototyping":"原型制作","iteration":"迭代","ideation":"构思","creative confidence":"创意自信","early adopter":"早期采用者","tipping point":"引爆点","disruptive innovation":"颠覆式创新","sustaining innovation":"延续性创新","seminar":"研讨课","tutorial":"导修课","lecture":"讲座课","office hours":"答疑时间","assessment":"考核","rubric":"评分标准","formative feedback":"形成性反馈","summative assessment":"终结性评价","critical analysis":"批判性分析","literature review":"文献综述","methodology":"研究方法","citation":"引用","plagiarism":"抄袭","dissertation":"学位论文","capstone":"毕业设计","thesis statement":"论点陈述","abstract":"摘要","argument":"论证","counter-argument":"反论","synthesis":"综合","seminal work":"奠基性著作","primary source":"一手资料","secondary source":"二手资料","learning outcome":"学习成果","curriculum":"课程设置"};

let CFG = loadConfig() || {
  base: 'https://api.deepseek.com/anthropic',
  model: 'deepseek-flash',
  key: '',
  glossary: DEFAULT_GLOSSARY,
};
// 老版本存过配置但没存术语表时补齐
if (!CFG.glossary || !Object.keys(CFG.glossary).length) CFG.glossary = DEFAULT_GLOSSARY;

async function callModel(system, user, maxTokens = 4000, think){
  if (!CFG.key) throw new Error('还没填 API Key（点右上角「设置」）');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60000);
  const t0 = Date.now();
  try {
    const r = await fetch(CFG.base.replace(/\/+$/, '') + '/v1/messages', {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': CFG.key,
        'authorization': 'Bearer ' + CFG.key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CFG.model, max_tokens: maxTokens,
        // 见 CLAUDE.md：翻译等任务必须关思考；只有「长答」模式才开
        thinking: think ? { type: 'enabled' } : { type: 'disabled' },
        temperature: 0.3,
        system, messages: [{ role: 'user', content: user }],
      }),
    });
    const j = await r.json();
    if (j.error) {
      const m = j.error.message || JSON.stringify(j.error);
      if (/auth|key|401|403/i.test(m)) throw new Error('API Key 不对或已失效：' + m);
      if (/balance|quota|402|insufficient/i.test(m)) throw new Error('账户余额不够了：' + m);
      throw new Error(m);
    }
    const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    return { text, ms: Date.now() - t0, usage: j.usage || {} };
  } finally { clearTimeout(timer); }
}

/* 前端统一通过这个对象说话。本地版的实现是 fetch('/api/xxx')，
   分享版的实现是直接调 core.mjs。前端的其余代码两边完全一样。 */
window.__CP_API = {
  standalone: true,
  canImport: false,                     // 单文件版没有本机的笔记目录
  config: () => CFG,
  setConfig: c => { CFG = c; saveConfig(c); },
  defaultGlossary: () => DEFAULT_GLOSSARY,

  async translate(body){
    const r = buildTranslate(CFG.glossary, body.items, body.context);
    if (!r.ok) return { ok: true, items: [], ms: 0 };
    const out = await callModel(r.system, r.user, 4000);
    const p = parseTranslate(out.text, r.ids);
    return { ok: true, items: p.items, missing: p.missing, ms: out.ms,
             raw: p.parse_error ? out.text.slice(0, 400) : undefined };
  },
  async answer(body){
    const r = buildAnswer(CFG.glossary, body.question, body.context, body, body.long);
    // 长答开思考（多等几秒换更完整的论述），短答必须关——短答只有几秒可用
    const out = await callModel(r.system, r.user, r.long ? 3000 : 2000, r.long, !!r.long);
    return { ok: true, data: parseAnswer(out.text), ms: out.ms };
  },
  async summary(body){
    const r = buildSummary(body.items, body.prev);
    if (!r.ok) return { ok: false, error: r.error };
    const out = await callModel(r.system, r.user, 1500);
    return { ok: true, data: parseSummary(out.text), ms: out.ms };
  },
  async warm(){
    // 前缀缓存预热：本地版靠服务端，这边直接发两个极小请求
    const g = CFG.glossary;
    const jobs = [buildTranslate(g, [{ id: 1, en: 'ok' }], []).system, buildAnswer(g, '', []).system];
    const res = [];
    for (const s of jobs) { try { const t0 = Date.now(); await callModel(s, 'ok', 1); res.push({ ok: true, ms: Date.now() - t0 }); }
                            catch (e) { res.push({ ok: false, error: e.message }); } }
    return { ok: true, translate: res[0], answer: res[1] };
  },
  async exportMd(body){
    const md = transcriptMarkdown({ ...body, date: new Date().toISOString().slice(0, 10) });
    return { ok: true, md, file: (body.course || 'transcript') + '.md' };
  },
  async exportDocx(body){
    const date = new Date().toISOString().slice(0, 10);
    return { ok: true, bytes: transcriptDocx({ ...body, date }) };
  },

  /* 分享版没有服务端，听课记录只能存在浏览器里。
     一节课的全文大概 100–300KB，localStorage 上限约 5MB，所以只留最近 15 节
     （超了就砍最老的；真写不下时再砍一半重试）。 */
  sessions(){
    const h = loadHist();
    const list = Object.values(h).map(x => ({
      id: x.id, date: x.date, first: x.first, last: x.last,
      course: x.course, label: x.label,
      paras: (x.paras || []).length,
      zh: (x.paras || []).filter(p => p.zh).length,
      summaries: (x.summaries || []).length,
      answers: (x.answers || []).length,
    })).sort((a, b) => (a.first < b.first ? 1 : -1));
    return Promise.resolve({ ok: true, sessions: list });
  },
  session(id){
    const h = loadHist();
    return Promise.resolve(h[id] ? { ok: true, data: h[id] }
      : { ok: false, error: '本机没有这节课的记录' });
  },
  saveSession(snap){
    if (!snap || !snap.id) return;
    const h = loadHist();
    h[snap.id] = snap;
    const ids = Object.keys(h).sort((a, b) => ((h[a].first || '') < (h[b].first || '') ? 1 : -1));
    for (const k of ids.slice(15)) delete h[k];
    try { localStorage.setItem(HIST_STORE, JSON.stringify(h)); }
    catch (e) {
      for (const k of ids.slice(7)) delete h[k];       // 还写不下就再砍一半
      try { localStorage.setItem(HIST_STORE, JSON.stringify(h)); } catch (e2) {}
    }
  },
};
