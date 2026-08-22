/* =========================================================
 * 影视前期提示词生成器 · 纯前端 H5
 * 仅调用 DeepSeek 生成文字与提示词；出图交给「即梦」。
 * 复用参考：show-me-the-story(逐章) / character-sheet-generator(角色卡字段)
 *          / video-shot-agent(分镜结构)
 * ========================================================= */
'use strict';

/* ---------- 全局状态 ---------- */
const KEY_CFG = 'fyp_cfg';
const KEY_STATE = 'fyp_state';   // 旧版单项目 key（仅用于首次迁移）
const KEY_LIB = 'fyp_lib';       // 新版多项目历史库
const MAX_PROJECTS = 10;         // 历史项目上限
let lib = { curId: null, items: [] }; // {curId, items:[{id, idea, outline, ..., step, title, logline, updatedAt}]}

const state = {
  mode: 'shortfilm',    // 'shortfilm' 短片 / 'longnovel' 经典长篇小说
  recipe: 'mesh',       // 长篇写作范式：mesh多线网状 / layered分层递归 / dual写手-编辑双审 / web黄金网文
  idea: '',
  coverPrompt: '',      // 整部小说封面提示词（场景页生成 / 长篇模式用）
  coverWithTitle: false,// 封面提示词是否包含「汉字书名」（false=纯画面无文字）
  outline: null,        // {title, logline, chapters:[{title,summary}]}
  outlineConfirmed: false,
  chapters: [],         // [{title, content, confirmed}]
  characters: [],       // [{name, role, profile:{...}, prompts:{...}}]
  scenes: [],           // [{name, 作用, description, prompt}]
  storyboard: [],       // [{镜号,章节,时长,景别,角度,运镜,主体,构图,光线,画面描述,对白,转场,出图提示词,连续性,剪辑动机}]
  boardConcepts: [],    // 每章一条 {视觉概念, 母题}（分镜生成时随章节返回）
  raw: {}               // 容错：各阶段原始返回
};
let currentStep = 1;

/* 角色筛选状态 + Tom Select 实例池（render 重建前需销毁） */
let charFilters = {q:'', idents:[], gender:'', ageMin:'', ageMax:''};
let charTS = [];
function destroyCharTS(){ charTS.forEach(t=>{ try{ t.destroy(); }catch(e){} }); charTS = []; }
function parseAge(s){
  if(s==null || s==='') return null;
  const m = String(s).match(/\d+/);
  return m ? +m[0] : null;
}

/* ---------- 工具函数 ---------- */
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];

function toast(msg){
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._t); t._t = setTimeout(()=>t.classList.add('hidden'), 1800);
}
async function copyText(text){
  try{
    await navigator.clipboard.writeText(text);
    toast('已复制');
  }catch(e){
    // 兜底
    const ta=document.createElement('textarea'); ta.value=text; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy'); ta.remove(); toast('已复制');
  }
}
function esc(s){ return String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function download(name, text){
  const blob = new Blob([text], {type:'text/markdown;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- 字数统计：中文按字、英文按单词，分别统计再合计（纯前端，本地算） ---------- */
const CJK_ALL = /\p{Script=Han}|[\u3000-\u303f\uff00-\uffef]/gu;
const EN_WORD = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;
function countWords(text){
  text = String(text||'');
  const cjk = (text.match(CJK_ALL)||[]).length;
  const rest = text.replace(CJK_ALL, ' ');
  const en = (rest.match(EN_WORD)||[]).length;
  return {cjk, en, total: cjk + en};
}
function wcInner(w){
  const fmt = n => n.toLocaleString('en-US');
  return `📝 <b>${fmt(w.total)}</b><i>字</i>`;
}
function wcBadge(text, attrs){
  const w = countWords(text);
  return `<span class="wc" ${attrs||''} title="中文 ${w.cjk} 字 · 英文 ${w.en} 词">${wcInner(w)}</span>`;
}

/* ---------- 配置 ---------- */
function getCfg(){
  try{ return JSON.parse(localStorage.getItem(KEY_CFG)) || {}; }catch(e){ return {}; }
}
function saveCfg(cfg){ localStorage.setItem(KEY_CFG, JSON.stringify(cfg)); }

/* ---------- 主题切换（单页内深色 / 3D 黑板 / 热血 FC） ---------- */
const THEMES = ['dark','blackboard','mecha','cyber','guofeng'];
let bbLoaded = false;
function ensureBlackboard(){
  if(bbLoaded) return Promise.resolve();
  return new Promise((res)=>{
    const s = document.createElement('script');
    s.src = 'assets/blackboard3d.js';
    s.onload = ()=>{ bbLoaded = true; res(); };
    s.onerror = ()=>{ res(); }; // 失败也不阻塞，内容仍可用
    document.head.appendChild(s);
  });
}
function applyTheme(theme){
  if(THEMES.indexOf(theme) < 0) theme = 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  const c = getCfg(); c.theme = theme; saveCfg(c);
  if(theme === 'blackboard'){
    ensureBlackboard().then(()=>{ if(window.Blackboard3D) window.Blackboard3D.start(); });
  }else if(window.Blackboard3D){
    window.Blackboard3D.stop();
  }
  // 机甲主题顶部胶囊导航显隐
  const mtn = $('#mechaTopNav');
  if(mtn) mtn.classList.toggle('hidden', theme !== 'mecha');
  // 机甲背景图类
  document.body.classList.toggle('has-mecha-bg', theme === 'mecha');
  // 赛博朋克背景图类（手柄底座已内嵌 viewStory，不必单独显隐）
  document.body.classList.toggle('has-cyber-bg', theme === 'cyber');
  // 古风国潮背景图类
  document.body.classList.toggle('has-guofeng-bg', theme === 'guofeng');
  $$('.theme-btns .theme').forEach(b=> b.classList.toggle('active', b.dataset.theme === theme));
  updateMechaNav();
  updateWcTotal(); // 主题切换后刷新内嵌总字数
}
function restartCascade(){
  // 3D 黑板主题下，每次切换步骤重放“拉下新黑板”动画
  if(document.documentElement.getAttribute('data-theme') !== 'blackboard') return;
  const v = $('#view'); if(!v) return;
  v.style.animation = 'none'; void v.offsetWidth; v.style.animation = '';
}

/* =========================================================
 * 多项目历史库：fyp_state（单项目）→ fyp_lib（最多 10 个项目）
 * ========================================================= */
function makeId(){ return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

// 从当前 state 捕获一个项目快照（含步骤，供切换恢复）
function projectSnapshot(){
  return {
    mode: state.mode || 'shortfilm',
    recipe: state.recipe || 'mesh',
    idea: state.idea,
    coverPrompt: state.coverPrompt,
    coverWithTitle: state.coverWithTitle,
    outline: state.outline,
    outlineConfirmed: state.outlineConfirmed,
    chapters: state.chapters,
    characters: state.characters,
    scenes: state.scenes,
    storyboard: state.storyboard,
    boardConcepts: state.boardConcepts,
    raw: state.raw,
    step: currentStep,
    title: (state.outline && state.outline.title) || (state.idea ? state.idea.trim().slice(0,20) : '未命名作品'),
    logline: (state.outline && state.outline.logline) || ''
  };
}
// 把项目快照写入当前 state；内容缺失/损坏时切到空白但保持调用方可控
function applyProject(p){
  state.mode = (p.mode === 'longnovel') ? 'longnovel' : 'shortfilm';
  state.recipe = p.recipe || 'mesh';
  state.idea = p.idea || '';
  state.coverPrompt = p.coverPrompt || '';
  state.coverWithTitle = !!p.coverWithTitle;
  state.outline = p.outline || null;
  state.outlineConfirmed = !!p.outlineConfirmed;
  state.chapters = p.chapters || [];
  state.characters = p.characters || [];
  state.scenes = p.scenes || [];
  state.storyboard = p.storyboard || [];
  state.boardConcepts = p.boardConcepts || [];
  state.raw = p.raw || {};
  currentStep = (p.step && p.step >= 1 && p.step <= 5) ? p.step : 1;
}
function clearState(){
  state.mode = 'shortfilm';
  state.recipe = 'mesh';
  state.idea = ''; state.outline = null; state.coverPrompt = ''; state.coverWithTitle = false; state.outlineConfirmed = false;
  state.chapters = []; state.characters = []; state.scenes = []; state.storyboard = []; state.boardConcepts = []; state.raw = {};
  currentStep = 1;
}
function saveLib(){
  localStorage.setItem(KEY_LIB, JSON.stringify(lib));
}
function robustSaveLib(){
  try{
    saveLib();
  }catch(e){
    // 存储满兜底：淘汰最旧非当前项目后重试
    if(/quota/i.test(String(e.name + e.message))){
      const others = lib.items.filter(i=> i.id !== lib.curId);
      if(others.length){
        others.sort((a,b)=> (a.updatedAt||0) - (b.updatedAt||0));
        lib.items = lib.items.filter(i=> i.id !== others[0].id);
        try{ saveLib(); }catch(e2){}
      }
    }
  }
}
// 首次加载：迁移旧单项目 fyp_state → 第一个项目；否则读历史库
function loadState(){
  clearState();
  try{
    const raw = localStorage.getItem(KEY_LIB);
    if(raw){
      const parsed = JSON.parse(raw);
      if(parsed && Array.isArray(parsed.items)){
        lib = parsed;
        // 保持 curId 有效
        if(!lib.items.some(i=> i.id === lib.curId)) lib.curId = lib.items[0] && lib.items[0].id;
        if(lib.curId){ const cur = lib.items.find(i=> i.id === lib.curId); if(cur) applyProject(cur); }
        return;
      }
    }
  }catch(e){}
  // 无新库：尝试迁移旧版单项目 fyp_state
  migrateOldState();
}
function migrateOldState(){
  try{
    const s = JSON.parse(localStorage.getItem(KEY_STATE));
    if(!s || typeof s !== 'object') return;
    Object.assign(state, s);
    state.raw = s.raw || {};
    currentStep = (s.step && s.step >= 1 && s.step <= 5) ? s.step : 1;
    const snap = projectSnapshot();
    lib = { curId: snap.id = makeId(), items: [{ ...snap, updatedAt: Date.now() }] };
    saveLib();
    localStorage.removeItem(KEY_STATE);
  }catch(e){}
}
// persist：把当前状态补存到当前项目（含当前步骤），便于切换后恢复
function persist(){
  // 尚无当前项目时，自动新建一个
  if(!lib.items.some(i=> i.id === lib.curId)){
    const snap = projectSnapshot();
    const newId = makeId();
    lib.items.unshift({ ...snap, id: newId, updatedAt: Date.now() });
    lib.curId = newId;
  }
  const idx = lib.items.findIndex(i=> i.id === lib.curId);
  if(idx >= 0){
    const snap = projectSnapshot();
    lib.items[idx] = { ...snap, id: lib.curId, updatedAt: Date.now() };
  }
  robustSaveLib();
}

/* ---------- DeepSeek 调用（浏览器直连，已验证支持 CORS） ---------- */
async function callDeepSeek(system, user, {temperature=null, signal}={}){
  const cfg = getCfg();
  if(!cfg.apiKey) throw new Error('请先到 ⚙️ 填写 DeepSeek API Key');
  const base = (cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const body = {
    model: cfg.model || 'deepseek-v4-pro',
    messages: [{role:'system', content: system}, {role:'user', content: user}],
    temperature: (temperature==null ? (cfg.temperature ?? 0.7) : temperature),
    stream: false
  };
  let res;
  try{
    res = await fetch(url, {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+cfg.apiKey},
      body: JSON.stringify(body),
      signal
    });
  }catch(e){
    throw new Error('网络/跨域失败：' + e.message + '。若被拦截，可在设置里填一个代理地址。');
  }
  if(!res.ok){
    let msg = '请求失败 ('+res.status+')';
    try{ const j = await res.json(); if(j.error && j.error.message) msg = j.error.message; }catch(e){}
    throw new Error(msg);
  }
  const data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

/* 容错 JSON 解析：去代码围栏、抽取首尾 {} 或 [] */
function parseJson(text){
  if(!text) throw new Error('模型返回为空');
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(fence) t = fence[1].trim();
  try{ return JSON.parse(t); }catch(e){}
  const m = t.match(/[\{\[][\s\S]*[\}\]]/);
  if(m){ try{ return JSON.parse(m[0]); }catch(e){} }
  throw new Error('返回不是合法 JSON（已原样保留，可在导出中查看）');
}

/* 按钮忙碌态 */
function busy(btn, on, label){
  if(on){ btn._txt = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'+(label||'生成中…'); }
  else { btn.disabled = false; btn.innerHTML = btn._txt; }
}

/* =========================================================
 * 提示词模板（中文，面向国内 + 即梦）
 * ========================================================= */
const PROMPTS = {
  outlineSys: `你是一位专业编剧与故事架构师，擅长短剧/短视频叙事。根据用户的一句或几句话构想，设计一部适合改编为短视频的故事。
请严格只输出如下 JSON（不要任何解释、不要 markdown 代码块）：
{"title":"故事标题","logline":"一句话梗概（含核心冲突）","chapters":[{"title":"第1章标题","summary":"该章核心事件与转折，1-2句"}]}
要求：chapters 数量按故事体量在 6-12 章之间；标题有钩子感；summay 体现人物动机与情节推进。`,

  chapterSys: `你是一位擅长网文与短剧的编剧。请根据「故事大纲」与「本章概要」写出本章完整正文。
要求：有强画面感、对话自然、节奏明快、推进剧情；篇幅 800-1500 字；只输出正文，不要标题、不要解释。`,

  characterSys: `你是一位影视角色设定师。根据完整故事，提取主要角色（3-6 个，含主角与关键配角），为每个角色产出「影视前期定妆提示词包」，用于用户粘贴到「即梦(Dreamina)」生成角色参考图。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"characters":[{"name":"角色名","role":"身份/作用","profile":{"年龄":"","性别":"","身份":"","性格":"","外貌":"脸型/发型/瞳色/身形等","常服与配色":"","标志性道具":"","材质质感":""},
"prompts":{"定妆图":"全身定妆图提示词，需固化固定外貌特征以保证后续垫图一致性","三视图":"正面/侧面/背面描述","表情":"喜/怒/哀/惊等表情参考","服饰细节":"衣物纹样与剪裁放大","道具":"武器/饰品/随身物","配色":"主色/辅色/点缀色色板","材质":"布料/金属/皮革等质感"}}]}
要求：所有 prompts 为中文、具体、可直接粘贴即梦；『定妆图』要写清不变的身份特征；风格统一。`,

  sceneSys: `你是一位美术/场景设定师。根据故事与角色，提取关键场景（4-8 个），产出即梦出图提示词。
⚠️ 重要：场景是「纯环境/空间设定」——它是无人物、无角色的环境模型（空镜），供视频 AI 作环境参考。**严禁出现任何人物、角色、人形、剪影、拟人元素**。出图提示词必须以环境为主体（空间结构/陈设/材质/光线/氛围/天气/时间感），并在提示词末尾附上负向约束：no people, no characters, no humans, no silhouettes, no figures, empty of people。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"scenes":[{"name":"场景名","作用":"在故事中的功能","description":"场景文字设定","prompt":"即梦出图提示词（中文，含风格/光线/氛围/构图，可直接粘贴；末尾附 no people 等负向约束）"}]}
要求：prompt 贴合即梦习惯，风格与整体基调一致；每条 prompt 必须体现「无人环境」这一核心语义。`,

  storyboardSys: `你是一位资深分镜师/导演。根据故事、角色、场景，为【指定章节】产出导演级短视频分镜表。
工作方法（导演脑前置）：
1. 先提炼本章「视觉概念」：一句可证伪、专属本章、能派生镜头序列的画面主意（拒绝"气氛很好"式空话）。
2. 再设计「母题」：建立(镜N) → 变奏(镜M) → 打破/兑现(镜K) 的镜头落点。
3. 最后拆镜头：每镜是一个连续 take，镜间有受控的剪辑动机；只写可拍摄、可生成、可校验的物理事实（拒绝比喻与情绪散文）。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"视觉概念":"本章一句画面主意","母题":"建立→变奏→打破","shots":[{"镜号":1,"时长":3,"景别":"","角度":"","运镜":"","主体":"本镜主体是谁/什么","构图":"主体位置/景深","光线":"","画面描述":"本镜画面与动作","对白":"台词或旁白，无则空","转场":"","出图提示词":"即梦出图提示词（中文，按 运镜+镜头感+主体+风格+光线+比例 拼装；引用对应角色定妆特征与场景，保证一致性）","连续性":"入口引用/出口状态","剪辑动机":"为什么接这一镜"}]}
【镜头技巧库】取值请从这里选：
- 景别：大特写/特写/近景/中景/全景/远景/过肩
- 角度：平视/仰拍/俯拍/荷兰角/鸟瞰/顶视
- 运镜：推/拉/摇/移/跟/升降/环绕/手持/变焦/航拍
- 光线：黄金时刻/柔光漫射/霓虹背光/体积光/轮廓光/烛光暗调
- 转场：硬切/叠化/淡入淡出/匹配剪辑/甩镜
要求：镜号从 1 开始连续；每章 6-12 镜，按本章情节密度增减；每镜时长 2-6 秒，对话密集或大动作镜头可到 8 秒，须填具体秒数；出图提示词可直接粘贴即梦。`,

  // —— 经典长篇小说模式 ——
  coverSysClean: `你是一位资深书籍装帧设计师与插画师。根据用户提供的小说标题与故事梗概，为这部小说的【封面图】产出一条可粘贴到「即梦(Dreamina)」的中文出图提示词【纯画面版，不含任何文字】。
要求：画面要抓住小说核心意象与情绪（世界观/主角困境/关键场景），构图强烈、光影戏剧化、色彩有记忆点；为封面预留的书法/书名排布位置要留出充足留白（如顶部或居中留白区），方便排版方后期加字；长度 150-280 字；结尾可附风格关键词（如"电影级打光、史诗感、高对比、厚涂插画"）；**严禁生成任何文字/标题/字幕/笔画**，画面里不要出现可辨认的汉字或拼音字母；只输出提示词正文，不要解释、不要 markdown 代码块。`,

  coverSysTitle: `你是一位资深书籍装帧设计师与插画师。根据用户提供的小说标题与故事梗概，为这部小说的【封面图】产出一条可粘贴到「即梦(Dreamina)」的中文出图提示词【含书名文字版】。
要求：画面要抓住小说核心意象与情绪（世界观/主角困境/关键场景），构图强烈、光影戏剧化、色彩有记忆点；**封面需包含书法风格的【书名汉字】作为主体文字**，请把小说标题精准写入提示词，指定其为封面主文字（如"金色书法大字『书名』题于画面中央/顶部，字迹遒劲、带有水墨或烫金质感"）；其余可附风格关键词；长度 150-280 字；只输出提示词正文，不要解释、不要 markdown 代码块。`,

  coverSys: `你是一位资深书籍装帧设计师与插画师。根据用户提供的小说标题与故事梗概，为这部小说的【封面图】产出一条可粘贴到「即梦(Dreamina)」的中文出图提示词【纯画面版，不含任何文字】。
要求：画面要抓住小说核心意象与情绪（世界观/主角困境/关键场景），构图强烈、光影戏剧化、色彩有记忆点；为封面预留的书法/书名排布位置要留出充足留白（如顶部或居中留白区），方便排版方后期加字；长度 150-280 字；结尾可附风格关键词（如"电影级打光、史诗感、高对比、厚涂插画"）；**严禁生成任何文字/标题/字幕/笔画**，画面里不要出现可辨认的汉字或拼音字母；只输出提示词正文，不要解释、不要 markdown 代码块。`,

  longOutlineSys: `你是一位能驾驭超长篇的著名小说架构师。根据用户的一句话或几句构想，设计一部经典的【长篇小说】，最终成品体量约 30 万字。
你不能用三幕流水的短剧套路来搭长篇，而要用真正的长篇小说结构美学来设计骨架。请严格只输出如下 JSON（不要任何解释、不要 markdown 代码块）：
{"title":"小说名","logline":"一句话梗概（含核心冲突与深层命题）","structure":{"mode":"结构模式","designReason":"为何选此结构、其精妙之处","mainLine":"主线：贯穿始终的核心冲突","subLines":["副线1：具体内容","副线2：具体内容"],"hiddenLine":"暗线：先埋设后揭晓的隐藏真相","pivotChapter":"多线汇合/大逆转所在章号(如 24)","threeFix":"三定：定时间轴 / 定汇合点 / 定主次(哪条线是主轴)"},"chapters":[{"title":"第1章标题","summary":"该章核心事件与转折，1-2句","line":"该章推进哪条线/埋哪个伏笔/节奏起伏"}]}
选择结构模式时，默认优先采用【多线交织或网状交织】（次选单线因果、板块拼贴或闭环循环），并补齐 mainLine / subLines / hiddenLine 三条以上的叙事线索；多线必须做到"三定"：定时间轴、定汇合点（在哪一章几条线收束汇合）、定主次（以一条线为轴，其余服务它），否则会散架。暗线要从早期章节就埋设，直到结局呼应揭晓。章节总数 32-40 章（以便按 5 章一批逐步撰写，最终约 30 万字）。每章 title 有钩子感，summary 写清人物动机、情节推进与本批应埋伏笔；line 标注该章归属的线索与节奏（如"主线推进/暗线植入/支线完成/情绪张力升高"），使整体节奏有跌宕起伏的事件密度控制，而非平铺。`,

  longChapterSys: `你是一位中文长篇小说的资深写手。根据「整体结构」「故事大纲」与「本章概要」写出本章完整正文，做到章章服务整体架构，绝不悬空发散。
要求：单章篇幅 7000-9000 字；严格围绕本章概要推进，同时照顾它在全书结构中的位置——本线、伏笔、明暗线呼应；细腻的环境与心理描写、生动对话、符合人物弧光；节奏张弛有度（本章若是情绪高潮或转折则加压，若是过渡则蓄力）；章末留悬念或钩子，为后续章节/伏笔回落埋线；只输出正文，不要标题、不要"本章完/未完待续"之类片尾标注、不要任何解释。`,

  editorSys: `你是一位挑剔而专业的长篇小说编辑。请对「给定的一章初稿」做三维审查，并输出 JSON 评分与本轮审稿意见。
三个维度：角色一致性（人物性格/弧光是否符合设定）、剧情逻辑（因果是否合理、是否违背前文/时间线）、世界观一致（设定/能力/专名是否统一、是否出现硬伤）。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"role":0,"plot":0,"world":0,"pass":true,"issues":["问题1","问题2"],"advice":"若 pass 为 false，给出具体到段落的重写方向"}
rules：role/plot/world 各按 0-100 打分；pass=true 当且仅当三维都 ≥70；issues 列出未达标维度的具体问题；advice 简明可执行。`
};

/* =========================================================
 * 长篇写作范式（借助开源方案提炼，可切换）
 * 每种范式 = 大纲提示词 + 章节提示词 + 是否注入结构上下文 + 是否走双审
 * ---------------------------------------------------------
 * mesh   多线网状交织   借鉴《红楼梦/水浒》网状多线 + 暗线早埋结局揭晓（默认）
 * layered分层递归展开   借鉴 Long-Novel-GPT / AI_Gen_Novel：卷→部→章→节逐级细分
 * dual   写手-编辑双审   借鉴 NovelForge：写手起草 + 编辑按角色/剧情/世界观三维打分修订
 * web    黄金网文节奏    借鉴网文爆款体系：开篇抛钩子、因果链清晰、爽点-压抑-爆发交替
 * ========================================================= */
const LONG_RECIPES = [
  { id:'mesh', name:'多线网状交织', tag:'默认·大师结构', useStructure:true, useEditor:false,
    outlineSys: PROMPTS.longOutlineSys,
    chapterSys: PROMPTS.longChapterSys,
    desc:'借鉴《红楼梦》式网状多线：多条主线 + 副线 + 暗线同时推进并在汇合章收束，暗线早期埋设、结局揭晓。适合宏大世界观与群像坑。' },
  { id:'layered', name:'分层递归展开', tag:'借鉴 Long-Novel-GPT', useStructure:false, useEditor:false,
    outlineSys: `你是能驾驭超长篇的著名小说架构师。按【卷→部→章】分层递归地设计一部长篇小说（约 30 万字，32-40 章）。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"title":"小说名","logline":"一句话梗概","volumes":[{"name":"第X卷卷名","theme":"本卷主题与情绪基调","chapters":[{"title":"章标题","summary":"本章核心事件与转折，1-2句","goal":"本章阶段性目标/推进什么"}]}]}
要求：整体分 2-4 卷，各卷有清晰主题与情绪递进；每卷内章节数合理（总 32-40 章）；章章承担阶段性目标（引入/冲突/转折/高潮/收束），卷与书之间存在因果链；标题有钩子感。`,
    chapterSys: `你是中文长篇小说的资深写手。根据「本卷主题」「本章目标」与「本章概要」写出本章完整正文，做到章章承接上卷、为后续蓄力。
要求：单章篇幅 7000-9000 字；围绕“本章目标”进（该引入就引入、该冲突就冲突、该转折就转折），承接上一卷已建立的人物与世界设定、不推倒重来；有细腻环境与心理描写、生动对话、人物弧光；章末留钩子或悬念；只输出正文，不要标题、不要"本章完/未完待续"标注、不要任何解释。`,
    desc:'借鉴 Long-Novel-GPT / AI_Gen_Novel 的“卷→部→章→节”分层递归：先生成全局卷章框架，再逐卷逐章填充目标。适合目标明确、结构清晰的类型文。' },
  { id:'dual', name:'写手-编辑双审', tag:'借鉴 NovelForge', useStructure:true, useEditor:true,
    outlineSys: PROMPTS.longOutlineSys,
    chapterSys: PROMPTS.longChapterSys,
    desc:'借鉴 NovelForge 的 Writer-Editor 多轮协作：写手起草初稿，再用“编辑”评审按角色一致性/剧情逻辑/世界观三维打分（0-100），低于阈值自动让写手修订。质量更稳、消耗约双倍调用。' },
  { id:'web', name:'黄金网文节奏', tag:'借鉴网文爆款体系', useStructure:false, useEditor:false,
    outlineSys: `你是深谙网文爆款逻辑的资深网文作者。根据用户构想设计一部长篇网文（约 30 万字，32-40 章）。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"title":"书名","logline":"一句话卖点（含核心爽点与悬念）","chapters":[{"title":"章标题","summary":"本章核心事件与爽点/转折，1-2句","hook":"本章结尾钩子/悬念"}]}
要求：遵循强节奏网文写法——开篇尽快抛核心冲突与悬念；因果链清晰、角色抉择有代价、实力或关系阶梯递进、情绪节奏有张有弛（爽点-压抑-爆发交替）；每章 summary 写清本集的“爽点”与推进，hook 写清章末钩子；总 32-40 章。`,
    chapterSys: `你是资深网文写手。根据「本章概要」与「章末钩子」写出本章正文，保证读者追更欲。
要求：单章篇幅 7000-9000 字；开篇(前1-2段)尽快进入事件或情绪；以对话与行动推动剧情、少冗长环境描写；本章须兑现一个"爽点/进展"，并为下章留钩子（悬念/反转/危机）；因果清晰、有记忆点的人设；章末务必切在钩子上；只输出正文，不要标题、不要"本章完/未完待续"标注、不要任何解释。`,
    desc:'借鉴网文爆款节奏体系：开篇抛钩子、因果链清晰、阶梯递进、爽爆交替、章末强钩子。适合升级流、爽文、快节奏类型。' }
];
function longRecipe(){ return LONG_RECIPES.find(r=> r.id === state.recipe) || LONG_RECIPES[0]; }
function longOutlineSys(){ return longRecipe().outlineSys; }
function longChapterSys(){ return longRecipe().chapterSys; }

function fullStoryText(){
  return state.chapters.map(c => `【${c.title}】\n${c.content}`).join('\n\n');
}

function isLong(){ return state.mode === 'longnovel'; }

/* =========================================================
 * 创作规范：仅作用于「写小说」环节（大纲 + 章节正文）。
 * 角色 / 场景 / 分镜提示词生成不使用规范，保持独立性。
 * ========================================================= */
const SPECS = [
  { id:'full',        name:'完整长篇',     short:'完整长篇',
    desc:'生成全部章节的完整小说。默认行为，不选任何其他规范时即是此模式。',
    sys:'' },
  { id:'planfirst',   name:'先规划再动笔', short:'先规划',
    desc:'先确立世界观、人物小传与伏笔架构再动笔；章章服务整体，章末留钩子。',
    sys:'动笔前先确立清晰的世界观（时代/地理/力量或社会规则）、主要人物小传（动机/弧光/关系网）与贯穿全书的伏笔与核心冲突。每一章都须服务于整体架构，避免随意发散；章末务必留钩子。' },
  { id:'webnovel',    name:'黄金网文节奏', short:'网文节奏',
    desc:'开篇抛冲突与悬念；因果链清晰、抉择有代价、阶梯递进、情绪张弛有度。',
    sys:'遵循强节奏网文写法：开篇尽快抛出核心冲突与悬念（金手指/秘密）；每章保证因果链清晰、角色抉择有代价、实力或关系阶梯递进、情绪节奏有张有弛（爽点-压抑-爆发交替）；以对话推动剧情、少冗长描写；章末必留钩子。' },
  { id:'consistency', name:'强一致性自检', short:'一致性',
    desc:'每章生成后自检时间线/性格/视角/伏笔/专名，与上文冲突即自我修正。',
    sys:'生成每一章后，自行核对并维持一致性：时间线不矛盾、人物性格与外貌前后统一、POV 视角不跳脱、已铺设伏笔需回收或有交代、地名与专有名词拼写统一；若与上文冲突须自我修正。' },
  { id:'character',   name:'角色/情节驱动', short:'角色驱动',
    desc:'以人物弧光与强情节为核心，弱化宏大世界观，单线深挖、心理优先。',
    sys:'以人物弧光与强情节为核心，弱化宏大世界观铺陈。每一章聚焦角色在压力下的抉择与关系变化，用紧凑单线深挖取代多线铺开；心理描写优先于环境描写。' }
];
function getSpec(){
  const cfg = getCfg();
  const id = cfg.spec || 'full';
  return SPECS.find(s=>s.id===id) || SPECS[0];
}
function specSysAddition(){
  const s = getSpec();
  return (s && s.sys) ? '\n\n【本次创作规范 · '+s.name+'】\n'+s.sys : '';
}

/* =========================================================
 * 渲染：各步骤视图
 * ========================================================= */
function renderStepper(){
  const steps = [
    {n:1,t:'故事构想'},{n:2,t:'角色提示词'},{n:3,t:'场景提示词'},
    {n:4,t:'分镜文字'},{n:5,t:'导出资产包'}
  ];
  $('#stepper').innerHTML = steps.map(s=>{
    const cls = s.n===currentStep ? 'active' : (s.n<currentStep ? 'done' : '');
    return `<span class="chip ${cls}">${s.n<currentStep?'✓ ':''}${s.t}</span>`;
  }).join('');
}

function updateMechaNav(){
  const mtn = $('#mechaTopNav'); if(!mtn) return;
  $$('.cap', mtn).forEach(c=>{
    const n = c.dataset.step ? +c.dataset.step : null;
    c.classList.toggle('active', n && n === currentStep);
  });
}

function render(){
  destroyCharTS(); // 先销毁旧 Tom Select，避免 DOM 残留/重复实例
  restartCascade();
  renderStepper();
  updateMechaNav();
  $$('.tab').forEach(t=>{
    const n = +t.dataset.step;
    // 长篇模式隐藏「角色」「分镜」（不需要生成视频提示词）
    const hideLong = isLong() && (n===2 || n===4);
    t.classList.toggle('hidden', hideLong);
    t.classList.toggle('active', n===currentStep);
  });
  const v = $('#view');
  if(currentStep===1) v.innerHTML = viewStory();
  else if(currentStep===2) v.innerHTML = viewCharacters();
  else if(currentStep===3) v.innerHTML = viewScenes();
  else if(currentStep===4) v.innerHTML = viewStoryboard();
  else if(currentStep===5) v.innerHTML = viewExport();
  bindView();
  updateWcTotal();
}

/* ---------- P1 故事 ---------- */
const CYBER_HOME_GRID = `
  <div class="cyber-home-grid">
    <button class="cyber-card-btn purple" data-step="1"><span class="ico">📖</span><span class="lab">故事</span><span class="sub">输入构想并生成章节</span></button>
    <button class="cyber-card-btn cyan" data-step="2"><span class="ico">🧑</span><span class="lab">角色</span><span class="sub">生成角色定妆提示词</span></button>
    <button class="cyber-card-btn pink" data-step="3"><span class="ico">🏞️</span><span class="lab">场景</span><span class="sub">生成场景即梦提示词</span></button>
    <button class="cyber-card-btn orange" data-step="4"><span class="ico">🎞️</span><span class="lab">分镜</span><span class="sub">生成视频分镜文字</span></button>
  </div>`;

function viewStory(){
  if(!state.outline){
    const homeSub = isLong()
      ? '用几句话描述你的长篇构想（世界观、主角、核心冲突都行）。AI 会扩写成 32-40 章大纲，之后按「5 章一批」逐步写到约 30 万字。'
      : '用几句话描述你的点子（世界观、主角、核心冲突都行）。AI 会扩写成完整故事大纲与章节。';
    return CYBER_HOME_GRID + `
    <div class="card">
      <h3>① 输入故事构想</h3>
      <p class="sub">${homeSub}</p>
      ${ isLong() ? recipePicker() : '' }
      ${ isLong() ? '' : `<div class="spec-current" id="specCurrentBtn" title="点击修改创作规范">当前创作规范：<b>${esc(getSpec().name)}</b> · 点击右上角 ⚖️ 修改</div>` }
      <textarea id="ideaInput" placeholder="例：现代都市，一个能听见别人心声的外卖员，意外卷进一起豪门遗产骗局……">${esc(state.idea)}</textarea>
      <div class="btn-row">
        <button id="btnGenOutline" class="btn primary block">${isLong()?'📚 生成长篇大纲':'✨ 生成故事大纲'}</button>
      </div>
      <p id="outlineStatus" class="status"></p>
    </div>`;
  }
  // 大纲已生成
  const o = state.outline;
  let html = `
    <div class="card">
      <h3>📋 故事大纲：${esc(o.title||'')}</h3>
      <p class="sub">${esc(o.logline||'')}</p>
      <div style="margin:10px 0">${ (o.chapters||[]).map((c,i)=>`<span class="pill">${i+1}. ${esc(c.title)}</span>`).join('') }</div>
      ${ structureCard(o) }
      ${ state.outlineConfirmed ? `
        <div class="btn-row"><span class="pill tag-ok">✓ 大纲已确认</span></div>
        ${ isLong() ? `<div class="btn-row" style="margin-top:8px">
          <label class="long-jump"><span>跳到章节：</span>
          <select id="longJump"><option value="">— 选择章节阅读 —</option>${state.chapters.map((c,i)=>`<option value="${i}">第${i+1}章 ${esc(c.title)}</option>`).join('')}</select></label>
        </div>` : '' }
        <div id="chaptersWrap"></div>
        <div class="btn-row" style="margin-top:12px">
          <button id="btnGenAllChapters" class="btn primary">${isLong()?'⚡ 生成下一批 5 章':'⚡ 一键生成全部章节'}</button>
          <button id="btnReOutline" class="btn ghost">重生成大纲</button>
        </div>
        <p id="chStatus" class="status"></p>
        ${ isLong() ? `<div class="long-progress"></div>` : '' }
        <div id="wcTotal" class="wc-total hidden"></div>
        <div class="cyber-pad hidden"></div>
      ` : `
        <div class="btn-row">
          <button id="btnConfirmOutline" class="btn primary">✓ 确认大纲，进入写正文</button>
          <button id="btnReOutline" class="btn ghost">重生成</button>
        </div>
      ` }
    </div>`;
  return html;
}

function renderChapters(){
  const wrap = $('#chaptersWrap'); if(!wrap) return;
  wrap.innerHTML = state.chapters.map((c,i)=>`
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <div style="display:flex;align-items:center;gap:8px;min-width:0">
          <h3 style="margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">第${i+1}章 · ${esc(c.title)}</h3>
          ${wcBadge(c.content, `data-wc-ch="${i}"`)}
        </div>
        <span class="pill ${c.confirmed?'tag-ok':'tag-warn'}">${c.confirmed?'✓ 已确认':'待确认'}</span>
      </div>
      <textarea data-ch="${i}" style="margin-top:8px">${esc(c.content)}</textarea>
      <div class="btn-row">
        <button class="btn ghost" data-regen="${i}">🔄 重生成</button>
        <button class="btn ghost" data-read="${i}" ${c.content&&c.content.trim()?'':'disabled'}>📖 阅读</button>
        <button class="btn ghost" data-toggle="${i}">${c.confirmed?'↺ 取消确认':'✓ 标记已确认'}</button>
      </div>
    </div>`).join('');
}

/* ---------- 沉浸式章节阅读 ---------- */
function openReader(i){
  const c = state.chapters[i]; if(!c) return;
  const ov = $('#readerOverlay'); if(!ov) return;
  $('#readerTitle').textContent = `第${i+1}章 · ${c.title||''}`;
  const paras = String(c.content||'').split(/\n+/).map(p=>p.trim()).filter(Boolean);
  $('#readerBody').innerHTML = paras.length ? paras.map(p=>`<p>${esc(p)}</p>`).join('')
    : `<p class="muted">（本章暂无正文）</p>`;
  ov.classList.remove('hidden');
  document.body.classList.add('reader-lock'); // 锁定背景滚动
}
function closeReader(){
  const ov = $('#readerOverlay'); if(!ov) return;
  ov.classList.add('hidden');
  document.body.classList.remove('reader-lock');
}
function bindReader(){
  const ov = $('#readerOverlay'); if(!ov) return;
  $$('[data-reader-close]', ov).forEach(el=> el.onclick = (e)=>{
    // 点击面板内部不关闭（backdrop 与 ✕ 按钮才关闭）
    if(e.target.closest('.reader-panel') && !e.target.closest('.reader-close')) return;
    closeReader();
  });
}
document.addEventListener('keydown', (e)=>{
  if(e.key === 'Escape'){
    closeReader();
    const h = $('#histPanel'); if(h && !h.classList.contains('hidden')) closeHistPanel();
    const p = $('#specPanel'); if(p && !p.classList.contains('hidden')) closeSpecPanel();
  }
});

/* ---------- 字数角标实时更新 + 页面末尾总字数 ---------- */
function updateChapterWc(i, text){
  const el = $('[data-wc-ch="'+i+'"]');
  if(!el) return;
  const w = countWords(text);
  el.innerHTML = wcInner(w);
  el.title = `中文 ${w.cjk} 字 · 英文 ${w.en} 词`;
}
function updateWcTotal(){
  const el = $('#wcTotal'); if(!el) return;
  const chapters = state.chapters.filter(c=> c.content && c.content.trim());
  if(!chapters.length){ el.classList.add('hidden'); el.innerHTML=''; return; }
  let total=0, cjk=0, en=0;
  chapters.forEach(c=>{ const w = countWords(c.content); total+=w.total; cjk+=w.cjk; en+=w.en; });
  const fmt = n=> n.toLocaleString('en-US');
  el.classList.remove('hidden');
  el.innerHTML = `<span class="inner">📚 小说内容总字数 <b>${fmt(total)}</b> <span class="brk">（中 ${fmt(cjk)} · 英 ${en}）</span></span>`;
}

/* 长篇模式：写入进度（已写/总章数 + 估算字数目标） */
function renderLongProgress(){
  const el = $('.long-progress'); if(!el) return;
  const done = state.chapters.filter(c=> c.content && c.content.trim()).length;
  const total = state.chapters.length;
  let chars = 0; state.chapters.forEach(c=> chars += countWords(c.content).total);
  el.innerHTML = `<span class="pill">写作进度：${done}/${total} 章</span> <span class="pill">已写约 ${chars.toLocaleString('en-US')} 字（目标 30 万字）</span>`;
}

/* ---------- P2 角色 ---------- */
function viewCharacters(){
  if(!readyForAssets()){
    return `<div class="center-empty">请先在「故事」里确认大纲并生成章节。<br>角色提示词需要基于完整故事生成。</div>`;
  }
  if(!state.characters.length){
    return `<div class="card">
      <h3>🧑 角色定妆提示词包</h3>
      <p class="sub">基于已确认故事，AI 抽取主要角色，并为每个角色产出：定妆图 / 三视图 / 表情 / 服饰 / 道具 / 配色 / 材质 共 7 组即梦提示词。</p>
      <button id="btnGenChars" class="btn primary block">✨ 生成角色定妆提示词</button>
      <p id="charStatus" class="status"></p>
    </div>`;
  }
  const ids = [...new Set(state.characters.map(c=>(c.profile&&c.profile.身份)||c.role||'').filter(Boolean))];
  const identOptions = ids.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('');
  return `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h3>🧑 角色定妆提示词包（${state.characters.length}）</h3>
        <button id="btnGenChars" class="btn ghost">🔄 重生成</button>
      </div>
      <div class="char-toolbar">
        <input id="charSearch" class="char-search" placeholder="🔍 搜索角色姓名 / 身份…" value="${esc(charFilters.q)}">
        <select id="charJump" class="char-jump" placeholder="选择角色快速定位"></select>
        <select id="charIdent" multiple placeholder="身份筛选（可多选）">${identOptions}</select>
        <div class="char-filters">
          <select id="charGender">
            <option value="" ${charFilters.gender===''?'selected':''}>性别：全部</option>
            <option value="男" ${charFilters.gender==='男'?'selected':''}>男</option>
            <option value="女" ${charFilters.gender==='女'?'selected':''}>女</option>
            <option value="其他" ${charFilters.gender==='其他'?'selected':''}>其他</option>
          </select>
          <div class="cf-age">
            <input type="number" id="ageMin" class="age-input" placeholder="年龄≥" min="0" max="200" value="${esc(charFilters.ageMin)}">
            <span class="age-sep">~</span>
            <input type="number" id="ageMax" class="age-input" placeholder="年龄≤" min="0" max="200" value="${esc(charFilters.ageMax)}">
          </div>
        </div>
        <div class="char-count" id="charCount"></div>
      </div>
    </div>
    <div id="charList">${charFiltered().map(idx=>charCard(state.characters[idx], idx)).join('')}</div>` + fallbackRaw('characters');
}

function charCard(c, idx){
  const pf = c.profile||{};
  const kv = Object.entries(pf).map(([k,v])=>`<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');
  const order = ['定妆图','三视图','表情','服饰细节','道具','配色','材质'];
  const pr = c.prompts||{};
  const cards = order.map(k=>pr[k]==null?'':`
    <div class="subcard">
      <div class="lbl">${esc(k)}<button class="copy" data-copy="${esc(pr[k])}">复制</button></div>
      <div class="prompt-text">${esc(pr[k])}</div>
    </div>`).join('');
  const allText = Object.values(pf).join(' ') + ' ' + Object.values(pr).join(' ');
  return `<div class="card" id="char-${idx}">
    <h3 style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${esc(c.name||'未命名')} <span class="pill">${esc(c.role||'')}</span> ${wcBadge(allText)}</h3>
    <div class="subcard">${kv}</div>
    ${cards}
  </div>`;
}

/* ---------- 角色筛选：搜索 / 身份 / 性别 / 年龄区间（返回保留原索引） ---------- */
function charFiltered(){
  const {q, idents, gender, ageMin, ageMax} = charFilters;
  const min = ageMin===''||ageMin==null ? null : +ageMin;
  const max = ageMax===''||ageMax==null ? null : +ageMax;
  const out = [];
  state.characters.forEach((c,i)=>{
    const pf = c.profile||{};
    if(q){
      const hay = ((c.name||'')+' '+(c.role||'')+' '+(pf.身份||'')).toLowerCase();
      if(!hay.includes(q.toLowerCase())) return;
    }
    if(idents && idents.length){
      const id = pf.身份||c.role||'';
      if(!idents.some(v=> id.includes(v) || v.includes(id))) return;
    }
    if(gender){
      const g = pf.性别||'';
      if(gender==='其他'){ if(g==='男'||g==='女') return; }
      else if(g!==gender && !g.includes(gender)) return;
    }
    if(min!=null || max!=null){
      const age = parseAge(pf.年龄);
      if(age==null) return; // 未知年龄在有区间约束时默认不显示
      if(min!=null && age<min) return;
      if(max!=null && age>max) return;
    }
    out.push(i);
  });
  return out;
}
function applyCharFilters(){
  const wrap = $('#charList'); if(!wrap) return;
  const idxs = charFiltered();
  wrap.innerHTML = idxs.length
    ? idxs.map(i=>charCard(state.characters[i], i)).join('')
    : `<div class="center-empty">没有符合条件的角色，试试放宽筛选条件。</div>`;
  const cnt = $('#charCount');
  if(cnt) cnt.textContent = `显示 ${idxs.length} / ${state.characters.length} 个角色`;
  bindCopyBtns();
}
function bindCopyBtns(){ $$('[data-copy]').forEach(b=> b.onclick = ()=> copyText(b.getAttribute('data-copy')) ); }

/* 角色页筛选/下拉初始化（Tom Select：选择角色快速定位 + 身份多选筛选） */
function initCharFilter(){
  if(!window.TomSelect) return;
  const wrap = $('#charList'); if(!wrap) return;
  // 下拉「选择角色快速定位」
  const jumpSel = $('#charJump');
  if(jumpSel){
    jumpSel.innerHTML = `<option value="">⬇️ 选择角色快速定位…</option>` + state.characters.map((c,i)=>`<option value="${i}">${esc(c.name||'未命名')}${c.role?(' · '+esc(c.role)):''}</option>`).join('');
    try{
      charTS.push(new TomSelect(jumpSel, {
        plugins:['dropdown_input'],
        placeholder:'⬇️ 选择角色快速定位…',
        allowEmptyOption:true,
        onChange: v=>{
          if(v==='' || v==null) return;
          const card = $('#char-'+v);
          if(card){ card.scrollIntoView({behavior:'smooth', block:'center'}); card.classList.add('flash'); setTimeout(()=>card.classList.remove('flash'), 1600); }
        }
      }));
      // 确保空占位
      try{ jumpSel.tomselect.setValue('', true); }catch(e){}
    }catch(e){}
  }
  // 身份多选筛选
  const identSel = $('#charIdent');
  if(identSel){
    try{
      const ts = new TomSelect(identSel, {
        plugins:['dropdown_input','clear_button'],
        placeholder:'身份筛选（可多选）',
        allowEmptyOption:false,
        onChange: v=>{ charFilters.idents = v||[]; applyCharFilters(); }
      });
      charTS.push(ts);
      if(charFilters.idents.length) ts.setValue(charFilters.idents, true);
    }catch(e){}
  }
}

/* ---------- P3 场景 ---------- */
// 封面提示词卡片（含「纯画面无文字 / 含汉字书名」双模式切换），长短篇共用
function coverCardHtml(){
  const modeLab = state.coverWithTitle ? '含汉字书名' : '纯画面·无文字';
  const modeHint = state.coverWithTitle
    ? '封面将包含书名汉字的书法大字作为主体文字。'
    : '封面为纯画面，预留书名留白，仅作底图，文字后期排版。';
  const seg = state.coverWithTitle
    ? `<div class="cover-modes"><button type="button" class="cm-on">🏷️ 含汉字书名</button><button type="button" class="cm-off" data-cv="clean">🖼️ 纯画面</button></div>`
    : `<div class="cover-modes"><button type="button" class="cm-off" data-cv="title">🏷️ 含汉字书名</button><button type="button" class="cm-on">🖼️ 纯画面</button></div>`;
  return `
    <div class="card cover-card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h3 style="margin:0">📕 小说封面提示词</h3>
        <span class="pill" id="coverModeLab">${modeLab}</span>
      </div>
      ${seg}
      <p class="sub">${modeHint}</p>
      ${state.coverPrompt ? `
        <div class="subcard"><div class="lbl">封面提示词<button class="copy" data-copy="${esc(state.coverPrompt)}">复制</button></div><div class="prompt-text">${esc(state.coverPrompt)}</div></div>
        <div class="btn-row" style="margin-top:8px"><button id="btnGenCover" class="btn ghost">🔄 重生成封面提示词</button></div>
      ` : `
        <div class="btn-row"><button id="btnGenCover" class="btn primary block">🖼️ 生成封面提示词</button></div>
        <p id="coverStatus" class="status"></p>
      `}
    </div>`;
}
function viewScenes(){
  if(!readyForAssets()) return `<div class="center-empty">请先在「故事」里确认大纲并生成章节。</div>`;
  // 长篇模式：只需封面提示词，无需"场景/角色/分镜"等视频资产
  if(isLong()) return coverCardHtml();
  const coverCard = coverCardHtml();
  if(!state.scenes.length){
    return coverCard + `<div class="card">
      <h3>🏞️ 场景提示词</h3>
      <p class="sub">AI 抽取关键场景，产出即梦出图提示词（含风格/光线/氛围/构图）。</p>
      <button id="btnGenScenes" class="btn primary block">✨ 生成场景提示词</button>
      <p id="sceneStatus" class="status"></p>
    </div>`;
  }
  return coverCard + `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center">
      <h3>🏞️ 场景提示词（${state.scenes.length}）</h3>
      <button id="btnGenScenes" class="btn ghost">🔄 重生成</button></div></div>` +
    state.scenes.map(s=>`
    <div class="card">
      <h3 style="display:flex;align-items:center;gap:8px">${esc(s.name||'')} <span class="pill tag-env">🌿 纯环境·无人物</span> ${wcBadge((s.description||'')+' '+(s.prompt||''))}</h3>
      <p class="sub">作用：${esc(s.作用||'')}</p>
      <div class="subcard"><div class="lbl">场景设定</div><div class="prompt-text">${esc(s.description||'')}</div></div>
      <div class="subcard"><div class="lbl">即梦出图提示词<button class="copy" data-copy="${esc(s.prompt||'')}">复制</button></div><div class="prompt-text">${esc(s.prompt||'')}</div></div>
    </div>`).join('') + fallbackRaw('scenes');
}

/* ---------- P4 分镜 ---------- */
function viewStoryboard(){
  if(!readyForAssets()) return `<div class="center-empty">请先在「故事」里确认大纲并生成章节。</div>`;
  if(!state.storyboard.length){
    return `<div class="card">
      <h3>🎞️ 分镜文字</h3>
      <p class="sub">AI 按章节产出导演级分镜：每章先给「视觉概念+母题」，再拆镜头（景别/角度/运镜/光线/主体/构图/转场/时长/出图提示词/连续性契约）。每镜的「出图提示词」可直接去即梦出图，时长可手改。</p>
      <button id="btnGenBoard" class="btn primary block">✨ 生成分镜文字（逐章）</button>
      <p id="boardStatus" class="status"></p>
    </div>`;
  }
  // 按章节分组（兼容旧数据：无 章节 的归「未分组」，无 时长 按 3 秒）
  const groups = {};
  state.storyboard.forEach((s,i)=>{ const k = s.章节 || '未分组'; (groups[k]=groups[k]||[]).push(i); });
  const keys = Object.keys(groups).sort((a,b)=>{
    const na=+a, nb=+b;
    return (!isNaN(na)&&!isNaN(nb)) ? na-nb : String(a).localeCompare(String(b),'zh');
  });
  const rows = keys.map(k=>{
    const idxs = groups[k];
    const sec = idxs.reduce((sum,i)=> sum + (Number(state.storyboard[i].时长)||0), 0);
    const ci = (!isNaN(+k)&&state.boardConcepts&&state.boardConcepts[+k-1]) ? state.boardConcepts[+k-1] : null;
    return `<div class="board-ch">
      <div class="board-ch-head">
        <div class="board-ch-title">🎬 第${esc(k)}章</div>
        <div class="board-ch-stat" id="chStat-${esc(k)}">共 ${idxs.length} 镜 · 总时长 ${sec}s</div>
      </div>
      ${ci && (ci.视觉概念||ci.母题) ? `<div class="board-concept"><b>视觉概念：</b>${esc(ci.视觉概念||'')}${ci.母题?('<br><b>母题：</b>'+esc(ci.母题)):''}</div>`:''}
      ${idxs.map(i=>shotHtml(i)).join('')}
    </div>`;
  }).join('');
  const totalSec = state.storyboard.reduce((sum,s)=> sum + (Number(s.时长)||0), 0);
  return `<div class="card" style="display:flex;justify-content:space-between;align-items:center">
      <h3>🎞️ 分镜（${state.storyboard.length} 镜）</h3>
      <button id="btnGenBoard" class="btn ghost">🔄 重生成</button>
    </div>${rows}
    <div class="card board-total">⏱ 全局：<b id="boardTotal">共 ${state.storyboard.length} 镜 · 总时长 ${totalSec}s</b><span class="muted">（每镜时长可点击数字直接修改，统计实时联动）</span></div>`
    + fallbackRaw('storyboard');
}
function shotHtml(i){
  const s = state.storyboard[i];
  return `<div class="shot">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span class="no">镜 ${esc(s.镜号)}</span>
      <span class="dur">⏱ <input type="number" class="dur-input" data-dur="${i}" value="${esc(s.时长??3)}" min="0.5" max="30" step="0.5"> 秒</span>
      ${wcBadge((s.画面描述||'')+' '+(s.出图提示词||''))}
    </div>
    <div class="meta">
      ${['景别','角度','运镜','光线','转场'].map(k=> s[k]?`<span class="pill">${esc(s[k])}</span>`:'').join('')}
    </div>
    ${s.主体?`<div class="prompt-text" style="margin-top:6px"><b>主体：</b>${esc(s.主体)}</div>`:''}
    ${s.构图?`<div class="prompt-text" style="margin-top:4px"><b>构图：</b>${esc(s.构图)}</div>`:''}
    <div class="prompt-text" style="margin-top:6px">${esc(s.画面描述||'')}</div>
    ${ s.对白 ? `<div class="sub" style="margin-top:6px">💬 ${esc(s.对白)}</div>`:'' }
    <div class="subcard" style="margin-top:8px"><div class="lbl">出图提示词<button class="copy" data-copy="${esc(s.出图提示词||'')}">复制</button></div><div class="prompt-text">${esc(s.出图提示词||'')}</div></div>
    ${ s.连续性 ? `<div class="muted" style="margin-top:6px">🔗 连续性：${esc(s.连续性)}</div>`:'' }
    ${ s.剪辑动机 ? `<div class="muted" style="margin-top:4px">🎯 剪辑动机：${esc(s.剪辑动机)}</div>`:'' }
  </div>`;
}
/* 分镜时长联动：手改某镜秒数后，实时刷新对应章段头 + 全局统计 */
function updateBoardTiming(){
  const groups = {};
  state.storyboard.forEach((s,i)=>{ const k=s.章节||'未分组'; (groups[k]=groups[k]||[]).push(i); });
  Object.keys(groups).forEach(k=>{
    const sec = groups[k].reduce((sum,i)=> sum + (Number(state.storyboard[i].时长)||0), 0);
    const el = $('#chStat-'+k); if(el) el.textContent = `共 ${groups[k].length} 镜 · 总时长 ${sec}s`;
  });
  const totalSec = state.storyboard.reduce((sum,s)=> sum + (Number(s.时长)||0), 0);
  const el = $('#boardTotal'); if(el) el.textContent = `共 ${state.storyboard.length} 镜 · 总时长 ${totalSec}s`;
}

function fallbackRaw(key){
  const raw = state.raw[key];
  if(!raw) return '';
  return `<div class="card"><p class="muted">以下为模型原始返回（解析 JSON 失败时保留）：</p>
    <textarea style="min-height:120px">${esc(raw)}</textarea></div>`;
}

function readyForAssets(){
  return state.outlineConfirmed && state.chapters.some(c=>c.content && c.content.trim());
}

/* ---------- P5 导出 ---------- */
let expSel = []; // 长篇导出勾选的章节索引

function viewExport(){
  // 长篇模式：多选章节 + TXT / EPUB / DOCX 导出
  if(isLong()) return longExportView();
  if(!readyForAssets()) return `<div class="center-empty">尚无可导出的内容。请先完成故事章节。</div>`;
  const md = buildMarkdown();
  return `<div class="card">
    <h3>📦 导出资产包</h3>
    <p class="sub">汇总故事 / 角色提示词 / 场景提示词 / 分镜，复制后粘贴到文档，或下载 .md。拿着提示词去「即梦」出图做视频。</p>
    <div class="btn-row">
      <button id="btnCopyAll" class="btn primary">📋 复制全部</button>
      <button id="btnDownload" class="btn ghost">⬇️ 下载 .md</button>
    </div>
  </div>
  <div class="card"><textarea id="exportArea" style="min-height:300px">${esc(md)}</textarea></div>`;
}

/* ---------- 长篇模式导出 ---------- */
function longExportView(){
  const written = state.chapters.filter(c=> c.content && String(c.content).trim()).length;
  if(!written) return `<div class="center-empty">尚无已写章节，请先在「故事」里「生成下一批 5 章」。</div>`;
  // 清理已失效的勾选（章节被重生成等）
  expSel = expSel.filter(i=> state.chapters[i] && state.chapters[i].content && String(state.chapters[i].content).trim());
  const title = state.outline?.title || '未命名长篇小说';
  return `
    <div class="card">
      <h3>📦 导出长篇 · ${esc(title)}</h3>
      <p class="sub">勾选要导出的章节（单章 / 多章 / 全部）。不勾选直接点导出将默认导出全部已写章节。支持三种格式：<b>TXT</b> 纯文本、<b>EPUB</b> 电子书、<b>DOCX</b> 文档。</p>
      <div class="btn-row">
        <button id="expSelAll" class="btn ghost">☑️ 全选已写</button>
        <button id="expSelNone" class="btn ghost">⬜ 清空</button>
        <span class="muted" id="expCount">已选 ${expSel.length} / 已写 ${written} 章（共 ${state.chapters.length} 章）</span>
      </div>
    </div>
    <div class="card">
      <div class="exp-ch-list">
        ${state.chapters.map((c,i)=>{
          const ok = c.content && String(c.content).trim();
          return `<label class="exp-ch ${ok?'':'disabled'}">
            <input type="checkbox" data-expch="${i}" ${expSel.includes(i)?'checked':''} ${ok?'':'disabled'}>
            <span class="exp-ch-no">第${i+1}章</span>
            <span class="exp-ch-title">${esc(c.title||'')}</span>
            <span class="wc">${ok? wcInner(countWords(c.content)) : '未写'}</span>
          </label>`;
        }).join('')}
      </div>
      <div class="btn-row" style="margin-top:12px">
        <button id="expTxt" class="btn">📄 导出 TXT</button>
        <button id="expEpub" class="btn">📚 导出 EPUB</button>
        <button id="expDocx" class="btn">📝 导出 DOCX</button>
      </div>
      <p id="exportStatus" class="status"></p>
    </div>`;
}
function activeChapters(){
  let idx = expSel.filter(i=> state.chapters[i] && state.chapters[i].content && String(state.chapters[i].content).trim()).sort((a,b)=>a-b);
  if(!idx.length) idx = state.chapters.map((c,i)=> (c.content && String(c.content).trim())?i:null).filter(x=>x!==null);
  return idx;
}
function syncExpChecks(){
  $$('#view [data-expch]').forEach(cb=> cb.checked = expSel.includes(+cb.dataset.expch));
  const cnt = $('#expCount'); if(cnt) cnt.textContent = `已选 ${expSel.length} / 已写 ${state.chapters.filter(c=>c.content&&String(c.content).trim()).length} 章（共 ${state.chapters.length} 章）`;
}
function downloadBlob(name, blob){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(()=> URL.revokeObjectURL(a.href), 1000);
}
function expText(){
  const idx = activeChapters(); if(!idx.length){ toast('没有可导出的已写章节'); return; }
  const title = state.outline?.title || '未命名长篇小说';
  let t = `${title}\n${'='.repeat(24)}\n`;
  if(state.outline?.logline) t += `\n${state.outline.logline}\n\n`;
  idx.forEach(i=>{ const c=state.chapters[i]; t += `\n第${i+1}章 ${c.title||''}\n\n${String(c.content||'').trim()}\n`; });
  download(`${title}_长篇.txt`, t);
  toast(`已导出 ${idx.length} 章 TXT`);
}
function expEpub(){
  const idx = activeChapters(); if(!idx.length){ toast('没有可导出的已写章节'); return; }
  if(typeof JSZip === 'undefined'){ toast('找不到 JSZip 库'); return; }
  const title = state.outline?.title || '未命名长篇小说';
  const author = '使用者';
  const uid = (crypto && crypto.randomUUID) ? crypto.randomUUID() : ('uuid-'+Date.now()+'-'+Math.random().toString(16).slice(2));
  const modDate = new Date().toISOString();
  const base = 'OEBPS';
  const chapterFiles = idx.map(i=>{
    const c = state.chapters[i];
    const paras = String(c.content||'').split(/\n+/).map(p=>p.trim()).filter(Boolean)
      .map(p=> `<p>${esc(p)}</p>`).join('\n');
    const h1 = `第${i+1}章 ${esc(c.title||'')}`;
    const xhtml = `<?xml version="1.0" encoding="utf-8"?>\n`+
      `<!DOCTYPE html>\n`+
      `<html xmlns="http://www.w3.org/1999/xhtml">\n<head>\n  <title>${freeText(h1)}</title>\n  <link rel="stylesheet" type="text/css" href="styles.css"/>\n</head>\n<body>\n  <h1>${h1}</h1>\n${paras}\n</body>\n</html>`;
    return { id:'ch'+(i+1), file:`text/ch${i+1}.xhtml`, title:h1, xhtml };
  });
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', {compression:'STORE'});
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n  <rootfiles>\n    <rootfile full-path="${base}/content.opf" media-type="application/oebps-package+xml"/>\n  </rootfiles>\n</container>`);
  const manifest = chapterFiles.map(f=>`    <item id="${f.id}" href="${f.file}" media-type="application/xhtml+xml"/>`).join('\n');
  const spine = chapterFiles.map(f=>`    <itemref idref="${f.id}"/>`).join('\n');
  zip.file(`${base}/content.opf`, `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">\n  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n    <dc:identifier id="uid">urn:uuid:${uid}</dc:identifier>\n    <dc:title>${freeText(title)}</dc:title>\n    <dc:language>zh-CN</dc:language>\n    <dc:creator>${freeText(author)}</dc:creator>\n    <meta property="dcterms:modified">${modDate}</meta>\n  </metadata>\n  <manifest>\n    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n    <item id="css" href="styles.css" media-type="text/css"/>\n${manifest}\n  </manifest>\n  <spine>\n${spine}\n  </spine>\n</package>`);
  const navLis = chapterFiles.map(f=>`    <li><a href="${f.file}">${freeText(f.title)}</a></li>`).join('\n');
  zip.file(`${base}/nav.xhtml`, `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n<head>\n  <meta charset="utf-8"/>\n  <title>${freeText(title)}</title>\n</head>\n<body>\n  <nav epub:type="toc" id="toc">\n    <h1>目录</h1>\n    <ol>\n${navLis}\n    </ol>\n  </nav>\n</body>\n</html>`);
  const ncxPts = chapterFiles.map((f,i)=>`    <navPoint id="${f.id}" playOrder="${i+1}"><navLabel><text>${freeText(f.title)}</text></navLabel><content src="${f.file}"/></navPoint>`).join('\n');
  zip.file(`${base}/toc.ncx`, `<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n  <head><meta name="dtb:uid" content="urn:uuid:${uid}"/></head>\n  <docTitle><text>${freeText(title)}</text></docTitle>\n  <navMap>\n${ncxPts}\n  </navMap>\n</ncx>`);
  zip.file(`${base}/styles.css`, `body{font-family:serif,"PingFang SC","Source Han Serif SC",serif;line-height:1.9;margin:2em;color:#222}\nh1{font-size:1.4em;text-align:center;margin-bottom:1.6em;color:#333}\np{text-indent:2em;margin:0.5em 0}`);
  chapterFiles.forEach(f=> zip.file(`${base}/${f.file}`, f.xhtml));
  const st = $('#exportStatus'); if(st) st.textContent = '正在打包 EPUB…';
  zip.generateAsync({type:'blob', mimeType:'application/epub+zip'}).then(blob=>{
    downloadBlob(`${title}_长篇.epub`, blob);
    if(st) st.textContent = '';
    toast(`已导出 EPUB（${idx.length} 章）`);
  }).catch(()=>{ if(st) st.textContent='打包失败'; toast('EPUB 打包失败'); });
}
function expDocx(){
  const idx = activeChapters(); if(!idx.length){ toast('没有可导出的已写章节'); return; }
  if(typeof JSZip === 'undefined'){ toast('找不到 JSZip 库'); return; }
  const title = state.outline?.title || '未命名长篇小说';
  const xmlEsc = t=> String(t??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const paras = [];
  paras.push(`<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="36"/></w:rPr><w:t xml:space="preserve">${xmlEsc(title)}</w:t></w:r></w:p>`);
  if(state.outline?.logline) paras.push(`<w:p><w:r><w:t xml:space="preserve">${xmlEsc(state.outline.logline)}</w:t></w:r></w:p>`);
  idx.forEach(i=>{
    const c = state.chapters[i];
    paras.push(`<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">第${i+1}章 ${xmlEsc(c.title||'')}</w:t></w:r></w:p>`);
    String(c.content||'').split(/\n+/).map(p=>p.trim()).filter(Boolean)
      .forEach(p=> paras.push(`<w:p><w:r><w:t xml:space="preserve">${xmlEsc(p)}</w:t></w:r></w:p>`));
  });
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n  <Default Extension="xml" ContentType="application/xml"/>\n  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>\n</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>\n</Relationships>`);
  const body = paras.join('\n');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`);
  const st = $('#exportStatus'); if(st) st.textContent = '正在打包 DOCX…';
  zip.generateAsync({type:'blob', mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}).then(blob=>{
    downloadBlob(`${title}_长篇.docx`, blob);
    if(st) st.textContent = '';
    toast(`已导出 DOCX（${idx.length} 章）`);
  }).catch(()=>{ if(st) st.textContent='打包失败'; toast('DOCX 打包失败'); });
}
function freeText(t){ return String(t??'').replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

function buildMarkdown(){
  const o = state.outline;
  let md = `# 影视前期资产包 · ${o?.title||'未命名'}\n\n> 由「影视前期提示词生成器」生成 · 出图请在即梦用提示词生成\n\n`;
  md += `## 一、故事大纲\n**梗概**：${o?.logline||''}\n\n`;
  (o?.chapters||[]).forEach((c,i)=> md += `${i+1}. **${c.title}** — ${c.summary}\n`);
  md += `\n## 二、章节正文\n`;
  state.chapters.forEach((c,i)=> md += `\n### 第${i+1}章 ${c.title}\n${c.content}\n`);
  if(state.characters.length){
    md += `\n## 三、角色定妆提示词包\n`;
    state.characters.forEach(c=>{
      md += `\n### ${c.name}（${c.role||''}）\n`;
      const pf=c.profile||{}; Object.entries(pf).forEach(([k,v])=> md+=`- **${k}**：${v}\n`);
      const pr=c.prompts||{}; const order=['定妆图','三视图','表情','服饰细节','道具','配色','材质'];
      order.forEach(k=>{ if(pr[k]!=null) md+=`\n**${k}提示词**：\n${pr[k]}\n`; });
    });
  }
  if(state.scenes.length){
    md += `\n## 四、场景提示词（纯环境 · 无人物，供视频 AI 空镜/环境参考）\n`;
    state.scenes.forEach(s=> md += `\n### ${s.name}（${s.作用||''}）\n- 设定：${s.description||''}\n- 即梦提示词（无人物）：${s.prompt||''}\n`);
  }
  if(state.storyboard.length){
    md += `\n## 五、分镜表（按章节，含时长）\n`;
    const groups = {};
    state.storyboard.forEach(s=>{ const k=s.章节||'未分组'; (groups[k]=groups[k]||[]).push(s); });
    const keys = Object.keys(groups).sort((a,b)=>{ const na=+a,nb=+b; return (!isNaN(na)&&!isNaN(nb))?na-nb:String(a).localeCompare(String(b),'zh'); });
    keys.forEach(k=>{
      const list = groups[k];
      const sec = list.reduce((a,s)=> a+(Number(s.时长)||0),0);
      md += `\n### 第${k}章（${list.length} 镜 · 总时长 ${sec}s）\n`;
      list.forEach(s=>{
        md += `\n**镜${s.镜号}**（${s.时长??3}s）｜ ${s.景别||''} ｜ ${s.角度||''} ｜ ${s.运镜||''} ｜ ${s.光线||''}\n`;
        if(s.主体) md += `- 主体：${s.主体}\n`;
        if(s.构图) md += `- 构图：${s.构图}\n`;
        md += `- 画面：${s.画面描述||''}\n`;
        if(s.对白) md += `- 对白：${s.对白}\n`;
        if(s.转场) md += `- 转场：${s.转场}\n`;
        md += `- 出图提示词：${s.出图提示词||''}\n`;
        if(s.连续性) md += `- 连续性：${s.连续性}\n`;
        if(s.剪辑动机) md += `- 剪辑动机：${s.剪辑动机}\n`;
      });
    });
  }
  return md;
}

/* =========================================================
 * 事件绑定
 * ========================================================= */
function bindView(){
  // 复制按钮（事件委托）
  bindCopyBtns();

  // 赛博朋克首页入口卡片
  $$('.cyber-home-grid [data-step]').forEach(b=> b.onclick = ()=>{ currentStep = +b.dataset.step; render(); window.scrollTo(0,0); });

  // P1
  const idea = $('#ideaInput'); if(idea){
    idea.oninput = ()=> state.idea = idea.value;
    $('#btnGenOutline').onclick = genOutline;
  }
  // 长篇：写作范式切换
  $$('[data-recipe]').forEach(b=> b.onclick = ()=>{
    const r = b.dataset.recipe;
    if(r === state.recipe || !LONG_RECIPES.some(x=> x.id===r)) return;
    state.recipe = r; persist(); render();
    toast('已切换写作范式：'+longRecipe().name);
  });
  const specCur = $('#specCurrentBtn'); if(specCur) specCur.onclick = openSpecPanel;
  const btnCO = $('#btnConfirmOutline'); if(btnCO) btnCO.onclick = ()=>{ state.outlineConfirmed=true; persist(); render(); };
  const btnRO = $('#btnReOutline'); if(btnRO) btnRO.onclick = ()=>{ state.outline=null; state.outlineConfirmed=false; state.chapters=[]; persist(); render(); };
  const btnGA = $('#btnGenAllChapters'); if(btnGA) btnGA.onclick = genAllChapters;
  // 长篇：章节跳转下拉
  const longJump = $('#longJump'); if(longJump) longJump.onchange = ()=>{ const i=+longJump.value; if(longJump.value!=='') openReader(i); longJump.value=''; }; 
  if(isLong()) renderLongProgress();

  // P2 角色：搜索 / 性别 / 年龄区间 / Tom Select 初始化
  if(currentStep===2){
    const s = $('#charSearch'); if(s){
      s.oninput = ()=>{ charFilters.q = s.value; applyCharFilters(); };
    }
    const g = $('#charGender'); if(g){
      g.onchange = ()=>{ charFilters.gender = g.value; applyCharFilters(); };
    }
    const aMin = $('#ageMin'), aMax = $('#ageMax');
    if(aMin) aMin.oninput = ()=>{ charFilters.ageMin = aMin.value; applyCharFilters(); };
    if(aMax) aMax.oninput = ()=>{ charFilters.ageMax = aMax.value; applyCharFilters(); };
    initCharFilter();
  }
  // P2
  const btnGC = $('#btnGenChars'); if(btnGC) btnGC.onclick = genCharacters;
  // P3
  const btnGS = $('#btnGenScenes'); if(btnGS) btnGS.onclick = genScenes;
  const btnCV = $('#btnGenCover'); if(btnCV) btnCV.onclick = genCover;
  // 封面模式切换：纯画面(clean) / 含汉字书名(title)
  $$('[data-cv]').forEach(b=> b.onclick = ()=>{
    const v = b.dataset.cv === 'title';
    if(state.coverWithTitle === v) return;
    state.coverWithTitle = v;
    state.coverPrompt = ''; // 切换模式后旧提示词不再适用，清空待重生成
    persist(); render();
  });
  // P4
  const btnGB = $('#btnGenBoard'); if(btnGB) btnGB.onclick = genStoryboard;
  // P5
  const btnCA = $('#btnCopyAll'); if(btnCA) btnCA.onclick = ()=> copyText(buildMarkdown());
  const btnDL = $('#btnDownload'); if(btnDL) btnDL.onclick = ()=> download(`影视资产包_${state.outline?.title||'story'}.md`, buildMarkdown());
  // 长篇：多选章节 + 三种格式导出
  if(isLong()){
    $$('#view [data-expch]').forEach(cb=> cb.onchange = ()=>{
      const i = +cb.dataset.expch;
      if(cb.checked){ if(!expSel.includes(i)) expSel.push(i); } else expSel = expSel.filter(x=>x!==i);
      syncExpChecks();
    });
    const selAll = $('#expSelAll'); if(selAll) selAll.onclick = ()=>{ expSel = state.chapters.map((c,i)=> (c.content && String(c.content).trim())?i:null).filter(x=>x!==null); syncExpChecks(); };
    const selNone = $('#expSelNone'); if(selNone) selNone.onclick = ()=>{ expSel=[]; syncExpChecks(); };
    const bt = $('#expTxt'); if(bt) bt.onclick = expText;
    const be = $('#expEpub'); if(be) be.onclick = expEpub;
    const bd = $('#expDocx'); if(bd) bd.onclick = expDocx;
  }

  // 章节编辑/重生成/确认/阅读（动态）
  renderChapters();
  $$('textarea[data-ch]').forEach(ta=> ta.oninput = ()=>{ const i=+ta.dataset.ch; state.chapters[i].content = ta.value; persist(); updateChapterWc(i, ta.value); updateWcTotal(); });
  $$('[data-regen]').forEach(b=> b.onclick = ()=> genOneChapter(+b.dataset.regen));
  $$('[data-toggle]').forEach(b=> b.onclick = ()=>{ const i=+b.dataset.toggle; state.chapters[i].confirmed=!state.chapters[i].confirmed; persist(); render(); });
  $$('[data-read]').forEach(b=> b.onclick = ()=> openReader(+b.dataset.read));
  // 分镜时长手改：实时联动章段头与全局统计
  $$('[data-dur]').forEach(inp=> inp.oninput = ()=>{
    const i = +inp.dataset.dur;
    const v = parseFloat(inp.value);
    state.storyboard[i].时长 = isNaN(v)||v<=0 ? 0.5 : Math.min(30, v);
    persist(); updateBoardTiming();
  });
  bindReader();
}

/* =========================================================
 * 生成动作
 * ========================================================= */
async function genOutline(){
  const btn = $('#btnGenOutline'); busy(btn,true,'生成大纲中…');
  const st = $('#outlineStatus'); st.className='status'; st.textContent='';
  state.idea = $('#ideaInput').value.trim();
  if(!state.idea){ toast('先写几句构想'); busy(btn,false); return; }
  try{
    const sys = isLong() ? longOutlineSys() : PROMPTS.outlineSys + specSysAddition();
    const txt = await callDeepSeek(sys, '故事构想：'+state.idea);
    state.raw.outline = txt;
    const o = parseJson(txt);
    // 兼容分层递归范式：返回 volumes，需扁平化为 chapters 并保留卷归属
    if(isLong() && (!o.chapters || !o.chapters.length) && o.volumes && o.volumes.length){
      const flat = [];
      o.volumes.forEach(v=> (v.chapters||[]).forEach(c=> flat.push({...c, volume: v.name, volumeTheme: v.theme})));
      o.chapters = flat;
      o._volumes = o.volumes;
    }
    if(!o.chapters || !o.chapters.length) throw new Error('未解析到章节');
    state.outline = o; state.outlineConfirmed=false;
    state.chapters = o.chapters.map(c=>({title:c.title, content:'', confirmed:false}));
    persist(); render();
    toast('大纲已生成');
  }catch(e){
    st.className='status err'; st.textContent = e.message;
  }finally{ busy(btn,false); }
}

// 长篇：把整体结构/卷信息拼进章节生成的上下文（按范式注入）
function longChapterContext(i){
  const o = state.outline;
  if(!isLong() || !o) return '';
  let ctx = '';
  // 分层递归范式：注入所属卷主题
  if(longRecipe().id === 'layered'){
    const c = o.chapters[i];
    if(c && c.volume){
      ctx += `\n\n【本卷定位】\n所属卷：${c.volume}\n本卷主题与情绪基调：${c.volumeTheme||''}\n本章目标：${c.goal||o.chapters[i].summary||''}`;
    }
  }
  // 多线网状 / 写手-编辑双审范式：注入结构设计
  if(longRecipe().useStructure && o.structure){
    const s = o.structure;
    ctx += `\n\n【整体结构】
结构模式：${s.mode||''}
设计用意：${s.designReason||''}
主线：${s.mainLine||''}
副线：${(s.subLines||[]).join('；')||''}
暗线：${s.hiddenLine||''}
汇合/大逆转章节：${s.pivotChapter||''}
三定（时间轴/汇合点/主次）：${s.threeFix||''}
本章位于全书的线条与节奏：${o.chapters[i]&&o.chapters[i].line||''}`;
  }
  return ctx;
}
// 长篇：写作范式选择器（借鉴开源方案的可切换写法菜单）
function recipePicker(){
  const cur = state.recipe;
  return `<div class="card recipe-card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <h3 style="margin:0;font-size:14px">📚 选择写作范式</h3>
      <span class="pill tag-ok">${longRecipe().tag}</span>
    </div>
    <div class="recipe-grid">
      ${LONG_RECIPES.map(r=>`
        <button type="button" class="recipe ${r.id===cur?'active':''}" data-recipe="${r.id}">
          <b>${r.name}</b>
          <span class="r-tag">${r.tag}</span>
          <span class="r-desc">${esc(r.desc)}</span>
        </button>`).join('')}
    </div>
    <p class="muted" style="margin:6px 0 0">切换后仅影响后续生成方式，可在生成大纲前随时更换。</p>
  </div>`;
}
function structureCard(o){
  const s = o && o.structure;
  if(!isLong() || !s || !longRecipe().useStructure) return '';
  return `<div class="card structure-card">
    <h3>🏗️ 长篇结构设计</h3>
    <div class="sc-row"><b>结构模式</b><span>${esc(s.mode||'')}</span></div>
    ${s.designReason?`<div class="sc-row"><b>设计用意</b><span>${esc(s.designReason)}</span></div>`:''}
    ${s.mainLine?`<div class="sc-row"><b>主线</b><span>${esc(s.mainLine)}</span></div>`:''}
    ${(s.subLines||[]).length?`<div class="sc-row"><b>副线</b><span>${esc((s.subLines||[]).join(' · '))}</span></div>`:''}
    ${s.hiddenLine?`<div class="sc-row"><b>暗线</b><span>${esc(s.hiddenLine)}</span></div>`:''}
    ${s.pivotChapter?`<div class="sc-row"><b>汇合/大逆转</b><span>第 ${esc(s.pivotChapter)} 章附近</span></div>`:''}
    ${s.threeFix?`<div class="sc-row"><b>三定</b><span>${esc(s.threeFix)}</span></div>`:''}
  </div>`;
}
// 写一条章节正文（含 dual 范式的编辑双审；maxRound 为最多重写轮次）
async function writeOneChapterContent(i, user){
  let txt = await callDeepSeek(longChapterSys(), user);
  if(!isLong() || !longRecipe().useEditor){
    return txt.trim();
  }
  // 双审：编辑评审打分，不满 70 由写手按意见重写（最多 2 轮）
  for(let r=0; r<2; r++){
    const draft = txt;
    let j;
    try{ j = parseJson(await callDeepSeek(PROMPTS.editorSys, '【本章初稿】\n'+draft.slice(0,3000))); }catch(e){ j={}; }
    const pass = j.pass===true || ((j.role||0)>=70 && (j.plot||0)>=70 && (j.world||0)>=70);
    if(pass) break;
    const advice = j.advice || (j.issues||[]).join('；');
    if(!advice) break;
    txt = await callDeepSeek(longChapterSys(), `${user}\n\n【编辑审稿意见】该章未达标（角色${j.role??'-'}/剧情${j.plot??'-'}/世界观${j.world??'-'}）。请按以下意见重写本章：\n${advice}\n\n务必保留原有人物设定与已铺伏笔，仅修正指出的问题。只输出正文。`);
  }
  return txt.trim();
}
async function genOneChapter(i, btn){
  busy(btn,true,'生成中…');
  const o = state.outline;
  const prev = i>0 ? state.chapters[i-1].content : '';
  const user = `故事标题：${o.title}\n一句话梗概：${o.logline}\n全部章节：${o.chapters.map(c=>c.title).join(' / ')}\n\n本章标题：${state.chapters[i].title}\n本章概要：${o.chapters[i].summary}${longChapterContext(i)}${prev?('\n上一章结尾：'+prev.slice(-200)+'…'):'\n（这是第一章）'}`;
  try{
    const txt = await writeOneChapterContent(i, user);
    state.chapters[i].content = txt;
    state.chapters[i].confirmed = false;
    persist(); render();
    toast('第'+(i+1)+'章完成');
  }catch(e){ toast('生成失败：'+e.message); }
  finally{ busy(btn,false); }
}

async function genAllChapters(){
  const btn = $('#btnGenAllChapters'); busy(btn,true,'逐章生成中…');
  const st = $('#chStatus'); st.className='status';
  // 长篇模式：只生成【下一批 5 章】（未生成或未确认的区间）；短片模式：全部
  const batchSize = isLong() ? 5 : state.chapters.length;
  let start = 0;
  if(isLong()){
    // 找第一批存在未生成章节的连续区间起点（从第一个空内容开始）
    const firstEmpty = state.chapters.findIndex(c => !(c.content && c.content.trim()));
    start = firstEmpty >= 0 ? firstEmpty : 0;
  }
  const genCount = Math.min(batchSize, state.chapters.length - start);
  if(genCount <= 0){ st.className='status ok'; st.textContent = '全部章节已生成。'; busy(btn,false); return; }
  for(let k=0;k<genCount;k++){
    const i = start + k;
    if(!isLong() && state.chapters[i].content && state.chapters[i].confirmed) continue;
    st.textContent = isLong()
      ? `正在生成第 ${i+1}/${state.chapters.length} 章（本批第 ${k+1}/${genCount} 章）…`
      : `正在生成第 ${i+1}/${state.chapters.length} 章…`;
    await genOneChapterNoUI(i);
  }
  st.className='status ok';
  st.textContent = isLong()
    ? `本批 ${genCount} 章已生成（共进度 ${genCount+start}/${state.chapters.length} 章）。继续点「生成下一批 5 章」直到写完全部。`
    : '全部章节已生成，请审阅并标记确认。';
  busy(btn,false); render();
}

// 无 UI 阻塞版（供循环调用）
async function genOneChapterNoUI(i){
  const o = state.outline;
  const prev = i>0 ? state.chapters[i-1].content : '';
  const user = `故事标题：${o.title}\n一句话梗概：${o.logline}\n全部章节：${o.chapters.map(c=>c.title).join(' / ')}\n\n本章标题：${state.chapters[i].title}\n本章概要：${o.chapters[i].summary}${longChapterContext(i)}${prev?('\n上一章结尾：'+prev.slice(-200)+'…'):'\n（这是第一章）'}`;
  try{
    const txt = isLong()
      ? await writeOneChapterContent(i, user)
      : (await callDeepSeek(PROMPTS.chapterSys + specSysAddition(), user)).trim();
    state.chapters[i].content = txt;
    persist();
  }catch(e){ /* 继续后续 */ }
}

async function genCharacters(){
  const btn = $('#btnGenChars'); busy(btn,true,'生成角色中…');
  try{
    const txt = await callDeepSeek(PROMPTS.characterSys, '【完整故事】\n'+fullStoryText());
    state.raw.characters = txt;
    const j = parseJson(txt);
    state.characters = j.characters || [];
    persist(); render();
    toast('角色提示词已生成');
  }catch(e){
    const p = $('#charStatus'); if(p){ p.className='status err'; p.textContent=e.message; }
  }finally{ busy(btn,false); }
}

async function genScenes(){
  const btn = $('#btnGenScenes'); busy(btn,true,'生成场景中…');
  try{
    const txt = await callDeepSeek(PROMPTS.sceneSys, '【完整故事】\n'+fullStoryText());
    state.raw.scenes = txt;
    const j = parseJson(txt);
    state.scenes = (j.scenes || []).map(s=>{
      // 兜底：确保每条出图提示词带「无人环境」负向约束（防模型漏写）
      const p = String(s.prompt||'');
      const neg = ['no people','no characters','no humans','无人'];
      if(!neg.some(k=>p.toLowerCase().includes(k))){
        s.prompt = p.replace(/\s*$/,'') + '\n（无人物纯环境：no people, no characters, no humans, empty of figures）';
      }
      return s;
    });
    persist(); render();
    toast('场景提示词已生成');
  }catch(e){
    const p = $('#sceneStatus'); if(p){ p.className='status err'; p.textContent=e.message; }
  }finally{ busy(btn,false); }
}

/* 生成整部小说封面提示词（场景页顶部 / 长篇模式专用） */
async function genCover(){
  const btn = $('#btnGenCover'); busy(btn,true,'生成封面提示词…');
  const st = $('#coverStatus'); if(st){ st.className='status'; st.textContent=''; }
  const o = state.outline;
  if(!o){ toast('先生成故事大纲'); busy(btn,false); return; }
  // 依据「是否含汉字书名」选择对应提示词体系
  const sys = state.coverWithTitle ? PROMPTS.coverSysTitle : PROMPTS.coverSysClean;
  const user = `小说标题：${o.title}\n一句话梗概：${o.logline}\n章节：${(o.chapters||[]).map(c=>c.title).join(' / ')}\n\n请为这部小说设计封面图的出图提示词。\n模式：${state.coverWithTitle?'包含书名汉字作为封面主体文字':'纯画面、无任何文字、预留书名留白'}`;
  try{
    const txt = await callDeepSeek(sys, user);
    state.coverPrompt = txt.trim();
    persist(); render();
    toast(state.coverWithTitle?'已生成含书名封面提示词':'已生成纯画面封面提示词');
  }catch(e){
    if(st){ st.className='status err'; st.textContent=e.message; }
    else toast('生成失败：'+e.message);
  }finally{ busy(btn,false); }
}

async function genStoryboard(){
  const btn = $('#btnGenBoard'); busy(btn,true,'生成分镜中…');
  const st = $('#boardStatus');
  try{
    const chars = state.characters.map(c=>`${c.name}(${c.role})：定妆特征-${((c.profile&&c.profile.外貌)||'')}，常服-${((c.profile&&c.profile.常服与配色)||'')}`).join('\n');
    const scenes = state.scenes.map(s=>`${s.name}：${s.description||''}`).join('\n');
    const base = `【角色定妆特征】\n${chars||'（未生成角色）'}\n\n【场景】\n${scenes||'（未生成场景）'}`;
    const shots = [];
    const concepts = [];
    const fails = [];
    for(let i=0;i<state.chapters.length;i++){
      if(st){ st.className='status'; st.textContent = `正在为第 ${i+1}/${state.chapters.length} 章生成分镜…`; }
      const ch = state.chapters[i];
      const oc = (state.outline&&state.outline.chapters&&state.outline.chapters[i])||{};
      const content = ch.content||'';
      const user = `【本章】第${i+1}章 ${ch.title||oc.title||''}\n本章概要：${oc.summary||''}\n本章正文：\n${content.slice(0,1500)}${content.length>1500?'…':''}\n\n${base}`;
      try{
        const txt = await callDeepSeek(PROMPTS.storyboardSys, user);
        const j = parseJson(txt);
        (j.shots||[]).forEach(s=>{
          s.章节 = i+1;
          if(s.时长==null) s.时长 = 3;
          shots.push(s);
        });
        concepts.push({视觉概念:j.视觉概念||'', 母题:j.母题||''});
      }catch(e){
        fails.push('第'+(i+1)+'章：'+e.message);
        concepts.push({视觉概念:'', 母题:''});
      }
    }
    if(!shots.length) throw new Error('分镜生成失败：' + fails.join('；'));
    state.boardConcepts = concepts;
    state.storyboard = shots;
    state.raw.storyboard = '';
    persist(); render();
    toast(fails.length ? `分镜已生成（${fails.length} 章失败）` : '分镜已生成（按章节分组）');
  }catch(e){
    const p = $('#boardStatus'); if(p){ p.className='status err'; p.textContent=e.message; }
  }finally{
    busy(btn,false);
    if(st){ st.className='status'; st.textContent=''; }
  }
}

/* =========================================================
 * 历史作品弹层（多项目管理：切换/新建/删除）
 * ========================================================= */
function fmtHistTime(ts){
  if(!ts) return '';
  const d = new Date(ts), now = new Date();
  const pad = n => String(n).padStart(2,'0');
  if(d.toDateString() === now.toDateString()) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function histProgress(p){
  if(p.chapters && p.chapters.length){
    const done = p.chapters.filter(c=> c.confirmed).length;
    return `${done}/${p.chapters.length} 章`;
  }
  if(p.outline && p.outline.chapters && p.outline.chapters.length) return `大纲 ${p.outline.chapters.length} 章`;
  if(p.characters && p.characters.length) return `${p.characters.length} 角色`;
  if(p.scenes && p.scenes.length) return `${p.scenes.length} 场景`;
  if(p.storyboard && p.storyboard.length) return `${p.storyboard.length} 镜`;
  if(p.idea) return '草稿';
  return `第 ${p.step||1} 步`;
}
function renderHistList(){
  const list = $('#histList'); if(!list) return;
  const items = [...lib.items].sort((a,b)=> (b.updatedAt||0) - (a.updatedAt||0));
  list.innerHTML = items.map(p=>{
    const isCur = p.id === lib.curId;
    return `<div class="hist-item ${isCur?'active':''}">
      <button class="hist-main" data-switch="${p.id}">
        <span class="hist-title">${isCur?'<em class="hist-cur">当前</em>':''}${esc(p.title||'未命名作品')}</span>
        ${p.logline?`<span class="hist-desc">${esc(p.logline)}</span>`:''}
        <span class="hist-meta">${histProgress(p)} · ${fmtHistTime(p.updatedAt)}</span>
      </button>
      <button class="hist-del" data-del="${p.id}" title="删除作品">🗑</button>
    </div>`;
  }).join('') || `<div class="hist-empty">还没有作品，点击「＋ 新建小说」开始。</div>`;
  $$('#histList [data-switch]').forEach(b=> b.onclick = ()=> switchProject(b.dataset.switch));
  $$('#histList [data-del]').forEach(b=> b.onclick = (e)=>{ e.stopPropagation(); deleteProject(b.dataset.del); });
}
function openHistPanel(){ renderHistList(); $('#histPanel').classList.remove('hidden'); }
function closeHistPanel(){ $('#histPanel').classList.add('hidden'); }
function switchProject(id){
  if(id === lib.curId){ closeHistPanel(); return; }
  persist(); // 先保存当前项目
  lib.curId = id;
  const cur = lib.items.find(i=> i.id === id);
  applyProject(cur || {}); // 内容缺失 → 空白，id 仍保持有效
  saveLib(); // 提交 curId 切换
  closeHistPanel();
  render();
  window.scrollTo(0,0);
  toast(`已切换到「${cur ? (cur.title||'未命名作品') : '空白项目'}」`);
}
function newProject(mode){
  // 上限：满 10 弹 confirm 是否删除最旧以新建
  if(lib.items.length >= MAX_PROJECTS){
    const oldest = [...lib.items].sort((a,b)=> (a.updatedAt||0) - (b.updatedAt||0))[0];
    if(oldest && !confirm(`历史已达 ${MAX_PROJECTS} 个上限，是否删除最旧的「${oldest.title||'未命名作品'}」以新建？`)){
      return false;
    }
    if(oldest) lib.items = lib.items.filter(i=> i.id !== oldest.id);
  }
  clearState();
  if(mode) state.mode = mode; // 'longnovel' 经典长篇小说
  const snap = projectSnapshot();
  const newId = makeId();
  lib.items.unshift({ ...snap, id: newId, updatedAt: Date.now() });
  lib.curId = newId;
  saveLib();
  closeHistPanel();
  render();
  window.scrollTo(0,0);
  toast(mode==='longnovel' ? '已新建经典长篇小说' : '已新建空白小说');
  return true;
}
function newLongProject(){
  if(!confirm('创建一部「经典长篇小说」？\n\n将按 32-40 章大纲分批写作（每批 5 章，每章约 7000-9000 字），目标约 30 万字。\n此模式不生成视频提示词，只产出文字章节，可导出 TXT / EPUB / DOCX。')){
    return false;
  }
  return newProject('longnovel');
}
function deleteProject(id){
  const it = lib.items.find(i=> i.id === id);
  if(!it) return;
  if(!confirm(`确定删除「${it.title||'未命名作品'}」？此操作不可恢复。`)) return;
  const wasCur = id === lib.curId;
  lib.items = lib.items.filter(i=> i.id !== id);
  if(wasCur){
    // 删当前项目：切到最近项目；若全删空则空白
    if(lib.items.length){
      const next = [...lib.items].sort((a,b)=> (b.updatedAt||0) - (a.updatedAt||0))[0];
      lib.curId = next.id;
      applyProject(next);
      toast('已删除，已切换到最近作品');
    }else{
      clearState();
      lib.curId = null;
      toast('已删除全部作品');
    }
    closeHistPanel(); render(); window.scrollTo(0,0);
  }
  saveLib();
  renderHistList();
}
function rebindHistPanel(){
  const btn = $('#btnHist');
  if(btn) btn.onclick = (e)=>{
    e.stopPropagation();
    const p = $('#histPanel');
    if(p.classList.contains('hidden')) openHistPanel(); else closeHistPanel();
  };
  const nb = $('#btnNewProject');
  if(nb) nb.onclick = (e)=>{ e.stopPropagation(); newProject(); };
}

/* =========================================================
 * 创作规范弹层
 * ========================================================= */
function renderSpecList(){
  const cur = getSpec().id;
  const list = $('#specList'); if(!list) return;
  list.innerHTML = SPECS.map(s=>`
    <button class="spec-row ${s.id===cur?'active':''}" data-spec="${s.id}">
      <div class="sr-title">${s.name} ${s.id===cur?'<span class="sr-check">✓</span>':''}</div>
      <div class="sr-desc">${s.desc}</div>
    </button>`).join('');
  $$('#specList .spec-row').forEach(b=> b.onclick = ()=> selectSpec(b.dataset.spec));
}
function openSpecPanel(){ renderSpecList(); $('#specPanel').classList.remove('hidden'); }
function closeSpecPanel(){ $('#specPanel').classList.add('hidden'); }
function selectSpec(id){
  const cfg = getCfg(); cfg.spec = id; saveCfg(cfg);
  closeSpecPanel(); renderSpecList(); updateSpecButton();
  toast('创作规范：'+getSpec().name+'（仅作用于写小说）');
  if(currentStep===1) render(); // 刷新首页的规范提示
}
function updateSpecButton(){
  const b = $('#btnSpec'); if(!b) return;
  const lab = b.querySelector('.tb-lab');
  if(lab) lab.textContent = getSpec().short;
}

/* =========================================================
 * 设置弹窗
 * ========================================================= */
function openSettings(){ $('#settingsModal').classList.remove('hidden'); fillCfg(); }
function closeSettings(){ $('#settingsModal').classList.add('hidden'); }
function fillCfg(){
  const c = getCfg();
  $('#cfgKey').value = c.apiKey||'';
  $('#cfgBase').value = c.baseUrl||'';
  const ms = $('#cfgModel');
  ms.value = c.model || 'deepseek-v4-pro';
  if(!ms.value) ms.value = 'deepseek-v4-pro'; // 兜底旧配置/未知模型
  $('#cfgTemp').value = (c.temperature==null?'':c.temperature);
}
function saveSettings(){
  const c = {
    apiKey: $('#cfgKey').value.trim(),
    baseUrl: $('#cfgBase').value.trim() || 'https://api.deepseek.com',
    model: $('#cfgModel').value.trim() || 'deepseek-v4-pro',
    temperature: parseFloat($('#cfgTemp').value)
  };
  if(isNaN(c.temperature)) c.temperature = 0.7;
  saveCfg(c);
  const st = $('#cfgStatus'); st.className='status ok'; st.textContent='已保存到本机浏览器。';
  toast('配置已保存');
}
async function testConn(){
  const st = $('#cfgStatus'); st.className='status'; st.textContent='测试中…';
  const old = getCfg();
  // 临时保存后再测
  saveSettings();
  try{
    const r = await callDeepSeek('你是测试助手，只回复「ok」。','你好');
    st.className='status ok'; st.textContent='连接成功：'+r.slice(0,20);
  }catch(e){
    st.className='status err';
    let msg = e.message;
    if(/insufficient balance/i.test(msg)){
      msg += '（账户余额不足，请去 DeepSeek 控制台充值，不是 Key 填错）';
    }else if(/not found.*model/i.test(msg)){
      msg += '（模型名不存在，请从下拉菜单选择官方模型）';
    }
    st.textContent='连接失败：'+msg;
  }
}

/* =========================================================
 * 初始化
 * ========================================================= */
function init(){
  loadState();
  // 应用已保存主题（统一走 applyTheme，保证 mecha nav 显隐等副作用一致）
  const c = getCfg();
  applyTheme(c.theme || 'dark');
  // 顶栏设置
  $('#btnSettings').onclick = openSettings;
  // 历史作品按钮：展开/收起弹层；新建小说按钮
  rebindHistPanel();
  // 经典长篇小说入口（左上角历史右侧）：确认后新建长篇项目
  const btnLongEl = $('#btnLong');
  if(btnLongEl) btnLongEl.onclick = (e)=>{ e.stopPropagation(); newLongProject(); };
  // 创作规范按钮：展开/收起弹层（仅作用于写小说）
  const btnSpec = $('#btnSpec');
  if(btnSpec) btnSpec.onclick = (e)=>{ e.stopPropagation(); const p=$('#specPanel'); if(p.classList.contains('hidden')) openSpecPanel(); else closeSpecPanel(); };
  updateSpecButton();
  // 点击空白处关闭规范/历史弹层
  document.addEventListener('click', (e)=>{
    const p = $('#specPanel'); if(p && !p.classList.contains('hidden') && !p.contains(e.target) && !e.target.closest('#btnSpec')) closeSpecPanel();
    const h = $('#histPanel'); if(h && !h.classList.contains('hidden') && !h.contains(e.target) && !e.target.closest('#btnHist')) closeHistPanel();
  });
  $$('[data-close]').forEach(b=> b.onclick = closeSettings);
  $('#btnCfgSave').onclick = saveSettings;
  $('#btnCfgTest').onclick = testConn;
  // 主题按钮
  $$('.theme-btns .theme').forEach(b=> b.onclick = ()=> applyTheme(b.dataset.theme));
  // 机甲主题顶部胶囊导航
  const mtn = $('#mechaTopNav');
  if(mtn){
    $$('.cap', mtn).forEach(c=> c.onclick = ()=>{
      if(c.dataset.export){ currentStep = 5; }
      else { currentStep = +c.dataset.step; }
      render(); window.scrollTo(0,0);
    });
  }
  // 底部导航
  $$('.tab').forEach(t=> t.onclick = ()=>{ currentStep = +t.dataset.step; render(); window.scrollTo(0,0); });
  // 进入时若无 Key，自动弹设置
  if(!c.apiKey) setTimeout(openSettings, 300);
  render();
}
document.addEventListener('DOMContentLoaded', init);
