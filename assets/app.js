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
const KEY_GLIB = 'fyp_glib';     // v8 词典库（跨作品的多套可复用词典，独立于项目轨道）
const MAX_PROJECTS = 10;         // 历史项目上限
let lib = { curId: null, items: [] }; // {curId, items:[{id, idea, outline, ..., step, title, logline, updatedAt}]}
let gglib = [];                  // v8 词典库：[{id, name, note, savedAt, g:{characters,places,propernouns}}]

const state = {
  mode: 'shortfilm',    // 'shortfilm' 短片 / 'longnovel' 经典长篇小说
  recipe: 'mesh',       // (兼容旧字段) 旧式单一范式 id；新项目用 recipeSet
  recipeSet: { structure:'mesh', rhythm:'web', quality:[] }, // 长篇三维写作范式：结构(单选)+节奏(单选)+质量(可多选)
  wordRange: null,      // 用户填的单章字数区间 {min,max}；与 chapterRange 互斥
  chapterRange: null,   // 用户填的全书章节区间 {min,max}；与 wordRange 互斥
  totalWords: null,     // 用户最前选定的「全书大约总字数」（原始整数字，UI 以【万】输入；null=未设）
  idea: '',
  coverPrompt: '',      // 整部小说封面提示词（场景页生成 / 长篇模式用）
  coverWithTitle: false,// 封面提示词是否包含「汉字书名」（false=纯画面无文字）
  outline: null,        // {title, logline, chapters:[{title,summary}]}
  outlineConfirmed: false,
  pendingGlossary: null, // v8 辅轨槽位：大纲前导入的待用词典 {characters,places,propernouns}，不写进 outline 直至确认
  glossAdherence: 60,   // v8 遵从度（%）：用户控制 AI 遵循词典的程度；默认 60（折中，续作/新作均安全，见规划 Q4）
  glossAllowFill: false, // v8 「允许 AI 补充」开关：低遵从时是否放行 AI 新增实体
  gsCollapsed: true,    // v8b：万物词典卡片是否整卡收缩（默认收缩，点圆形展开全部）
  chapters: [],         // [{title, content, confirmed}]
  characters: [],       // [{name, role, profile:{...}, prompts:{...}}]
  scenes: [],           // [{name, 作用, description, prompt}]
  storyboard: [],       // [{镜号,章节,时长,景别,角度,运镜,主体,构图,光线,画面描述,对白,转场,出图提示词,连续性,剪辑动机}]
  boardConcepts: [],    // 每章一条 {视觉概念, 母题}（分镜生成时随章节返回）
  titleHistory: [],     // 曾用书名记录 [{name, date}]（改名时追加，最新在前）
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
    recipeSet: state.recipeSet || { structure:'mesh', rhythm:'web', quality:[] },
    wordRange: state.wordRange || null,
    chapterRange: state.chapterRange || null,
    totalWords: state.totalWords || null,
    idea: state.idea,
    coverPrompt: state.coverPrompt,
    coverWithTitle: state.coverWithTitle,
    outline: state.outline,
    outlineConfirmed: state.outlineConfirmed,
    pendingGlossary: state.pendingGlossary,
    glossAdherence: state.glossAdherence,
    glossAllowFill: state.glossAllowFill,
    gsCollapsed: state.gsCollapsed,
    chapters: state.chapters,
    characters: state.characters,
    scenes: state.scenes,
    storyboard: state.storyboard,
    boardConcepts: state.boardConcepts,
    raw: state.raw,
    titleHistory: state.titleHistory,
    step: currentStep,
    title: (state.outline && state.outline.title) || (state.idea ? state.idea.trim().slice(0,20) : '未命名作品'),
    logline: (state.outline && state.outline.logline) || ''
  };
}
// 把项目快照写入当前 state；内容缺失/损坏时切到空白但保持调用方可控
function applyProject(p){
  state.mode = (p.mode === 'longnovel') ? 'longnovel' : 'shortfilm';
  state.recipe = p.recipe || 'mesh';
  state.recipeSet = migrateRecipeSet(p.recipeSet, p.recipe);
  state.wordRange = (p.wordRange && p.wordRange.min && p.wordRange.max) ? {min:+p.wordRange.min, max:+p.wordRange.max} : (p.chapterRange ? null : null);
  state.chapterRange = (p.chapterRange && p.chapterRange.min && p.chapterRange.max) ? {min:+p.chapterRange.min, max:+p.chapterRange.max} : null;
  state.totalWords = (p.totalWords && +p.totalWords>0) ? +p.totalWords : null;
  state.idea = p.idea || '';
  state.coverPrompt = p.coverPrompt || '';
  state.coverWithTitle = !!p.coverWithTitle;
  state.outline = p.outline || null;
  state.outlineConfirmed = !!p.outlineConfirmed;
  state.pendingGlossary = p.pendingGlossary || null;
  state.glossAdherence = (typeof p.glossAdherence === 'number') ? p.glossAdherence : 60;
  state.glossAllowFill = !!p.glossAllowFill;
  state.gsCollapsed = (typeof p.gsCollapsed === 'boolean') ? p.gsCollapsed : true;
  state.chapters = p.chapters || [];
  state.characters = p.characters || [];
  state.scenes = p.scenes || [];
  state.storyboard = p.storyboard || [];
  state.boardConcepts = p.boardConcepts || [];
  state.titleHistory = Array.isArray(p.titleHistory) ? p.titleHistory : [];
  state.raw = p.raw || {};
  currentStep = (p.step && p.step >= 1 && p.step <= 5) ? p.step : 1;
}
function clearState(){
  state.mode = 'shortfilm';
  state.recipe = 'mesh';
  state.recipeSet = { structure:'mesh', rhythm:'web', quality:[] };
  state.wordRange = null; state.chapterRange = null; state.totalWords = null;
  state.idea = ''; state.outline = null; state.coverPrompt = ''; state.coverWithTitle = false; state.outlineConfirmed = false;
  state.pendingGlossary = null; state.glossAdherence = 60; state.glossAllowFill = false; state.gsCollapsed = true;
  state.chapters = []; state.characters = []; state.scenes = []; state.storyboard = []; state.boardConcepts = []; state.titleHistory = []; state.raw = {};
  currentStep = 1;
}
// 兼容旧版单一范式 → 三维 recipeSet
function migrateRecipeSet(set, legacyRecipe){
  if(set && (set.structure || set.rhythm || (Array.isArray(set.quality) && set.quality.length) || (set.structure===null && set.rhythm===null))){
    const out = {
      structure: (typeof set.structure === 'string' && STRUCTURE_IDS.includes(set.structure)) ? set.structure : null,
      rhythm: (typeof set.rhythm === 'string' && RHYTHM_IDS.includes(set.rhythm)) ? set.rhythm : null,
      quality: Array.isArray(set.quality) ? set.quality.filter(q=> QUALITY_IDS.includes(q)) : []
    };
    // 修正结构维度内部互斥：若同时出现多个结构，只保留第一个
    if(STRUCTURE_IDS.indexOf(out.structure) > -1) out.structure = out.structure;
    return out;
  }
  // 旧 recipe 单一 id 迁移映射
  const legacyMap = { mesh:{structure:'mesh',rhythm:null,quality:[]}, layered:{structure:'layered',rhythm:null,quality:[]}, dual:{structure:'mesh',rhythm:null,quality:['dual']}, web:{structure:null,rhythm:'web',quality:[]}, web100:{structure:null,rhythm:'web',quality:[]}, causal:{structure:'causal',rhythm:null,quality:[]} };
  return legacyMap[legacyRecipe] || { structure:'mesh', rhythm:null, quality:[] };
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

/* ---------- DeepSeek 调用（浏览器直连，已验证支持 CORS，支持流式） ---------- */
// onStream(deltaText)：提供时开启流式（stream:true），每收到一段增量就回调用；不传则一次性返回全文。
async function callDeepSeek(system, user, {temperature=null, signal=null, maxTokens=null, onStream=null}={}){
  const cfg = getCfg();
  if(!cfg.apiKey) throw new Error('请先到 ⚙️ 填写 DeepSeek API Key');
  const base = (cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const streaming = typeof onStream === 'function';
  const body = {
    model: cfg.model || 'deepseek-v4-pro',
    messages: [{role:'system', content: system}, {role:'user', content: user}],
    temperature: (temperature==null ? (cfg.temperature ?? 0.7) : temperature),
    stream: streaming
  };
  // 缓存友好：请求的前缀（system + user 恒定首部）在全书各章保持不变，
  // DeepSeek 自动命中上下文缓存，命中价远低于未命中价；可变信息一律放 user 最末。
  if(maxTokens && maxTokens>0) body.max_tokens = maxTokens;
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
  if(!streaming){
    const data = await res.json();
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  }
  // 流式：解析 SSE（data: {...}），把 delta content 逐段回传给 onStream，最后返回完整拼接文本
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if(!reader) throw new Error('当前浏览器不支持流式响应');
  const decoder = new TextDecoder();
  let buf = '', full = '';
  const feed = (chunk)=>{
    buf += chunk;
    let nl;
    while((nl = buf.indexOf('\n')) >= 0){
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if(!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if(payload === '[DONE]') continue;
      let j;
      try{ j = JSON.parse(payload); }catch(e){ continue; }
      const delta = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || '';
      if(delta){ full += delta; onStream(delta); }
    }
  };
  while(true){
    const {done, value} = await reader.read();
    if(done) break;
    feed(decoder.decode(value, {stream:true}));
  }
  feed(decoder.decode());
  return full;
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

  longOutlineSys: `你是一位能驾驭超长篇的著名小说架构师。根据用户的一句话或几句构想，设计一部经典的【长篇小说】，最终成品体量以用户指定的总字数目标为准。
你不能用三幕流水的短剧套路来搭长篇，而要用真正的长篇小说结构美学来设计骨架。请严格只输出如下 JSON（不要任何解释、不要 markdown 代码块）：
{"title":"小说名","logline":"一句话梗概（含核心冲突与深层命题）","structure":{"mode":"结构模式","designReason":"为何选此结构、其精妙之处","mainLine":"主线：贯穿始终的核心冲突","subLines":["副线1：具体内容","副线2：具体内容"],"hiddenLine":"暗线：先埋设后揭晓的隐藏真相","pivotChapter":"多线汇合/大逆转所在章号(如 24)","threeFix":"三定：定时间轴 / 定汇合点 / 定主次(哪条线是主轴)"},"glossary":{"characters":[{"name":"人物姓名","identity":"身份地位","role":"在故事中的职能/作用","relation":"与该人相关人物及关系","trait":"性格/外貌/说话特征要点"}],"places":[{"name":"地名/场景名","type":"类型(城/宗门/村镇等)","note":"设定要点与作用"}],"propernouns":[{"name":"专名/专属设定术语","note":"含义与拼写唯一约定"}]},"chapters":[{"title":"第1章标题","summary":"该章核心事件与转折，1-2句","line":"该章推进哪条线/埋哪个伏笔/节奏起伏"}]}
选择结构模式时，默认优先采用【多线交织或网状交织】（次选单线因果、板块拼贴或闭环循环），并补齐 mainLine / subLines / hiddenLine 三条以上的叙事线索；多线必须做到"三定"：定时间轴、定汇合点（在哪一章几条线收束汇合）、定主次（以一条线为轴，其余服务它），否则会散架。暗线要从早期章节就埋设，直到结局呼应揭晓。每章 title 有钩子感，summary 写清人物动机、情节推进与本批应埋伏笔；line 标注该章归属的线索与节奏（如"主线推进/暗线植入/支线完成/情绪张力升高"），使整体节奏有跌宕起伏的事件密度控制，而非平铺。
【glossary 万物词典要求】glossary 是全文保持一致性的权威基准：必须列出本故事涉及的全部重要人物（含配角）、地域地名、专属设定术语；**全书正文一律只使用本词典中的人名/地名/专名，禁止自造或混用其他拼写**。人物 relation 写清角色间关系，trait 归纳其稳定性格与外貌要点以便后续各章保持一致。数量依故事体量，人物 3-15 名、地名 2-10 处、专名 2-8 个均可，务必覆盖后续章节会反复出现的核心要素。`,

  longChapterSys: `你是一位中文长篇小说的资深写手。根据「整体结构」「故事大纲」与「本章概要」写出本章完整正文，做到章章服务整体架构，绝不悬空发散。
要求：严格围绕本章概要推进，同时照顾它在全书结构中的位置——本线、伏笔、明暗线呼应；细腻的环境与心理描写、生动对话、符合人物弧光；节奏张弛有度（本章若是情绪高潮或转折则加压，若是过渡则蓄力）；章末留悬念或钩子，为后续章节/伏笔回落埋线；只输出正文，不要标题、不要"本章完/未完待续"之类片尾标注、不要任何解释。`,

  editorSys: `你是一位挑剔而专业的长篇小说编辑。请对「给定的一章初稿」做三维审查，并输出 JSON 评分与本轮审稿意见。
三个维度：角色一致性（人物性格/弧光是否符合设定）、剧情逻辑（因果是否合理、是否违背前文/时间线）、世界观一致（设定/能力/专名是否统一、是否出现硬伤）。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"role":0,"plot":0,"world":0,"pass":true,"issues":["问题1","问题2"],"advice":"若 pass 为 false，给出具体到段落的重写方向"}
rules：role/plot/world 各按 0-100 打分；pass=true 当且仅当三维都 ≥70；issues 列出未达标维度的具体问题；advice 简明可执行。`
};

/* =========================================================
 * 长篇写作范式：结构 / 节奏 / 质量 三维，皆可独立或组合
 * ---------------------------------------------------------
 * 结构(STRUCTURES, 单选互斥)   mesh多线网状 / causal单线因果 / layered分层递归
 *                              hero英雄之旅 / savecat节拍表 / seven七点结构
 * 节奏(RHYTHMS, 单选互斥)      web黄金网文 / repress压抑反转 / slice慢生活
 *                              mystery悬疑解谜 / epic群像史诗 / fatal悲剧宿命 / inward文艺向内
 * 质量(QUALITIES, 可多选可空)   dual写手-编辑双审 / selfref自省重写 / plothole伏笔洞检测
 * 页面选择与介绍折叠遵循 v2 方案；默认节奏为 web（黄金网文），默认结构 mesh。
 * ========================================================= */
const SIZE_DEFAULT = { min:3000, max:5000 };

/* ---------- 预置示例点子库（固定 12 条，每次随机出现一条） ---------- */
const IDEA_SAMPLES = [
  { text:"现代都市，一个能听见别人心声的外卖员，意外卷进一起豪门遗产骗局……", tag:"都市 · 奇幻" },
  { text:"仙侠世界，一个专测天劫的渡劫顾问帮人渡劫赚钱，自己却因从不受劫而引来天雷记恨……", tag:"仙侠 · 轻喜" },
  { text:"悬疑刑侦，能看见死者最后三秒记忆的法医，追查连环悬案时发现所有死者都指向她的童年伙伴……", tag:"悬疑 · 刑侦" },
  { text:"末世生存，粮仓守护者发现地下城其实是为富人修建的末日方舟，而自己只是唯一的过期补给员……", tag:"末世 · 生存" },
  { text:"历史穿越，现代历史系学生穿成冷宫弃妃，靠课本知识预判宫廷权谋，却一步步改写了史书记载……", tag:"历史 · 穿越" },
  { text:"科幻太空，资源枯竭的殖民舰上，负责修理冷藏舱的技工发现一批被故意下架的冬眠者名单……", tag:"科幻 · 太空" },
  { text:"玄幻宗门，筑基失败、修为倒退的宗门杂役，反而成了唯一能看透渡心魔考核本质的人……", tag:"玄幻 · 宗门" },
  { text:"都市职场，跨国公司的普通 HR 发现公司招人的真正目的，竟与一场惊天商业骗局有关……", tag:"都市 · 职场" },
  { text:"宫斗权谋，被当作嫡女替代品培养的庶女，在嫡姐病逝后顶替入宫，卷入一场夺嫡阴谋……", tag:"宫斗 · 权谋" },
  { text:"奇幻日常，开在传说妖孽必经之路上的小茶馆主人，每夜接待不同来客，用一盏茶化解恩怨……", tag:"奇幻 · 日常" },
  { text:"赛博朋克，沉迷修复旧物的小镇修理工，在一台老录像机里发现的不是过去，而是尚未发生的未来……", tag:"赛博 · 设定" },
  { text:"医学悬疑，屡遭误诊斥责的乡村赤脚大夫，用祖传中医救下重患，却被卷入一场针对他的医疗阴谋……", tag:"医学 · 悬疑" }
];
let _lastIdeaIdx = -1;
let _curIdeaPh = '';
function currentIdeaPhrase(){
  if(!_curIdeaPh) _curIdeaPh = pickRandomIdea();
  return _curIdeaPh;
}
function rerollIdeaPhrase(){
  // 若用户已输入内容，则把新例子填入输入框；否则仅更新占位
  _curIdeaPh = pickRandomIdea();
  const ta = $('#ideaInput');
  if(ta && !ta.value.trim()) ta.setAttribute('placeholder', _curIdeaPh);
  else if(ta) ta.value = _curIdeaPh;
}
function pickRandomIdea(){
  if(!IDEA_SAMPLES.length) return '';
  let i = Math.floor(Math.random()*IDEA_SAMPLES.length);
  if(i === _lastIdeaIdx && IDEA_SAMPLES.length > 1) i = (i+1)%IDEA_SAMPLES.length; // 避免与上一轮重复
  _lastIdeaIdx = i;
  return IDEA_SAMPLES[i].text;
}

const STRUCTURES = [
  { id:'mesh', name:'多线网状交织', tag:'大师结构', short:'网状多线', src:'经典 · 网文 / 《红楼梦》体系',
    useStructure:true, structure:true,
    outlineSys: PROMPTS.longOutlineSys,
    chapterSys: PROMPTS.longChapterSys,
    desc:'借鉴《红楼梦》式网状多线：多条主线 + 副线 + 暗线同时推进并在汇合章收束，暗线早期埋设、结局揭晓。',
    mech:'默认优先采用多线交织或网状结构，补齐 ≥3 条叙事线索并做“三定”（定时间轴/定汇合点/定主次）；暗线从早期埋设直到结局呼应。',
    fit:'宏大世界观、群像、多势力角力的长篇；人物关系网复杂、多条伏笔同时推进的作品。',
    effect:'信息密度高、可读性强，是大师级长篇常用骨架；代价是需要强的一致性自检，否则易散架、坑填不完。' },
  { id:'causal', name:'单线因果式', tag:'经典打怪', short:'单线因果', src:'经典 · 取经路结构',
    useStructure:false, structure:false,
    outlineSys: `你是擅长编排经典长篇结构的资深小说架构师。根据用户构想设计一部长篇小说。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"title":"小说名","logline":"一句话梗概","chapters":[{"title":"章标题","summary":"本章核心事件与因果推进，1-2句","hook":"本章结尾因果钩子/悬念"}]}
要求：遵循「单线因果式」经典结构（如《西游记》取经路）——一根主线贯穿始终，"因为所以"一环扣一环，打完一关进入下一关，前因后果清晰、易读性强；主线明确推进、尽量不铺开多线；章章之间有明确因果链，前一章结果成为后一章起因；整体呈引入→闯关/成长→高潮→收束的清晰线路；每章 summary 写清本章推进的关卡/事件与原因结果，hook 写清衔接下章的因果钩子。`,
    chapterSys: `你是中文长篇小说的资深写手。根据「本章概要」与「章末钩子」写出本章完整正文，做到因果衔接、章章推进。
要求：遵循"因为所以"的单线因果推进——承接上一章的结果，作为本章起因，本章结束又为下一章留下因果钩子；主线单一清晰、少插枝节；有细腻的环境与心理描写、生动对话、鲜明的人物弧光与成长；节奏张弛有度；章末务必切在钩子上；只输出正文，不要标题、不要"本章完/未完待续"标注、不要任何解释。`,
    desc:'经典「单线因果式」结构（如《西游记》取经路）：一根主线贯穿、"因为所以"一环扣一环、打完一关进下一关，主线清晰易读。',
    mech:'所有章节沿一根主线串成因果链：上一章结果是本章起因、本章结果接下一章，打怪闯关式推进。',
    fit:'常规冒险/成长爽文、连载稳定、怕写崩的稳健型作品；追求易读、主线清晰、读者不迷路。',
    effect:'易读性强、追更顺滑、写作承载力稳定；代价是难容纳复杂副线，多线并存时会受限。' },
  { id:'layered', name:'分层递归展开', tag:'Long-Novel-GPT', short:'分层递归', src:'开源 · Long-Novel-GPT',
    useStructure:false, structure:false,
    outlineSys: `你是能驾驭超长篇的著名小说架构师。按【卷→部→章】分层递归地设计一部长篇小说。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"title":"小说名","logline":"一句话梗概","volumes":[{"name":"第X卷卷名","theme":"本卷主题与情绪基调","chapters":[{"title":"章标题","summary":"本章核心事件与转折，1-2句","goal":"本章阶段性目标/推进什么"}]}]}
要求：整体分 2-4 卷，各卷有清晰主题与情绪递进；每卷内章节数合理；章章承担阶段性目标（引入/冲突/转折/高潮/收束），卷与书之间存在因果链；标题有钩子感。`,
    chapterSys: `你是中文长篇小说的资深写手。根据「本卷主题」「本章目标」与「本章概要」写出本章完整正文，做到章章承接上卷、为后续蓄力。
要求：围绕“本章目标”推进（该引入就引入、该冲突就冲突、该转折就转折），承接上一卷已建立的人物与世界设定、不推倒重来；有细腻环境与心理描写、生动对话、人物弧光；章末留钩子或悬念；只输出正文，不要标题、不要"本章完/未完待续"标注、不要任何解释。`,
    desc:'借鉴 Long-Novel-GPT / AI_Gen_Novel 的“卷→部→章→节”分层递归：先生成全局卷章框架，再逐卷逐章填充目标。',
    mech:'自上而下先生成全局卷章框架（卷→部→章），再逐卷逐章填充阶段性目标，层级清晰、容量可控。',
    fit:'目标明确、分卷清晰、需要高可维护性的超长篇；世界观宏大、章节海量想保持不乱的类型文。',
    effect:'结构层级严谨、每卷有独立主题与情绪递进，长期连载不易崩；代价是卷间衔接与全局呼应更费设计。' },
  { id:'hero', name:'英雄之旅', tag:'Hero\'s Journey', short:'英雄之旅', src:'开源 · NovelForger',
    useStructure:false, structure:true,
    outlineSys: `你是深谙「英雄之旅」结构美学的著名小说架构师。根据用户构想设计一部长篇小说。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"title":"小说名","logline":"一句话梗概","structure":{"mode":"英雄之旅","designReason":"为何采用此倒逼成长框架","stageChapters":{"平凡世界":["章标题",...],"召唤":["章标题",...],"拒绝召唤":["章标题",...],"跨过门槛":["章标题",...],"试炼盟友敌人":["章标题",...],"深渊一搏":["章标题",...],"回报":["章标题",...],"归来":["章标题",...],"变更之王":["章标题",...]}},"chapters":[{"title":"章标题","summary":"本章核心事件与英雄阶段，1-2句","hook":"本章结尾钩子/悬念"}]}
要求：遵循经典「英雄之旅」十二阶段（平凡世界→召唤→拒绝→导师→跨过门槛→试炼/盟友/敌人→深渊→一搏→回报→归来→变更），倒逼主角成长弧光；阶段不必逐一对应单独一章，可按体量合并或拆分，但整体要完整走完成长路径；每章 summary 写清该章的英雄阶段与推进，hook 写清章末钩子。`,
    chapterSys: `你是中文长篇小说的资深写手。根据「本章概要」与「章末钩子」写出本章完整正文，做到章章推动英雄的成长弧光。
要求：围绕本章所处的「英雄之旅」阶段推进角色弧光——该试炼就试炼、该受挫就受挫、该升华就升华；主角每次抉择都要有代价、有成长痕迹；细腻的环境与心理描写、生动对话；章末留钩子或悬念；只输出正文，不要标题、不要"本章完/未完待续"标注、不要任何解释。`,
    desc:'借鉴 Hero\'s Journey（《千面英雄》，NovelForger 支持）：12 阶段倒逼主角成长弧光，适合成长正气类长篇。',
    mech:'把全书章节映射到英雄之旅十二阶段（平凡世界→召唤→跨过门槛→深渊→一搏→归来），让成长弧光结构可预期。',
    fit:'主角成长型、冒险/奇幻类；希望有清晰#成长曲线#与情感爆发点的长篇。',
    effect:'主角弧光完整、情感起伏有据可依、商业辨识度高；代价是套用若生硬会显得套路化。' },
  { id:'savecat', name:'节拍表', tag:'Save the Cat', short:'节拍表', src:'业界 · Save the Cat',
    useStructure:false, structure:true,
    outlineSys: `你是深谙「节拍表」结构美学的著名小说架构师。根据用户构想设计一部长篇小说。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"title":"小说名","logline":"一句话梗概","structure":{"mode":"Save the Cat 节拍表","designReason":"如何用 15 拍控制节奏","beats":{"开场画面":["章标题",...],"催化剂":["章标题",...],"争执":["章标题",...],"进入第二幕":["章标题",...],"B故事":["章标题",...],"中点":["章标题",...],"坏人逼近":["章标题",...],"一切尽失":["章标题",...],"黑暗时刻":["章标题",...],"进入第三幕":["章标题",...],"终局":["章标题",...],"最终画面":["章标题",...]}},"chapters":[{"title":"章标题","summary":"本章核心事件与节拍，1-2句","hook":"本章结尾钩子/悬念"}]}
要求：遵循 Save the Cat 的 15 节拍（开场→催化剂→争执→B故事→中点→一切尽失→终局→最终画面等），把全书章节分配到各节拍上，节奏可预估；每章 summary 写清本章所属节拍与推进，hook 写清章末钩子。`,
    chapterSys: `你是中文长篇小说的资深写手。根据「本章概要」与「章末钩子」写出本章完整正文，做到章章贴合 Save the Cat 节拍曲线。
要求：围绕本章所处的「节拍」推进节奏（平原蓄力、催化剂提速、黑暗时刻骤降、终局引爆等），情绪张力随节拍起伏；细腻的心理与场景描写、生动对话、人物弧光；章末留钩子或悬念；只输出正文，不要标题、不要"本章完/未完待续"标注、不要任何解释。`,
    desc:'借鉴 Save the Cat 15 节拍法：三幕展开为 15 个可预估节拍点，适合商业向、节奏可控的长篇。',
    mech:'用 15 个固定节拍（开场/催化剂/争执/中点/一切尽失/终局…）标注全书情绪曲线，节奏可计算、可预估。',
    fit:'商业类型文、需要稳定节奏与“可预估追读”的连载作品；编剧思维、强钩子驱动的长篇。',
    effect:'节奏可预估、爽点位置明确、改编友好；代价是拍点分配若机械会产生套路感。' },
  { id:'seven', name:'七点结构', tag:'Seven-Point', short:'七点结构', src:'开源 · NovelForger',
    useStructure:false, structure:true,
    outlineSys: `你是深谙「七点结构」的著名小说架构师。根据用户构想设计一部长篇小说。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"title":"小说名","logline":"一句话梗概","structure":{"mode":"七点结构","designReason":"七个锚点如何控制转折","points":{"Hook钩子":["章标题",...],"PlotTurn1一转折":["章标题",...],"Pinch1中点施压":["章标题",...],"Midpoint中点":["章标题",...],"Pinch2压力加码":["章标题",...],"PlotTurn2二转折":["章标题",...],"Resolution解局":["章标题",...]}},"chapters":[{"title":"章标题","summary":"本章核心事件与转折锚点，1-2句","hook":"本章结尾钩子/悬念"}]}
要求：遵循七点结构（Hook→Plot Turn 1→Pinch 1→Midpoint→Pinch 2→Plot Turn 2→Resolution），用七个锚点控制全书转折节奏；每章 summary 写清该章所在锚点与推进，hook 写清章末钩子。`,
    chapterSys: `你是中文长篇小说的资深写手。根据「本章概要」与「章末钩子」写出本章完整正文，做到章章朝七个锚点有序逼近。
要求：围绕本章所在锚点推进（前段蓄力、Two Plot 转折、Pinch 施压、Midpoint 承转），每章都向“下一个转折点”收拢、不生枝节；细腻的心理与场景描写、生动对话、人物弧光；章末留钩子或悬念；只输出正文，不要标题、不要"本章完/未完待续"标注、不要任何解释。`,
    desc:'借鉴 Seven-Point Structure（NovelForger 支持）：Hook→转折→施压→中点→加码→再转折→解局，七个锚点控转折。',
    mech:'以七个固定锚点（Hook/PlotTurn/Pinch/Midpoint/Pinch/PlotTurn/Resolution）规划全书转折，前紧后强。',
    fit:'中短到中长篇、转折重戏剧性、希望#转折节奏#清晰的作品。',
    effect:'转折节奏清晰、终点明确、不拖沓；代价是锚点之外的空间偏线性、群像叙事较难承载。' }
];

const RHYTHMS = [
  { id:'web', name:'黄金网文', tag:'爽点密集', short:'黄金网文', src:'经典 · 网文爆款体系',
    outlineNote:'节奏遵循黄金网文强节奏——开篇尽快抛核心冲突与悬念（金手指/秘密）；因果链清晰、角色抉择有代价、实力或关系阶梯递进；情绪节奏有张有弛（爽点-压抑-爆发交替）；每章 summary 写清本集“爽点”与推进，hook 写清章末强钩子。',
    chapterNote:'严格遵循黄金网文强节奏——开篇(前1-2段)尽快进入事件或情绪；以对话与行动推动剧情、少冗长环境描写；本章须兑现一个"爽点/进展"，并为下章留强钩子（悬念/反转/危机）；因果清晰、有记忆点的人设；章末务必切在钩子上。',
    desc:'当前商业网文最有效的节奏配方，核心是“爽点管理”：全程用小高潮喂给读者，持续满足与追更。',
    mech:'开篇抛冲突悬念；因果清晰、抉择有代价、实力/关系阶梯递进；情绪爽点-压抑-爆发交替；章末必留强钩子。',
    fit:'升级流、逆袭、热血爽文等重代入感连载；读者重爽感、重追更。',
    effect:'留存与追更率高、最懂市场；代价是易套路化，需靠人物与爽点创新破局。' },
  { id:'repress', name:'压抑反转流', tag:'现实虐文', short:'压抑反转', src:'现实 · 黑暗向节奏',
    outlineNote:'节奏为压抑反转流——回报延迟、挫折长期，主角不会立刻打脸、苦难不马上消解；情绪是隐忍煎熬、积蓄良久才释放；困境层层叠加、主角反复受挫；每章 summary 写清本集被压抑的张力与潜在的伏笔，hook 写清迟来的反转或加剧的困境。',
    chapterNote:'遵循压抑反转流——本段情绪以隐忍煎熬为主，不立刻给胜利与奖励；困境层层叠加、主角反复受挫；把发泄点压到很后，部分努力可以没有回报；章末压在反转来临前或苦难加剧处，勾着读者等释放。',
    desc:'与爽文相反：回报延迟、挫折长期、反转来得晚，部分努力无回报；情绪隐忍煎熬、积蓄良久才释放。',
    mech:'困境层层叠加、主角反复受挫、不会立刻打脸；冲突发生后不立刻给胜利，反转往往很晚、甚至部分努力无回报。',
    fit:'社会向、悬疑、悲剧、历史写实网文；追求真实沉重的情感冲击而非即时爽感。',
    effect:'压抑到极点的释放更有力量、人物弧光深；但需控节奏，避免“虐而无解”劝退读者。' },
  { id:'slice', name:'慢生活流', tag:'种田日常', short:'慢生活', src:'现实 · 治愈向节奏',
    outlineNote:'节奏为慢生活流——低外部冲突、少大起大落，冲突是细碎生活矛盾；剧情推进极慢，聚焦人物感受、生活细节、人际关系；爽点来自安宁烟火与人物陪伴，非升级逆袭；每章 summary 写清本集的日常事件与人物关系变化。',
    chapterNote:'遵循慢生活流——聚焦日常生活与人物相处，不追求强冲突；剧情推进慢、冲突多为细碎小事；细腻刻画感官与情绪、烟火气与陪伴感；爽点来自安宁与温暖，而非打脸逆袭。',
    desc:'种田/日常/治愈：低外部冲突、少大起大落，冲突是细碎生活矛盾；推进极慢，聚焦感受、细节、关系。',
    mech:'以日常与生活矛盾代替强冲突，推进极慢；爽点来自安宁烟火与人物陪伴。',
    fit:'种田、日常、治愈、慢热的温馨长篇；读者追求沉浸与陪伴而非刺激。',
    effect:'氛团队入手温柔治愈、黏性高、抗弃文；代价是无强钩子、追读节奏需靠情感维系。' },
  { id:'mystery', name:'悬疑解谜流', tag:'悬念悬置', short:'悬疑解谜', src:'正统 · 悬疑推理节奏',
    outlineNote:'节奏为悬疑解谜流——冲突不快速解决，故意压住答案、延迟兑现；不断抛谜团线索、危机接踵但不揭真相；旧问题搁置、释放留到中后期；每章 summary 写清本集抛出的谜团/线索与悬置的张力，hook 埋最小的启示或新谜面。',
    chapterNote:'遵循悬疑解谜流——答案要压住，冲突不要立刻收束；不断抛谜团与线索，危机接踵但不揭真相；旧问题先搁置；本章结尾留悬念，勾着读者解谜。',
    desc:'悬念悬置：冲突不快速解决、故意压住答案、延迟兑现；不断抛谜团线索、危机接踵但不揭真相。',
    mech:'正统悬疑节奏是“悬置＞即时解决”：放下钩子、转开视角、旧问题搁置、释放拖到中后期。',
    fit:'悬疑、推理、解谜、谍战类长篇；读者重“猜中/揭晓”的智力快感。',
    effect:'抓人、让人放不下、揭晓时爆点强；代价是伏笔回收要求高，烂尾风险大。' },
  { id:'epic', name:'群像史诗节奏', tag:'宏大史诗', short:'群像史诗', src:'历史 · 宏大奇幻节奏',
    outlineNote:'节奏为群像史诗——不以单一主角得失为节奏开关，视角在多人间切换；主角会失败、配角命运独立；大事件周期长、一卷几十章才完成一次大起落；每章 summary 写清多线中本章的视角人物与推进。',
    chapterNote:'遵循群像史诗——视角在多人间切换，不以单一主角成败为节奏开关；主角也会失败、配角命运独立；大事件跨度长、不追求每章小爽点；多线并进、交织成时代洪流。',
    desc:'历史/宏大奇幻：不以单一主角得失为节奏开关，视角在多人间切换、配角命运独立、大事件周期长。',
    mech:'大事件以卷为单位起落，视角多线切换，主角可失败、配角命运独立，格局宏大。',
    fit:'历史演义、宏大奇幻、权谋群像类长篇；读者重世界构建与时代感。',
    effect:'格局与史诗感强、人物群像丰满、可承载大世界；代价是个体代入感弱、节奏偏慢。' },
  { id:'fatal', name:'悲剧宿命流', tag:'命运悲剧', short:'悲剧宿命', src:'文学 · 悲剧节奏',
    outlineNote:'节奏为悲剧宿命——努力≠胜利、结局被命运预先约束；抗争不一定换来圆满，一次次抗争爬升迎短暂光亮再跌落；情绪很少彻底宣泄、留有怅然；每章 summary 写清本集一次次挣扎与短暂的希望、以及不可抗的推力。',
    chapterNote:'遵循悲剧宿命——抗争不一定换来圆满，努力可能徒劳；爬升后迎短暂光亮再跌落；情绪很少彻底宣泄、刻意留怅然与无力感，让悲剧宿命感贯穿。',
    desc:'努力≠胜利、结局被命运预先约束：抗争不一定圆满，一次次爬升迎短暂光亮再跌落；情绪少有宣泄、留怅然。',
    mech:'以“命运不可抗”为底色，抗争服务于悲剧张力而非胜利；情绪罕有彻底宣泄。',
    fit:'悲剧、宿命、史诗型沉重作品；读者重情绪厚重感与命运叩问。',
    effect:'情感厚重、后劲足、文学性强；代价是致郁、不适配追求爽感的读者。' },
  { id:'inward', name:'文艺向内流', tag:'心理向内', short:'文艺向内', src:'文学 · 心理向节奏',
    outlineNote:'节奏为文艺向内——节奏由内心驱动，外部事件只是载体；冲突多发生在心里，剧情推进慢、大事件少，重点是人物纠结、自我认知与情感变化；每章 summary 写清本集人物内心变化与情感转折。',
    chapterNote:'遵循文艺向内——节奏由人物内心驱动，外部事件仅是载体；冲突多在心理层面；推进慢、大事件少；着力刻画纠结、自我认知与情感变化、文笔细腻。',
    desc:'情绪/心理向：节奏由内心驱动，外部事件是载体；冲突多在心里，推进慢、大事件少，重纠结与自我认知。',
    mech:'以内心冲突代替外部事件驱动叙事，细腻刻画人物情绪与认知变化。',
    fit:'文艺、情感、成长类长篇；读者重文笔、情绪共鸣与人物内省。',
    effect:'文笔与情绪质感强、人物立体、差异化明显；代价是节奏慢、爽点少，需要读者耐性。' }
];

const QUALITIES = [
  { id:'dual', name:'写手-编辑双审', tag:'NovelForge', short:'双审', src:'开源 · NovelForge',
    desc:'写手起草初稿后，编辑按角色一致性/剧情逻辑/世界观三维打分（0-100），低于阈值自动让写手按意见重写。',
    mech:'一章初稿 → 编辑三维评分（role/plot/world，≥70 为 pass）→ 不达标则带上意见让写手重写，最多 2 轮。',
    fit:'追求叙事质量下限、想减少硬伤与逻辑崩坏的作品。',
    effect:'直接锁单章质量下限，逻辑更稳；代价是每章约多 1-2 次调用、更耗时。' },
  { id:'selfref', name:'自省重写', tag:'Reflexion', short:'自省重写', src:'开源 · NovelForge Self-Reflection',
    desc:'每章生成后让模型自评短板并自我修正，实现最简单（纯提示词追加）。',
    mech:'章节初稿生成后，自问“本章最大短板”（情绪/逻辑/文笔/人物），据此重写 1 次完善，成本较低。',
    fit:'想低成本增强单章完成度的作品。',
    effect:'简单高效、单章完成度上升；代价是自评可能不敏锐，提升幅度不如双审稳定。' },
  { id:'plothole', name:'伏笔洞检测', tag:'逻辑核查', short:'伏笔检测', src:'论文 · FLAWEDFICTIONS',
    desc:'针对连续性错误（时间线/性格/伏笔回收）做专项核查与修正，与结构/节奏无关、任意组合可叠加。',
    mech:'章节写出后专项检查时间线、性格一致、伏笔回收、专名统一四处；发现逻辑漏洞即按“一致性自检”重写修正。',
    fit:'多线、长连载、伏笔密的作品；强烈建议与多线网状结构同用时开启。',
    effect:'大幅减少吃书/穿帮/伏笔丢弃，中长期一致性更稳；代价是额外一次核查调用。' }
];

const STRUCTURE_IDS = STRUCTURES.map(s=> s.id);
const RHYTHM_IDS = RHYTHMS.map(r=> r.id);
const QUALITY_IDS = QUALITIES.map(q=> q.id);

// 当前所选
function selStructure(){ return state.recipeSet && STRUCTURES.find(s=> s.id === state.recipeSet.structure) || null; }
function selRhythm(){ return state.recipeSet && RHYTHMS.find(r=> r.id === state.recipeSet.rhythm) || null; }
function selQualities(){ return (state.recipeSet && Array.isArray(state.recipeSet.quality)) ? state.recipeSet.quality.filter(id=> QUALITY_IDS.includes(id)).map(id=> QUALITIES.find(q=> q.id===id)).filter(Boolean) : []; }
function hasQuality(id){ return Array.isArray(state.recipeSet && state.recipeSet.quality) && state.recipeSet.quality.includes(id); }

// 默认体量：用户填了哪一侧就用哪一侧；都没填回退默认字数区间 3000-5000
// 归一化：把可能残缺的区间补全（min/max 任一缺省则用对侧/默认补足），保证派生计算不出现 NaN
function normalRange(r, fallback){
  const min = (typeof r==='object' && +r.min>0) ? +r.min : fallback.min;
  const max = (typeof r==='object' && +r.max>0) ? +r.max : Math.max(min, fallback.max);
  return { min, max: Math.max(min, max) };
}
function selSize(){
  if(state.chapterRange && (state.chapterRange.min>0 || state.chapterRange.max>0)){
    return { kind:'chapter', range: normalRange(state.chapterRange, {min:80,max:100}) };
  }
  if(state.wordRange && (state.wordRange.min>0 || state.wordRange.max>0)){
    return { kind:'word', range: normalRange(state.wordRange, SIZE_DEFAULT) };
  }
  return { kind:'word', range: SIZE_DEFAULT };
}
const fmtRange = r => `${r.min}-${r.max}`;
// 全书总字数基准：优先用用户在「最前」设定的 totalWords，未设时回退 30 万
function totalWordsBase(){ return (state.totalWords && +state.totalWords>0) ? +state.totalWords : 300000; }
const totalWan = () => (totalWordsBase()/10000).toLocaleString('en-US');
// 由区间中值映射到对侧建议值（总字数可调，故按 totalWordsBase）
function estCounterpart(sz){
  const mid = (sz.range.min + sz.range.max) / 2;
  if(!mid) return null;
  return Math.round(totalWordsBase()/mid);
}
// 体量一句提示（页面 + 可复用）
function sizeHintText(){
  const hasW = state.wordRange && (state.wordRange.min>0 || state.wordRange.max>0);
  const hasC = state.chapterRange && (state.chapterRange.min>0 || state.chapterRange.max>0);
  if(!hasW && !hasC) return '请先 ☑ 勾选「每章字数」或「全书章节」其中一项，再滑动滑条调整区间。';
  const sz = selSize();
  const cnt = estCounterpart(sz);
  if(sz.kind==='word') return `按每章 ${fmtRange(sz.range)} 字，全书约需 ${cnt} 章。`;
  return `全书约 ${fmtRange(sz.range)} 章，每章据此约 ${cnt} 字。`;
}
// 生成「体量」单侧块：顶部为二选一勾选框（radio），下方为该侧双滑条。
// side ∈ {word,chapter}；r 为已有区间（可为 null 用默认）；on 表示该侧是否已勾选生效。
// 只有勾选（on）的一侧滑条才可操作；未勾选侧整块灰色、滑条禁用占位。
function sizeSlider(side, label, lo, hi, step, r, on){
  const dflt = side==='word' ? {min:3000,max:5000} : {min:80,max:100};
  const v = (r && +r.min>0 && +r.max>0) ? {min:+r.min, max:+r.max} : dflt;
  v.min = Math.max(lo, Math.min(hi, v.min));
  v.max = Math.max(lo, Math.min(hi, v.max));
  if(v.max < v.min) v.max = v.min;
  const cls = on ? 'size-block on' : 'size-block';
  const fmt = n => side==='word' ? n.toLocaleString() : String(n);
  return `<div class="${cls}" data-side="${side}">
      <button type="button" class="size-pick" data-pick="${side}" aria-pressed="${on}">
        <span class="size-radio">${on?'✓':''}</span>
        <span class="size-lbl">${label}</span>
      </button>
      <span class="size-val"><b data-dr-val="${side}">${fmt(v.min)} ~ ${fmt(v.max)}</b></span>
      <div class="drs ${on?'':'ds-off'}" data-drs="${side}" data-min="${lo}" data-max="${hi}" data-step="${step}"></div>
      <span class="size-scale">${lo.toLocaleString()} ~ ${hi.toLocaleString()}${side==='word'?' 字':' 章'}</span>
    </div>`;
}
// 同轨双滑块：采用成熟的 noUiSlider（零依赖，双手柄 + 触屏 + 键盘 + ARIA，社区最通用）
// 参考 https://github.com/leongersen/noUiSlider  · 用法见 https://refreshless.com/nouislider/
// margin=step 保证两柄不交叉；update 实时刷新标签，change 松手才提交到 state
function initDRS(){
  $$('.drs').forEach(drs=>{
    const side = drs.dataset.drs;
    const lo = +drs.dataset.min, hi = +drs.dataset.max, step = +drs.dataset.step;
    const stateR = side==='word' ? state.wordRange : state.chapterRange;
    const dflt = side==='word' ? {min:3000,max:5000} : {min:80,max:100};
    let v0 = (stateR && +stateR.min>0) ? +stateR.min : dflt.min;
    let v1 = (stateR && +stateR.max>0) ? +stateR.max : dflt.max;
    v0 = Math.max(lo, Math.min(hi, v0));
    v1 = Math.max(lo, Math.min(hi, v1));
    if(v1 < v0) v1 = v0;
    if(drs.noUiSlider){ drs.noUiSlider.destroy(); drs.noUiSlider = null; } // render 会重建；先销毁旧实例
    // 未勾选侧：不创建滑块，仅保留灰色禁用占位（.ds-off）
    if(drs.classList.contains('ds-off')) return;
    noUiSlider.create(drs, {
      start: [v0, v1],
      connect: true,
      step: step,
      margin: step,
      range: { min: lo, max: hi }
    });
    const lbl = drs.parentElement.querySelector('[data-dr-val="'+side+'"]');
    const fmt = n => side==='word' ? n.toLocaleString() : String(n);
    // 拖动实时更新上面的数值标签
    drs.noUiSlider.on('update', (vals)=>{
      if(lbl){ const a=+vals[0], b=+vals[1]; lbl.textContent = fmt(a)+' ~ '+fmt(b); }
    });
    // 松手/键盘结束时提交到 state，并刷新派生提示
    drs.noUiSlider.on('change', (vals)=>{
      const R = { min: Math.round(+vals[0]), max: Math.round(+vals[1]) };
      if(side==='word'){ state.wordRange=R; state.chapterRange=null; }
      else { state.chapterRange=R; state.wordRange=null; }
      const hint = $('#sizeHint'); if(hint) hint.textContent = sizeHintText();
      persist(); render();
    });
  });
}
// 勾选「体量」某侧（radio 二选一）：选中该侧并把另一侧置空；该侧无已设区间则给默认区间作为滑条起点。
function pickSize(side){
  if(side==='word'){
    if(!(state.wordRange && +state.wordRange.min>0)) state.wordRange = { min:3000, max:5000 };
    state.chapterRange = null;
  }else{
    if(!(state.chapterRange && +state.chapterRange.min>0)) state.chapterRange = { min:80, max:100 };
    state.wordRange = null;
  }
  const hint = $('#sizeHint'); if(hint) hint.textContent = sizeHintText();
  persist(); render();
}

// 按所选体量推导「单章正文的 max_tokens 上限」，防止模型偶发超长输出推高成本
// 中文字符与 token 大体按 1:1 估算，加 1.6 倍缓冲并夹在安全区间内
function chapterMaxTokens(){
  const sz = selSize();
  let base;
  if(sz.kind==='word') base = sz.range.max;
  else base = Math.round(totalWordsBase() / ((sz.range.min + sz.range.max) / 2));
  return Math.min(20000, Math.max(600, Math.ceil(base * 1.6)));
}
// 把「锚点 → 改写段落」应用回初稿（段落级重写合并）。锚点找不到则跳过该条，保守不破坏正文。
function applyPatches(draft, patches){
  if(!Array.isArray(patches) || !patches.length) return draft;
  let out = draft;
  for(const p of patches){
    const a = String(p.anchor || '').trim();
    const r = String(p.rewritten || '').trim();
    if(!a || !r) continue;
    const idx = out.indexOf(a);
    if(idx < 0) continue;
    const segStart = out.lastIndexOf('\n\n', idx) + 2;         // 该段起点
    let segEnd = out.indexOf('\n\n', idx + a.length);          // 该段终点
    if(segEnd < 0) segEnd = out.length;
    const leading = out.slice(0, segStart);
    const trailing = out.slice(segEnd);
    out = leading + r + (trailing.startsWith('\n') || /[\n。！？）」』]\s*$/.test(r) ? trailing : '\n' + trailing);
  }
  return out;
}

// 体量提示（拼入大纲提示词）
function outlineSizeNote(){
  const sz = selSize();
  const cnt = estCounterpart(sz);
  if(sz.kind === 'word') return `全书目标约 ${totalWan()} 万字；单章篇幅落在 ${fmtRange(sz.range)} 字，据此全书约 ${cnt} 章。`;
  return `全书目标约 ${totalWan()} 万字 / ${fmtRange(sz.range)} 章，据此每章约 ${cnt} 字。`;
}
/* 万物词典统一要求块：无论选哪种结构都追加到大纲提示词，保证模型输出 glossary（建议7/决策8/9）
 * 用独立的“追加 JSON 字段”写法，兼容各结构各自的 schema，无需改每个结构模板。 */
const GLOSSARY_SYS = `\n\n【glossary 万物词典（必须一并输出）】请在返回的 JSON 顶层再追加一个 glossary 字段，作为全文保持一致性的权威基准：
"glossary":{"characters":[{"name":"人物姓名","relation":"与该人相关人物及关系","trait":"性格/外貌要点"}],"places":[{"name":"地名/场景名","type":"类型","note":"设定要点"}],"propernouns":[{"name":"专名/专属设定术语","note":"含义与拼写唯一约定"}]}
必须列出本故事涉及的全部重要人物（含配角）、关键地域地名与专属设定术语；**全书正文一律只使用本词典中的人名/地名/专名，禁止自造或混用其他拼写**。人物 relation 写清角色间关系，trait 归纳稳定性格与外貌以便后续各章保持一致；数量依故事体量，人物 3-15 名、地名 2-10 处、专名 2-8 个均可。`;

function buildOutlineSys(){
  const st = selStructure(), rh = selRhythm();
  const parts = [];
  parts.push(st ? st.outlineSys : PROMPTS.longOutlineSys);
  if(rh && rh.outlineNote) parts.push('\n【节奏风格 · '+rh.name+'】\n'+rh.outlineNote);
  parts.push('\n【篇幅体量】\n'+outlineSizeNote());
  parts.push(outlineGlossaryInject(state.pendingGlossary));   // v8 双轨：有导引用权威块，无导入保持原「请自造词典」块
  return parts.join('\n\n');
}
// 遵从度 → 喂给 AI 的要求（v8：与 adherenceHint 的语义一一对应，供模型判断遵循程度）
function adherenceSys(a, allowFill){
  if(a>=100) return '遵从度为 100%（铁律）：词典中已有的人名/地名/专名必须逐字沿用，禁止改拼写或另造别名，仅允许按本作大纲新增角色。';
  if(a>=80)  return `遵从度为 ${a}%（基准）：尽量沿用既有命名，允许个别因新情节做小幅调整。`;
  if(a>=60)  return `遵从度为 ${a}%（主要参照）：核心人物保留原名，地名/专名可按新剧情调整。`;
  if(a>=30)  return `遵从度为 ${a}%（灵感来源）：可适度大改命名，仅保留题材与语感。`;
  return `遵从度为 ${a}%（几乎放弃）：仅作背景语感参考，允许完全重新构建设定${allowFill?'，可自由创新命名。':''}`;
}
// v8 阶段3：大纲提示词词典块（双轨关键）。有 pendingGlossary 时生成「权威复用词典块」，
// 把导入词典作为一致性底稿回填给模型；无导入时返回默认 GLOSSARY_SYS，主轨完全不受影响。
function outlineGlossaryInject(g){
  if(!g || !sourceHasGlossary(g)) return GLOSSARY_SYS;
  const cs=(g.characters||[]).map(c=>`${c.name}${c.relation?`（${c.relation}）`:''}${c.trait?`｜${c.trait}`:''}`).join('； ');
  const ps=(g.places||[]).map(p=>`${p.name}${p.type?`（${p.type}）`:''}${p.note?`｜${p.note}`:''}`).join('； ');
  const pn=(g.propernouns||[]).map(p=>`${p.name}${p.note?`（${p.note}）`:''}`).join('； ');
  const fill = state.glossAllowFill ? '\n允许并鼓励你在不在底稿中的新设定上自由新增人物/地名/专名。' : '\n除非必要，避免无谓地新增与底稿无关的实体。';
  return `\n\n【复用词典 · 权威一致性底稿（v8）】以下是既有的权威词典，请在返回 JSON 顶层照常追加 glossary 字段，并以本底稿为主集：${adherenceSys(state.glossAdherence, state.glossAllowFill)}
"glossary":{"characters":[{"name":"人物姓名","relation":"他人关系","trait":"性格/外貌"}],"places":[{"name":"地名","type":"类型","note":"设定"}],"propernouns":[{"name":"专名","note":"含义"}]}
人物：${cs||'（无）'}
地点：${ps||'（无）'}
专名：${pn||'（无）'}
底稿中已有人名/地名/专名一律沿用，不得推倒重造一套；只按本作大纲补充新增条目，新增条目 schema 与该类别保持一致。${fill}`;
}
// v8 阶段3：本体词典块（章节正文共同复用）。取合并后的大纲词典，生成「严格服从」一致性基准。
// v8b（建议1）：正文也全量带词典详情（人物关系/性格外貌/身份职能、地点类型/说明、专名含义），
// 不再做瘦身上限——详情对提高重生成的上下文一致性收益大于其微小 token 开销（约 +300~500 token/章）。
function chapterGlossaryBlock(){
  const o = state.outline;
  const g = (o && o.glossary) || {};
  if(!sourceHasGlossary(g)) return '';
  const cDetail = c => [c.relation?`关系:${c.relation}`:'', c.trait?`性格/外貌:${c.trait}`:'', c.identity?`身份:${c.identity}`:'', c.role?`职能:${c.role}`:''].filter(Boolean).join('；');
  const pDetail = p => [p.type?`类型:${p.type}`:'', p.note?`说明:${p.note}`:''].filter(Boolean).join('；');
  const cs = (g.characters||[]).filter(c=>c.name).map(c=> `${c.name}${cDetail(c)?`（${cDetail(c)}）`:''}`).join('、');
  const ps = (g.places||[]).filter(p=>p.name).map(p=> `${p.name}${pDetail(p)?`（${pDetail(p)}）`:''}`).join('、');
  const pn = (g.propernouns||[]).filter(p=>p.name).map(p=> `${p.name}${p.note?`（${p.note}）`:''}`).join('、');
  return `\n\n【全文一致性基准（严格服从，禁止自造新名）】\n人物：${cs||'（无）'}\n地点：${ps||'（无）'}\n专名：${pn||'（无）'}\n正文人名一律使用以上基准中的名称，人物关系/性格、地点类型、专名含义按上表保持统一。`;
}
// v8 阶段4：覆盖面自检——对每条词典条目统计其在已生成章节正文的出现次数，返回 {used:[],unused:[]} 与全局命中率。
function checkGlossaryCoverage(){
  const g = (state.outline && state.outline.glossary) || {};
  const body = state.chapters.filter(c=>c && c.content).map(c=>String(c.content)).join('\n');
  const summary = { total:0, hit:0, chars:{used:[],unused:[]}, places:{used:[],unused:[]}, props:{used:[],unused:[]} };
  const scan = (arr, bucket)=>{
    (arr||[]).forEach(it=>{
      const nm = String(it.name||'').trim(); if(!nm) return;
      summary.total++;
      const re = new RegExp(escRe(nm), 'g');
      const n = body.match(re) ? body.match(re).length : 0;
      (n>0 ? bucket.used : bucket.unused).push({name:nm, count:n});
      if(n>0) summary.hit++;
    });
  };
  scan(g.characters, summary.chars);
  scan(g.places, summary.places);
  scan(g.propernouns, summary.props);
  return summary;
}
// v8 阶段4：覆盖面自检弹窗（列每条条目的出现次数，标出 0 次者）
function openCoveragePanel(){
  closeCoveragePanel();
  const s = checkGlossaryCoverage();
  const row = (arr, icon)=> arr.length ? arr.map(x=>`<div class="cv-row ${x.count===0?'cv-zero':''}"><span class="cv-icon">${icon}</span><b>${esc(x.name)}</b><span class="cv-cnt">${x.count===0?'未用到':x.count+' 次'}</span></div>`).join('') : '';
  const pct = s.total ? Math.round(s.hit/s.total*100) : 0;
  const ov = document.createElement('div');
  ov.id='cvPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>📊 词典覆盖面自检</b><button class="gs-x" data-cv-close>✕</button></div>
      <div class="gs-body">
        <p class="muted" style="margin:0 0 8px">对已在正文中出现过的章节做统计；0 次的条目可能未被使用，可考虑精简。共 ${s.total} 条 · 已覆盖 ${s.hit} 条（${pct}%）</p>
        ${s.chars.used.length||s.chars.unused.length?`<div class="cv-sec">👤 人物</div>${row(s.chars.used.concat(s.chars.unused),'👤')}`:''}
        ${s.places.used.length||s.places.unused.length?`<div class="cv-sec">📍 地点</div>${row(s.places.used.concat(s.places.unused),'📍')}`:''}
        ${s.props.used.length||s.props.unused.length?`<div class="cv-sec">🔤 专名</div>${row(s.props.used.concat(s.props.unused),'🔤')}`:''}
      </div>
      <div class="gs-actions"><button class="btn" data-cv-close>关闭</button></div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelectorAll('[data-cv-close]').forEach(b=> b.onclick = ()=>{ closeCoveragePanel(); });
  ov.addEventListener('click', e=>{ if(e.target===ov) closeCoveragePanel(); });
}
function closeCoveragePanel(){ const p=$('#cvPanel'); if(p) p.remove(); }
// 体量提示（拼入章节正文提示词，控制单章容量）
function sizeChapterInjection(){
  const sz = selSize();
  const cnt = estCounterpart(sz);
  if(sz.kind === 'word') return `本章正文应落在 ${fmtRange(sz.range)} 字区间（全书约 ${cnt} 章、总目标约 ${totalWan()} 万字），据此把握本章的容量与叙事节奏。`;
  return `全书约 ${fmtRange(sz.range)} 章（每章据此约 ${cnt} 字），总目标约 ${totalWan()} 万字，据此把握单章容量与节奏。`;
}
// 更新体量派生提示（页面内）
function bindSizeHint(){
  const el = $('#sizeHint'); if(!el) return;
  el.textContent = sizeHintText();
  // 同步刷新两个滑条侧的值标签（render 会重画滑条位置，这里先改文字，避免拿旧值）
  $$('[data-size-lbl]').forEach(b=>{
    const key = b.dataset.sizeLbl;          // e.g. 'word-min'
    const [side, kind] = key.split('-');
    const r = side==='word' ? state.wordRange : state.chapterRange;
    if(r && +r[kind]>0){ b.textContent = side==='word' ? (+r[kind]).toLocaleString() : r[kind]; }
  });
}
// 拼装：章节提示词 =（结构章节 × 节奏 × 体量）
function buildChapterSys(){
  const st = selStructure(), rh = selRhythm();
  const parts = [];
  parts.push(st ? st.chapterSys : PROMPTS.longChapterSys);
  if(rh && rh.chapterNote) parts.push('\n【节奏风格 · '+rh.name+'】\n'+rh.chapterNote);
  parts.push('\n【篇幅体量】\n'+sizeChapterInjection());
  return parts.join('\n\n');
}
// 兼容旧调用入口
function longRecipe(){ return selStructure() || STRUCTURES[0]; }
function longOutlineSys(){ return buildOutlineSys(); }
function longChapterSys(){ return buildChapterSys(); }

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

// 当前书名
function currentTitle(){
  const o = state.outline;
  if(o && o.title) return o.title;
  return state.idea ? state.idea.trim().slice(0,20) : '未命名作品';
}
// 曾用名记录：每次改名时把旧名压入历史（最新在前）
function pushTitleHistory(oldName){
  if(!oldName) return;
  const d = new Date();
  const date = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')
    + ' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
  state.titleHistory.unshift({ name: oldName, date });
  if(state.titleHistory.length > 50) state.titleHistory = state.titleHistory.slice(0,50);
}
// 修改书名：确认后改 outline.title/state 标题，并把旧名压入曾用名
function renameTitle(newName){
  newName = String(newName||'').trim();
  if(!newName){ toast('书名不能为空'); return; }
  const oldName = currentTitle();
  if(oldName === newName){ toast('书名未变化'); return; }
  pushTitleHistory(oldName);
  if(state.outline) state.outline.title = newName;
  persist(); render();
  toast(`已改名为「${newName}」，原「${oldName}」已记入曾用名`);
}
// 标题栏：当前名 + 改名按钮 +「曾用名」小三角（点击展开）
function titleManagerHtml(){
  let histRows;
  if(state.titleHistory && state.titleHistory.length){
    histRows = state.titleHistory.map(h=>
      `<div class="hist-row"><span class="hist-name">${esc(h.name)}</span><span class="hist-date">${esc(h.date)}</span></div>`
    ).join('');
  }else{
    histRows = `<div class="hist-empty">暂无曾用名</div>`;
  }
  return `
    <div class="title-manager">
      <span class="tm-cur" id="tmCur" title="点击改名">${esc(currentTitle())}</span>
      <button type="button" class="icon-btn tm-tri" id="btnTmTri" title="曾用名" data-tm-tri>▾</button>
      <div class="tm-hist hidden" id="tmHist">
        <div class="hist-title">曾用名</div>
        ${histRows}
      </div>
    </div>`;
}
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
      ? `用几句话描述你的长篇构想（世界观、主角、核心冲突都行）。AI 会先扩写成与所选体量匹配的全书大纲，之后按「两章一批」逐步写到约 ${totalWan()} 万字。`
      : '用几句话描述你的点子（世界观、主角、核心冲突都行）。AI 会扩写成完整故事大纲与章节。';
    return CYBER_HOME_GRID + `
    <div class="card">
      <h3>① 输入故事构想</h3>
      <p class="sub">${homeSub}</p>
      ${ isLong() ? recipePicker() : '' }
      ${ isLong() ? '' : `<div class="spec-current" id="specCurrentBtn" title="点击修改创作规范">当前创作规范：<b>${esc(getSpec().name)}</b> · 点击右上角 ⚖️ 修改</div>` }
      <div class="idea-row">
        <textarea id="ideaInput" placeholder="${esc(currentIdeaPhrase())}">${esc(state.idea)}</textarea>
        <button id="btnRerollIdea" class="btn ghost idea-reroll" title="换个示例">🎲</button>
      </div>
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
      <div class="card-head-row">
        <h3 style="margin:0">📋 故事大纲</h3>
        ${titleManagerHtml()}
      </div>
      <p class="sub">${esc(o.logline||'')}</p>
      <div class="outline-strip">${ (o.chapters||[]).map((c,i)=>`<span class="outline-pill">${i+1}. ${esc(c.title)}</span>`).join('') }</div>
      ${ structureCard(o) }
      ${ state.outlineConfirmed ? `
        <div class="btn-row"><span class="pill tag-ok">✓ 大纲已确认</span></div>
        ${ isLong() ? glossaryCardHtml() : '' }
        ${ isLong() ? `<div class="btn-row" style="margin-top:8px">
          <label class="long-jump"><span>跳到章节：</span>
          <select id="longJump"><option value="">— 选择章节阅读 —</option>${state.chapters.map((c,i)=>`<option value="${i}">第${i+1}章 ${esc(c.title)}</option>`).join('')}</select></label>
        </div>` : '' }
        <div id="chaptersWrap"></div>
        <div class="btn-row" style="margin-top:12px">
          <button id="btnGenAllChapters" class="btn primary">${isLong()?'⚡ 生成下一批 2 章':'⚡ 一键生成全部章节'}</button>
          ${ isLong() ? '<button id="btnGenOneChapter" class="btn ghost">⚡ 生成单章</button>' : '<button id="btnReOutline" class="btn ghost">重生成大纲</button>' }
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

// 万物词典「设定表」卡片：展示人物/地名/专名，用户可更正错名（决策9）
// 词典是全文一致性准则，可小幅修正，但禁用删除（应由大纲确立）。
function glossaryCardHtml(){
  const g = (state.outline && state.outline.glossary) || {characters:[], places:[], propernouns:[]};
  const gl = ()=>state.outline.glossary = state.outline.glossary || {characters:[],places:[],propernouns:[]};
  const empty = !(g.characters&&g.characters.length) && !(g.places&&g.places.length) && !(g.propernouns&&g.propernouns.length);
  const hasBody = state.chapters.some(c=>c && c.content);   // 是否有正文可做覆盖面统计（阶段4）
  const tools = `<span class="gs-tools">
    <button type="button" class="btn ghost gs-tool" data-gs-undo-card hidden>↩ 撤销上次改动</button>
    <button type="button" class="btn ghost gs-tool" data-gs-coverage ${hasBody?'':'hidden'}>📊 覆盖面</button>
    <button type="button" class="btn ghost gs-tool" data-gs-export>导出 JSON</button>
    <button type="button" class="btn ghost gs-tool" data-gs-import>导入 JSON</button>
    <input type="file" id="gsImportFile" accept=".json,application/json" hidden />
  </span>`;
  if(empty) return `<div class="card"><h3 class="gs-card-title">📇 设定表 · 万物词典 ${tools}</h3><p class="sub">当前大纲未含万物词典。此词典会在生成大纲时自动确立，作为全书人名/地名/专名的一致性基准；请重生成大纲以启用。</p></div>`;
  // 可折叠条目：点击展开/收起该条目全部字段（建议1·此轮）
  // 折叠态只显示名字 + 一行简述；展开态显示该条全部可编辑介绍，文字再多也能全部看到。
  const fmt = (o, keys)=>{ const ks = (keys||[]).filter(k=>o[k]); return ks.map(k=>o[k]).join(' · '); };
  const entry = (o, type, i, nameKeys, detailKeys)=>{
    const name = o.name || '';
    const brief = fmt(o, nameKeys);
    const detail = detailKeys.map(k=>({k, v:o[k]})).filter(x=>x.v).map(x=>`<label class="gs-f"><span>${kLabel(x.k)}</span><input type="text" data-gs-set="${type}" data-gs-idx="${i}" data-gs-key="${x.k}" data-orig="${esc(x.v)}" value="${esc(x.v)}" /></label>`).join('');
    // 折叠态：名字 + 简述（可点）；展开态：把名字也变成可编辑 + 全字段
    return `<div class="gs-entry" data-gs-entry="${type}:${i}">
      <div class="gs-head" role="button" tabindex="0" data-gs-toggle="${type}:${i}">
        <span class="gs-fold-ico">▸</span>
        <input type="text" class="gs-name" data-gs-name="${type}:${i}" data-orig="${esc(name)}" value="${esc(name)}" placeholder="名称" />
        <span class="gs-brief">${esc(brief||'（无简介，点击展开编辑）')}</span>
      </div>
      <div class="gs-detail">
        ${detail}
      </div>
    </div>`;
  };
  const kLabel = k => ({name:'名称', relation:'关系', trait:'性格/外貌', identity:'身份', role:'职能', type:'类型', note:'说明'}[k]||k);
  const chars = (g.characters||[]).map((c,i)=>entry(c,'char',i,['role','identity','relation'],['name','relation','trait','identity','role'])).join('');
  const places = (g.places||[]).map((p,i)=>entry(p,'place',i,['type','note'],['name','type','note'])).join('');
  const props = (g.propernouns||[]).map((p,i)=>entry(p,'proper',i,['note'],['name','note'])).join('');
  const collapsed = !!state.gsCollapsed;
  const total = (g.characters||[]).length + (g.places||[]).length + (g.propernouns||[]).length;
  return `<div class="card gs-card${collapsed?' gs-collapsed':''}">
    <div class="gs-card-head">
      <h3 class="gs-card-title">📇 设定表 · 万物词典（${total} 条）${tools}</h3>
      <button type="button" class="gs-collapse-btn" data-gs-collapse title="${collapsed?'展开全部':'收缩'}" aria-label="${collapsed?'展开':'收缩'}">${collapsed?'＋':'−'}</button>
    </div>
    <div class="gs-card-body"${collapsed?' style="display:none"':''}>
    <p class="sub">全文一致性基准：生成正文时一律使用以下人名/地名/专名，不得自造新名。可小幅修改错名，保留为准则。</p>
    <div class="gs-group" data-gs-type="char"><div class="gs-title">👤 人物（${g.characters.length}）</div>
      ${chars||'<span class="muted">（无）</span>'}</div>
    <div class="gs-group" data-gs-type="place"><div class="gs-title">🗺️ 地点（${g.places.length}）</div>
      ${places||'<span class="muted">（无）</span>'}</div>
    <div class="gs-group" data-gs-type="proper"><div class="gs-title">📌 专名（${g.propernouns.length}）</div>
      ${props||'<span class="muted">（无）</span>'}</div>
    <p class="muted" style="margin:6px 0 0">修改后自动保存生效。</p>
    </div>
  </div>`;
}
// 绑定设定表编辑：失焦即写回 state；点击条目折叠/展开全部字段（建议1·此轮）
// 改动透明化（本版）：失焦判定改动→扫描受影响章节→弹出选择卡（仅新章生效 / 批量重生成 / 回退）
function bindGlossary(){
  if(!state.outline || !state.outline.glossary) return;
  const g = state.outline.glossary;
  const getArr = t => t==='char'?(g.characters||[]):t==='place'?(g.places||[]):(g.propernouns||[]);
  // 整卡收缩/展开：标题右侧圆形按钮；展开时同时把所有条目展开
  $$('[data-gs-collapse]').forEach(b=>{
    b.onclick = ()=>{
      state.gsCollapsed = !state.gsCollapsed;
      persist();
      const card = b.closest('.gs-card');
      const body = card && card.querySelector('.gs-card-body');
      if(body){ body.style.display = state.gsCollapsed ? 'none' : ''; }
      b.textContent = state.gsCollapsed ? '＋' : '−';
      b.title = state.gsCollapsed ? '展开全部' : '收缩';
      if(!state.gsCollapsed){ // 展开时把所有条目也展开
        card && $$('.gs-entry', card).forEach(en=>{ en.classList.add('open'); const h=en.querySelector('.gs-fold-ico'); if(h) h.textContent='▾'; });
      } else { // 收缩时把所有条目折叠
        card && $$('.gs-entry', card).forEach(en=>{ en.classList.remove('open'); const h=en.querySelector('.gs-fold-ico'); if(h) h.textContent='▸'; });
      }
    };
  });
  // 折叠/展开：仅点击折线图标或简介触发；点击名字输入框不折叠
  $$('[data-gs-toggle]').forEach(h=>{
    const toggle = ()=>{ const box=h.closest('.gs-entry'); const on=box.classList.toggle('open'); h.querySelector('.gs-fold-ico').textContent = on?'▾':'▸'; };
    h.onclick = (e)=>{
      if(e.target.closest('input.gs-name')) return;   // 编辑名字时不折叠
      toggle();
    };
    h.onkeydown = (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggle(); } };
  });
  // 所有可编辑字段（名字 + 各详情）失焦即存；改动时评估影响范围
  $$('[data-gs-name],[data-gs-set]').forEach(inp=>{
    inp.onchange = ()=>{
      const [type, idx] = inp.dataset.gsSet ? [inp.dataset.gsSet, +inp.dataset.gsIdx]
        : inp.dataset.gsName.split(':').map((v,k)=> k===0?v:(+v));
      const arr = getArr(type);
      if(!arr[idx]) return;
      const oldVal = inp.dataset.orig;
      const newVal = inp.value;
      if(newVal === oldVal) return;            // 无实质变化：不记录、不弹窗
      const isName = inp.hasAttribute('data-gs-name');
      const key = isName ? 'name' : inp.dataset.gsKey;
      gsPushUndo();                            // 记录改动前的整本词典（任意模式，供常驻撤销）
      arr[idx][key] = newVal;                  // 再写回 state（保持现状可编辑即存）
      persist();                               // 改动即保存（防误操作丢数据）
      inp.dataset.orig = newVal;               // 该输入框的 basline 更新
      // 触发「改动透明化」评估：长篇（有正文生成）时弹选择卡
      if(isLong()){
        openGlossaryPanel({type, idx, isName, key, oldVal, newVal});
      }
    };
  });
  // 覆盖面自检（阶段4）：需有正文后才可见
  $$('[data-gs-coverage]').forEach(b=> b.onclick = openCoveragePanel);
  // 导出词典 JSON（项6）
  $$('[data-gs-export]').forEach(b=> b.onclick = exportGlossaryJson);
  // 导入词典 JSON（项7）
  $$('[data-gs-import]').forEach(b=> b.onclick = ()=> { const f=$('#gsImportFile'); if(f) f.click(); });
  const imp = $('#gsImportFile'); if(imp) imp.onchange = e=>{ const file = e.target.files && e.target.files[0]; if(file) importGlossaryJson(file); e.target.value=''; };
  // 词典卡片常驻「撤销上次改动」（建议1·此轮）：弹窗被关后仍有可见入口可回退
  $$('[data-gs-undo-card]').forEach(b=> b.onclick = undoLastGlossaryChange);
  syncGlossaryUndoBtn();
}
// 撤销最后一次词典改动（常驻入口）
function undoLastGlossaryChange(){
  if(!gsUndoStack.length){ syncGlossaryUndoBtn(); return; }
  const snap = gsUndoStack.pop();
  try{ if(snap){ state.outline.glossary = JSON.parse(snap); persist(); } }catch(e){}
  syncGlossaryUndoBtn();
  renderGlossaryOnly();
  toast('已撤销词典改动');
}
// 按栈内快照数量刷新「撤销上次改动」按钮可见性
function syncGlossaryUndoBtn(){
  $$('[data-gs-undo-card]').forEach(b=>{
    const n = gsUndoStack.length;
    b.hidden = !n;
    if(n) b.textContent = '↩ 撤销上次改动 ('+n+')';
  });
}

// 快照（项5）：记录任一条目改动前的整本词典，供一键回退；最多保留 10 步防无限膨胀
let gsUndoStack = [];
const GS_UNDO_MAX = 10;
function gsPushUndo(){
  const g = state.outline && state.outline.glossary;
  if(g) gsUndoStack.push(JSON.stringify(g));
  if(gsUndoStack.length > GS_UNDO_MAX) gsUndoStack.shift();
  syncGlossaryUndoBtn();
}
// 词典 JSON：导出（v8 带 _meta 元数据头，便于多库/续作版本管理）。来源优先辅轨槽位（构想阶段挂载的），否则大纲词典。
// 导出的文件始终是 {characters,places,propernouns,...} 结构，可用 importGlossaryJson 再读回；_meta 会被导入时忽略。
function exportGlossaryJson(){
  const src = state.pendingGlossary || (state.outline && state.outline.glossary);
  if(!src || (!sourceHasGlossary(src))){ toast('当前没有可导出的词典'); return; }
  const title = (state.outline && state.outline.title) || (state.idea ? state.idea.trim().slice(0,12) : 'story');
  const meta = { _meta:{ title, source:'storyfactory', version:'2.0', exportedAt: new Date().toISOString(), adherence: state.glossAdherence } };
  download(`词典_${title}.json`, JSON.stringify({ ...meta, ...src }, null, 2));
  toast('已导出词典 JSON（含元数据头）');
}
function sourceHasGlossary(g){
  return g && ((g.characters&&g.characters.length)||(g.places&&g.places.length)||(g.propernouns&&g.propernouns.length));
}
// v8 阶段3：依遵从度把「导入词典(imported)」与「模型输出词典(modelOut)」合并为新作权威词典。
// 语义与 adherenceHint/adherenceSys 对齐：a>=50 导入为主，a<50 模型为主，a<30 几乎放弃。
// 返回 { glossary, kept, added, rec }。
function glossaryMerge(imported, modelOut, adherence, allowFill){
  const cat = ['characters','places','propernouns'];
  const res = { glossary:{characters:[],places:[],propernouns:[]}, kept:0, added:0, rec:0 };
  const a = (typeof adherence==='number') ? adherence : 100;
  cat.forEach(k=>{
    const imp = (imported&&imported[k])||[];
    const mdl = (modelOut&&modelOut[k])||[];
    const impBy = {};
    imp.forEach(it=>{ const nm=String(it.name||'').trim(); if(nm) impBy[nm]=it; });
    const has = it=>String(it.name||'').trim();
    const out = res.glossary[k];
    if(a < 30){                                       // 几乎放弃：完全采用模型输出
      mdl.forEach(it=>{ if(has(it)){ out.push(it); res.added++; } });
      return;
    }
    if(a < 50){                                       // 灵感来源：模型为主，仅补同名导入详情
      mdl.forEach(it=>{
        const nm = has(it); if(!nm) return;
        if(impBy[nm]){ out.push(impBy[nm]); res.kept++; }   // 同名以导入版为准（名+详情）
        else { out.push(it); res.added++; }
      });
      return;
    }
    imp.forEach(it=>{ if(has(it)){ out.push(it); res.kept++; } });   // a>=50：导入词典为主体
    mdl.forEach(it=>{
      const nm = has(it); if(!nm) return;
      if(impBy[nm]) return;                                          // 重名：一律保留导入版，丢弃模型版（词典保持唯一）
      if(allowFill || a<80){ out.push(it); res.added++; }            // 新名：a<80 自动补，a>=80 需「允许补充」才补
    });
  });
  return res;
}
/* ================= v8 词典库 + 历史一键导出 ================= */
function loadGlib(){
  try{ gglib = JSON.parse(localStorage.getItem(KEY_GLIB)) || []; }catch(e){ gglib = []; }
}
function saveGlib(){ try{ localStorage.setItem(KEY_GLIB, JSON.stringify(gglib)); }catch(e){} }
// 从「词典库」选用某套 → 挂载到当前辅轨槽位（intent: reuse across works）
function glibUse(id){
  const it = gglib.find(x=> x.id === id); if(!it) return;
  state.pendingGlossary = it.g;
  persist(); render();
  closeGlibPanel();
  toast(`已选用词典「${it.name}」挂载到本作，可调遵从度后生成大纲`);
}
// 把当前条件里可用的词典存入库（当前辅轨槽位优先，否则大纲词典）
function glibSave(){
  const src = state.pendingGlossary || (state.outline && state.outline.glossary);
  if(!src || !sourceHasGlossary(src)){ toast('当前没有可入库的词典'); return; }
  const name = prompt('给这套词典起个名字（如：仙侠传·世界观）', (state.outline&&state.outline.title) || '无题词典');
  if(name === null) return;
  const t = name.trim() || ('词典'+(gglib.length+1));
  if(gglib.some(x=> x.name === t)){ if(!confirm('词典库已有同名「'+t+'」，仍要覆盖保存吗？')) return; gglib = gglib.filter(x=> x.name !== t); }
  gglib.push({ id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2,6), name:t, savedAt: Date.now(), g: JSON.parse(JSON.stringify(src)) });
  saveGlib(); openGlibPanel();
  toast('已存入词典库：'+t);
}
function glibDel(id){ gglib = gglib.filter(x=> x.id !== id); saveGlib(); openGlibPanel(); }
function closeGlibPanel(){ const p=$('#glibPanel'); if(p) p.remove(); }
function openGlibPanel(){
  closeGlibPanel();
  const ov = document.createElement('div'); ov.id='glibPanel'; ov.className='gs-overlay';
  const itemsHtml = gglib.length ? gglib.map(x=>{
    const n = x.g; const cn=(n.characters||[]).length, pn=(n.places||[]).length, rn=(n.propernouns||[]).length;
    return `<div class="cv-row">
      <b>${esc(x.name)}</b>
      <span class="cv-cnt">👤${cn} · 📍${pn} · 🔤${rn}</span>
      <span class="cv-actions">
        <button class="cv-b btn" data-glib-use="${x.id}">选用</button>
        <button class="cv-b btn" data-glib-del="${x.id}">删除</button>
      </span>
    </div>`;
  }).join('') : '<p class="muted" style="margin:8px 0">还没有保存过词典。先打开一个新长篇并导入/生成词典，点「存入词典库」即可在此汇集多套世界观。</p>';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>🗂️ 词典库</b><button class="gs-x" data-glib-close>✕</button></div>
      <div class="gs-body">
        <p class="muted" style="margin:0 0 8px">跨作品汇集可复用词典。点「选用」即挂载到当前新篇的辅轨槽位，之后设置遵从度、生成大纲即可带入。</p>
        ${itemsHtml}
      </div>
      <div class="gs-actions" style="grid-template-columns:1fr 1fr">
        <button class="btn" data-glib-close>关闭</button>
        <button class="btn primary" data-glib-save>＋ 存入当前词典</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelectorAll('[data-glib-close]').forEach(b=> b.onclick = closeGlibPanel);
  ov.querySelector('[data-glib-save]').onclick = glibSave;
  ov.querySelectorAll('[data-glib-use]').forEach(b=> b.onclick = ()=> glibUse(b.dataset.glibUse));
  ov.querySelectorAll('[data-glib-del]').forEach(b=> b.onclick = ()=>{ if(confirm('从库中删除该词典？不影响已生成作品。')) glibDel(b.dataset.glibDel); });
  ov.addEventListener('click', e=>{ if(e.target===ov) closeGlibPanel(); });
}
// 历史作品一键导出该作词典（阶段5）：无需切换进项目，直接下载该作词典 JSON
function exportWorkGlossaryJSON(id){
  const p = lib.items.find(i=> i.id === id);
  const g = p && p.outline && p.outline.glossary;
  if(!p || !g || !sourceHasGlossary(g)){ toast('该作品暂无可用词典'); return; }
  const meta = { _meta:{ title:p.title||'复用词典', source:'storyfactory', version:'2.0', exportedAt:new Date().toISOString() } };
  download(`词典_${(p.title||'story').slice(0,12)}.json`, JSON.stringify({ ...meta, ...g }, null, 2));
  toast('已导出该作词典 JSON');
}
// 词典 JSON 导入入口（v8 双轨）：已导出的文件可能带 _meta 头（v8），在此剥离；支持两种落点
//  - 已生成大纲 → 覆盖 outline.glossary（用户主动导入，不走影响评估）
//  - 未生成大纲（构想阶段）→ 写入 pendingGlossary 辅轨槽位，供生成长篇大纲时带入
function normalizeGlossaryJSON(j){
  const src = (j && j._meta) ? j : j;
  const ok = src && typeof src==='object'
    && Array.isArray(src.characters) && Array.isArray(src.places) && Array.isArray(src.propernouns);
  if(!ok) return null;
  return { characters: src.characters, places: src.places, propernouns: src.propernouns };
}
function importGlossaryJson(file, target){
  const r = new FileReader();
  r.onload = ()=>{
    try{
      const j = JSON.parse(r.result);
      const g = normalizeGlossaryJSON(j);
      if(!g) throw 0;
      if(target === 'pending' || !(state.outline && state.outline.glossary)){
        // 构想阶段 / 显式挂到辅轨：写 pendingGlossary，不进 outline
        state.pendingGlossary = g;
        persist(); render();
        toast(`已挂载词典（预检通过）：人物 ${g.characters.length} · 地点 ${g.places.length} · 专名 ${g.propernouns.length}，可在生成大纲时带入`);
      } else {
        if(!state.outline) state.outline = state.outline || {};
        state.outline.glossary = g;
        persist(); render();
        toast('词典已导入');
      }
    }catch(e){ toast('导入失败：JSON 结构须含 characters/places/propernouns'); }
  };
  r.readAsText(file);
}

// 扫描正文：旧名/条目引用出现在哪些已生成章节（项2，纯本地字符串检索，零成本）
function scanGlossaryImpact({type, idx, oldVal, newVal, isName}){
  const g = state.outline.glossary;
  const getArr = t => t==='char'?(g.characters||[]):t==='place'?(g.places||[]):(g.propernouns||[]);
  const arr = getArr(type);
  // 被改动的「实体名」：名字字段用旧名（正文里旧章节存的是旧名）；其它字段看该条自身名字 + 旧值
  const entityName = arr[idx] ? arr[idx].name : oldVal;
  const terms = new Set();
  if(isName && oldVal) terms.add(oldVal);      // 改名：扫旧名，找旧章节正文
  else if(entityName) terms.add(entityName);   // 改详情：扫该实体名是否被正文引用
  const hits = state.chapters.map((c,i)=>{
    if(!c || !c.content) return null;
    let n = 0, occurs = 0;
    for(const t of terms){ if(t){ const re = new RegExp(escRe(t), 'g'); const m = String(c.content).match(re); if(m){ n += m.length; occurs++; } } }
    return occurs>0 ? {i, n, title: c.title||('第'+(i+1)+'章')} : null;
  }).filter(Boolean);
  // 词典内部相互引用：其它条目是否引用了被改条目（名字/名字改动时旧名）
  const refs = [];
  const refNames = isName ? [oldVal, newVal] : [entityName];
  ['char','place','proper'].forEach(t=>{
    getArr(t).forEach((it, ii)=>{
      if(t===type && ii===idx) return;
      const tsv = Object.values(it).join(' ');
      for(const rn of refNames){ if(rn && tsv.includes(rn)){ refs.push({t, ii, name: it.name||''}); break; } }
    });
  });
  return {hits, refs, word: isName ? oldVal : entityName};
}
function escRe(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 弹出「改动透明化」选择卡（项3/4/5）：默认全选可取消，出口=仅新章生效 / 批量重生成
function openGlossaryPanel(info){
  closeGlossaryPanel();
  if(!state.outline || !state.outline.glossary) return;
  const g = state.outline.glossary;
  const getArr = t => t==='char'?(g.characters||[]):t==='place'?(g.places||[]):(g.propernouns||[]);
  const arr = getArr(info.type);
  const itemName = arr[info.idx] ? arr[info.idx].name : '该条目';
  const scan = scanGlossaryImpact(info);
  const hits = scan.hits || [];

  const labels = {name:'名称', relation:'关系', trait:'性格/外貌', identity:'身份', role:'职能', type:'类型', note:'说明'};
  const kind = info.isName ? `「${info.oldVal||''}」→「${info.newVal||''}」`
    : `「${itemName}」的「${labels[info.key]||info.key||'详情'}」已修改（正文引用该条目 ${scan.word?('出现自 「'+scan.word+'」'):''}）`;
  const hitHtml = hits.length ? hits.map(h=>`
    <label class="gs-hit"><input type="checkbox" class="gs-hit-cb" data-ch="${h.i}" checked />
      <span>第${h.i+1}章 · ${esc(h.title||'')}</span><i>正文出现 ${h.n} 次</i></label>`).join('')
    : `<p class="gs-nohit">✓ 旧名在已生成正文中未出现，无需重塑任何章节。该改动仅对后续新生成章节生效。</p>`;
  const refHtml = scan.refs.length ? `<div class="gs-refs">⚠️ 词典内其它条目仍引用旧名（建议一并核对）：${scan.refs.map(r=>{
    const lab = r.t==='char'?'人物':r.t==='place'?'地点':'专名';
    return `<span class="pill">${lab}「${esc(r.name||'')}」</span>`;
  }).join('')}</div>` : '';

  const names = {char:'人物',place:'地点',proper:'专名'};
  const ov = document.createElement('div');
  ov.id = 'gsPanel';
  ov.className = 'gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>📇 词典改动 · 影响范围</b>
        <button class="gs-x" data-gs-close>✕</button></div>
      <p class="gs-modal-sub">检测到你改动了 ${names[info.type]||''}：${kind}</p>
      <div class="gs-body">
        <p class="gs-q"><b>① 会影响的已生成章节（默认全选，可取消个别）：</b></p>
        ${hitHtml}
        ${refHtml}
      </div>
      <div class="gs-actions">
        <button class="btn ghost" data-gs-undo>↩ 回退本次改动</button>
        <button class="btn ghost" data-gs-future>仅对新章生效</button>
        <button class="btn primary" data-gs-regen ${hits.length?'':'disabled'}>⚡ 批量重生成所选章节（${hits.length}）</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-gs-close]').onclick = closeGlossaryPanel;
  ov.querySelector('[data-gs-future]').onclick = ()=>{
    gsUndoStack.pop(); syncGlossaryUndoBtn();   // 已生效，丢弃快照
    closeGlossaryPanel();
    toast('已保存，仅对后续新章生效');
  };
  ov.querySelector('[data-gs-undo]').onclick = ()=>{
    const snap = gsUndoStack.pop(); syncGlossaryUndoBtn();
    if(snap){ try{ state.outline.glossary = JSON.parse(snap); persist(); }catch(e){} }
    closeGlossaryPanel(); renderGlossaryOnly(); toast('已恢复改动前词典');
  };
  const regenBtn = ov.querySelector('[data-gs-regen]');
  if(regenBtn) regenBtn.onclick = ()=>{
    const sel = $$('.gs-hit-cb:checked', ov).map(b=>+b.dataset.ch);
    gsUndoStack.pop(); syncGlossaryUndoBtn();   // 用户已确认批量重生成，丢弃快照（重生成后为新一致性）
    closeGlossaryPanel();
    regenSelectedChapters(sel);
  };
  // 点遮罩关闭
  ov.addEventListener('click', e=>{ if(e.target===ov) closeGlossaryPanel(); });
}
// 仅重绘「故事」视图（保留词典卡片反映回退后的词典；页面回顶，属可接受）
function renderGlossaryOnly(){
  const host = $('#view');
  if(host){ host.innerHTML = viewStory(); bindView(); window.scrollTo({top:100, behavior:'smooth'}); }
}

// 批量重生成（项2/4）：对选中的受影响章节逐章按新词典重写，保证前后连贯
async function regenSelectedChapters(list){
  if(!list || !list.length) return;
  const panel = document.createElement('div');
  panel.id = 'gsPanel'; panel.className = 'gs-overlay';
  panel.innerHTML = `<div class="gs-modal"><div class="gs-modal-head"><b>⚡ 正在按新词典重生成 ${list.length} 章…</b></div>
    <p class="gs-progress muted">请保持页面打开，逐章推进，不会打断你浏览已生成章节。</p></div>`;
  document.body.appendChild(panel);
  state.generating = true;
  try{
    for(const i of list){
      chState[i]='generating'; patchChapter(i);
      const pg = panel.querySelector('.gs-progress');
      if(pg) pg.textContent = `正在重写第 ${i+1} 章…`;
      try{
        const user = buildChapterUser(i, {regenerating:true});
        const txt = await writeOneChapterContent(i, user);      // 关闭流式，单章连贯
        snapshotChapterVersion(i);            // v7.2：覆盖前存旧版，支持回退
        state.chapters[i].content = txt;
        chState[i]='done'; persist(); patchChapter(i);
      }catch(e){ chState[i]='error'; persist(); patchChapter(i); }
    }
    closeGlossaryPanel();
    renderChapters();
    toast('所选章节已按新词典重生成完成');
  }finally{ state.generating = false; }
}
function closeGlossaryPanel(){ const p=$('#gsPanel'); if(p) p.remove(); }

/* =====================================================
 * 章节版本历史（v7.2）：重生成后可回退到之前版本
 * 章节结构：{ title, content, confirmed, history:[{content,ts}] }
 * 生成/重生成覆盖前快照旧内容；卡片「📚 版本」按钮可预览并恢复。
 * ===================================================== */
function ensureChapterHistory(i){
  const c = state.chapters[i]; if(!c) return c;
  if(!Array.isArray(c.history)) c.history = [];
  return c;
}
// 生成/重生成覆盖前调用：把当前非空正文存入历史（尾=最新）
function snapshotChapterVersion(i){
  const c = ensureChapterHistory(i); if(!c) return;
  const cur = c.content;
  if(cur && String(cur).trim()) c.history.push({ content: cur, ts: Date.now() });
  if(c.history.length > 30) c.history.splice(0, c.history.length - 30); // 上限30防膨胀
}
function chVersions(i){ const c=ensureChapterHistory(i); return c? c.history : []; }
function hasChVersions(i){ return chVersions(i).length > 0; }

// 版本历史弹窗：列出当前 + 历史，可预览、可恢复
function openChapterVersionPanel(i){
  closeChapterVersionPanel();
  const c = ensureChapterHistory(i); if(!c) return;
  const title = c.title || ('第'+(i+1)+'章');
  const fmtTs = ts=>{ const d=new Date(ts); return (d.getMonth()+1)+'-'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
  const cur = String(c.content||'');
  const hist = c.history;
  const rows = hist.map((v,origIdx)=>`
    <div class="cv-row">
      <div class="cv-meta"><span class="cv-time">${fmtTs(v.ts)}</span><span class="cv-wc">${(v.content||'').length} 字</span></div>
      <div class="cv-actions">
        <button type="button" class="btn ghost cv-b" data-cv-prev="${origIdx}">预览</button>
        <button type="button" class="btn ghost cv-b" data-cv-restore="${origIdx}">↩ 恢复</button>
      </div>
    </div>`).join('');
  const ov = document.createElement('div'); ov.id='cvPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>📚 版本历史 · 第${i+1}章「${esc(title)}」</b>
        <button class="gs-x" data-cv-close>✕</button></div>
      <div class="cv-body">
        <div class="cv-row cur"><div class="cv-meta"><span class="cv-time">当前版本</span><span class="cv-wc">${cur.length} 字</span></div></div>
        ${hist.length? `<div class="cv-div">历史版本（点「恢复」回到该版；恢复前会先把当前正文存为新的历史版本）</div>${rows}`
        : '<p class="muted cv-empty">暂无历史版本。当章节被重生成时，旧正文会自动存档在这里，供你随时回退。</p>'}
        <div class="cv-preview hidden" id="cvPreview">
          <div class="cv-prev-head"><b id="cvPrevTitle">版本预览</b><button class="gs-x" data-cv-prev-close>✕</button></div>
          <div class="cv-pre" id="cvReader"></div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-cv-close]').onclick = closeChapterVersionPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeChapterVersionPanel(); });
  // 预览：显示该版本全文
  ov.addEventListener('click', e=>{
    const p = e.target.closest('[data-cv-prev]'); if(!p) return;
    const v = hist[+p.dataset.cvPrev]; if(!v) return;
    const pr=$('#cvPreview'), rd=$('#cvReader'), pt=$('#cvPrevTitle');
    if(pr && rd){ pt.textContent = '预览 · 历史版本（'+fmtTs(v.ts)+'）'; rd.textContent = v.content||'（空）'; pr.classList.remove('hidden'); }
  });
  ov.querySelector('[data-cv-prev-close]').onclick = ()=>{ const pr=$('#cvPreview'); if(pr) pr.classList.add('hidden'); };
  // 恢复：确认后把当前正文存历史，再用选中版覆盖当前
  ov.addEventListener('click', e=>{
    const rb = e.target.closest('[data-cv-restore]'); if(!rb) return;
    const v = hist[+rb.dataset.cvRestore]; if(!v) return;
    if(!window.confirm('恢复该历史版本将覆盖当前正文。\n\n（当前正文会自动保存为一条新的历史版本，不会被删除。）\n确定恢复吗？')) return;
    snapshotChapterVersion(i);                  // 先把当前正文存历史
    c.content = v.content;                      // 用历史版覆盖当前
    c.history.splice(+rb.dataset.cvRestore, 1); // 移除已升为当前的版本
    persist(); closeChapterVersionPanel(); renderChapters();
    toast('已恢复历史版本');
  });
}
function closeChapterVersionPanel(){ const p=$('#cvPanel'); if(p) p.remove(); }

function renderChapters(){
  const wrap = $('#chaptersWrap'); if(!wrap) return;
  const total = state.chapters.length;
  if(isLong()){
    // 建议3：长篇每页 10 章，分页渲染；chPage 对齐到有效页
    const maxPage = Math.max(0, Math.ceil(total / CH_PAGE_SIZE) - 1);
    if(chPage > maxPage) chPage = maxPage;
    const from = chPage * CH_PAGE_SIZE;
    const slice = state.chapters.slice(from, from + CH_PAGE_SIZE);
    const html = slice.map((c,offset)=>{
      const i = from + offset;
      const hasC = !!(c.content && c.content.trim());
      // 建议1：无正文章节→卡片折叠成标题行；有正文→默认展开；点击标题行切换
      const foldedCls = hasC ? '' : ' folded';
      const stTxt = chState[i]==='generating'?'⏳ 生成中':chState[i]==='error'?'⚠️ 生成失败':(hasC?'已生成':'未生成');
       const stTag = chState[i]==='error'||!hasC?'tag-warn':'tag-ok';
       return `<div class="card ch-card" data-ch-card="${i}">
        <div class="ch-head" data-fold="${i}" role="button" tabindex="0" aria-expanded="${foldedCls?'false':'true'}">
          <span class="ch-fold-ico">${hasC?'▾':'▸'}</span>
          <h3 style="margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">第${i+1}章 · ${esc(c.title)}</h3>
          <span class="pill ${stTag}" data-ch-state>${stTxt}</span>
          ${wcBadge(c.content, `data-wc-ch="${i}"`)}
        </div>
        <div class="ch-body${foldedCls}">
          <textarea data-ch="${i}" style="margin-top:8px">${esc(c.content)}</textarea>
          <div class="btn-row">
            ${hasChVersions(i)?`<button class="btn ghost" data-ver="${i}">📚 版本(${chVersions(i).length})</button>`:''}
            <button class="btn ghost" data-regen="${i}" ${state.generating?'disabled':''}>🔄 重生成</button>
            <button class="btn ghost" data-read="${i}">📖 阅读</button>
          </div>
        </div>
      </div>`;
    }).join('');
    // 分页条
    const pageCount = Math.max(1, Math.ceil(total / CH_PAGE_SIZE));
    const pages = Array.from({length:pageCount},(_,p)=>p)
      .map(p=>`<button type="button" class="ch-page${p===chPage?' active':''}" data-page="${p}">${p+1}</button>`).join('');
    wrap.innerHTML = `<div class="ch-pager"><span class="muted">第 ${from+1}–${from+slice.length} 章 / 共 ${total} 章</span>${pages}</div>
      ${html}
      <div class="ch-pager">${pages}</div>`;
  } else {
    // 短片模式：全部渲染，保留「待确认/已确认」（决策7：仅长篇去除确认）
    wrap.innerHTML = state.chapters.map((c,i)=>`
      <div class="card ch-card" data-ch-card="${i}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div style="display:flex;align-items:center;gap:8px;min-width:0">
            <h3 style="margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">第${i+1}章 · ${esc(c.title)}</h3>
            ${wcBadge(c.content, `data-wc-ch="${i}"`)}
          </div>
          <span class="pill ${c.confirmed?'tag-ok':'tag-warn'}">${c.confirmed?'✓ 已确认':'待确认'}</span>
        </div>
        <textarea data-ch="${i}" style="margin-top:8px">${esc(c.content)}</textarea>
        <div class="btn-row">
          ${hasChVersions(i)?`<button class="btn ghost" data-ver="${i}">📚 版本(${chVersions(i).length})</button>`:''}
          <button class="btn ghost" data-regen="${i}">🔄 重生成</button>
          <button class="btn ghost" data-read="${i}">📖 阅读</button>
          <button class="btn ghost" data-toggle="${i}">${c.confirmed?'↺ 取消确认':'✓ 标记已确认'}</button>
        </div>
      </div>`).join('');
  }
}

/* ---------- 沉浸式章节阅读 ---------- */
let readerCur = -1;
function renderToc(current){
  const list = $('#tocList'); if(!list) return;
  const total = state.chapters.length;
  const cn = $('#tocCount'); if(cn) cn.textContent = total;
  list.innerHTML = state.chapters.map((c,i)=>{
    const active = i === current ? ' active' : '';
    const done = c.content && c.content.trim() ? ' done' : '';
    return `<button type="button" class="toc-item${active}${done}" data-toc="${i}"><span class="toc-idx">${i+1}</span><span class="toc-t">${esc(c.title||('第'+(i+1)+'章'))}</span></button>`;
  }).join('');
}
function openReader(i){
  const c = state.chapters[i]; if(!c) return;
  const ov = $('#readerOverlay'); if(!ov) return;
  $('#readerTitle').textContent = `第${i+1}章 · ${c.title||''}`;
  const paras = String(c.content||'').split(/\n+/).map(p=>p.trim()).filter(Boolean);
  // 无正文时：展示大纲概要，让「空章也可预览剧情定位」
  let fallback = `<p class="muted">（本章尚未生成正文）</p>`;
  const sum = (state.outline && state.outline.chapters && state.outline.chapters[i] && state.outline.chapters[i].summary) || '';
  if(sum) fallback = `<p class="muted">📋 大纲概要：${esc(sum)}</p>
    <p class="muted" style="margin-top:6px">生成正文后将在此展示全文。可用下方「重生成」或「一键批量生成」补写。</p>`;
  $('#readerBody').innerHTML = paras.length ? paras.map(p=>`<p>${esc(p)}</p>`).join('') : fallback;
  // 构建目录并定位当前章
  renderToc(i);
  readerCur = i;
  ov.classList.remove('hidden');
  document.body.classList.add('reader-lock'); // 锁定背景滚动
}
function closeReader(){
  const ov = $('#readerOverlay'); if(!ov) return;
  ov.classList.add('hidden');
  // 关闭阅读时同时收起目录
  const toc = $('#readerToc'); if(toc) toc.classList.add('hidden');
  document.body.classList.remove('reader-lock');
}
function bindReader(){
  const ov = $('#readerOverlay'); if(!ov) return;
  $$('[data-reader-close]', ov).forEach(el=> el.onclick = (e)=>{
    // 点击面板内部不关闭（backdrop 与 ✕ 按钮才关闭）
    if(e.target.closest('.reader-panel') && !e.target.closest('.reader-close')) return;
    closeReader();
  });
  // 右上角「☰」章节目录：开合抽屉
  const tocBtn = $('#readerTocBtn'); const toc = $('#readerToc');
  if(tocBtn && toc){
    tocBtn.onclick = (e)=>{ e.stopPropagation(); const show = toc.classList.toggle('hidden'); tocBtn.classList.toggle('on', !show); };
  }
  const tocClose = $('#tocClose');
  if(tocClose && toc) tocClose.onclick = (e)=>{ e.stopPropagation(); toc.classList.add('hidden'); if(tocBtn) tocBtn.classList.remove('on'); };
  // 目录项点击跳转
  const list = $('#tocList');
  if(list && toc) list.onclick = (e)=>{
    const item = e.target.closest('[data-toc]'); if(!item) return;
    openReader(+item.dataset.toc);
  };
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
  const sz = selSize();
  const sizeName = sz.kind==='word' ? `每章约 ${fmtRange(sz.range)} 字` : `全书约 ${fmtRange(sz.range)} 章`;
  el.innerHTML = `<span class="pill">写作进度：${done}/${total} 章</span> <span class="pill">已写约 ${chars.toLocaleString('en-US')} 字（目标 ${totalWan()} 万字 · ${sizeName}）</span>`;
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
  if(!written) return `<div class="center-empty">尚无已写章节，请先在「故事」里「生成下一批 2 章」。</div>`;
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
    const rr = $('#btnRerollIdea'); if(rr) rr.onclick = (e)=>{ e.stopPropagation(); rerollIdeaPhrase(); };
    $('#btnGenOutline').onclick = genOutline;
  }
  // 长篇：三维写作范式选择（结构单选 / 节奏单选 / 质量多选 / 体量二选一）
  $$('[data-structure]').forEach(b=> b.onclick = ()=>{
    const id = b.dataset.structure;
    state.recipeSet = state.recipeSet || {structure:null,rhythm:null,quality:[]};
    if(state.recipeSet.structure === id){ /* 已选中，可取消 */ state.recipeSet.structure = null; }
    else { state.recipeSet.structure = id; }
    persist(); render();
  });
  $$('[data-rhythm]').forEach(b=> b.onclick = ()=>{
    const id = b.dataset.rhythm;
    state.recipeSet = state.recipeSet || {structure:null,rhythm:null,quality:[]};
    if(state.recipeSet.rhythm === id){ state.recipeSet.rhythm = null; }
    else { state.recipeSet.rhythm = id; }
    persist(); render();
  });
  $$('[data-quality]').forEach(b=> b.onclick = ()=>{
    const id = b.dataset.quality;
    state.recipeSet = state.recipeSet || {structure:null,rhythm:null,quality:[]};
    if(!Array.isArray(state.recipeSet.quality)) state.recipeSet.quality = [];
    if(state.recipeSet.quality.includes(id)) state.recipeSet.quality = state.recipeSet.quality.filter(q=> q!==id);
    else state.recipeSet.quality.push(id);
    persist(); render();
  });
  // 体量二选一：点击 ☑ 勾选该侧（radio，二选一）
  $$('.size-pick').forEach(b=> b.onclick = ()=>{ pickSize(b.dataset.pick); });
  // 全书总字数：直接填数字（单位：万）。失焦/回车提交 → 设定或解锁范式与体量
  const twIn = $('#totalWordsIn');
  if(twIn){
    twIn.addEventListener('keydown', e=>{ if(e.key==='Enter') twIn.blur(); });
    twIn.addEventListener('change', ()=>{
      const v = parseFloat(twIn.value);
      if(v && v>0) state.totalWords = Math.round(v*10000);
      else { state.totalWords = null; }
      persist(); render();
    });
  }
  initDRS();
  bindGlossary();
  bindPendingGlossary();
  const specCur = $('#specCurrentBtn'); if(specCur) specCur.onclick = openSpecPanel;
  const btnCO = $('#btnConfirmOutline'); if(btnCO) btnCO.onclick = ()=>{ state.outlineConfirmed=true; persist(); render(); };
  const btnRO = $('#btnReOutline'); if(btnRO) btnRO.onclick = ()=>{ state.outline=null; state.outlineConfirmed=false; state.chapters=[]; persist(); render(); };
  const btnGA = $('#btnGenAllChapters'); if(btnGA) btnGA.onclick = genAllChapters;
  const btnGOne = $('#btnGenOneChapter');
  if(btnGOne) btnGOne.onclick = async ()=>{
    // 生成最新一章：定位第一个尚无正文的章节
    const idx = state.chapters.findIndex(c => !(c.content && String(c.content).trim()));
    if(idx < 0){ toast('所有章节均已生成，无需单章生成'); return; }
    await genOneChapter(idx, btnGOne, {});
  };

  // 标题管理器：点击当前名改名；点小三角展开/收起曾用名
  const tmCur = $('#tmCur'); if(tmCur) tmCur.onclick = ()=>{
    const newName = prompt('修改书名：', currentTitle());
    if(newName == null) return; // 取消
    renameTitle(newName);
  };
  const histPanel_ = $('#tmHist');
  // 曾用名：点击外部关闭
  const triBtn = $('#btnTmTri');
  if(triBtn) triBtn.onclick = (e)=>{
    e.stopPropagation();
    const on = triBtn.classList.toggle('on');
    if(histPanel_) histPanel_.classList.toggle('hidden', !on);
  };
  if(histPanel_) histPanel_.onclick = (e)=> e.stopPropagation();
  document.addEventListener('click', (e)=>{
    const pan = $('#tmHist');
    if(pan && !pan.classList.contains('hidden') && !e.target.closest('.title-manager')){
      pan.classList.add('hidden');
      const b = $('#btnTmTri'); if(b) b.classList.remove('on');
    }
  });
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
  // 用事件委托处理章节区内部点击：分页/折叠会重建部分按钮，委托在 #chaptersWrap 上保证始终生效（Bug2 修复）
  const chaptersDelegate = (e)=>{
    const t = e.target.closest('[data-regen],[data-toggle],[data-read],[data-fold],[data-page],[data-ver]');
    if(!t) return;
    if(t.hasAttribute('data-ver')){ openChapterVersionPanel(+t.dataset.ver); }
    else if(t.hasAttribute('data-regen')){ openChapterRegenPanel(+t.dataset.regen); }
    else if(t.hasAttribute('data-toggle')){ const i=+t.dataset.toggle; state.chapters[i].confirmed=!state.chapters[i].confirmed; persist(); render(); }
    else if(t.hasAttribute('data-read')){ openReader(+t.dataset.read); }
    else if(t.hasAttribute('data-fold')){ const i=+t.dataset.fold; const body=t.closest('.ch-card').querySelector('.ch-body'); const ico=t.querySelector('.ch-fold-ico'); const on = body.classList.toggle('folded'); t.setAttribute('aria-expanded', String(!on)); if(ico) ico.textContent = on?'▸':'▾'; }
    else if(t.hasAttribute('data-page')){ chPage = +t.dataset.page; renderChapters(); }
  };
  const cw = $('#chaptersWrap');
  if(cw && !cw.dataset.delegated){
    cw.dataset.delegated = '1';           // 只绑定一次，跨次 render 复用
    cw.addEventListener('click', chaptersDelegate);
    // textarea 输入也委托，分页重建后仍生效（Bug2 连带修复）
    cw.addEventListener('input', (e)=>{
      const ta = e.target.closest('textarea[data-ch]'); if(!ta) return;
      const i = +ta.dataset.ch; state.chapters[i].content = ta.value;
      persist(); updateChapterWc(i, ta.value); updateWcTotal();
    });
  }
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
  if(isLong() && !selStructure() && !selRhythm() && selQualities().length===0){
    toast('请至少选择一种写作方式（结构 / 节奏 / 质量 任选其一）');
    busy(btn,false); return;
  }
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
    // 万物词典：新生成大纲默认含 glossary（人物/地名/专名）；旧大纲缺省时给空，UI 提示重生成可启用
    if(!o.glossary || (!o.glossary.characters && !o.glossary.places && !o.glossary.propernouns)){
      o.glossary = { characters:[], places:[], propernouns:[] };
    }
    // v8 双轨合并：若构想阶段挂载过辅轨词典，按遵从度把它与新作大纲词典合并为权威词典，再清空辅轨槽位
    let mergeNote = '';
    if(state.pendingGlossary && sourceHasGlossary(state.pendingGlossary)){
      const m = glossaryMerge(state.pendingGlossary, o.glossary, state.glossAdherence, state.glossAllowFill);
      o.glossary = m.glossary;
      mergeNote = ` · 词典已并入（沿用 ${m.kept} · 新增 ${m.added}${m.rec?` · 覆盖 ${m.rec}`:''}）`;
      state.pendingGlossary = null; state.glossAllowFill = false;
    }
    state.chapters = o.chapters.map(c=>({title:c.title, content:'', confirmed:false}));
    persist(); render();
    toast('大纲已生成'+mergeNote);
  }catch(e){
    st.className='status err'; st.textContent = e.message;
  }finally{ busy(btn,false); }
}

// 长篇：把整体结构/卷信息拼进章节生成的上下文（按所选结构注入）
function longChapterContext(i){
  const o = state.outline;
  if(!isLong() || !o) return '';
  let ctx = '';
  const st = selStructure();
  // 分层递归结构：注入所属卷主题
  if(st && st.id === 'layered'){
    const c = o.chapters[i];
    if(c && c.volume){
      ctx += `\n\n【本卷定位】\n所属卷：${c.volume}\n本卷主题与情绪基调：${c.volumeTheme||''}\n本章目标：${c.goal||o.chapters[i].summary||''}`;
    }
  }
  // 带结构设计的结构（mesh 网状等）：注入 structure 对象
  if((st && st.structure) && o.structure){
    const s = o.structure;
    const flat = [];
    if(s.mode) flat.push('结构模式：'+s.mode);
    if(s.designReason) flat.push('设计用意：'+s.designReason);
    if(s.mainLine) flat.push('主线：'+s.mainLine);
    if(s.subLines && s.subLines.length) flat.push('副线：'+(s.subLines||[]).join('；'));
    if(s.hiddenLine) flat.push('暗线：'+s.hiddenLine);
    if(s.pivotChapter) flat.push('汇合/大逆转章节：'+s.pivotChapter);
    if(s.threeFix) flat.push('三定（时间轴/汇合点/主次）：'+s.threeFix);
    const curTitle = (o.chapters[i] && o.chapters[i].title) || '';
    if(s.stageChapters) flat.push('本章所属英雄阶段：'+stageOfChapter(i, s.stageChapters, curTitle)+'\n全阶段映射：'+arcMapText(s.stageChapters));
    if(s.beats) flat.push('本章所属节拍：'+stageOfChapter(i, s.beats, curTitle)+'\n全节拍映射：'+arcMapText(s.beats));
    if(s.points) flat.push('本章所属七点锚点：'+stageOfChapter(i, s.points, curTitle)+'\n全锚点映射：'+arcMapText(s.points));
    ctx += '\n\n【整体结构】\n' + flat.join('\n');
  }
  return ctx;
}
// 定位“本章属于哪个阶段/节拍/锚点”——通过章节下标或标题在该阶段的标题列表内查找
function stageOfChapter(i, map, curTitle){
  if(!map || typeof map !== 'object') return '';
  const idx = i + 1;
  const t = String(curTitle||'');
  for(const key in map){
    const arr = Array.isArray(map[key]) ? map[key] : [];
    // 标题命中（去空格后含当前章节标题）或以“第N章”形式命中下标
    const hit = arr.some(x=> String(x).replace(/\s/g,'') && t && String(x).replace(/\s/g,'').includes(t.replace(/\s/g,''))) ||
      arr.some(x=> /第?(\d+)(章|话)?/.test(String(x)) && +String(x).match(/第?(\d+)/)[1] === idx);
    if(hit) return key;
  }
  return '（未匹配，按大纲推进即可）';
}
// 把阶段→章标题映射压成一段提示文本
function arcMapText(map){
  if(!map || typeof map !== 'object') return '';
  return Object.keys(map).map(k=> `${k}: ${(Array.isArray(map[k])?map[k]:[map[k]]).join('、')}`).join('  ');
}
// 长篇：写作范式选择器（三维卡片：结构/节奏/质量 + 体量二选一；介绍折叠、选中展开）
function recipePicker(){
  const rs = state.recipeSet || {structure:null,rhythm:null,quality:[]};
  const selSt = selStructure(), selRh = selRhythm();
  const selQArr = selQualities();
  // 组合摘要
  const labelSt = selSt ? selSt.name : '未选';
  const labelRh = selRh ? selRh.name : '未选';
  const labelQ = selQArr.length ? selQArr.map(q=>q.name).join('+') : '未选';
  // 体量小结：未勾选任何一侧时用默认文字提示
  const sz = selSize();
  const szLabel = sz.kind==='word' ? `单章 ${fmtRange(sz.range)} 字` : `全书 ${fmtRange(sz.range)} 章`;
  // 总字数门控：最前先填“全书大约总字数（万）”，填了才展开范式与体量
  const twOn = (state.totalWords && +state.totalWords>0);
  const twWan = twOn ? String(Math.round(+state.totalWords/10000)) : '';
  // 卡片渲染（dim 为维度名，selKeys 判断选中，toggle 是点击后是否多选）
  const card = (it, field, isSel, extra) => `
    <button type="button" class="recipe ${isSel?'active':''}" data-${field}="${esc(it.id)}">
      <div class="r-top"><b>${it.name}</b><span class="r-tag ${isSel?'on':''}">${it.tag}</span></div>
      <div class="r-src">${it.src}</div>
      <div class="r-points">
        ${['desc','mech','fit','effect'].map((k,i)=>`<div class="pt"><b>${['概览','运作','适合','效果'][i]}</b><span>${esc(it[k]||'')}</span></div>`).join('')}
      </div>
      <span class="r-check">${isSel?'✓':''}</span>
    </button>`;
  const dim = (title, icon, rule, cardsHtml) => `
    <div class="poly-dim">
      <div class="poly-head"><span class="poly-ic">${icon}</span><b>${title}</b><span class="poly-rule">${rule}</span></div>
      <div class="poly-grid">${cardsHtml}</div>
    </div>`;
  // 门控：未填总字数时，范式与体量折叠，仅展示待设提示
  const core = twOn ? `
    ${dim('结构骨架','🏗️','单选 · 可选其一', STRUCTURES.map(it=>card(it,'structure', it.id===rs.structure)).join(''))}
    ${dim('节奏风格','⚡','单选 · 可选其一（默认黄金网文）', RHYTHMS.map(it=>card(it,'rhythm', it.id===rs.rhythm)).join(''))}
    ${dim('质量机制','🛡️','可多选 · 可不选', QUALITIES.map(it=>card(it,'quality', hasQuality(it.id))).join(''))}
    <div class="poly-size">
      <div class="poly-head"><span class="poly-ic">📏</span><b>体量设定</b><span class="poly-rule">先勾选一项 · 再滑动调区间 · 二选一（全书总字数 ${totalWan()} 万字）</span></div>
      <div class="size-grid">
        ${sizeSlider('word', '每章字数（字）', 1000, 12000, 100,
          state.wordRange ? state.wordRange : null,
          !!(state.wordRange && +state.wordRange.min>0))}
        ${sizeSlider('chapter', '全书章节（章）', 1, 120, 1,
          state.chapterRange ? state.chapterRange : null,
          !!(state.chapterRange && +state.chapterRange.min>0))}
      </div>
      <p class="size-hint" id="sizeHint">${sizeHintText()}</p>
    </div>
    ${pendingGlossaryPanel()}
    <p class="muted" style="margin:8px 0 0">至少选择结构、节奏、质量其中一项即可生文；体量需先用 ☑ 勾选一项才能调整滑条。介绍默认折叠，选中后自动展开。</p>`
    : `<div class="tw-lock"><span class="tw-lock-ic">🔒</span><span>待填入全书总字数后，此处才展开“写作范式”与“体量设定”。</span></div>`;
  return `<div class="card recipe-card poly-card">
    <div class="tw-panel">
      <div class="poly-head"><span class="poly-ic">📐</span><b>全书总字数</b><span class="poly-rule">写正文前先定总目标 · 填数字（单位：万）</span></div>
      <div class="tw-row">
        <input type="number" id="totalWordsIn" class="tw-in" min="1" step="1" inputmode="numeric" placeholder="如 30" value="${twWan}" ${twOn?'':'data-first'} />
        <span class="tw-unit">万字</span>
        ${twOn ? `<span class="pill tag-ok">目标 ${totalWan()} 万字</span>` : ''}
      </div>
      <p class="size-hint" id="twHint">${twOn ? '总字数已设定，下方范式与体量将据此自动推导。' : '全书的“大约总字数”（写成约 3 万 ~ 60 万皆可）。此项必填，填完才解锁下方设置。'}</p>
    </div>
    <div class="poly-combo">
      <span class="pc-lbl">当前组合</span>
      <span class="pc-item">结构：${labelSt}</span>
      <span class="pc-item">节奏：${labelRh}</span>
      <span class="pc-item">质量：${labelQ}</span>
      <span class="pc-item">体量：${szLabel}</span>
    </div>
    ${core}
  </div>`;
}

// v8 辅轨词典面板（仅长篇小说构想阶段）：把上一部导出的词典就地挂载为「待用词典」，供生成长篇大纲时带入。
// 附遵从度滑条 + 「允许 AI 补充」开关（未挂载词典时两控件隐藏，恪守主轨道零干扰）。
function pendingGlossaryPanel(){
  if(!isLong()) return '';
  const hasPending = state.pendingGlossary && sourceHasGlossary(state.pendingGlossary);
  const p = state.pendingGlossary || {};
  const nChar = (p.characters||[]).length, nPlace=(p.places||[]).length, nProp=(p.propernouns||[]).length;
  const counts = hasPending ? `<span class="gs-pend-count">人物 ${nChar} · 地点 ${nPlace} · 专名 ${nProp}</span>` : '';
  const controls = hasPending ? `
    <div class="gs-adherence">
      <div class="gat-head"><b>📖 词典遵从度</b><span class="gat-val">${state.glossAdherence}%</span></div>
      <input type="range" min="0" max="100" step="10" value="${state.glossAdherence}" id="glossAdherence" class="gor" />
      <p class="gat-hint">${adherenceHint(state.glossAdherence)}</p>
      <label class="gat-switch"><input type="checkbox" id="glossAllowFill" ${state.glossAllowFill?'checked':''} /> <span>允许 AI 按剧情补充新角色/地名/专名</span></label>
    </div>` : '';
  return `<div class="card gs-pend">
    <h3 class="gs-card-title">📇 可复用词典 ${counts}
      <span class="gs-tools">
        <button type="button" class="btn ghost gs-tool" id="gsGlib" title="跨作品词典库">🗂️ 词典库</button>
        ${hasPending ? `<button type="button" class="btn ghost gs-tool" id="gsClearPending">🗑 清除</button><button type="button" class="btn ghost gs-tool" id="gsExportPend">导出 JSON</button>` : ''}
        <button type="button" class="btn ghost gs-tool" id="gsImportPend">📥 导入词典(新篇)</button>
        <input type="file" id="gsImportPendFile" accept=".json,application/json" hidden />
      </span>
    </h3>
    ${hasPending
      ? `<p class="sub">本次生成大纲时将代入此词典作为一致性底稿：以它为主，按新大纲补全。遵从度与「允许补充」控制其遵循程度。生成后可在设定表中继续编辑。</p>${controls}`
      : `<p class="sub">将上一部导出的「词典_xxx.json」在这里导入，即可把该书的人名/地名/专名作为本作的一致性底稿带进大纲生成（适合续作/同世界观）。不导入则完全不影响默认流程。</p>`}
  </div>`;
}
// 遵从度 → 语义化说明（v8：把百分比翻译成给用户看的自然语言）
function adherenceHint(a){
  if(a>=100) return '铁律：人名/地名/专名必须逐字沿用，禁止改拼写，仅按新大纲补新角色。';
  if(a>=80)  return '基准：尽量沿用，允许个别因新情节小幅调整。';
  if(a>=60)  return '主要参照：核心角色沿用，地名/专名可按新剧情调整。';
  if(a>=30)  return '灵感来源：可大改人名地名，仅保留题材与语感。';
  return '几乎放弃：仅作背景语感参考，允许完全重新构建设定。';
}
// v8 辅轨词典面板事件绑定（构想阶段）：导入/清除/导出 + 遵从度滑条 + 允许补充开关。
// 滑条/开关变动只更新局部，不整页 render，避免中断用户输入。
function bindPendingGlossary(){
  const impBtn = $('#gsImportPend'); const impFile = $('#gsImportPendFile');
  if(impBtn && impFile){ impBtn.onclick = ()=>{ impFile.click(); }; impFile.onchange = e=>{ const f=e.target.files&&e.target.files[0]; if(f) importGlossaryJson(f,'pending'); impFile.value=''; }; }
  const glibBtn = $('#gsGlib'); if(glibBtn) glibBtn.onclick = openGlibPanel;
  const clearBtn = $('#gsClearPending');
  if(clearBtn) clearBtn.onclick = ()=>{ state.pendingGlossary=null; state.glossAllowFill=false; persist(); render(); toast('已清除待用词典，回到无词典默认流程'); };
  const expBtn = $('#gsExportPend'); if(expBtn) expBtn.onclick = ()=>{ exportGlossaryJson(); };
  const adh = $('#glossAdherence');
  if(adh){ adh.oninput = ()=>{
    const v = +adh.value;
    state.glossAdherence = v;
    const val = document.querySelector('.gat-val'); if(val) val.textContent = v+'%';
    const hint = document.querySelector('.gat-hint'); if(hint) hint.textContent = adherenceHint(v);
    persist();
  }; }
  const allow = $('#glossAllowFill');
  if(allow) allow.onchange = ()=>{ state.glossAllowFill = allow.checked; persist(); };
}
function structureCard(o){
  const s = o && o.structure;
  const st = selStructure();
  if(!isLong() || !s || !(st && st.structure)) return '';
  const rows = [`<b>结构模式</b><span>${esc(s.mode||'')}</span>`];
  const push = (k,t,fmt)=>{ const v=s[k]; if(v==null) return; if(Array.isArray(v)){ rows.push(`<b>${t}</b><span>${esc(v.join(' · '))}</span>`); } else rows.push(`<b>${t}</b><span>${esc(fmt?fmt(v):v)}</span>`); };
  push('designReason','设计用意');
  push('mainLine','主线');
  push('subLines','副线');
  push('hiddenLine','暗线');
  push('pivotChapter','汇合/大逆转', v=>`第 ${v} 章附近`);
  push('threeFix','三定');
  // 阶段映射（英雄/节拍/七点）
  ['stageChapters','beats','points'].forEach(k=>{ if(s[k]){ rows.push(`<b>${k==='stageChapters'?'英雄阶段':k==='beats'?'节拍':k==='points'?'七点锚点':k}</b><span>${esc(arcMapText(s[k])||'')}</span>`); } });
  return `<div class="card structure-card">
    <h3>🏗️ 长篇结构设计</h3>
    ${rows.map(r=>`<div class="sc-row">${r}</div>`).join('')}
  </div>`;
}
// 写一条章节正文（依所勾选质量机制 post-processing：dual 双审 / selfref 自省 / plothole 伏笔洞检测）
// 省 token 策略：正文与初审均带上 max_tokens 上限；各机制一律「段落级重写」而非整章重写，
// 并共享一个整体重写预算，避免三种机制叠加把输出放大数倍。
async function writeOneChapterContent(i, user, onPhase){
  const mt = chapterMaxTokens();
  onPhase = onPhase || (()=>{});
  // 关闭流式（建议6）：一次性返回全文，不再传 onStream
  onPhase('撰写本章正文…');
  let txt = await callDeepSeek(longChapterSys(), user, {maxTokens: mt});
  return applyChapterQuality(txt, user, mt, onPhase);
}
// 对单章正文执行所勾选的质量机制（dual 双审 / selfref 自省 / plothole 伏笔洞检测）。
// 抽出为独立函数：单章路径与批量 2 章路径（genTwoChapters 对两章各自调用）共用，
// 保证「选了质检就处处生效」。
async function applyChapterQuality(txt, user, mt, onPhase){
  if(!isLong()) return txt.trim();
  mt = mt || chapterMaxTokens();
  onPhase = onPhase || (()=>{});
  // 共享重写预算：最多 3 次段落级修正，三种机制共同消耗，防止 ×4 输出放大
  let budget = 3;
  // 双审：编辑评审打分，不满 70 由写手按意见做段落级重写（不整章重发）
  if(hasQuality('dual')){
    onPhase('编辑双审中…');
    for(let r=0; r<2 && budget>0; r++){
      const draft = txt;
      let j;
      try{ j = parseJson(await callDeepSeek(PROMPTS.editorSys, '【本章初稿】\n'+draft.slice(0,3000))); }catch(e){ j={}; }
      const pass = j.pass===true || ((j.role||0)>=70 && (j.plot||0)>=70 && (j.world||0)>=70);
      if(pass) break;
      let advice = j.advice || (Array.isArray(j.issues) ? j.issues.map(x=>x.fix||x.rewritten||'').filter(Boolean).join('；') : '');
      const patches = Array.isArray(j.issues) ? j.issues.filter(x=>x.anchor && x.rewritten) : [];
      if(patches.length){
        budget--;
        txt = applyPatches(txt, patches);
        continue;
      }
      if(!advice) break;
      // 无结构化锚点时，仍只引导（段落级修正），不整章重写
      budget--;
      txt = await callDeepSeek(longChapterSys(),
        `${user}\n\n【编辑审稿意见】该章未达标（角色${j.role??'-'}/剧情${j.plot??'-'}/世界观${j.world??'-'}）。请在保持原文整体不变的前提下，只改写被指出的问题段落，其余段落文字原样保留，不要整章重写。问题：\n${advice}\n\n只输出需改写的段落文本。`, {maxTokens: mt});
    }
  }
  // 自省重写：自评本轮最大短板，仅针对该短板及其所在段做段落级修正
  if(hasQuality('selfref')){
    onPhase('自省打磨中…');
    const selfSys = `你是本章的自我编辑。请通读【本章初稿】，找出本章最明显的短板（只选一个：情绪感染力 / 剧情逻辑 / 文笔细节 / 人物刻画），指出该短板具体落在哪一个段落。请严格只输出 JSON（不要解释、不要 markdown 代码块）：{"weak":"短板名","why":"具体到句段的不足","how":"改进方向，简明可执行","anchor":"短板对应段落中的一句原文（用于定位该段）","rewritten":"按改进方向改写后的该段完整文字"}`;
    let s;
    try{ s = parseJson(await callDeepSeek(selfSys, '【本章初稿】\n'+txt.slice(0,3000))); }catch(e){ s={}; }
    if(s && s.weak && budget>0){
      if(s.anchor && s.rewritten){
        budget--;
        txt = applyPatches(txt, [s]);
      } else if(s.how && budget>0){
        budget--;
        txt = await callDeepSeek(longChapterSys(),
          `${user}\n\n【自省重写】本章主要短板：${s.weak}。改进方向：${s.how||s.why||''}。请保持原文整体不变，只针对该短板的段落做内化完善，其余段落原样保留，不要整章重写。只输出需改写的段落文本。`, {maxTokens: mt});
      }
    }
  }
  // 伏笔洞检测：专项核查连续性错误，问题段落级修正（无问题零额外输出）
  if(hasQuality('plothole')){
    onPhase('伏笔连续性核查中…');
    const holeSys = `你是长篇小说的连续性校对编辑。请专项核查【本章初稿】的四类逻辑漏洞：①时间线是否自洽；②人物性格/外貌/称呼是否与前文统一；③已铺设的伏笔是否被丢弃或矛盾；④地名/专名是否统一。若发现问题，请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：{"issues":[{"type":"时间线|性格|伏笔|专名","desc":"具体问题","fix":"修正说明","anchor":"该问题所在段落中的一句原文","rewritten":"按 fix 改写后的该段完整文字"}],"pass":true}`;
    let h;
    try{ h = parseJson(await callDeepSeek(holeSys, '【本章初稿】\n'+txt.slice(0,3000))); }catch(e){ h={}; }
    const issues = (h && Array.isArray(h.issues) && h.issues.length) ? h.issues : [];
    const pass = !issues.length || h.pass===true;
    const anchored = issues.filter(x=>x.anchor && x.rewritten);
    if(!pass && budget>0){
      if(anchored.length){
        budget--;
        txt = applyPatches(txt, anchored);
      } else if(issues.length && budget>0){
        budget--;
        const adv = issues.map(x=>`[${x.type}] ${x.desc} → ${x.fix}`).join('\n');
        txt = await callDeepSeek(longChapterSys(),
          `${user}\n\n【连续性修正】本章存在以下一致性/伏笔问题，请保持原文整体不变，只改写被指出的问题段落，其余段落原样保留，不要整章重写。问题：\n${adv}\n\n只输出需改写的段落文本。`, {maxTokens: mt});
      }
    }
  }
  return txt.trim();
}
// 组装单章生成的 user 提示词。恒定前缀块（标题/梗概/全部章节标题/一致性词典）保持在前、全章不变，
// 以最大化 DeepSeek 上下文缓存命中；可变信息（本章概要/结构/上一章结尾）放最末。
// opt.regenerating=true 时（单章重生成）额外注入上章结尾+下章概要，保证前后连贯（建议5/决策5）。
// 章节标题窗口列表（v8b 抽出）：以第 i 章为中心、前后各 R 章；分卷结构整卷全列。
// 单章路径 buildChapterUser 与批量 2 章 genTwoChapters(topic 窗口以 pairStart 为中心) 共用，
// 确保两种生成方式模型都能看到本章在全书中的位置与前后节奏。
function chapterTitleWindow(i){
  const o = state.outline;
  const vol = o.chapters[i] && o.chapters[i].volume;
  if(vol){
    return o.chapters.map(c=>c.title).filter((_,k)=> o.chapters[k] && o.chapters[k].volume === vol).join(' / ');
  }
  const R = 10;
  const from = Math.max(0, i - R), to = Math.min(o.chapters.length - 1, i + R);
  const parts = [];
  if(from > 0) parts.push(`…（前 ${from} 章略）`);
  for(let k=from;k<=to;k++) parts.push(o.chapters[k].title);
  if(to < o.chapters.length - 1) parts.push(`…（后 ${o.chapters.length-1-to} 章略）`);
  return parts.join(' / ');
}
function buildChapterUser(i, opt={}){
  const o = state.outline;
  const prev = i>0 ? state.chapters[i-1].content : '';
  // 标题列表收窄（v8b 复用 chapterTitleWindow）：不再全量带上 100+ 章，仅保留与本章相关的窗口。
  const titles = chapterTitleWindow(i);
  // 万物词典一致性基准（建议5）：全文服从，不得自造新名（v8 统一走 chapterGlossaryBlock）
  const gloss = chapterGlossaryBlock();
  const head = `故事标题：${o.title}\n一句话梗概：${o.logline}\n章节：${titles}${gloss}`;
  // 重生成/首次都带上一章中文内容到末尾，保证承接；可选带下一章概要（仅当重生成且下一章已有内容才注入）
  let tail = `本章标题：${state.chapters[i].title}\n本章概要：${o.chapters[i].summary}${longChapterContext(i)}${prev?('\n上一章结尾：'+prev.slice(-200)+'…'):'\n（这是第一章）'}`;
  const nextHasContent = i < o.chapters.length-1 && state.chapters[i+1] && state.chapters[i+1].content && String(state.chapters[i+1].content).trim();
  if(opt.regenerating && nextHasContent){
    tail += `\n下一章概要（请预留衔接，但不要剧透下一章情节）：${o.chapters[i+1].summary||''}`;
  }
  // 人工干预要求（建议3·此轮）：重生成时遵循用户指定的改动方向
  if(opt.advice){
    tail += `\n\n【人工干预要求（用户指定，务必优先遵循）】\n${opt.advice}\n请在重写本章时落实以上要求，其余不受影响的内容仍保持既有文风与世界观一致。`;
  }
  return `${head}\n\n${tail}`;
}
// 章节生成状态机：chState[i] = 'idle'|'generating'|'done'|'error'（健壮性契约）
const chState = {};
// 章节所在页数（建议3：每页 10 章），供渲染与跳转定位
let chPage = 0;
const CH_PAGE_SIZE = 10;

// 定点刷新第 i 章卡片（健壮性契约：不整页 render，保留其它卡片/滚动位置/焦点）
function patchChapter(i){
  const card = document.querySelector('.ch-card[data-ch-card="'+i+'"]');
  if(!card) return;               // 该章不在当前页渲染范围，跳过 DOM（数据已落库，翻页即见）
  // 字数徽标
  const wc = card.querySelector('[data-wc-ch="'+i+'"]');
  if(wc) wc.innerHTML = wcBadge(state.chapters[i].content, `data-wc-ch="${i}"`);
  // 生成态徽标 + 折叠开关
  const statePill = card.querySelector('[data-ch-state]');
  const stMap = { idle:'', generating:'⏳ 生成中', done:'已生成', error:'⚠️ 生成失败' };
  const tagMap = { idle:'tag-warn', generating:'tag-warn', done:'tag-ok', error:'tag-warn' };
  if(statePill){ statePill.textContent = stMap[chState[i]] || '未生成'; statePill.className='pill '+tagMap[chState[i]]; }
  // textarea 值（焦点保护：正在编辑的不覆盖）
  const hasC = !!(state.chapters[i].content && state.chapters[i].content.trim());
  const body = card.querySelector('.ch-body');
  const ta = card.querySelector('textarea[data-ch="'+i+'"]');
  if(ta && !ta.matches(':focus')) ta.value = state.chapters[i].content;
  if(body && body.classList.contains('folded') && hasC){ body.classList.remove('folded'); }
  const ico = card.querySelector('.ch-fold-ico'); if(ico) ico.textContent = hasC ? '▾' : '▸';
  const re = card.querySelector('[data-regen="'+i+'"]');
  if(re){ re.disabled = !!state.generating; }
}

// 重生成干预弹窗（建议3·此轮）：可任选「直接重生成」或「带人工建议重生成」
function openChapterRegenPanel(i){
  closeChapterRegenPanel();
  const c = state.chapters[i];
  const title = c && c.title ? c.title : ('第'+(i+1)+'章');
  const ov = document.createElement('div');
  ov.id = 'regenPanel'; ov.className = 'gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>🔄 重生成 · 第${i+1}章「${esc(title)}」</b>
        <button class="gs-x" data-rp-close>✕</button></div>
      <div class="gs-body">
        <p class="gs-q"><b>想如何改动这一章？</b> 可在下方填写你的具体要求（改动方向、补充设定、错误修正等）；留空则按现有风格直接重写。</p>
        <textarea id="rpAdvice" class="rp-advice" placeholder="例如：这一章节奏太慢，请压缩到 1500 字以内；女主的性格再外放一点；增加与上一章结尾的衔接…（可选）"></textarea>
      </div>
      <div class="gs-actions">
        <button class="btn" data-rp-plain>直接重生成（无干预）</button>
        <button class="btn primary" data-rp-with>💡 带我的建议重生成</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-rp-close]').onclick = closeChapterRegenPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeChapterRegenPanel(); });
  ov.querySelector('[data-rp-plain]').onclick = ()=>{
    const btn = document.querySelector('[data-regen="'+i+'"]');
    closeChapterRegenPanel();
    genOneChapter(i, btn, {});
  };
  ov.querySelector('[data-rp-with]').onclick = ()=>{
    const advice = $('#rpAdvice').value.trim();
    const btn = document.querySelector('[data-regen="'+i+'"]');
    closeChapterRegenPanel();
    genOneChapter(i, btn, {advice});
  };
  const ta = $('#rpAdvice'); if(ta) ta.focus();
}
function closeChapterRegenPanel(){ const p=$('#regenPanel'); if(p) p.remove(); }

// 单章生成（🔄 重生成，决策5：只重写目标章，注入上章结尾+下章概要+全局词典）
// opt.advice：可选的人工干预要求（建议3·此轮），随 buildChapterUser 注入模型
async function genOneChapter(i, btn, opt={}){
  chState[i] = 'generating'; state.generating = true; patchChapter(i);
  if(btn) busy(btn,true,'生成中…');
  // 进度区：与「一键批量生成」同源。单章也在此实时显示「第几章 + 当前阶段」。
  const st = $('#chStatus');
  const setPhase = msg => { if(st){ st.className='status'; st.textContent = `第 ${i+1}/${state.chapters.length} 章：${msg||''}`; } };
  setPhase('准备中…');
  try{
    const user = buildChapterUser(i, {regenerating:true, advice:opt.advice});
    const txt = await writeOneChapterContent(i, user, setPhase);   // 关闭流式；各阶段经 setPhase 上报
    snapshotChapterVersion(i);            // v7.2：覆盖前存旧版，支持回退
    state.chapters[i].content = txt;
    chState[i] = 'done';
    if(!isLong()) state.chapters[i].confirmed = false;
    persist();                       // 不整页 render，仅定点刷新
    patchChapter(i);
    if(st){ st.className='status ok'; st.textContent = `第 ${i+1} 章已生成。`; }
    toast('第'+(i+1)+'章完成');
  }catch(e){ chState[i] = 'error'; patchChapter(i); if(st){ st.className='status err'; st.textContent = '第'+(i+1)+'章生成失败：'+e.message; } toast('第'+(i+1)+'章生成失败：'+e.message); }
  finally{ state.generating = false; if(btn) busy(btn,false); patchChapter(i); }
}

// 从模型返回的连续两章正文里切分（分隔：模型输出按「【第X章…】…【第X+1章…】」组织）
function splitTwoChapters(txt){
  // 以「第N章」标题行切分（兼容【第N章】或「第N章」两种写法）。不盲切对半：
  // 若模型未按规范分段（只出一章或没分段），返回空结果交给调用方抛错停批，避免把两章错填进一格。
  const parts = txt.split(/\n?\s*【?\s*第\s*\d+\s*章\s*[】]?[\s:：]*/).map(s=>s.trim()).filter(Boolean);
  if(parts.length >= 2){
    const a = parts[0], b = parts.slice(1).join('\n');
    if(a && b) return [a, b];
  }
  return ['', ''];
}

// 一次写 2 章（建议6/决策6）：单次请求连续写两章正文，天然保证两章内人名地名关系一致
async function genTwoChapters(pairStart){
  const mt = chapterMaxTokens() * 1.6;   // 两章内容，放宽上限
  const o = state.outline;
  // 标题窗口（v8b）：以本对开头章为中心，与单章共用 chapterTitleWindow，保证模型看见本章在全书中的位置与前后节奏
  const titles = chapterTitleWindow(pairStart);
  const head = `故事标题：${o.title}\n一句话梗概：${o.logline}\n章节：${titles}`;
  // 一致性词典（v8 统一走 chapterGlossaryBlock）
  const gloss = chapterGlossaryBlock();
  // 批量字数说明（v8c）：两章各自落在所选区间，合计上限为单章上限 ×2。作为独立块追加在写作任务之后，使体量约束在批量场景更明确。
  const batchSizeNote = `\n【每章篇幅体量】两章各自都应落在 ${fmtRange(selSize().range)} 字区间内，两章尽量均衡，不可一章过短、一章过长（合计不超过该区间上限的 2 倍，即 ${fmtRange(selSize().range)} × 2）。`;
  const prevEnd = pairStart>0 ? state.chapters[pairStart-1].content.slice(-200) : '';
  const user = `${head}${gloss}
\n【写作任务】请连续写作以下两章正文，章间要紧扣衔接、人名地名人物关系保持一致，各自维持单章既定体量与章末钩子。\n
第 ${pairStart+1} 章「${state.chapters[pairStart].title}」概要：${o.chapters[pairStart].summary}
第 ${pairStart+2} 章「${state.chapters[pairStart+1].title}」概要：${o.chapters[pairStart+1].summary}
${batchSizeNote}
${longChapterContext(pairStart)}
${prevEnd?('上一章结尾：'+prevEnd+'…'):''}

请严格按顺序输出两章正文，用【第${pairStart+1}章】与【第${pairStart+2}章】作为分段标题。只输出正文，不要多余解释。`;
  const txt = await callDeepSeek(longChapterSys(), user, {maxTokens: mt});
  const pair = splitTwoChapters(txt);
  // 建议2/3：两章必须都正确切出才落库，否则抛错交给批次停批，绝不静默错填（杜绝“两章挤进一格”）
  if(!pair[0] || !pair[1] || !pair[0].trim() || !pair[1].trim()){
    throw new Error('模型未按【第N章】分别输出两章正文，未落库。可重试本批。');
  }
  // 建议2（v8d）：篇幅合理性校验——若某章远低于所选字数下限（< 下限的 45%），多半是模型把两章内容塞给了另一章，
  // 判定为可疑并抛错停批，交由用户重试，而不是静默产出一章过短的长短失衡结果。
  const ink = selSize().range.min;   // 所选单章字数下限
  const sizA = String(pair[0]).replace(/\s/g,'').length, sizB = String(pair[1]).replace(/\s/g,'').length;
  const short = Math.min(sizA, sizB), long = Math.max(sizA, sizB);
  if(long > 0 && short < ink * 0.45 && long > short * 3){
    throw new Error(`两章篇幅失衡（第${pairStart+1}章 ${sizA} 字 / 第${pairStart+2}章 ${sizB} 字），可能被模型错切，未落库。可重试本批。`);
  }
  // 质检搬入批量 2 章（v8b）：对两章分别执行所勾选的质量机制；第二章质检时以打磨后的第一章作为“前章承接”。
  // 每章各自的 user 用 buildChapterUser 重建，保证质检的“前章结尾/下一章概要”上下文正确。
  // 先质检通过、后统一快照+落库，避免质检中途失败污染已落库内容（质检失败会向上抛错停批）。
  const a = await applyChapterQuality(pair[0].trim(), buildChapterUser(pairStart), mt);
  // 临时把打磨后的第一章写回 state.chapters，使第二章 buildChapterUser 能读到真实的前章内容作为承接；
  // 若 B 质检失败，异常上抛停批，此刻未快照未 persist，内存残留会在重试时被覆盖。
  state.chapters[pairStart].content = a;
  const b = await applyChapterQuality(pair[1].trim(), buildChapterUser(pairStart+1), mt);
  snapshotChapterVersion(pairStart);            // v7.2：覆盖前存旧版，支持回退
  snapshotChapterVersion(pairStart+1);
  state.chapters[pairStart].content = a;
  state.chapters[pairStart+1].content = b;
}

// 批量生成：长篇每批固定 2 章（决策6）/ 短片全部。进度区 #chStatus 实时更新，页面不锁死。
async function genAllChapters(){
  const btn = $('#btnGenAllChapters'); busy(btn,true,'逐章生成中…');
  const st = $('#chStatus'); if(st){ st.className='status'; st.textContent=''; }
  let batchFailed = false;                             // 建议2：批次是否因任一章失败而中止
  const batchSize = isLong() ? 2 : state.chapters.length;   // 决策6：每批固定 2 章
  let start = 0;
  if(isLong()){
    const firstEmpty = state.chapters.findIndex(c => !(c.content && c.content.trim()));
    start = firstEmpty >= 0 ? firstEmpty : 0;
  }
  const genCount = Math.min(batchSize, state.chapters.length - start);
  if(genCount <= 0){ if(st){st.className='status ok'; st.textContent='全部章节已生成。';} busy(btn,false); return; }
  for(let k=0;k<genCount;k++){
    const i = start + k;
    if(!isLong() && state.chapters[i].content && state.chapters[i].confirmed) continue;
    chState[i] = 'generating'; state.generating = true; patchChapter(i);
    if(st) st.textContent = isLong()
      ? `正在生成第 ${i+1}/${state.chapters.length} 章（本批第 ${k+1}/${genCount} 章，每批 2 章）…`
      : `正在生成第 ${i+1}/${state.chapters.length} 章…`;
    try{
      // 长篇：优先「一次 2 章」；若剩 1 章则单章
      if(isLong() && k+1 < genCount){
        await genTwoChapters(i);
        chState[i]='done'; chState[i+1]='done'; k++;   // 本对一次处理两章，外层 k 再前进
      } else if(isLong()){
        const txt = await writeOneChapterContent(i, buildChapterUser(i));
        snapshotChapterVersion(i);            // v7.2：覆盖前存旧版，支持回退
        state.chapters[i].content = txt;
        chState[i]='done';
      } else {
        const txt = await callDeepSeek(PROMPTS.chapterSys + specSysAddition(), buildChapterUser(i));
        snapshotChapterVersion(i);            // v7.2：覆盖前存旧版，支持回退
        state.chapters[i].content = txt; state.chapters[i].confirmed=false;
        chState[i]='done';
      }
      persist(); patchChapter(i);
      // 若生成落在当前页之外，切到其所在页以便用户看到（建议3）
      const targetPage = Math.floor(i / CH_PAGE_SIZE);
      if(isLong() && Math.abs(chPage - targetPage) >= 1){ chPage = targetPage; renderChapters(); }
    }catch(e){
      chState[i]='error'; patchChapter(i);
      if(st){ st.className='status err'; st.textContent += ` 第${i+1}章失败(${e.message})。`; }
      // 建议2：长篇批量必须两章都对，任一对出错即停批，不继续生成后续章节
      if(isLong()){ if(st){ st.textContent += ' 已停止本批，请修复后重试。'; } batchFailed = true; break; }
      // 短片模式保留既有错误隔离（跳过继续），符合短片中单章失败不影响整批的预期
      state.chapters[i].content = state.chapters[i].content || '';
    } finally { state.generating = false; }
  }
  if(st && !batchFailed){ st.className='status ok'; st.textContent = isLong()
    ? `本批共 ${genCount} 章已处理。继续点「生成下一批 2 章」直到写完全部。`
    : '全部章节已生成，请审阅并标记确认。'; }
  busy(btn,false);
  if(!isLong()) render();            // 短片模式可整页刷新（无折叠/分页负担）
  else { renderChapters(); }         // 长篇仅重绘章节区，保留顶部/大纲不动
}

// 无 UI 阻塞版（供短片循环调用，保留）
async function genOneChapterNoUI(i){
  const user = buildChapterUser(i);
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
let histOpenId = null;   // 当前展开详情的历史项目 id（折叠态，互不影响）
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
    const open = histOpenId === p.id;
    // 展开详情：按项目类型展示正文/大纲/已完成内容片段
    const preview = histItemPreview(p);
    return `<div class="hist-item ${isCur?'active':''} ${open?'open':''}" data-hist="${p.id}">
      <div class="hist-head" data-hist-toggle="${p.id}">
        <span class="hist-fold" data-hist-fold="${p.id}">${open?'▾':'▸'}</span>
        <button class="hist-main" data-switch="${p.id}">
          <span class="hist-title">${isCur?'<em class="hist-cur">当前</em>':''}${esc(p.title||'未命名作品')}</span>
          ${p.logline?`<span class="hist-desc">${esc(p.logline)}</span>`:''}
          <span class="hist-meta">${histProgress(p)} · ${fmtHistTime(p.updatedAt)}</span>
        </button>
        <button class="hist-del" data-histdict="${p.id}" title="导出该作词典">📇</button>
        <button class="hist-del" data-del="${p.id}" title="删除作品">🗑</button>
      </div>
      <div class="hist-body">${preview}</div>
    </div>`;
  }).join('') || `<div class="hist-empty">还没有作品，点击「＋ 新建小说」开始。</div>`;
  $$('#histList [data-switch]').forEach(b=> b.onclick = ()=> switchProject(b.dataset.switch));
  $$('#histList [data-del]').forEach(b=> b.onclick = (e)=>{ e.stopPropagation(); deleteProject(b.dataset.del); });
  // 历史作品一键导出该作词典（阶段5）
  $$('#histList [data-histdict]').forEach(b=> b.onclick = (e)=>{ e.stopPropagation(); exportWorkGlossaryJSON(b.dataset.histdict); });
  // 折叠/展开单条项目详情：只影响当前项，不影响其它项的选择
  $$('#histList .hist-head').forEach(h=> h.onclick = (e)=>{
    if(e.target.closest('[data-switch]')) return;   // 点标题=切换项目，不折叠
    if(e.target.closest('[data-del]')) return;      // 删除按钮不触发折叠
    if(e.target.closest('[data-histdict]')) return; // 导出按钮不触发折叠
    const id = h.dataset.histToggle;
    histOpenId = (histOpenId===id) ? null : id;
    renderHistList();                               // 重新渲染以切折叠态
  });
}
// 单条历史作品的详情预览（HTML）
function histItemPreview(p){
  // 优先展示已有章正文的前若干字符，其次大纲标题，其次其它阶段摘要
  const chapters = (p.chapters||[]).filter(c=> c && c.content && String(c.content).trim());
  const parts = [];
  if(chapters.length){
    parts.push(`<b>正文已生成 ${chapters.length} 章：</b>`);
    const rows = chapters.slice(0, 8).map((c,i)=>`<div class="hist-p-row">第${i+1}章 · ${esc(c.title||'')}</div>`).join('');
    parts.push(rows);
    if(chapters.length>8) parts.push(`<div class="muted">… 其余 ${chapters.length-8} 章</div>`);
  }
  const outline = p.outline && p.outline.chapters;
  if(outline && outline.length){
    parts.push(`<b>大纲（${outline.length} 章）：</b>`);
    parts.push(`<div class="hist-p-row muted">${esc(outline.map(c=>c.title).slice(0,6).join(' / '))}${outline.length>6?' …':''}</div>`);
  }
  if(p.characters && p.characters.length){
    parts.push(`<div class="hist-p-row muted">角色：${esc(p.characters.map(c=>c.name).slice(0,6).join('、'))}</div>`);
  }
  if(p.scenes && p.scenes.length){
    parts.push(`<div class="hist-p-row muted">场景：${esc(p.scenes.map(s=>s.name).slice(0,6).join('、'))}</div>`);
  }
  if(!parts.length) parts.push('<div class="muted">（暂无内容，仅记录了构想与进度）</div>');
  return parts.join('');
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
  // 点击「新建长篇」不再弹确认页，直接新建并进入经典长篇小说页面
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
  // 历史弹层头部「＋ 新建长篇」：确认后新建经典长篇小说项目
  const nlo = $('#histNewLong');
  if(nlo) nlo.onclick = (e)=>{ e.stopPropagation(); newLongProject(); };
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
  loadGlib();                        // v8 词典库（跨作品复用）
  // 应用已保存主题（统一走 applyTheme，保证 mecha nav 显隐等副作用一致）
  const c = getCfg();
  applyTheme(c.theme || 'dark');
  // 顶栏设置
  $('#btnSettings').onclick = openSettings;
  // 历史作品按钮：展开/收起弹层；新建小说 / 新建长篇按钮
  rebindHistPanel();
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
