/* =========================================================
 * 影视前期提示词生成器 · 纯前端 H5
 * 仅调用 DeepSeek 生成文字与提示词；出图交给「即梦」。
 * 复用参考：show-me-the-story(逐章) / character-sheet-generator(角色卡字段)
 *          / video-shot-agent(分镜结构)
 * ========================================================= */
'use strict';

/* ---------- 全局状态 ---------- */
const APP_VERSION = '1.0.29';   // 应用版本号（fixed11 基线 + 新增：① 逐章梗概受风格影响(默认开/随书/首位要求)；② 重生成全部标题受风格影响，独立开关 titleStyleOn 默认开、独占卡片第二行、rt-input 高度翻倍）：index.html 的 ?v= 资源戳与之同步递增，用于标识产物已更新
const KEY_CFG = 'fyp_cfg';
const KEY_STATE = 'fyp_state';   // 旧版单项目 key（仅用于首次迁移）
const KEY_LIB = 'fyp_lib';       // 新版多项目历史库
const KEY_GLIB = 'fyp_glib';     // v8 词典库（跨作品的多套可复用词典，独立于项目轨道）
const MAX_PROJECTS = 50;         // 历史项目上限
let lib = { curId: null, items: [] }; // {curId, items:[{id, idea, outline, ..., step, title, logline, updatedAt}]}
let gglib = [];                  // v8 词典库：[{id, name, note, savedAt, g:{characters,places,propernouns}}]

const state = {
  mode: 'shortfilm',    // 'shortfilm' 短片 / 'longnovel' 经典长篇小说
  recipe: 'mesh',       // (兼容旧字段) 旧式单一范式 id；新项目用 recipeSet
  recipeSet: { structure:null, rhythm:null, quality:[], titleStyle:[] }, // 长篇三维写作范式：结构(单选)+节奏(单选)+质量(可多选)；默认全部不选，由 AI 按构想发挥
  wordRange: null,      // (兼容遗留) 不再作为长篇必填；保留字段避免旧快照破坏
  chapterRange: null,   // (兼容遗留) 同上
  totalWords: null,     // (兼容遗留) 同上
  chapterCount: null,   // 全书章节数量（整数 1-200，生成大纲前唯一必填数字；null=未设）
  idea: '',
  coverPrompt: '',      // 整部小说封面提示词（场景页生成 / 长篇模式用）
  coverWithTitle: false,// 封面提示词是否包含「汉字书名」（false=纯画面无文字）
  outline: null,        // {title, logline, chapters:[{title,summary}]}
  outlineConfirmed: false,
  pendingGlossary: null, // v8 辅轨槽位：大纲前导入的待用词典 {characters,places,propernouns}，不写进 outline 直至确认
  glossAdherence: 60,   // v8 遵从度（%）：用户控制 AI 遵循词典的程度；默认 60（折中，续作/新作均安全，见规划 Q4）
  glossAllowFill: false, // v8 「允许 AI 补充」开关：低遵从时是否放行 AI 新增实体
  glossAutoFill: true,   // v8c 词典自动补全（默认开）：批量生成章节后自动提取正文中的新人物/地名/专名并入词典；关则只保留手动「📥 提取新增」
  gsCollapsed: true,    // v8b：万物词典卡片是否整卡收缩（默认收缩，点圆形展开全部）
  stCollapsed: false,   // v10.3：长篇结构设计栏是否收缩（默认展开，点击标题收起）
  cpCollapsed: true,    // v10.14：逐章方向梗概卡是否收缩（默认折叠，点击标题展开）
  planStyleOn: true,    // 逐章梗概是否受顶部写作风格影响（默认开；作为生成时的首位硬要求；随每本书）
  titleStyleOn: true,   // 重生成全部标题是否受顶部写作风格影响（默认开；独立开关、首位硬要求、随每本书）
  autoQC: false,        // 自动质检开关（默认关闭，v10.18）：生成后自动两段式查错修正；关则直接落库
  chapters: [],         // [{title, content, confirmed, editHistory:[], qcRecord:{}}]
  characters: [],       // [{name, role, profile:{...}, prompts:{...}}]
  outlineHistory: [],   // 大纲版本历史（上限10）：[{outline, ts}] 覆盖前快照，支持预览/恢复
  expSel: [],           // 长篇导出勾选的章节索引（随项目快照持久化，P3-4）
  hist: { characters:[], scenes:[], cover:[], storyboard:[] },  // P1-3 角色/场景/封面/分镜覆盖前快照（各上限10）
  chapterStyle: { tags: [], intensity: 2, collapsed: false, elemOpen: false },   // 写作风格（v2.0）：tags=风格id数组（多选，分 标题/梗概/章节 三组）；elemOpen=卡片内「章节风格」组是否展开（默认收拢）
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
/* 多 AI 模型配置：组(groups) → 账号(keys) → 模型(models) 三层。
 * 当前「生成使用」的唯一来源 = cfg.active，绝不并发多模型请求。
 * 深度兼容旧平铺 {apiKey, baseUrl, model}：首次读取时一次性迁移。 */
let uidSeq = 1000;
function uid(p){ return (p||'id')+(++uidSeq); }
function defaultModels(){ return [
  {name:'deepseek-v4-pro', label:'deepseek-v4-pro（质量最高，推荐）', kind:'pro'},
  {name:'deepseek-v4-flash', label:'deepseek-v4-flash（最快/最便宜）', kind:'flash'},
  {name:'deepseek-v4-flash-vision-exp', label:'deepseek-v4-flash-vision-exp（带视觉）', kind:'flash'}
]; }
function cfgDeepSeekGroup(){ return {id:'deepseek', kind:'openai', label:'DeepSeek 官方', baseUrl:'https://api.deepseek.com', keys:[], models:defaultModels()}; }

// 归一化 cfg：保证 groups/active 存在，迁移旧平铺配置。
function normalizeCfg(cfg){
  cfg = cfg || {};
  if(!Array.isArray(cfg.groups)){
    const g = cfgDeepSeekGroup();
    if(cfg.apiKey){            // 旧版单 Key 迁移
      const id = uid('k');
      g.keys.push({id, label:'默认账号', key:cfg.apiKey});
      cfg.active = { groupId:'deepseek', keyId:id, model: cfg.model || 'deepseek-v4-pro' };
    }
    cfg.groups = [g];
  }
  cfg.groups.forEach((gr,i)=>{
    gr.kind = gr.kind || 'openai';
    gr.baseUrl = gr.baseUrl || '';
    gr.keys = (gr.keys||[]).map((k,j)=>({id: k.id||uid('k'), label: k.label||('账号'+(j+1)), key: k.key||''}));
    gr.models = (gr.models && gr.models.length) ? gr.models : defaultModels();
  });
  // active 兜底：组 → 账号 → 模型
  const act = cfg.active || {};
  const group = cfg.groups.find(g=>g.id===act.groupId) || cfg.groups[0];
  if(group){
    const key = group.keys.find(k=>k.id===act.keyId) || group.keys[0];
    const model = group.models.find(m=>m.name===act.model)
      || group.models.find(m=>m.name==='deepseek-v4-pro') || group.models[0];
    cfg.active = { groupId: group.id, keyId: key ? key.id : null, model: model ? model.name : 'deepseek-v4-pro' };
  } else {
    cfg.active = { groupId:null, keyId:null, model:'' };
  }
  return cfg;
}
function getCfg(){
  try{ return normalizeCfg(JSON.parse(localStorage.getItem(KEY_CFG)) || {}); }catch(e){ return normalizeCfg({}); }
}
function saveCfg(cfg){ localStorage.setItem(KEY_CFG, JSON.stringify(cfg)); }

// 解析「当前生成使用」的具体请求参数（来源唯一，组→账号→模型）。
function resolveActiveSpec(){
  const cfg = getCfg();
  const act = cfg.active || {};
  const group = cfg.groups.find(g=>g.id===act.groupId) || cfg.groups[0] || {};
  const key = (group.keys||[]).find(k=>k.id===act.keyId) || (group.keys||[])[0] || {};
  const model = (group.models||[]).find(m=>m.name===act.model) || (group.models||[])[0] || {};
  return {
    groupId: group.id, groupLabel: group.label,
    keyId: key.id, keyLabel: key.label,
    baseUrl: (group.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, ''),
    apiKey: key.key || '',
    model: model.name || 'deepseek-v4-pro',
    temperature: (cfg.temperature==null ? 0.7 : cfg.temperature),
    outlineTemp: (cfg.outlineTemp==null ? 0.7 : cfg.outlineTemp),   // v10.8 分任务温度：大纲
    ideaTemp:    (cfg.ideaTemp==null ? 0.5 : cfg.ideaTemp),          // v10.13 分任务温度：优化构想
    titleTemp:   (cfg.titleTemp==null ? 0.5 : cfg.titleTemp),        // v10.15 分任务温度：标题 AI
    chapterTemp: (cfg.chapterTemp==null ? 0.5 : cfg.chapterTemp),   // v10.8 分任务温度：章节
    qcTemp:      (cfg.qcTemp==null ? 0.2 : cfg.qcTemp),              // v10.8 分任务温度：质检/提取
    planTemp:    (cfg.planTemp==null ? 0.4 : cfg.planTemp)           // v10.11 分任务温度：逐章梗概
  };
}
function currentSpecLabel(){
  const s = resolveActiveSpec();
  const model = s.model.replace('deepseek-v4-','').split('-')[0]; // v4-pro → pro
  return (s.groupLabel||'AI') + ' · ' + (s.keyLabel||'默认') + ' · ' + model;
}
// 当前所选模型是否支持流式：DeepSeek / 火山引擎 Doubao 启用流式进度反馈，其他 AI 不反馈。
function currentIsDeepSeek(){
  const s = resolveActiveSpec();
  return /deepseek/i.test(s.model||'') || /deepseek/i.test(s.groupId||'')
      || /doubao/i.test(s.model||'') || /doubao/i.test(s.groupId||'');
}

/* ---------- 主题切换（单页内深色 / 3D 黑板 / 热血 FC） ---------- */
const THEMES = ['dark','light','blackboard','mecha','cyber','guofeng'];
function applyTheme(theme){
  if(THEMES.indexOf(theme) < 0) theme = 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  const c = getCfg(); c.theme = theme; saveCfg(c);
  // 黑板主题为纯 CSS 实现（不再依赖 blackboard3d.js / three.js），此处无需任何 JS 初始化
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
  // 黑板主题下，每次切换步骤重放“拉下新黑板”级联动画（纯 CSS）
  if(document.documentElement.getAttribute('data-theme') !== 'blackboard') return;
  const v = $('#view'); if(!v) return;
  v.style.animation = 'none'; void v.offsetWidth; v.style.animation = '';
}

/* =========================================================
 * 多项目历史库：fyp_state（单项目）→ fyp_lib（最多 50 个项目）
 * ========================================================= */
function makeId(){ return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

// 从当前 state 捕获一个项目快照（含步骤，供切换恢复）
function projectSnapshot(){
  return {
    mode: state.mode || 'shortfilm',
    recipe: state.recipe || 'mesh',
    recipeSet: state.recipeSet || { structure:null, rhythm:null, quality:[], titleStyle:[] },
    wordRange: state.wordRange || null,
    chapterRange: state.chapterRange || null,
    totalWords: state.totalWords || null,
    chapterCount: (state.chapterCount && +state.chapterCount>0) ? +state.chapterCount : null,
    idea: state.idea,
    coverPrompt: state.coverPrompt,
    coverWithTitle: state.coverWithTitle,
    outline: state.outline,
    outlineConfirmed: state.outlineConfirmed,
    pendingGlossary: state.pendingGlossary,
    glossAdherence: state.glossAdherence,
    glossAllowFill: state.glossAllowFill,
    glossAutoFill: state.glossAutoFill,
    gsCollapsed: state.gsCollapsed,
    stCollapsed: state.stCollapsed,
    cpCollapsed: state.cpCollapsed,   // v10.14 梗概卡折叠透传
    planStyleOn: (typeof state.planStyleOn === 'boolean') ? state.planStyleOn : true,   // 逐章梗概受写作风格影响开关（随书）
    titleStyleOn: (typeof state.titleStyleOn === 'boolean') ? state.titleStyleOn : true,   // 重生成标题受写作风格影响开关（独立、随书）
    polishOptions: state.polishOptions,   // v10.16 优化构想保留方案透传
    polishAdopted: state.polishAdopted,   // v10.16 当前采用的方案名
    polishHistory: state.polishHistory,   // v10.16 优化构想批量版本（≤5）透传
    autoQC: (typeof state.autoQC === 'boolean') ? state.autoQC : false,
    chapters: state.chapters,
    characters: state.characters,
    outlineHistory: state.outlineHistory,
    expSel: Array.isArray(state.expSel) ? state.expSel : [],
    hist: state.hist || { characters:[], scenes:[], cover:[], storyboard:[] },
    chapterStyle: state.chapterStyle || { tags: [], intensity: 2, collapsed: false },
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
  state.chapterCount = (p.chapterCount && +p.chapterCount>0) ? +p.chapterCount : null;
  state.idea = p.idea || '';
  state.coverPrompt = p.coverPrompt || '';
  state.coverWithTitle = !!p.coverWithTitle;
  state.outline = p.outline || null;
  state.outlineConfirmed = !!p.outlineConfirmed;
  state.pendingGlossary = p.pendingGlossary || null;
  state.glossAdherence = (typeof p.glossAdherence === 'number') ? p.glossAdherence : 60;
  state.glossAllowFill = !!p.glossAllowFill;
  state.glossAutoFill = (typeof p.glossAutoFill === 'boolean') ? p.glossAutoFill : true;
  state.gsCollapsed = (typeof p.gsCollapsed === 'boolean') ? p.gsCollapsed : true;
  state.stCollapsed = !!p.stCollapsed;
  state.cpCollapsed = (typeof p.cpCollapsed === 'boolean') ? p.cpCollapsed : true;   // v10.14 梗概卡默认折叠
  state.planStyleOn = (typeof p.planStyleOn === 'boolean') ? p.planStyleOn : true;     // 逐章梗概风格约束默认开（随书）
  state.titleStyleOn = (typeof p.titleStyleOn === 'boolean') ? p.titleStyleOn : true;   // 重生成标题风格约束默认开（独立、随书）
  state.polishOptions = Array.isArray(p.polishOptions) ? p.polishOptions : undefined;   // v10.16 保留方案
  state.polishAdopted = (typeof p.polishAdopted === 'string') ? p.polishAdopted : undefined;
  state.polishHistory = Array.isArray(p.polishHistory) ? p.polishHistory : undefined;   // v10.16 优化构想批量版本
  state.autoQC = (typeof p.autoQC === 'boolean') ? p.autoQC : false;   // 自动质检默认关闭（v10.18）
  state.chapters = p.chapters || [];
  state.characters = p.characters || [];
  state.outlineHistory = Array.isArray(p.outlineHistory) ? p.outlineHistory : [];
  state.expSel = Array.isArray(p.expSel) ? p.expSel.filter(i=> Number.isInteger(i)) : [];
  state.hist = (p.hist && typeof p.hist === 'object') ? {
    characters: Array.isArray(p.hist.characters)?p.hist.characters:[],
    scenes: Array.isArray(p.hist.scenes)?p.hist.scenes:[],
    cover: Array.isArray(p.hist.cover)?p.hist.cover:[],
    storyboard: Array.isArray(p.hist.storyboard)?p.hist.storyboard:[]
  } : { characters:[], scenes:[], cover:[], storyboard:[] };
  state.chapterStyle = (p.chapterStyle && typeof p.chapterStyle === 'object')
    ? { tags: Array.isArray(p.chapterStyle.tags)?p.chapterStyle.tags:[], intensity: (p.chapterStyle.intensity===1||p.chapterStyle.intensity===3)?p.chapterStyle.intensity:2, collapsed: !!p.chapterStyle.collapsed, elemOpen: p.chapterStyle.elemOpen === true }
    : { tags: [], intensity: 2, collapsed: false, elemOpen: false };
  wsDraft = null;   // v2.1 切作品后草稿重置（以新作品的生效配置为起点）
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
  state.recipeSet = { structure:null, rhythm:null, quality:[], titleStyle:[] };
  state.wordRange = null; state.chapterRange = null; state.totalWords = null; state.chapterCount = null;
  state.idea = ''; state.outline = null; state.coverPrompt = ''; state.coverWithTitle = false; state.outlineConfirmed = false;
  state.pendingGlossary = null; state.glossAdherence = 60; state.glossAllowFill = false; state.glossAutoFill = true; state.gsCollapsed = true;
  state.autoQC = false;  // 自动质检默认关闭（v10.18）
  state.chapters = []; state.characters = []; state.scenes = []; state.storyboard = []; state.boardConcepts = []; state.titleHistory = []; state.raw = {};
  state.outlineHistory = []; state.expSel = [];
  state.hist = { characters:[], scenes:[], cover:[], storyboard:[] };
  state.chapterStyle = { tags: [], intensity: 2, collapsed: false, elemOpen: false };
  wsDraft = null;   // v2.1 新项目草稿重置
  currentStep = 1;
}
// 兼容旧版单一范式 → 三维 recipeSet
function migrateRecipeSet(set, legacyRecipe){
  // 新格式三维：set 存在即按新格式处理（structure/rhythm 为 null 也是合法新格式值，表示未选）
  if(set && typeof set === 'object'){
    return {
      structure: (typeof set.structure === 'string' && STRUCTURE_IDS.includes(set.structure)) ? set.structure : null,
      rhythm: (typeof set.rhythm === 'string' && RHYTHM_IDS.includes(set.rhythm)) ? set.rhythm : null,
      quality: Array.isArray(set.quality) ? set.quality.filter(q=> QUALITY_IDS.includes(q)) : [],
      titleStyle: Array.isArray(set.titleStyle) ? set.titleStyle.filter(id=> TITLE_STYLE_IDS.includes(id)) : []
    };
  }
  // 旧 recipe 单一 id 迁移映射
  const legacyMap = { mesh:{structure:'mesh',rhythm:null,quality:[]}, layered:{structure:'layered',rhythm:null,quality:[]}, dual:{structure:'mesh',rhythm:null,quality:['dual']}, web:{structure:null,rhythm:'web',quality:[]}, web100:{structure:null,rhythm:'web',quality:[]}, causal:{structure:'causal',rhythm:null,quality:[]} };
  return legacyMap[legacyRecipe] || { structure:null, rhythm:null, quality:[] };
}
// 落盘：优先写 IndexedDB（突破 5MB）；IDB 不可用或写入失败时回退 localStorage 双写，保证不丢。
// 注意：保持内存模型 lib 不变，仅替换"落盘通道"。调用方（persist/开关项目/新建/删除）无需改动。
function idbSaveLib(){
  if(!idbAvailable()){
    // IDB 不可用：直接写回 localStorage 旧库路径（仅作回退，避免数据丢失）
    try{ localStorage.setItem(KEY_LIB, JSON.stringify(lib)); }catch(e){}
    return;
  }
  idbPutAll(lib.items, lib.curId).catch(function(){
    // IDB 写入失败：回退 localStorage，保证本次改动不丢
    try{ localStorage.setItem(KEY_LIB, JSON.stringify(lib)); }catch(e2){}
  });
}
function saveLib(){
  idbSaveLib();   // 原同步落盘改为异步走 IDB（fire-and-forget）
}
function robustSaveLib(){
  // 超过上限则淘汰最旧非当前项目（保持内存模型整洁，并清理 IDB 中孤儿记录）
  while(lib.items.length > MAX_PROJECTS){
    const others = lib.items.filter(i=> i.id !== lib.curId);
    if(!others.length) break;
    others.sort((a,b)=> (a.updatedAt||0) - (b.updatedAt||0));
    const victim = others[0];
    lib.items = lib.items.filter(i=> i.id !== victim.id);
    idbDelete(victim.id).catch(function(){}); // 清理 IDB 孤儿，避免重复
  }
  idbSaveLib();
}
// 把现有 localStorage 旧库一次性灌入 IDB（双写一版，不删 localStorage 旧数据，零丢失）
function idbMigrateFromLib(libObj){
  if(!idbAvailable()) return;
  idbPutAll(libObj.items, libObj.curId).catch(function(){});
}
// 首次加载（异步）：优先读 IndexedDB 全量项目；IDB 为空/不可用→回退旧 localStorage fyp_lib（双写迁移进 IDB）；再无→迁移旧单项目 fyp_state
async function loadState(){
  clearState();
  // 1) 优先读 IndexedDB
  try{
    if(idbAvailable()){
      const items = await idbList();
      if(items && items.length){
        const curId = (await idbGetMeta()) || (items[0] && items[0].id);
        lib = { curId: curId, items: items };
        // 保持 curId 有效
        if(!lib.items.some(i=> i.id === lib.curId)) lib.curId = lib.items[0] && lib.items[0].id;
        if(lib.curId){ const cur = lib.items.find(i=> i.id === lib.curId); if(cur) applyProject(cur); }
        return;
      }
    }
  }catch(e){ /* IDB 读取失败，继续回退 localStorage */ }
  // 2) IDB 空或不可用：回退旧 localStorage fyp_lib（并双写迁移进 IDB，不删旧数据）
  try{
    const raw = localStorage.getItem(KEY_LIB);
    if(raw){
      const parsed = JSON.parse(raw);
      if(parsed && Array.isArray(parsed.items)){
        lib = parsed;
        if(!lib.items.some(i=> i.id === lib.curId)) lib.curId = lib.items[0] && lib.items[0].id;
        if(lib.curId){ const cur = lib.items.find(i=> i.id === lib.curId); if(cur) applyProject(cur); }
        idbMigrateFromLib(lib); // 双写进 IDB（fire-and-forget），旧 localStorage 保留作回退
        return;
      }
    }
  }catch(e){}
  // 3) 无新库：尝试迁移旧版单项目 fyp_state
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

/* ---------- AI 请求（浏览器直连 OpenAI 兼容协议，支持流式） ---------- */
// 来源唯一：仅使用 cfg.active 指向的 (组/账号/模型)，绝不并发多模型。
// onStream(deltaText)：提供时开启流式（stream:true），每收到一段增量就回调用；不传则一次性返回全文。
// 函数名沿用 callDeepSeek；内部为通用 OpenAI 兼容协议，非 DeepSeek 型号也照常调用。

/* ---------- P2-1 AI 请求/响应日志（最近50条，只存本机，可一键清空） ---------- */
const KEY_AILOG = 'fyp_ailog';
let aiLog = [];   // [{ts, task, temp, sys, user, resp, ms, ok, err}]
(function loadAiLog(){ try{ aiLog = JSON.parse(localStorage.getItem(KEY_AILOG)) || []; }catch(e){ aiLog = []; } })();
function aiLogPush(rec){
  aiLog.push(rec);
  if(aiLog.length > 50) aiLog.splice(0, aiLog.length - 50);
  try{ localStorage.setItem(KEY_AILOG, JSON.stringify(aiLog)); }catch(e){ /* 存储满则仅内存保留 */ }
}
function aiLogClear(){ aiLog = []; try{ localStorage.removeItem(KEY_AILOG); }catch(e){} }
// 请求日志弹窗：列表（时间/任务/温度/耗时/成败）+ 展开看 prompt/响应前500字 + 一键清空
function openAiLogPanel(){
  closeAiLogPanel();
  const fmtTs = ts=>{ const d=new Date(ts); return (d.getMonth()+1)+'-'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0'); };
  const rows = aiLog.length ? [...aiLog].reverse().map((r,ri)=>{
    const task = String(r.task||'').slice(0,40);
    return `<div class="ailog-row">
      <div class="ailog-head">
        <span class="ailog-time">${fmtTs(r.ts)}</span>
        <span class="ailog-task">${esc(task||'（无任务名）')}</span>
        <span class="ailog-meta">${r.temp!=null?('🌡 '+r.temp):''} · ${r.ms!=null?(r.ms+'ms'):''} · <b class="${r.ok?'ok':'err'}">${r.ok?'✓':'✗'}</b></span>
        <button type="button" class="btn small ghost" data-ailog-toggle="${ri}">展开</button>
      </div>
      <div class="ailog-body hidden" data-ailog-body="${ri}">
        ${r.err?`<div class="ailog-sec"><b>错误：</b><span class="err">${esc(r.err)}</span></div>`:''}
        <div class="ailog-sec"><b>System · 前500字 / 共 ${(r.sysLen||r.sys.length).toLocaleString('en-US')} 字：</b><div class="ailog-pre">${esc(String(r.sys||''))}</div></div>
        <div class="ailog-sec"><b>User · 前500字 / 共 ${(r.userLen||r.user.length).toLocaleString('en-US')} 字：</b><div class="ailog-pre">${esc(String(r.user||''))}</div></div>
        <div class="ailog-sec"><b>响应 · 前500字 / 共 ${(r.respLen||0).toLocaleString('en-US')} 字：</b><div class="ailog-pre">${esc(String(r.resp||''))}</div></div>
        <p class="muted" style="font-size:11px">500 字仅为日志预览上限，实际发送/接收为全量，不影响请求。</p>
      </div>
    </div>`;
  }).join('') : '<p class="muted">暂无请求记录。每次调用 AI 都会记录（最近 50 条，仅存本机）。</p>';
  const ov = document.createElement('div'); ov.id='ailogPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>🗒️ AI 请求日志（${aiLog.length}/50）</b>
        <span style="display:flex;gap:6px">
          <button class="btn small ghost" data-ailog-clear>🗑 清空</button>
          <button class="gs-x" data-ailog-close>✕</button>
        </span></div>
      <div class="cv-body">
        <div class="cv-div">排查「AI 为什么写偏/漏设定」、复现 bug 的唯一证据；只存本机，可一键清空。</div>
        ${rows}
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-ailog-close]').onclick = closeAiLogPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeAiLogPanel(); });
  ov.addEventListener('click', e=>{
    const b = e.target.closest('[data-ailog-toggle]'); if(!b) return;
    const body = ov.querySelector('[data-ailog-body="'+b.dataset.ailogToggle+'"]');
    if(body) body.classList.toggle('hidden');
  });
  ov.querySelector('[data-ailog-clear]').onclick = ()=>{
    if(!window.confirm('清空全部 AI 请求日志？')) return;
    aiLogClear(); closeAiLogPanel(); toast('请求日志已清空');
  };
}
function closeAiLogPanel(){ const p=$('#ailogPanel'); if(p) p.remove(); }

async function callDeepSeek(system, user, {temperature=null, signal=null, maxTokens=null, onStream=null}={}){
  const _t0 = Date.now();
  // P2-1 记录基础信息（task 用 system 前 24 字近似任务名；具体字段在成功/失败收尾时补全）
  // v2.4 记录实际完整长度 sysLen/userLen/respLen，日志展示"前500字/共N字"消除误解
  const _rec = {
    ts: _t0,
    task: String(system||'').replace(/\s+/g,' ').slice(0,24),
    temp: (temperature==null ? null : temperature),
    sys: String(system||'').slice(0,500),
    user: String(user||'').slice(0,500),
    sysLen: String(system||'').length,
    userLen: String(user||'').length,
    respLen: 0,
    resp: '', ms: null, ok: false, err: ''
  };
  try{
    const s = resolveActiveSpec();
    if(!s.apiKey) throw new Error('请先在 ⚙️ 配置并选择要使用的 AI 账号（API Key）');
    const url = s.baseUrl + '/chat/completions';
    const streaming = typeof onStream === 'function';
    const body = {
      model: s.model,
      messages: [{role:'system', content: system}, {role:'user', content: user}],
      temperature: (temperature==null ? s.temperature : temperature),
      stream: streaming
    };
    // 缓存友好：请求的前缀（system + user 恒定首部）在全书各章保持不变，
    // DeepSeek 自动命中上下文缓存，命中价远低于未命中价；可变信息一律放 user 最末。
    if(maxTokens && maxTokens>0) body.max_tokens = maxTokens;
    let res;
    try{
      res = await fetch(url, {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+s.apiKey},
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
      const out = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      _rec.resp = String(out).slice(0,500); _rec.respLen = String(out).length; _rec.ms = Date.now()-_t0; _rec.ok = true;
      aiLogPush(_rec);
      return out;
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
    _rec.resp = String(full).slice(0,500); _rec.respLen = String(full).length; _rec.ms = Date.now()-_t0; _rec.ok = true;
    aiLogPush(_rec);
    return full;
  }catch(e){
    _rec.ms = Date.now()-_t0; _rec.ok = false; _rec.err = String(e.message||e).slice(0,200);
    aiLogPush(_rec);
    throw e;
  }
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

/* ---------- 全局中止控制器（流式停止按钮用） ---------- */
let _abortCtl = null;           // 当前 AbortController
let _abortBtn = null;           // 当前可见的停止按钮 DOM
// 创建一个停止按钮
function makeStopBtn(){
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'stop-btn'; b.innerHTML = '⏹ 停止';
  b.onclick = ()=>{
    if(_abortCtl){ _abortCtl.abort(); _abortCtl = null; }
    hideStopBtn();
  };
  b.style.display = 'none';
  return b;
}
// 显示停止按钮，挂载到父容器
function showStopBtn(parent){
  if(!_abortBtn){ _abortBtn = makeStopBtn(); document.body.appendChild(_abortBtn); }
  _abortCtl = new AbortController();
  _abortBtn.style.display = '';
  parent.appendChild(_abortBtn);
}
// 隐藏停止按钮
function hideStopBtn(){
  if(_abortBtn){ _abortBtn.style.display = 'none'; }
  _abortCtl = null;
}

/* =========================================================
 * 提示词模板（中文，面向国内 + 即梦）
 * ========================================================= */
/* 主线条四格 JSON 片段（主线必有、副暗汇合有则带、无则空、绝不硬造）。
 * 集中定义为常量，供 6 个结构范式的内联 outlineSys 引用，使「选中结构」时 structure 的 schema
 * 完全由 st.outlineSys 一处描述，消除此前 STRUCTURE_MAIN_SYS 与 st.outlineSys 各写一遍 mainLine/subLines/hiddenLine/pivotPlan
 * 的重复描述（S1）。未选中结构时改由 STRUCTURE_MAIN_SYS 兜底提供这份主线条骨架。 */
const MAIN_LINE_BLOCK = `"mainLine":"全书唯一主线/核心走向（必有：这本到底讲什么）",
  "subLines":["副线1：内容","副线2：内容"],  // 有则带；若故事确实没有副线就空数组或省略，绝不硬造
  "hiddenLine":"暗线内容（如何埋设、何时揭晓）",  // 有则带；若没有暗线就空字符串或省略，绝不硬造
  "pivotPlan":"汇合/大逆转所在章（点式，如 第20章三方对峙）"  // 有则带；无则该字段省略`;

// v10.9 公共 JSON 契约句：longOutlineSys / OUTLINE_GEN_SYS / 各结构 outlineSys 复用，避免双处漂移
const JSON_HEADER = `请按如下 JSON 结构输出（不要任何解释、不要 markdown 代码块；可在此基础上按下方追加块补充 glossary、structure 等其它顶层字段）：`;

const PROMPTS = {
  outlineSys: `你是一位专业编剧与故事架构师，擅长短剧/短视频叙事。根据用户的一句或几句话构想，设计一部适合改编为短视频的故事。
请严格只输出如下 JSON（不要任何解释、不要 markdown 代码块）：
{"title":"故事标题","logline":"一句话梗概（含核心冲突）","chapters":[{"title":"第1章标题","summary":"该章核心事件与转折，1-2句"}]}
要求：chapters 数量按故事体量在 6-12 章之间；summay 体现人物动机与情节推进。`,

  chapterSys: `你是一位擅长网文与短剧的编剧。请根据「故事大纲」与「本章概要」写出本章完整正文。
要求：有强画面感、对话自然、节奏明快、推进剧情；篇幅 800-1500 字；只输出正文，不要标题、不要解释。`,

  characterSys: `你是一位影视角色设定师。根据完整故事，提取主要角色（3-6 个，含主角与关键配角），为每个角色产出「影视前期定妆提示词包」，用于用户粘贴到「即梦(Dreamina)」生成角色参考图。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"characters":[{"name":"角色名","role":"身份/作用","profile":{"年龄":"","性别":"","身份":"","性格":"","外貌":"脸型/发型/瞳色/身形等","常服与配色":"","标志性道具":"","材质质感":""},
"prompts":{"定妆图":"全身定妆图提示词，需固化固定外貌特征以保证后续垫图一致性","三视图":"正面/侧面/背面描述","表情":"喜/怒/哀/惊等表情参考","服饰细节":"衣物纹样与剪裁放大","道具":"武器/饰品/随身物","配色":"主色/辅色/点缀色色板","材质":"布料/金属/皮革等质感"}}]}
要求：所有 prompts 为中文、具体、可直接粘贴即梦；『定妆图』要写清不变的身份特征；风格统一。`,

  sceneSys: `你是一位影视场景设定师。根据故事与角色，提取关键场景（4-8 个），产出即梦出图提示词。
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

  longOutlineSys: `你是一位能驾驭超长篇的小说架构师。
【核心任务】根据用户的一句话或几句构想，设计一部经典的【长篇小说】骨架：全书主线走向、结构安排与逐章标题。不要用三幕流水的短剧套路来搭长篇，要用真正的长篇小说结构美学来设计。
${JSON_HEADER}
{"title":"小说名","logline":"一句话梗概（含核心冲突与深层命题）","structure":{ ${MAIN_LINE_BLOCK} },"chapters":[{"title":"第1章标题"}]}
【硬性约束】
1. structure 字段按上方 JSON 内联定义主线条四格（mainLine 必有；副/暗/汇合有则带、无则空，绝不硬造）；chapterPlan（全部章节按线索分组）由下方【长篇结构设计 · 章节计划】块补充，一章不落。
2. **chapters 只需逐章列出标题，禁止输出任何逐章梗概、内容预告、章末钩子或阶段目标**——每章的正文与梗概在写正文阶段独立生成，不在大纲阶段预写。
【自由发挥区】在满足以上约束的前提下，章节标题的立意、措辞、节奏走向由你自由构思。
`,

  longChapterSys: `你是一位严格遵循既定大纲的章节执行写手。
【核心任务】你的职责不是规划全书，而是在给定的【整体结构】【本章标题】【前文真实正文】与【设定词典】框架内，扩写出本章完整正文，做到承接前文、服务整体、不越界发散。
【硬性约束】
1. 严格承接上一章真实正文推进本章，绝不悬空发散；保持人物/伏笔/时间线/专名的连续性（以【设定词典】为准，禁止自造新名）。
2. 只输出正文，不要标题、不要"本章完/未完待续"之类片尾标注、不要任何解释。
【自由发挥区】在满足以上约束的前提下，你可自由发挥：细腻的环境与心理描写、生动对话、符合人物弧光；节奏张弛有度（本章若是情绪高潮或转折则加压，若是过渡则蓄力）。`,

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

// v10.13 优化构想：调用 IDEA_POLISH_SYS 把粗糙构想优化为结构化高质量版本。
// 极短输入（<15 字）由 AI 走「骨架展开模式」且强制多方案；空输入禁用。
// 多方案模式（polishMulti 开）：AI 返回 JSON（advice + options[]），Tab 切换查看/编辑。
let polishMulti = false;   // 多方案开关（内存态，不持久化；极短构想强制 true）

// v10.16 多方案留存：采用后不销毁方案（state.polishOptions/polishAdopted 随快照持久化），
// 提示条提供「查看全部（零请求）/ 重新优化（force）/ 清除」；再次优化需 confirm 防误发请求。
async function polishIdea(btn, force){
  const idea = (state.idea || '').trim();
  if(!idea){ toast('请先输入故事构想'); return; }
  const kept = Array.isArray(state.polishOptions) && state.polishOptions.length;
  if(kept && !force){
    if(!confirm(`已有 ${kept} 个保留方案，重新优化将覆盖它们。继续？`)) return;
  }
  const multi = polishMulti || idea.length < 15;   // 极短强制多方案
  if(btn) busy(btn,true, multi ? '生成多方案构想中…' : '优化构想中…');
  try{
    const sys = IDEA_POLISH_SYS + (multi ? POLISH_MULTI_MODE : POLISH_SINGLE_MODE);
    const txt = await callDeepSeek(sys, idea, {temperature: resolveActiveSpec().ideaTemp});
    const out = String(txt||'').trim();
    if(!out){ toast('优化失败，请重试'); return; }
    showPolishResult(out, multi);
    toast(multi ? '已生成多方案，可切换查看' : '优化完成，可编辑后采用');
  }catch(e){ toast('优化失败：'+e.message); }
  finally{ if(btn) busy(btn,false); }
}

// 展示优化结果：多方案（JSON）→ advice + Tab 切换；单稿（文本）→ 按 💡 行拆分 advice
function showPolishResult(out, multi){
  const box = $('#polishBox'), ta = $('#polishText'), adv = $('#polishAdvice'), tabs = $('#polishTabs');
  if(!box || !ta) return;
  box.style.display = 'block';
  let advice = '';
  if(multi){
    const j = parseJson(out) || {};
    const opts = Array.isArray(j.options) ? j.options.filter(o=>o && String(o.text||'').trim()) : [];
    advice = String(j.advice || '');
    if(opts.length){
      snapshotPolishBatch('重新优化前');   // 覆盖前把旧整批方案归档为可回退版本（≤5）
      state.polishOptions = opts;
      state.polishAdopted = null;   // 新方案列表，尚未采用
      persist();
      renderPolishTabs(tabs, ta, adv, advice);
      ta.value = opts[0].text;
      return;
    }
    // JSON 解析失败降级：整体当文本
    ta.value = out;
    if(adv) adv.style.display = 'none';
    if(tabs) tabs.style.display = 'none';
    return;
  }
  // 单稿：按「💡 AI 编辑意见」行拆分
  const m = out.match(/(^|\n)\s*💡\s*AI 编辑意见\s*[:：]?\s*/);
  if(m){
    ta.value = out.slice(0, m.index).trim();
    advice = out.slice(m.index + m[0].length).trim();
  }else{
    ta.value = out;
  }
  if(adv){
    if(advice){ adv.style.display = 'block'; adv.textContent = '💡 AI 编辑意见：'+advice; }
    else adv.style.display = 'none';
  }
  if(tabs) tabs.style.display = 'none';
}

// v10.16 用缓存方案重新展开优化区（零请求）：Tab + advice + 当前采用的方案
function openPolishBox(){
  const box = $('#polishBox'), ta = $('#polishText'), adv = $('#polishAdvice'), tabs = $('#polishTabs');
  const opts = Array.isArray(state.polishOptions) ? state.polishOptions : [];
  if(!box || !ta || !opts.length) return;
  box.style.display = 'block';
  const adoptedIdx = Math.max(0, opts.findIndex(o=> o.name===state.polishAdopted));
  renderPolishTabs(tabs, ta, adv, '');
  const cur = opts[adoptedIdx] || opts[0];
  ta.value = cur ? cur.text : '';
  const tabsArr = tabs ? [...tabs.querySelectorAll('.pol-tab')] : [];
  if(tabsArr[adoptedIdx]){ tabsArr.forEach(x=>x.classList.remove('active')); tabsArr[adoptedIdx].classList.add('active'); }
}

// 多方案 Tab 渲染：固定短标签「方案A/B/C…」（杜绝省略号），完整方向名放 title 悬浮；点击切换 textarea 内容
function renderPolishTabs(tabs, ta, adv, advice){
  if(!tabs) return;
  const LETTERS = ['A','B','C','D','E'];
  tabs.style.display = 'flex';
  tabs.innerHTML = (state.polishOptions||[]).map((o,i)=>
    `<button class="pol-tab${i===0?' active':''}" data-pol-tab="${i}" title="${esc(o.name||('方案'+(LETTERS[i]||(i+1))))}">${'方案'+(LETTERS[i]||(i+1))}</button>`
  ).join('');
  [...tabs.querySelectorAll('[data-pol-tab]')].forEach(b=>{
    b.onclick = ()=>{
      const o = (state.polishOptions||[])[+b.dataset.polTab]; if(!o) return;
      if(ta) ta.value = o.text;
      tabs.querySelectorAll('.pol-tab').forEach(x=> x.classList.toggle('active', x===b));
    };
  });
  if(adv){
    if(advice){ adv.style.display = 'block'; adv.textContent = '💡 AI 编辑意见：'+advice; }
    else adv.style.display = 'none';
  }
}

// v10.13/v10.16 优化区绑定：复制 / 采用此方案（可反复切换）/ 收起 / 多方案开关 / 提示条
function bindPolishIdea(){
  const b = $('#btnPolishIdea');
  if(b) b.onclick = ()=> polishIdea(b);
  const chk = $('#chkPolishMulti');
  if(chk){
    const sync = ()=>{
      const short = (state.idea||'').trim().length < 15;
      chk.checked = polishMulti || short;
      chk.disabled = short;
    };
    sync();
    chk.onchange = ()=>{ polishMulti = chk.checked; };
    const idea = $('#ideaInput');
    if(idea) idea.oninput = ()=>{ state.idea = idea.value; sync(); };
  }
  const cp = $('#btnPolishCopy');
  if(cp) cp.onclick = ()=>{
    const ta = $('#polishText');
    if(ta && ta.value.trim()) copyText(ta.value);
    else toast('优化区为空');
  };
  // P3-2 保存此版为方案：把当前 textarea 内容存为新方案（原方案保留），刷新 Tab 并激活
  const save = $('#btnPolishSave');
  if(save) save.onclick = ()=>{
    const ta = $('#polishText');
    if(!ta || !ta.value.trim()){ toast('优化区为空'); return; }
    if(!Array.isArray(state.polishOptions)) state.polishOptions = [];
    const LETTERS = ['A','B','C','D','E'];
    const name = '方案'+(LETTERS[state.polishOptions.length]||(state.polishOptions.length+1))+' · 手动保存';
    state.polishOptions.push({ name, text: ta.value });
    state.polishAdopted = null;
    persist();
    const tabs = $('#polishTabs'), adv = $('#polishAdvice');
    renderPolishTabs(tabs, ta, adv, '');
    // 激活最后新增的方案 Tab
    const tabsArr = tabs ? [...tabs.querySelectorAll('.pol-tab')] : [];
    if(tabsArr.length){ tabsArr.forEach(x=>x.classList.remove('active')); tabsArr[tabsArr.length-1].classList.add('active'); }
    toast('已保存为新方案：'+name);
  };
  // v10.16 采用此方案：更新构想 + 记录采用名 + persist + render（方案保留，提示条更新）
  const use = $('#btnPolishUse');
  if(use) use.onclick = ()=>{
    const ta = $('#polishText');
    if(!ta){ toast('优化区为空'); return; }
    const v = ta.value.trim();
    if(!v){ toast('优化区为空'); return; }
    state.idea = v;
    const act = tabsActiveName();
    if(act) state.polishAdopted = act;
    persist(); render();
    toast(act ? '已采用：'+act : '已采用优化后的构想');
  };
  // v10.16 收起：仅隐藏优化区（方案保留，提示条仍在）
  const disc = $('#btnPolishDiscard');
  if(disc) disc.onclick = ()=>{
    const box = $('#polishBox');
    if(box) box.style.display = 'none';
  };
  // v10.16 提示条按钮：优化版本 / 查看全部 / 重新优化 / 清除
  const hist = $('[data-pol-keep-hist]');
  if(hist) hist.onclick = (e)=>{ e.stopPropagation(); openPolishBatchPanel(); };
  const view = $('[data-pol-keep-view]');
  if(view) view.onclick = (e)=>{ e.stopPropagation(); openPolishBox(); };
  const again = $('[data-pol-keep-again]');
  if(again) again.onclick = (e)=>{ e.stopPropagation(); polishIdea($('#btnPolishIdea'), true); };
  const clear = $('[data-pol-keep-clear]');
  if(clear) clear.onclick = (e)=>{
    e.stopPropagation();
    if(!confirm('清除全部保留方案？')) return;
    snapshotPolishBatch('清除前');   // 归档当前批，之后仍可在「优化版本」找回
    delete state.polishOptions;
    delete state.polishAdopted;
    persist(); render();
    toast('已清除保留方案');
  };
}
// 当前激活 Tab 对应的方案名（采用时记录）
function tabsActiveName(){
  const tabs = $('#polishTabs'); if(!tabs) return '';
  const act = tabs.querySelector('.pol-tab.active');
  const idx = act ? +act.dataset.polTab : -1;
  const o = (state.polishOptions||[])[idx];
  return o ? (o.name||'') : '';
}

// v10.16 方案提示条：采用后保留方案的可视入口（查看全部零请求 / 重新优化 / 清除）
function polishKeepBar(){
  const opts = Array.isArray(state.polishOptions) ? state.polishOptions : [];
  if(!opts.length) return '';
  const cur = state.polishAdopted || opts[0].name || '方案A';
  return `<div class="pol-keep">
    <span class="pol-keep-t">已保留 ${opts.length} 个优化方案（当前采用：${esc(cur)}）</span>
    <span class="pol-keep-btns">
      ${(state.polishHistory&&state.polishHistory.length)?`<button type="button" class="btn small ghost" data-pol-keep-hist>📚 优化版本(${state.polishHistory.length}/5)</button>`:''}
      <button type="button" class="btn small ghost" data-pol-keep-view>🔍 查看全部</button>
      <button type="button" class="btn small ghost" data-pol-keep-again>✨ 重新优化</button>
      <button type="button" class="btn small ghost" data-pol-keep-clear>✕ 清除</button>
    </span>
  </div>`;
}

/* ---------- v10.16 优化构想·批量版本（整批快照 ≤5 份，应用后生效） ---------- */
function polishHistory(){ return Array.isArray(state.polishHistory) ? state.polishHistory : []; }
// 把「当前全部保留方案」整批压入版本栈（最新在前、去重、上限5）；无方案则跳过
function snapshotPolishBatch(label){
  const opts = Array.isArray(state.polishOptions) ? state.polishOptions : [];
  if(!opts.length) return;
  const snap = { options: opts.map(o=>({ name:o.name, text:String(o.text||'') })), adopted: state.polishAdopted||null };
  const hist = state.polishHistory = state.polishHistory || [];
  if(hist.length &&
      JSON.stringify(hist[0].options) === JSON.stringify(snap.options) &&
      hist[0].adopted === snap.adopted) return;
  hist.unshift({ ts: Date.now(), label: label||'快照', options: snap.options, adopted: snap.adopted });
  if(hist.length > 5) hist.length = 5;
  persist();
}
// 整批应用某版：先把当前态归档（保留再回退机会），再覆盖当前保留方案
function applyPolishBatch(idx){
  const hist = polishHistory(); const b = hist[idx]; if(!b || !Array.isArray(b.options) || !b.options.length) return;
  if(!confirm(`整批应用「${idx+1}. ${b.label||'优化版本'}」（共 ${b.options.length} 个方案）？将覆盖当前保留的方案。`)) return;
  snapshotPolishBatch('切换前');
  state.polishOptions = b.options.map(o=>({ name:o.name, text:String(o.text||'') }));
  state.polishAdopted = (b.adopted && b.options.some(o=>o.name===b.adopted)) ? b.adopted : null;
  persist(); closePolishBatchPanel(); render();
  const box = $('#polishBox'); if(box){ box.style.display='block'; openPolishBox(); }
  toast(`已整批应用该优化版本（${state.polishOptions.length} 个方案）`);
}
function deletePolishBatch(idx){
  const hist = polishHistory(); if(!hist.length) return;
  hist.splice(idx,1);
  if(!hist.length) delete state.polishHistory; else state.polishHistory = hist;
  persist(); closePolishBatchPanel(); openPolishBatchPanel();
  toast('已删除该版本');
}
function openPolishBatchPanel(){
  closePolishBatchPanel();
  const hist = polishHistory(); if(!hist.length){ toast('暂无历史优化版本，运行「✨ 优化构想」后自动记录'); return; }
  const fmtTs = ts=>{ const d=new Date(ts); return (d.getMonth()+1)+'-'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
  const rows = hist.map((b,idx)=>`
    <div class="cv-row">
      <div class="cv-meta" style="flex:1;min-width:0">
        <div class="cv-time">${idx+1}. ${esc(b.label||'优化版本')} · ${fmtTs(b.ts)} · ${(b.options||[]).length} 方案</div>
        <div class="cv-t" style="font-size:12px;color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((b.options||[]).slice(0,3).map(o=>o.name).join(' / '))||'（空）'}</div>
      </div>
      <div class="cv-actions" style="display:flex;gap:6px;flex-shrink:0">
        <button type="button" class="btn ghost cv-b" data-polb-view="${idx}">👁 切换</button>
        <button type="button" class="btn primary cv-b" data-polb-apply="${idx}">应用</button>
        <button type="button" class="btn ghost cv-b" data-polb-del="${idx}">🗑</button>
      </div>
    </div>`).join('');
  const ov = document.createElement('div'); ov.id='polbPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>💾 优化构想 · 批量版本（${hist.length}/5）</b>
        <button class="gs-x" data-polb-close>✕</button></div>
      <div class="cv-body">
        <div class="cv-div">每次「✨ 优化构想」改动前后会把整批方案各归档一份（≤5 份可回退）；「👁 切换」只预览不生效，点「应用」后才覆盖当前保留方案。</div>
        ${rows}
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-polb-close]').onclick = closePolishBatchPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closePolishBatchPanel(); });
  ov.querySelectorAll('[data-polb-view]').forEach(b=> b.onclick = ()=> openPolishBatchPreview(+b.dataset.polbView));
  ov.querySelectorAll('[data-polb-apply]').forEach(b=> b.onclick = ()=> applyPolishBatch(+b.dataset.polbApply));
  ov.querySelectorAll('[data-polb-del]').forEach(b=> b.onclick = ()=> deletePolishBatch(+b.dataset.polbDel));
}
function closePolishBatchPanel(){ const p=$('#polbPanel'); if(p) p.remove(); }
// 单版整批方案的切换预览（不生效）；点「应用此版本」才真正覆盖
function openPolishBatchPreview(idx){
  closePolishBatchPreview();
  const hist = polishHistory(); const b = hist[idx]; if(!b) return;
  const fmtTs = ts=>{ const d=new Date(ts); return (d.getMonth()+1)+'-'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
  const list = (b.options||[]).map(o=>`<div class="cv-row"><div class="cv-t" style="font-size:12px"><b>${esc(o.name||'')}</b><br>${esc(String(o.text||'').slice(0,120))}${(o.text||'').length>120?'…':''}</div></div>`).join('') || '<p class="muted">（空批）</p>';
  const ov = document.createElement('div'); ov.id='polbPreview'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>👁 优化版本切换 · ${esc(b.label||'优化版本')}（${fmtTs(b.ts)} · ${(b.options||[]).length} 方案）</b>
        <button class="gs-x" data-polbp-close>✕</button></div>
      <div class="cv-body"><div style="max-height:60vh;overflow:auto">${list}</div></div>
      <div class="modal-actions" style="padding:12px 16px;border-top:1px solid var(--line)">
        <button type="button" class="btn ghost cv-b" data-polbp-close2>取消</button>
        <button type="button" class="btn primary cv-b" data-polbp-apply>✔ 应用此版本</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-polbp-close]').onclick = closePolishBatchPreview;
  ov.querySelector('[data-polbp-close2]').onclick = closePolishBatchPreview;
  ov.addEventListener('click', e=>{ if(e.target===ov) closePolishBatchPreview(); });
  ov.querySelector('[data-polbp-apply]').onclick = ()=> applyPolishBatch(idx);
}
function closePolishBatchPreview(){ const p=$('#polbPreview'); if(p) p.remove(); }


const STRUCTURES = [
  { id:'mesh', name:'多线网状交织', tag:'大师结构', short:'网状多线', src:'经典 · 网文 / 《红楼梦》体系',
    outlineSys: PROMPTS.longOutlineSys,
    chapterSys: PROMPTS.longChapterSys,
    desc:'借鉴《红楼梦》式网状多线：多条主线 + 副线 + 暗线同时推进并在汇合章收束，暗线早期埋设、结局揭晓。',
    mech:'默认优先采用多线交织或网状结构，补齐 ≥3 条叙事线索并做“三定”（定时间轴/定汇合点/定主次）；暗线从早期埋设直到结局呼应。',
    fit:'宏大世界观、群像、多势力角力的长篇；人物关系网复杂、多条伏笔同时推进的作品。',
    effect:'信息密度高、可读性强，是大师级长篇常用骨架；代价是需要强的一致性自检，否则易散架、坑填不完。' },
  { id:'causal', name:'单线因果式', tag:'经典打怪', short:'单线因果', src:'经典 · 取经路结构',
    outlineSys: `你是深谙「单线因果式」经典结构的小说架构师。根据用户构想设计一部长篇小说。
${JSON_HEADER}
{"title":"小说名","logline":"一句话梗概","structure":{ ${MAIN_LINE_BLOCK} },"chapters":[{"title":"章标题"}]}
要求：遵循「单线因果式」经典结构（如《西游记》取经路）——一根主线贯穿始终，"因为所以"一环扣一环，打完一关进入下一关，前因后果清晰、易读性强；主线明确推进、尽量不铺开多线；章章之间有明确因果链，前一章结果成为后一章起因；整体呈引入→闯关/成长→高潮→收束的清晰线路；**chapters 只需逐章列出标题，禁止输出任何逐章梗概、内容预告或章末钩子**——每章正文与梗概将在写正文阶段独立生成。structure 中的 chapterPlan（全部章节按关卡分组的写作安排）由下方【长篇结构设计 · 章节计划】块补充，一章不落。`,
    chapterSys: `你是严格遵循既定大纲的章节执行写手。根据本章标题、前文承接与结构定位写出本章完整正文，做到因果衔接、章章推进。
要求：遵循"因为所以"的单线因果推进——承接上一章的结果，作为本章起因，本章结束又为下一章留下因果衔接；主线单一清晰、少插枝节；有细腻的环境与心理描写、生动对话、鲜明的人物弧光与成长；节奏张弛有度；只输出正文，不要标题、不要"本章完/未完待续"标注、不要任何解释。`,
    desc:'经典「单线因果式」结构（如《西游记》取经路）：一根主线贯穿、"因为所以"一环扣一环、打完一关进下一关，主线清晰易读。',
    mech:'所有章节沿一根主线串成因果链：上一章结果是本章起因、本章结果接下一章，打怪闯关式推进。',
    fit:'常规冒险/成长爽文、连载稳定、怕写崩的稳健型作品；追求易读、主线清晰、读者不迷路。',
    effect:'易读性强、追更顺滑、写作承载力稳定；代价是难容纳复杂副线，多线并存时会受限。' },
  { id:'layered', name:'分层递归展开', tag:'Long-Novel-GPT', short:'分层递归', src:'开源 · Long-Novel-GPT',
    outlineSys: `你是深谙「卷→部→章」分层递归结构的小说架构师。按【卷→部→章】分层递归地设计一部长篇小说。
${JSON_HEADER}
{"title":"小说名","logline":"一句话梗概","structure":{ ${MAIN_LINE_BLOCK} },"volumes":[{"name":"第X卷卷名","theme":"本卷主题与情绪基调","chapters":[{"title":"章标题"}]}]}
要求：整体分 2-4 卷，各卷有清晰主题与情绪递进；每卷内章节数合理；章节标题立意清晰，卷与书之间存在因果链；**volumes 内章节只需列出标题，禁止输出任何逐章梗概、内容预告或阶段目标**——每章正文与梗概将在写正文阶段独立生成。structure 主线条四格（mainLine 必有、副暗汇合有则带）由上方 JSON 定义，全书章节安排由 volumes（卷→章）承载。`,
    chapterSys: `你是严格遵循既定大纲的章节执行写手。根据本章标题、前文承接与结构定位写出本章完整正文，做到章章承接上卷、为后续蓄力。
要求：围绕本章在卷内的位置推进（该引入就引入、该冲突就冲突、该转折就转折），承接上一卷已建立的人物与世界设定、不推倒重来；有细腻环境与心理描写、生动对话、人物弧光；只输出正文，不要标题、不要"本章完/未完待续"标注、不要任何解释。`,
    desc:'借鉴 Long-Novel-GPT / AI_Gen_Novel 的“卷→部→章→节”分层递归：先生成全局卷章框架，再逐卷逐章填充目标。',
    mech:'自上而下先生成全局卷章框架（卷→部→章），再逐卷逐章填充阶段性目标，层级清晰、容量可控。',
    fit:'目标明确、分卷清晰、需要高可维护性的超长篇；世界观宏大、章节海量想保持不乱的类型文。',
    effect:'结构层级严谨、每卷有独立主题与情绪递进，长期连载不易崩；代价是卷间衔接与全局呼应更费设计。' },
  { id:'hero', name:'英雄之旅', tag:'Hero\'s Journey', short:'英雄之旅', src:'开源 · NovelForger',
    outlineSys: `你是深谙「英雄之旅」结构美学的小说架构师。根据用户构想设计一部长篇小说。
${JSON_HEADER}
{"title":"小说名","logline":"一句话梗概","structure":{"mode":"英雄之旅","designReason":"为何采用此倒逼成长框架","stageChapters":{"平凡世界":["章标题",...],"召唤":["章标题",...],"拒绝":["章标题",...],"导师":["章标题",...],"跨过门槛":["章标题",...],"试炼/盟友/敌人":["章标题",...],"深渊":["章标题",...],"一搏":["章标题",...],"回报":["章标题",...],"归来":["章标题",...],"变更":["章标题",...]}, ${MAIN_LINE_BLOCK}},"chapters":[{"title":"章标题"}]}
要求：遵循经典「英雄之旅」十二阶段（平凡世界→召唤→拒绝→导师→跨过门槛→试炼/盟友/敌人→深渊→一搏→回报→归来→变更），倒逼主角成长弧光；阶段不必逐一对应单独一章，可按体量合并或拆分，但整体要完整走完成长路径；**chapters 只需逐章列出标题，禁止输出任何逐章梗概、内容预告或章末钩子**——每章正文与梗概将在写正文阶段独立生成。`,
    chapterSys: `你是严格遵循既定大纲的章节执行写手。根据本章标题、前文承接与结构定位写出本章完整正文，做到章章推动英雄的成长弧光。
要求：围绕本章所处的「英雄之旅」阶段推进角色弧光——该试炼就试炼、该受挫就受挫、该升华就升华；主角每次抉择都要有代价、有成长痕迹；细腻的环境与心理描写、生动对话；只输出正文，不要标题、不要"本章完/未完待续"标注、不要任何解释。`,
    desc:'借鉴 Hero\'s Journey（《千面英雄》，NovelForger 支持）：12 阶段倒逼主角成长弧光，适合成长正气类长篇。',
    mech:'把全书章节映射到英雄之旅十二阶段（平凡世界→召唤→拒绝→导师→跨过门槛→试炼/盟友/敌人→深渊→一搏→回报→归来→变更），让成长弧光结构可预期。',
    fit:'主角成长型、冒险/奇幻类；希望有清晰#成长曲线#与情感爆发点的长篇。',
    effect:'主角弧光完整、情感起伏有据可依、商业辨识度高；代价是套用若生硬会显得套路化。' },
  { id:'savecat', name:'节拍表', tag:'Save the Cat', short:'节拍表', src:'业界 · Save the Cat',
    outlineSys: `你是深谙「节拍表」结构美学的小说架构师。根据用户构想设计一部长篇小说。
${JSON_HEADER}
{"title":"小说名","logline":"一句话梗概","structure":{"mode":"Save the Cat 节拍表","designReason":"如何用 15 拍控制节奏","beats":{"开场画面":["章标题",...],"催化剂":["章标题",...],"争执":["章标题",...],"进入第二幕":["章标题",...],"B故事":["章标题",...],"中点":["章标题",...],"坏人逼近":["章标题",...],"一切尽失":["章标题",...],"黑暗时刻":["章标题",...],"进入第三幕":["章标题",...],"终局":["章标题",...],"最终画面":["章标题",...]}, ${MAIN_LINE_BLOCK}},"chapters":[{"title":"章标题"}]}
要求：遵循 Save the Cat 的 15 节拍（开场→催化剂→争执→B故事→中点→一切尽失→终局→最终画面等），把全书章节分配到各节拍上，节奏可预估；**chapters 只需逐章列出标题，禁止输出任何逐章梗概、内容预告或章末钩子**——每章正文与梗概将在写正文阶段独立生成。`,
    chapterSys: `你是严格遵循既定大纲的章节执行写手。根据本章标题、前文承接与结构定位写出本章完整正文，做到章章贴合 Save the Cat 节拍曲线。
要求：围绕本章所处的「节拍」推进节奏（平原蓄力、催化剂提速、黑暗时刻骤降、终局引爆等），情绪张力随节拍起伏；细腻的心理与场景描写、生动对话、人物弧光；只输出正文，不要标题、不要"本章完/未完待续"标注、不要任何解释。`,
    desc:'借鉴 Save the Cat 15 节拍法：三幕展开为 15 个可预估节拍点，适合商业向、节奏可控的长篇。',
    mech:'用 15 个固定节拍（开场/催化剂/争执/中点/一切尽失/终局…）标注全书情绪曲线，节奏可计算、可预估。',
    fit:'商业类型文、需要稳定节奏与“可预估追读”的连载作品；编剧思维、悬念驱动的长篇。',
    effect:'节奏可预估、爽点位置明确、改编友好；代价是拍点分配若机械会产生套路感。' },
  { id:'seven', name:'七点结构', tag:'Seven-Point', short:'七点结构', src:'开源 · NovelForger',
    outlineSys: `你是深谙「七点结构」的小说架构师。根据用户构想设计一部长篇小说。
${JSON_HEADER}
{"title":"小说名","logline":"一句话梗概","structure":{"mode":"七点结构","designReason":"七个锚点如何控制转折","points":{"Hook钩子":["章标题",...],"PlotTurn1一转折":["章标题",...],"Pinch1中点施压":["章标题",...],"Midpoint中点":["章标题",...],"Pinch2压力加码":["章标题",...],"PlotTurn2二转折":["章标题",...],"Resolution解局":["章标题",...]}, ${MAIN_LINE_BLOCK}},"chapters":[{"title":"章标题"}]}
要求：遵循七点结构（Hook→Plot Turn 1→Pinch 1→Midpoint→Pinch 2→Plot Turn 2→Resolution），用七个锚点控制全书转折节奏；**chapters 只需逐章列出标题，禁止输出任何逐章梗概、内容预告或章末钩子**——每章正文与梗概将在写正文阶段独立生成。`,
    chapterSys: `你是严格遵循既定大纲的章节执行写手。根据本章标题、前文承接与结构定位写出本章完整正文，做到章章朝七个锚点有序逼近。
要求：围绕本章所在锚点推进（前段蓄力、Two Plot 转折、Pinch 施压、Midpoint 承转），每章都向“下一个转折点”收拢、不生枝节；细腻的心理与场景描写、生动对话、人物弧光；只输出正文，不要标题、不要"本章完/未完待续"标注、不要任何解释。`,
    desc:'借鉴 Seven-Point Structure（NovelForger 支持）：Hook→转折→施压→中点→加码→再转折→解局，七个锚点控转折。',
    mech:'以七个固定锚点（Hook/PlotTurn/Pinch/Midpoint/Pinch/PlotTurn/Resolution）规划全书转折，前紧后强。',
    fit:'中短到中长篇、转折重戏剧性、希望#转折节奏#清晰的作品。',
    effect:'转折节奏清晰、终点明确、不拖沓；代价是锚点之外的空间偏线性、群像叙事较难承载。' }
];

const RHYTHMS = [
  { id:'web', name:'黄金网文', tag:'爽点密集', short:'黄金网文', src:'经典 · 网文爆款体系',
    outlineNote:'节奏遵循黄金网文强节奏——开篇尽快抛核心冲突与悬念（金手指/秘密）；因果链清晰、角色抉择有代价、实力或关系阶梯递进；情绪节奏有张有弛（爽点-压抑-爆发交替）；逐章梗概在写正文阶段独立生成。',
    chapterNote:'严格遵循黄金网文强节奏——开篇(前1-2段)尽快进入事件或情绪；以对话与行动推动剧情、少冗长环境描写；本章须兑现一个"爽点/进展"；因果清晰、有记忆点的人设。',
    desc:'当前商业网文最有效的节奏配方，核心是“爽点管理”：全程用小高潮喂给读者，持续满足与追更。',
    mech:'开篇抛冲突悬念；因果清晰、抉择有代价、实力/关系阶梯递进；情绪爽点-压抑-爆发交替。',
    fit:'升级流、逆袭、热血爽文等重代入感连载；读者重爽感、重追更。',
    effect:'留存与追更率高、最懂市场；代价是易套路化，需靠人物与爽点创新破局。' },
  { id:'repress', name:'压抑反转流', tag:'现实虐文', short:'压抑反转', src:'现实 · 黑暗向节奏',
    outlineNote:'节奏为压抑反转流——回报延迟、挫折长期，主角不会立刻打脸、苦难不马上消解；情绪是隐忍煎熬、积蓄良久才释放；困境层层叠加、主角反复受挫；逐章梗概在写正文阶段独立生成。',
    chapterNote:'遵循压抑反转流——本段情绪以隐忍煎熬为主，不立刻给胜利与奖励；困境层层叠加、主角反复受挫；把发泄点压到很后，部分努力可以没有回报；章末压在反转来临前或苦难加剧处，勾着读者等释放。',
    desc:'与爽文相反：回报延迟、挫折长期、反转来得晚，部分努力无回报；情绪隐忍煎熬、积蓄良久才释放。',
    mech:'困境层层叠加、主角反复受挫、不会立刻打脸；冲突发生后不立刻给胜利，反转往往很晚、甚至部分努力无回报。',
    fit:'社会向、悬疑、悲剧、历史写实网文；追求真实沉重的情感冲击而非即时爽感。',
    effect:'压抑到极点的释放更有力量、人物弧光深；但需控节奏，避免“虐而无解”劝退读者。' },
  { id:'slice', name:'慢生活流', tag:'种田日常', short:'慢生活', src:'现实 · 治愈向节奏',
    outlineNote:'节奏为慢生活流——低外部冲突、少大起大落，冲突是细碎生活矛盾；剧情推进极慢，聚焦人物感受、生活细节、人际关系；爽点来自安宁烟火与人物陪伴，非升级逆袭；逐章梗概在写正文阶段独立生成。',
    chapterNote:'遵循慢生活流——聚焦日常生活与人物相处，不追求强冲突；剧情推进慢、冲突多为细碎小事；细腻刻画感官与情绪、烟火气与陪伴感；爽点来自安宁与温暖，而非打脸逆袭。',
    desc:'种田/日常/治愈：低外部冲突、少大起大落，冲突是细碎生活矛盾；推进极慢，聚焦感受、细节、关系。',
    mech:'以日常与生活矛盾代替强冲突，推进极慢；爽点来自安宁烟火与人物陪伴。',
    fit:'种田、日常、治愈、慢热的温馨长篇；读者追求沉浸与陪伴而非刺激。',
    effect:'氛团队入手温柔治愈、黏性高、抗弃文；代价是追读节奏需靠情感维系。' },
  { id:'mystery', name:'悬疑解谜流', tag:'悬念悬置', short:'悬疑解谜', src:'正统 · 悬疑推理节奏',
    outlineNote:'节奏为悬疑解谜流——冲突不快速解决，故意压住答案、延迟兑现；不断抛谜团线索、危机接踵但不揭真相；旧问题搁置、释放留到中后期；逐章梗概在写正文阶段独立生成。',
    chapterNote:'遵循悬疑解谜流——答案要压住，冲突不要立刻收束；不断抛谜团与线索，危机接踵但不揭真相；旧问题先搁置，答案压住不揭。',
    desc:'悬念悬置：冲突不快速解决、故意压住答案、延迟兑现；不断抛谜团线索、危机接踵但不揭真相。',
    mech:'正统悬疑节奏是“悬置＞即时解决”：埋下悬念、转开视角、旧问题搁置、释放拖到中后期。',
    fit:'悬疑、推理、解谜、谍战类长篇；读者重“猜中/揭晓”的智力快感。',
    effect:'抓人、让人放不下、揭晓时爆点强；代价是伏笔回收要求高，烂尾风险大。' },
  { id:'epic', name:'群像史诗节奏', tag:'宏大史诗', short:'群像史诗', src:'历史 · 宏大奇幻节奏',
    outlineNote:'节奏为群像史诗——不以单一主角得失为节奏开关，视角在多人间切换；主角会失败、配角命运独立；大事件周期长、一卷几十章才完成一次大起落；逐章梗概在写正文阶段独立生成。',
    chapterNote:'遵循群像史诗——视角在多人间切换，不以单一主角成败为节奏开关；主角也会失败、配角命运独立；大事件跨度长、不追求每章小爽点；多线并进、交织成时代洪流。',
    desc:'历史/宏大奇幻：不以单一主角得失为节奏开关，视角在多人间切换、配角命运独立、大事件周期长。',
    mech:'大事件以卷为单位起落，视角多线切换，主角可失败、配角命运独立，格局宏大。',
    fit:'历史演义、宏大奇幻、权谋群像类长篇；读者重世界构建与时代感。',
    effect:'格局与史诗感强、人物群像丰满、可承载大世界；代价是个体代入感弱、节奏偏慢。' },
  { id:'fatal', name:'悲剧宿命流', tag:'命运悲剧', short:'悲剧宿命', src:'文学 · 悲剧节奏',
    outlineNote:'节奏为悲剧宿命——努力≠胜利、结局被命运预先约束；抗争不一定换来圆满，一次次抗争爬升迎短暂光亮再跌落；情绪很少彻底宣泄、留有怅然；逐章梗概在写正文阶段独立生成。',
    chapterNote:'遵循悲剧宿命——抗争不一定换来圆满，努力可能徒劳；爬升后迎短暂光亮再跌落；情绪很少彻底宣泄、刻意留怅然与无力感，让悲剧宿命感贯穿。',
    desc:'努力≠胜利、结局被命运预先约束：抗争不一定圆满，一次次爬升迎短暂光亮再跌落；情绪少有宣泄、留怅然。',
    mech:'以“命运不可抗”为底色，抗争服务于悲剧张力而非胜利；情绪罕有彻底宣泄。',
    fit:'悲剧、宿命、史诗型沉重作品；读者重情绪厚重感与命运叩问。',
    effect:'情感厚重、后劲足、文学性强；代价是致郁、不适配追求爽感的读者。' },
  { id:'inward', name:'文艺向内流', tag:'心理向内', short:'文艺向内', src:'文学 · 心理向节奏',
    outlineNote:'节奏为文艺向内——节奏由内心驱动，外部事件只是载体；冲突多发生在心里，剧情推进慢、大事件少，重点是人物纠结、自我认知与情感变化；逐章梗概在写正文阶段独立生成。',
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

// 章节标题风格（可多选；不选则大纲阶段不注入任何标题要求，标题由 AI 自由发挥）
const TITLE_STYLES = [
  { id:'summary',  name:'归纳', tag:'归纳概括', short:'归纳', src:'自定义 · 标题风格',
    desc:'标题能概括本章核心事件，读者看标题即知本章讲什么。',
    mech:'要求 AI 以本章核心事件/情节推进为基准拟题，标题与内容强对应。',
    fit:'追求"目录即导览"、读者快速定位剧情的作品。',
    effect:'标题信息密度高、便于检索回顾；代价是可能牺牲悬念感。',
    note:'章节标题须具备归纳作用：能概括本章核心事件，读者看标题即知本章讲什么，忌与内容脱节。' },
  { id:'point',    name:'画龙点睛', tag:'点题升华', short:'点睛', src:'自定义 · 标题风格',
    desc:'标题点出本章主题与情感内核，用双关/象征/意境词升华。',
    mech:'要求 AI 提炼本章情感与主题落点，用一个点睛词或意象完成升华。',
    fit:'情感向、主题鲜明、追求回味与记忆点的作品。',
    effect:'标题有回味与张力、记忆点强；代价是需要主题先行、对 AI 提炼要求高。',
    note:'章节标题须画龙点睛：点出本章主题与情感内核，可用双关、象征或意境词升华，忌平铺直叙。' },
  { id:'literary', name:'文学语句', tag:'诗化表达', short:'文学', src:'自定义 · 标题风格',
    desc:'标题用诗化、意象或典故化表达，讲究语言美感与余韵。',
    mech:'要求 AI 以文学笔法拟题（诗化/意象/典故），拒绝大白话。',
    fit:'文风典雅、追求整体气质的作品。',
    effect:'标题有文学美感、辨识度高；代价是可能与"归纳"取向冲突、需把握分寸。',
    note:'章节标题须有文学语句质感：采用诗化、意象或典故化表达，讲究语言美感与余韵，而非大白话。' },
  { id:'neat',     name:'字数工整', tag:'字数统一', short:'工整', src:'自定义 · 标题风格',
    desc:'全书每章标题字数统一，整齐有节奏。',
    mech:'要求 AI 全书标题保持相同字数（建议 4-6 字，可对仗）。',
    fit:'追求形式美、目录整齐划一的章回体/古风作品。',
    effect:'目录整齐、节奏感强；代价是字数约束下拟题难度上升。',
    note:'章节标题须字数工整：全书每章标题字数统一（建议 4-6 字，可对仗），整体整齐有节奏感。' }
];
const TITLE_STYLE_IDS = TITLE_STYLES.map(s=> s.id);

// v10.18 标题风格（tone 组）内置词条：由原「标题风格」维度迁入顶部「写作风格 → ① 标题风格」，供「重生成全部标题」使用（也随大纲标题生成）。
// 内容沿用原 TITLE_STYLES 的标题命名指令，贴合 tone 组"仅约束标题命名"的语义。
const TONE_TITLE_STYLES = TITLE_STYLES.map(s=>({ id:'tt_'+s.id, group:'tone', name:s.name, custom:false, note:s.note }));

// v10.18 梗概风格（texture 组）内置词条：逐章梗概/创作方向的标准五段骨架。
// 归入顶部「写作风格 → ② 梗概风格」，供「逐章梗概（创作方向）」生成时作为梗概结构要求注入（writeStylePlanBlock 读 texture 组）。
const TEXTURE_PLAN_STYLES = [
  { id:'tp_link', group:'texture', name:'承接上一章', custom:false,
    note:'本章梗概须先【承接上一章】：用 1 句话回应上一章结尾的钩子，说明本章从哪里开始。' },
  { id:'tp_event', group:'texture', name:'本章核心事件', custom:false,
    note:'本章梗概须含【本章核心事件】：用 3-5 句话写清 起因→经过→结果，必须包含至少 1 个反转或意外。' },
  { id:'tp_change', group:'texture', name:'人物变化', custom:false,
    note:'本章梗概须标明【人物变化】：本章结束时，主角的认知/情绪/能力发生了什么具体变化。' },
  { id:'tp_plant', group:'texture', name:'埋点与回收', custom:false,
    note:'本章梗概须安排【埋点与回收】：写出本次埋下什么新伏笔、又回收了哪条旧线。' },
  { id:'tp_next', group:'texture', name:'通往下章', custom:false,
    note:'本章梗概须以【通往下章】收尾：留下一个具体悬念，让下一章标题显得非写不可。' }
];

/* =========================================================
 * v2.0 / v10.17 写作风格选择器：内置词库 22 项，v10.17 起全部归入「章节风格(element)」组
 * 组别：tone=标题风格（重生成全部标题）/ texture=梗概风格（逐章梗概）/ element=章节风格（正文）——均多选
 * 注入：章节正文用章节风格（buildChapterSys/chapterStyleNote）；标题重生成用标题风格；逐章梗概用梗概风格。
 * 每项 note 为可执行 AI 指令；注入时统一附加一致性红线。
 * ========================================================= */
const WRITE_STYLES = [
  // 以下历史分组 tone/texture/element 已在 writeStyleLib 统一归并到 element（章节风格），归类注释见各条
  { id:'humor',   group:'tone',    name:'诙谐幽默', note:'用俏皮话、反差、自嘲制造笑意；比喻俏皮但不低俗；人物吐槽有梗但符合人设与场合。',
    tips:['把紧张或伤感的场面用轻松口吻化解，制造反差笑点','给人物设计符合性格的吐槽（主角嘴贫、配角耿直、长辈一本正经）','用生活化的夸张比喻把抽象情绪具象化'],
    avoid:['冷笑话堆砌（笑点必须服务剧情或人物）','所有角色说同一套俏皮话'],
    check:['至少 2 处自然笑点','笑点长在人物身上而非作者旁白'],
    demo:'他把这辈子的勇气都攒起来，最后用在了和老板娘砍价上。' },
  { id:'solemn',  group:'tone',    name:'严肃',     note:'语气庄重克制，不插科打诨；用词正式，叙述沉稳有分量。',
    tips:['用正式书面语与庄重句式','叙述沉稳，少用感叹与网络化表达','人物对话克制、有分量感'],
    avoid:['俏皮话/流行语/轻浮比喻','情绪化宣泄式抒情'],
    check:['全文无口语化玩笑','重大情节用庄重笔触'] },
  { id:'straight',group:'tone',    name:'正经',     note:'一本正经地叙述，叙事严谨规整，对话符合身份与场合，不浮夸、不油滑。',
    tips:['按身份与场合使用得体措辞','叙事平实规整、一板一眼','对话符合人物身份，不越界'],
    avoid:['浮夸修辞与夸张戏剧化','不符合人物身份的油腔滑调'],
    check:['对话与人物身份相符','无油滑腔调'] },
  { id:'cold',    group:'tone',    name:'冷峻克制', note:'惜字如金，情绪不外露；用客观白描代替抒情，把余味留给读者。',
    tips:['用短句、白描、留白代替抒情','情绪用动作与环境暗示','删掉冗余形容词，惜字如金'],
    avoid:['直白喊出情绪（如"他心如刀绞"）','大段心理独白'],
    check:['情绪段落少于直接描写','无直白情绪标签'],
    demo:'他把刀擦干净，放回架子上。窗外雨没停。' },
  { id:'warm',    group:'tone',    name:'温情细腻', note:'侧重人物内心与关系温度，细节柔软，对话温和有生活气。',
    tips:['多写人物的微小动作与眼神','对话温和、有生活气息','用日常细节传递温度'],
    avoid:['刻意煽情、强行催泪','甜腻到失真'],
    check:['至少一处生活细节体现关系温度','情感自然不煽情'] },
  { id:'passion', group:'tone',    name:'热血燃向', note:'节奏上扬、情绪饱满；多用短促有力的表达与动作冲击，读来有燃点。',
    tips:['用短促有力的口号式表达','动作描写有冲击力','情绪递进到高点再引爆'],
    avoid:['全程高亢失去起伏','为燃而燃的空喊口号'],
    check:['有清晰的情绪高点','高潮段落节奏明显加快'] },
  { id:'suspense',group:'tone',    name:'悬疑紧张', note:'制造信息差与压迫感，句尾留悬念；描写偏紧绷，意象偏暗。',
    tips:['制造信息差（读者知道得比角色少或多）','句尾留悬念钩子','环境描写偏暗、紧绷'],
    avoid:['提前泄底','为悬疑而故弄玄虚（逻辑不通）'],
    check:['段落间有悬念牵引','悬念符合逻辑、可回收'] },
  { id:'teasing', group:'tone',    name:'戏谑吐槽', note:'毒舌但不刻薄，冷幽默旁观者视角，善于拆台与自嘲。',
    tips:['冷幽默旁观者视角','一本正经说反话的拆台式吐槽','毒舌但留分寸'],
    avoid:['刻薄伤人的恶意嘲讽','吐槽脱离剧情变成作者乱入'],
    check:['吐槽符合人物视角','无恶意攻击'] },
  // ②（历史 texture，v10.17 并入 element 章节风格）
  { id:'rigorous',group:'texture', name:'严谨',     note:'逻辑链条清晰、前后呼应，用词精准，少用模糊修辞，有考据感。',
    tips:['逻辑链完整（因果/时间/空间都经得起推敲）','用词精准，少用"大约/好像"等模糊语','涉及设定时保持前后一致'],
    avoid:['含糊其辞','前后矛盾'],
    check:['时间线/因果关系无矛盾','专名与设定统一'] },
  { id:'ornate',  group:'texture', name:'华丽辞藻', note:'大量使用排比、对仗、通感与四字词，画面浓墨重彩，句子密度高。',
    tips:['多用排比、对仗、通感','用四字词与色彩意象铺陈','句子的密度与节奏感并重'],
    avoid:['华丽但空洞（只有形容词没有实义）','堆砌到影响阅读'],
    check:['至少 2 处排比/对仗','辞藻服务于画面与情绪'],
    demo:'暮色像一匹被揉皱的绸缎，摊在山脊上，流光一寸寸洇开。' },
  { id:'poetry',  group:'texture', name:'古诗词化用', note:'恰当化用或点化古诗词意境（不整段抄袭），以诗句意象托物言志、烘托氛围。',
    tips:['化用诗词意境与意象（不整段抄袭）','用诗句托物言志、烘托氛围','文辞带诗意'],
    avoid:['生硬掉书袋','为用诗而用诗、脱离情节'],
    check:['意境化用自然不生硬','无整段照抄'] },
  { id:'classic', group:'texture', name:'古文笔法', note:'文白相间，善用文言虚词、四六骈句与典故，笔致典雅有书卷气（中国古代文人笔意）。',
    tips:['文白相间、善用四六骈句','用文言虚词点缀','典故用事增加书卷气'],
    avoid:['通篇文言导致难读','滥用典故不作说明'],
    check:['白话为骨、文言为韵','可读性不牺牲'],
    demo:'是夜月明如洗，庭中桂影婆娑，似有暗香浮动。' },
  { id:'modern',  group:'texture', name:'现代文学笔法', note:'白话而讲究语感，长短句错落、意象现代，重视心理描写与留白（中国现代文人笔意）。',
    tips:['白话但讲究语感与节奏','长短句错落、意象现代','心理描写细腻，善用留白与细节'],
    avoid:['网络化表达','平铺直叙无节奏'],
    check:['有 1-2 处可反复回味的句子','心理与景物交融'],
    demo:'雨落在青石板上，像有人细细地敲着门。' },
  { id:'plain',   group:'texture', name:'白话口语', note:'平实如说话，短句为主，对话贴近生活原声，少书面腔。',
    tips:['句子短、像说话','对话贴近生活原声','少书面腔与成语'],
    avoid:['文绉绉的书面语','生硬翻译腔'],
    check:['读起来像听人说话','无翻译腔'] },
  { id:'implicit',group:'texture', name:'含蓄留白', note:'点到为止、以景结情；情绪不直接说破，用细节与侧面暗示。',
    tips:['情绪点到为止、以景结情','用细节暗示，不直接说破','结尾留余味'],
    avoid:['把情绪说穿','结尾把道理讲尽'],
    check:['关键情绪有留白','结尾有余味'] },
  { id:'aphorism',group:'texture', name:'金句频出', note:'每章至少 1-2 句可摘抄的警句/金句（哲理、扎心或诗意皆可），自然嵌入、不硬造。',
    tips:['每章 1-2 句可摘抄的警句（哲理/扎心/诗意）','金句嵌入对话或叙述高潮处'],
    avoid:['硬造金句、口号化','金句与情节脱节'],
    check:['至少 1 句可摘抄','金句自然生长自情节'] },
  // ③（历史 element，v10.17 为「章节风格」主组）
  { id:'memes',   group:'element', name:'网络梗',   note:'适度使用广为人知的网络热梗/流行语，不生造梗，每章不超过 3 处，人物用时符合年龄与场合。',
    tips:['用广为人知的网络热梗/流行语点缀','人物使用时符合年龄与场合','每章不超过 3 处'],
    avoid:['生造梗、过气冷梗','全员玩梗'],
    check:['每章 ≤3 处','梗符合人设与场合'] },
  { id:'idiom',   group:'element', name:'成语典故', note:'多用成语、熟语与历史典故，信手拈来但不过度堆砌。',
    tips:['多用成语、熟语','善用历史典故','信手拈来、恰到好处'],
    avoid:['过度堆砌成语','用错典故'],
    check:['成语使用准确','不密集到发酸'] },
  { id:'cinematic',group:'element',name:'电影感画面', note:'以镜头语言写场景：景别/光线/运镜/构图式的描写，画面有质感、可"脑内放映"。',
    tips:['用镜头语言写场景（景别/光线/运镜/构图）','动作连贯、可"脑内放映"','每场戏有画面主镜头'],
    avoid:['平铺直叙的流水账','只有远景没有特写'],
    check:['每场戏有画面主镜头','光线/构图至少一处具体'],
    demo:'镜头从雨帘推近，落在她攥紧的伞柄上，指节发白。' },
  { id:'shortbeat',group:'element',name:'短句快节奏', note:'句子短、段落碎、信息密度高、推进快，适合强情节段落。',
    tips:['句子短、段落碎','信息密度高','用单句成段制造节奏'],
    avoid:['长句堆叠拖慢节奏','节奏单一没有起伏'],
    check:['平均句长明显偏短','节奏有快慢变化'] },
  { id:'longflow',group:'element', name:'长句绵密', note:'用长句铺陈氛围与心理，从句叠加以形成绵密节奏（句读清晰、不绕晕）。',
    tips:['用长句铺陈氛围与心理','从句叠加形成绵密节奏','句读清晰'],
    avoid:['绕晕读者的超长句','为长而长'],
    check:['长句有内在节奏','读起来不迷路'] },
  { id:'dialect', group:'element', name:'方言俚语', note:'关键角色可用方言/俚语点缀地域感与人味，保证读者能懂，不滥用。',
    tips:['关键角色用方言/俚语点缀','体现地域感与人味','生僻词带意译，保证读者能懂'],
    avoid:['全程方言难懂','每个角色都说方言'],
    check:['方言只做点缀','读者能懂'] }
];
const WRITE_GROUP_LABEL = { tone:'① 标题风格', texture:'② 梗概风格', element:'③ 章节风格' };

// 运行时词库 = 内置 22 项（note 可被 cfg.styleCustom.notes 覆盖、可被 removed 删除）⊕ 用户新增
// v2.4 自定义风格 note 支持三行配方：写法:/避免:/自查:（按行解析成 tips/avoid/check）
function parseCustomStyleNote(note){
  const tips=[], avoid=[], check=[];
  const lines = String(note||'').split(/\n/);
  let mode = null;
  lines.forEach(l=>{
    const t = String(l||'').trim();
    if(!t) return;
    if(/^写法[:：]/.test(t)) mode = 'tips';
    else if(/^避免[:：]/.test(t)) mode = 'avoid';
    else if(/^自查[:：]/.test(t)) mode = 'check';
    else if(mode === 'tips') tips.push(t.replace(/^[①②③④⑤]?[.、）)]?\s*/,''));
    else if(mode === 'avoid') avoid.push(t.replace(/^[✗×\-\s]+/,''));
    else if(mode === 'check') check.push(t.replace(/^[□✅◇\-\s]+/,''));
  });
  return { tips, avoid, check };
}
function writeStyleLib(){
  const c = getCfg().styleCustom || {};
  const notes = (c && c.notes) || {};
  const removed = Array.isArray(c && c.removed) ? c.removed : [];
  const added = Array.isArray(c && c.added) ? c.added : [];
  // v10.19 系统内置词条保留原始来源 cat（语气基调/文风质感/语言元素），供章节风格组内分块展示
  const base = WRITE_STYLES.filter(s=> !removed.includes(s.id)).map(s=>{
    const cat = s.group==='tone' ? 'tone' : (s.group==='texture' ? 'texture' : 'element');
    return { ...s, group:'element', cat, note: notes[s.id] || s.note };
  });
  const customs = added.map(a=>{
    const parsed = parseCustomStyleNote(a.note||'');
    return { id:a.id, group:a.group, name:a.name||'未命名', note:a.note||'', custom:true, cat:'custom', tips:parsed.tips, avoid:parsed.avoid, check:parsed.check };
  });
  // v10.18 标题风格（tone 组）内置项迁入顶部「写作风格 → ① 标题风格」；梗概风格（texture 组）内置五段骨架归入「② 梗概风格」；均受 removed/notes 管理
  const toneTitles = TONE_TITLE_STYLES.filter(s=> !removed.includes(s.id)).map(s=>({ ...s, note: notes[s.id] || s.note }));
  const texturePlans = TEXTURE_PLAN_STYLES.filter(s=> !removed.includes(s.id)).map(s=>({ ...s, note: notes[s.id] || s.note }));
  return base.concat(customs).concat(toneTitles).concat(texturePlans);
}
function writeStyleById(id){
  return writeStyleLib().find(s=> s.id === id) || null;
}
// 当前生效的写作风格配置：override 优先（单章覆盖/对比用），缺省用 state.chapterStyle
function curWriteStyle(override){
  if(override && Array.isArray(override.tags)) return { tags: override.tags, intensity: (override.intensity===1||override.intensity===3)?override.intensity:2 };
  const s = state.chapterStyle || {};
  return { tags: Array.isArray(s.tags)?s.tags:[], intensity: (s.intensity===1||s.intensity===3)?s.intensity:2 };
}
// v10.17 按使用目标分组取所选风格对象：章节风格(element)/标题风格(tone)/梗概风格(texture)
function wsGroupStyleTags(override, group){
  const st = curWriteStyle(override);
  const lib = writeStyleLib();
  return (Array.isArray(st.tags) ? st.tags : []).map(id=> lib.find(s=>s.id===id)).filter(s=> s && s.group === group);
}
const WS_CONC_TXT = {
  1:'浓度（轻）：全章约三分之一段落体现风格，其余按常规写作；每段最多 1-2 处风格痕迹。写完自查：不足处不必强补，保持自然。',
  2:'浓度（中）：全章大部分段落（约三分之二）体现风格，每段至少 1 处明显痕迹；开头段落必须体现以立住基调。写完自查：不达标段落补强。',
  3:'浓度（重）：全章每一段都要体现风格，对话与叙述几乎句句带痕迹，形成统一文风。写完自查：无风格痕迹的段落一律重写。'
};
// 生成注入块：最高优先指令 + 浓度量化 + 四件套配方（仅展开选中项）；无选中返回空串
function wsStyleNoteBlock(items, st, headTitle, intro, demoLabel){
  if(!items.length) return '';
  const lines = ['【' + headTitle + '（用户指定 · 最高优先指令）】', intro, (WS_CONC_TXT[st.intensity] || WS_CONC_TXT[2])];
  items.forEach(s=>{
    lines.push('· '+s.name+'（总纲）：'+(s.note||''));
    if(Array.isArray(s.tips) && s.tips.length) lines.push('  写法：' + s.tips.map((t,i)=>`${['①','②','③','④','⑤'][i]||(i+1)+'.'} ${t}`).join('；'));
    if(Array.isArray(s.avoid) && s.avoid.length) lines.push('  避免：✗ ' + s.avoid.join('；✗ '));
    if(s.demo) lines.push('  示范写法：「'+s.demo+'」（可模仿其语感，不要照抄句子）');
    if(Array.isArray(s.check) && s.check.length) lines.push('  自查：' + s.check.map(c=>'□ '+c).join(' '));
  });
  lines.push('红线：以上风格仅约束表达方式，不得破坏人名/地名/专名一致性，不得违反基础剧情逻辑与人物设定。');
  return '\n\n' + lines.join('\n');
}
// 章节风格（element 组）注入：用于章节正文生成（单章/批量/重生成；含角色扮演对比）
function chapterStyleNote(override){
  const items = wsGroupStyleTags(override, 'element');
  const st = curWriteStyle(override);
  return wsStyleNoteBlock(items, st, '写作风格', '本指令为本章写作的最高优先要求：当它与节奏、篇幅、原创性等任何其他要求冲突时，以本指令为准；唯一不可逾越的红线：不得破坏人名/地名/专名一致性、不得违反基础剧情逻辑与人物设定。');
}
// 标题风格（tone 组）注入：用于「重生成全部标题」
function writeStyleTitleBlock(){
  const st = curWriteStyle(null);
  return wsStyleNoteBlock(wsGroupStyleTags(null, 'tone'), st, '标题风格', '生成本书书名与各章标题时，必须整体体现以下标题风格（仅约束标题命名，不约束正文）；标题须与章节内容相符且保持前后连贯。', '示例');
}
// 梗概风格（texture 组）注入：用于「逐章梗概（创作方向）」
function writeStylePlanBlock(){
  const st = curWriteStyle(null);
  return wsStyleNoteBlock(wsGroupStyleTags(null, 'texture'), st, '梗概风格', '本指令为本章梗概/创作方向生成时的最高优先要求：当它与节奏、篇幅等其它要求冲突时以本指令为准。', '示例');
}

// 当前所选
function selStructure(){ return state.recipeSet && STRUCTURES.find(s=> s.id === state.recipeSet.structure) || null; }
function selRhythm(){ return state.recipeSet && RHYTHMS.find(r=> r.id === state.recipeSet.rhythm) || null; }
function selQualities(){ return (state.recipeSet && Array.isArray(state.recipeSet.quality)) ? state.recipeSet.quality.filter(id=> QUALITY_IDS.includes(id)).map(id=> QUALITIES.find(q=> q.id===id)).filter(Boolean) : []; }
function hasQuality(id){ return Array.isArray(state.recipeSet && state.recipeSet.quality) && state.recipeSet.quality.includes(id); }
// 章节标题风格（多选）：返回选中的样式对象数组；未选返回 []
function selTitleStyles(){ return (state.recipeSet && Array.isArray(state.recipeSet.titleStyle)) ? state.recipeSet.titleStyle.filter(id=> TITLE_STYLE_IDS.includes(id)).map(id=> TITLE_STYLES.find(s=> s.id===id)).filter(Boolean) : []; }
function hasTitleStyle(id){ return Array.isArray(state.recipeSet && state.recipeSet.titleStyle) && state.recipeSet.titleStyle.includes(id); }
// 标题风格注入块：选中才生成，未选返回空（不发送任何标题要求，AI 自由发挥）
function titleStyleNote(){
  const arr = selTitleStyles();
  if(!arr.length) return '';
  return '【章节标题风格（用户指定，必须遵守）】\n' + arr.map(s=>'·'+s.note).join('\n');
}

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
// 全书章节数量：用户给定（1-200 整数）；未设返回 null。
function chapterCountVal(){
  const v = +state.chapterCount;
  if(Number.isInteger(v) && v>=1 && v<=200) return v;
  return null;
}
// 生成大纲前唯一必填数字：本章节数量一句提示
function chapterCountHint(){
  const v = chapterCountVal();
  return v ? `全书 ${v} 章` : '请填写全书章节数（1-200，必填）';
}
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
// 不再按字数设定：章节数只定章数，正文长度由模型自然把握，这里给一个安全的通用上限（约 8000 字缓冲）
function chapterMaxTokens(){
  return Math.min(20000, Math.max(600, Math.ceil(8000 * 1.6)));
}
// 段落去重（落库前安全网）：把正文按空行切成段落，若有相邻两段相似度 ≥0.8（80% 以上重叠），
// 则按“谁更像原稿/更长”保留其一、丢弃重复的那段，避免单章因多次段落级重写而出现整段重复。
function dedupAdjacentParagraphs(text){
  if(!text) return text;
  const sep = '\n\n';
  const paras = String(text).split(sep).map(p=> p.trim());
  if(paras.length < 2) return text;
  const norm = s => s.replace(/\s+/g,' ');
  // 相似度 = 2×公共子串长度占两段长度之和的比例（粗略，够用于整段重复检测）
  function sim(a,b){
    const aa = norm(a), bb = norm(b);
    if(!aa.length || !bb.length) return 0;
    const short = aa.length < bb.length ? aa : bb;
    const long = aa.length < bb.length ? bb : aa;
    // 用重叠滑动窗口取最大公共子串近似
    let best = 0;
    for(let step = Math.max(2, Math.floor(short.length/4)); step <= short.length; step++){
      let found = false;
      for(let k=0; k+step <= short.length; k++){
        if(long.indexOf(short.slice(k,k+step)) >= 0){ found = true; best = step; break; }
      }
      if(!found) break;
    }
    return 2*best / (aa.length + bb.length);
  }
  const out = [];
  for(const p of paras){
    if(!p) continue;                       // 跳过空段
    const last = out[out.length-1];
    // 只删「几乎完全相同」的相邻段落（阈值 0.95），且较短一半需达到较长一半的 60% 长度
    //（避免把正常的一段误删：只有当两段高度重叠才判定为整段重复）
    if(last && sim(p, last) >= 0.95){
      const lenP = norm(p).length, lenL = norm(last).length;
      const shorter = Math.min(lenP, lenL), longer = Math.max(lenP, lenL);
      if(longer > 0 && shorter / longer >= 0.6){
        // 保留更长/更完整的一段（通常新改写段更长，保留它）；等长时保留后插入的
        if(p.length > last.length) out[out.length-1] = p;
        else if(p.length === last.length && out[out.length-1] && p !== last) out[out.length-1] = last;
        continue;                          // 丢弃重复的当前段
      }
    }
    out.push(p);
  }
  return out.join(sep);
}

// 把「锚点 → 改写段落」应用回初稿（段落级重写合并）。锚点找不到则跳过该条，保守不破坏正文。
// 采用「删除→插入」：以锚点句定位其所在整段，删掉该段后用改写段顶替，杜绝「原文保留+改写追加」式重复。
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
    // 删除→插入：删掉锚点所在整段，用改写段 r 顶替，从根上杜绝“原文保留+改写追加”式重复。
    out = leading + r + (trailing.startsWith('\n') || /[\n。！？）」』]\s*$/.test(r) ? trailing : '\n' + trailing);
  }
  return out;
}

// 体量提示（拼入大纲提示词）：只给固定章节数，不给任何字数限制
function outlineSizeNote(){
  const n = chapterCountVal();
  return `全书共 ${n} 章（已由用户定死）。请严格生成恰好 ${n} 个章节，章号从 1 到 ${n} 连续，每章给出标题与梗概，不得增加也不得减少章节。全程不限制任何字数（不设单章字数、不设全书字数），按内容需要自然成稿。`;
}
/* 万物词典统一要求块：无论选哪种结构都追加到大纲提示词，保证模型输出 glossary（建议7/决策8/9）
 * glossary 等顶层字段仍以“下方追加块”形式补充（S2）；而各结构的主线条四格已内联进各自的 outlineSys（S1，见 MAIN_LINE_BLOCK）。 */
/* 基础大纲 JSON 契约（仅是大纲内容，与『结构』彻底无关）：用户未选任何结构范式时，作为独立的大纲内容块注入，
  * 只定 title/logline/chapters 的形态。不含任何"多线/三定"等结构偏好——结构未选则不推主线条/副暗线等结构命令；
  * 但"全部章节安排"仍由 CHAPTER_PLAN_FREE_SYS 以自由分组的形式轻量补充到 structure.chapterPlan。 */
const OUTLINE_GEN_SYS = `你是一位能驾驭超长篇的小说架构师。
【核心任务】根据用户的一句话或几句构想，设计一部长篇小说的大纲骨架。
${JSON_HEADER}
{"title":"小说名","logline":"一句话梗概（含核心冲突与深层命题）","chapters":[{"title":"第1章标题"}]}
【硬性约束】
1. 每章 title 立意清晰、体现节奏走向。
2. **chapters 只需逐章列出标题，禁止输出任何逐章梗概、内容预告、章末钩子或阶段目标**——每章的正文与梗概在写正文阶段独立生成，不在大纲阶段预写。
【自由发挥区】在满足以上约束的前提下，章节标题的立意、措辞、节奏走向由你自由构思。`;

const GLOSSARY_SYS = `\n\n【glossary 万物词典（必须一并输出）】请在返回的 JSON 顶层再追加一个 glossary 字段，作为全文保持一致性的权威基准：
"glossary":{"characters":[{"name":"人物姓名","identity":"身份/职业/社会身份","age":"岁数/年龄","gender":"性别","appearance":"外貌特征","hobby":"爱好/习惯","relation":"与该人的血缘/人际关联（妹妹/姐姐/朋友/仆人等）","trait":"性格要点"}],"places":[{"name":"地名/场景名","type":"类型","note":"设定要点"}],"propernouns":[{"name":"专名/专属设定术语","note":"含义与拼写唯一约定"}]}
必须列出本故事涉及的全部重要人物（含配角）、关键地域地名与专属设定术语；**全书正文一律只使用本词典中的人名/地名/专名，禁止自造或混用其他拼写**。每名人物**必须**标注 identity（身份/职业/社会身份）、age（岁数/年龄）、gender（性别）、appearance（外貌特征）、hobby（爱好/习惯），正文中人物的身份、年龄、性别、外貌、爱好须与此保持一致。
【relation 与 identity 务必区分，不可混淆】
· identity 身份 = 她/他自己是谁：职业/职务/族群/社会地位，可独立成句——「她是捕快」「她是市长」「她是尼罗河努比亚族船女」「她是篮球运动员」；
· relation 关系 = 她/他和谁是什么关联：血缘/姻亲/友伴/主仆，必须带"谁的"才成立——「林晚的妹妹」「她的仆人」「朋友：陈默」；禁止把身份词（捕快/市长/船女）写进 relation；
人物条目中不设"职能/角色定位"字段。trait 归纳稳定性格以便后续各章保持一致。`;

// v10.18 逐章梗概：章节规划师身份提示词。大纲确认后可选生成"每章本章梗概"（chapterPlans），
// 写正文时注入【本章梗概】对抗文风漂移；标题归大纲 AI，本 AI 只写本章梗概、不写标题。
const CHAPTER_PLAN_SYS = `你是一位深谙叙事节奏的章节规划师。
【核心任务】根据给定的小说大纲（标题、一句话梗概、长篇结构设计、设定词典），为每一章规划一条【一句话方向梗概】——提炼本章要发生的核心事件与走向，供章节写手据此执笔。
【硬性约束】
0. 若用户提示中出现【写作风格约束（首位要求，须优先遵循）】块，必须将其中语气/质感/元素/浓度要求作为首位硬约束执行——每条章方向都必须体现该风格基调（如要求"严肃"则方向措辞庄重不轻佻，"温情细腻"则带关系温度），不得忽略或降级为可选建议。
1. 输出与章节数完全一致的 JSON 数组，顺序对应每一章：{"chapterPlans":["第1章：本章梗概…","第2章：本章梗概…"]}
2. 为每一章写出【完整本章梗概】——写清本章发生什么：起因→经过→结果，可含关键反转、细节与伏笔；但不展开具体对话/描写/情节细则，留给正文阶段自由展开。每条梗概严格控制在 200 字以内，精炼所有核心信息。
3. 本章梗概须与本章标题呼应（标题是梗概的上位锚；标题由大纲架构师定，你不改写标题）。
4. 前章的梗概不得剧透后章的关键转折；相邻章节方向衔接自然、避免断档。
5. 不输出任何解释、不要 markdown 代码块。
【自由发挥区】在满足以上约束的前提下，各章方向的侧重点与措辞由你把握（本卷蓄力则写蓄力方向，本卷高潮则写加压方向）。`;

// v10.12 原创性要求（防雷同）· 大纲侧：防套路结构 + 高频人名 + 流水线标题。
// 独立注入块而非改写各结构常量：一处定义，经组装函数自动覆盖全部结构范式与默认路径。
const ORIGINALITY_OUTLINE_SYS = `【原创性要求（防雷同）】本作追求独特设定，避免与常见网络作品雷同：
1. 拒绝套路模板：不开局退婚/系统提示音/赘婿打脸/主角降智等烂大街桥段；情节逻辑优先从本作独有设定推导，而非套用通用模板。
2. 人名规避：人物姓名避免网文高频字组合（如林晚/苏晚/顾沉/云深/顾言之类）；可采用职业特征/意象组合造名（如"渔灯""沉砚"），姓名风格与世界观一致。
3. 章节标题同理：标题立意避免"xx之怒/惊变/震惊"式流水线命名。`;

// v10.12 原创性要求（防雷同）· 章节侧：防桥段套路 + 高频句式 + 无关套路元素。
const ORIGINALITY_CHAPTER_SYS = `【原创性要求（防雷同）】本章内容追求自然独特：
1. 桥段防套路：避免无理由误会、工具人反派强行送头、为冲突而冲突的降智桥段；冲突应来自前文设定与人物动机的自然推进。
2. 句式防高频：避免网文高频表达（"嘴角勾起一抹冷笑""眼神一凛"等），对话与描写尽量具体、贴合本作人物。
3. 不硬塞元素：不引入与既有设定无关的常见套路元素（金手指/系统/穿越梗等），除非本作设定明确包含。`;

// v10.15 重生成全部章节标题：保留大纲骨架，只重出标题；服从既有设定 + 用户建议 + 防套路第一优先。
const REGEN_TITLES_SYS = `你是一位深谙标题艺术的章节标题策划师。
【核心任务】根据给定的小说大纲（标题、一句话梗概、长篇结构设计、设定词典），在【不改变章节数量与结构安排】的前提下，为每一章重生成一个更有表现力的标题。
【硬性约束】
1. 章节数量与顺序必须与现有章节完全一致（一章不增、一章不减）；
2. 标题必须服从现有设定：与一句话梗概、结构设计、设定词典保持一致，不引入新人物/地名/专名；
3. 标题有表现力、立意新颖但不剧透：体现本章走向/情绪，不泄露后续反转与结局，不重复前文已用梗；
4. **防套路第一优先**：避免"xx之怒/惊变/震惊"式流水线命名与网文高频句式，也不刻意追求"钩子感"（钩子感要求已废除，防套路优先）；立意从本作独特设定推导；
5. 若用户提示中出现【写作风格约束（首位要求，须优先遵循）】块，必须将其中语气/质感/元素/浓度要求作为首位硬约束执行——每条标题的措辞基调都须贴合该风格（如"严肃"则标题庄重不轻佻、"温情细腻"则带温度、"冷峻克制"则惜字如金），不得忽略或降级；
6. 若用户提供了【重生成要求】，须以要求为最高优先；
7. 只输出 JSON 数组（不要解释、不要 markdown 代码块）：{"titles":["第1章标题","第2章标题",...]}
【自由发挥区】标题的立意、措辞、角度由你把握，让每章标题读起来各有记忆点、整批标题风格错落。`;

// v10.15 标题质检：重生成标题后自动跑一次（qcTemp 0.2），只提示不自动改。
const TITLE_QC_SYS = `你是长篇小说的标题质检编辑。检查【标题列表】是否与【设定基准】一致，只判定以下问题并输出 JSON（不要解释、不要 markdown 代码块）：
{"issues":[{"index":0,"type":"设定冲突|剧透|逻辑错位|套路化","fix":"一句话建议"}]}
判定项：①设定冲突（出现词典外新名/与梗概或结构矛盾）；②剧透（泄露后续反转/结局）；③逻辑错位（标题顺序与结构安排不符）；④套路化（xx之怒/惊变式流水线命名）。无问题输出 {"issues":[]}。`;

// v10.13 优化构想 AI：把用户粗糙构想优化为结构化高质量构想（通用核心要素 + 自适应分类要素）。
// 极短输入（<15 字仅题材词）走「骨架展开模式」：给可改草稿 + 显式标注 + 反问清单引导补充独有设定。
const IDEA_POLISH_SYS = `你是一位深谙网文与影视叙事的构想编辑。
【核心任务】把用户输入的粗糙故事构想，优化成一段结构化的高质量构想——保留用户全部原始意图，补全可推导的具体细节，让后续大纲 AI 有明确的创作依据。
【硬性约束】
0. 输入极短（少于 15 字，仅题材/方向词，如"穿越文""重生复仇""校园"）时：切换到「骨架展开模式」——按该题材的经典类型惯例，展开成一份通用骨架构想（该题材常见的主角设定、典型主线阶段、常见风格落点），必须在文首标注"（基于题材惯例的通用展开，非用户原话）"，并在末尾附一行"💡 建议补充：主角身份？核心设定/金手指？结构阶段？风格基调？——补充后再优化效果更好"；不得把骨架设定表述成用户提供的，也不得声称这是唯一写法。
1. 绝不删减、篡改用户明确表达的内容（题材/元素/风格都须保留），只能在原意上细化；
2. 不替用户新增故事设定（不凭空加角色/势力/冲突/金手指），只补全"可推导的通用细节"；
3. 输出结构 = 通用核心要素（题材 / 主角 / 结构（含阶段比例） / 风格（含落地方式） / 目标（读者体验））+ 自适应分类要素（分两层）：a. 预设类别：出现"系统/金手指/异能/穿越"→补「金手指（机制与限制）」；"爱情/CP"→补「感情线（关系与阻碍）」；"悬疑/推理/谜案"→补「谜题（核心悬念与线索布局）」；"权谋/宫斗/战争"→补「势力格局（阵营与博弈）」；"群像/家族/多主角"→补「人物关系网」；b. 开放补充：若构想含预设之外的核心题材词（如无限流/种田/娱乐圈/末世/星际/恐怖等），自行命名一个贴合该题材的分类要素（如「世界规则（副本形式/生存规则）」「资源系统（经济来源/发展目标）」「舞台体系（平台/流量/作品）」「生存法则」「科技体系」「恐惧来源」等）并给出关键内容，补充类别必须与该题材词直接对应；c. 用户构想中没有的类别一律不得输出（如无金手指的故事绝不写"金手指"要素）；自适应分类合计不超过 3 项，避免输出膨胀；
4. 若用户构想含风格基调（轻松/诙谐/深沉/热血等），必须明确写出"风格"要素并给出 2-3 个落地方式；
5. 篇幅 150-300 字，用简洁条目式，不要解释、不要 markdown 代码块、不要输出 JSON。
【自由发挥区】核心要素的措辞、自适应分类的选择与颗粒度、补充方向由你把握，让优化稿读起来具体、可执行、贴合用户原意。`;

// v10.13 优化构想·输出模式后缀：单稿（条目式文本 + 末尾💡编辑意见）
const POLISH_SINGLE_MODE = `\n\n【本次输出模式：单稿】以条目式文本输出一份完整优化构想；末尾另起一行输出"💡 AI 编辑意见："+2-3 句（本稿补全了什么、还建议用户补充什么、可选的发散方向）。`;

// v10.13 优化构想·输出模式后缀：多方案（JSON 载体，2-3 个方向方案 + 编辑意见）
const POLISH_MULTI_MODE = `\n\n【本次输出模式：多方案】严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"advice":"2-3 句编辑意见（补全了什么 / 建议补充什么）","options":[{"name":"方案A 稳健向","text":"完整构想条目式文本"},{"name":"方案B 反差向","text":"完整构想条目式文本"},{"name":"方案C 猎奇向","text":"完整构想条目式文本"}]}
要求：输出 2-3 个方案；每个方案的 text 都是完整独立的结构化构想（含通用核心要素 + 自适应分类），用户可直接编辑；方案差异仅在补全与走向（稳健/反差/猎奇），都必须保留用户明确表达的原意；options 的 name 带方向标签，text 不带 JSON 标记、为纯文本。`;

// v8c 词典增量补全：从已生成章节正文中提取「现有词典未收录」的新人物/新地名/新专名，去重后并入词典。
// 供批量生成章节后的自动补全与词典卡片的「📥 提取新增」共用；人物字段对齐词典契约（age/gender 必填）。
const GLOSSARY_EXTRACT_SYS = `你是长篇小说设定整理助手。给定【本章正文】与【现有词典】，提取正文中出现但现有词典【未收录】的新人物、新地名、新专名。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"characters":[{"name":"人名","identity":"身份/职业/社会身份","age":"岁数/年龄","gender":"性别","appearance":"外貌特征","hobby":"爱好/习惯","relation":"与该人的血缘/人际关联","trait":"性格要点"}],"places":[{"name":"地名","type":"类型","note":"设定要点"}],"propernouns":[{"name":"专名","note":"含义"}]}
规则：
1. 只提取正文中真实出现、且有明确所指（被命名）的实体；纯叙述性泛指不提取。
2. 必须与现有词典逐名去重：同名条目一律不再输出。
3. ★【人物必须输出全部 7 个字段：identity / age / gender / appearance / hobby / relation / trait】
   · 禁止只输出人名、禁止缺字段、禁止省略任何字段；
   · 从正文中提取该人物的身份、年龄、性别、外貌、爱好、关系、性格等信息，正文未明说的字段按上下文合理推断后填写；
   · 实在无法推断的字段填「未知」，不得留空、不得删除该字段；
   · relation 与 identity 务必区分：身份词（捕快/市长/船女）归 identity；带"谁的"的人际关联（XX的妹妹/她的仆人）归 relation。
4. 无明显新实体时输出 {"characters":[],"places":[],"propernouns":[]}。`;

/** 未选结构时的「章节安排」提示：仅要求 AI 输出 structure.chapterPlan，把全部章节按主题/起承转合自由分组、一章不落；
 *  不强制主线/副线/暗线（未选结构时用户本就不要求结构骨架）。集中定义为独立常量，便于以后调整分组口径。 */
const CHAPTER_PLAN_FREE_SYS = `\n\n【章节安排（未选结构时）】请在返回 JSON 的 "structure" 字段中补一个 "chapterPlan"：
"structure":{"chapterPlan":{  // 维度名 → 章标题列表；全书每一章都归入某个维度，一章不落、最后一章也要归组
  "维度名1":["章标题","章标题"],
  "维度名2":["章标题"]
}}
维度名由你按故事内容自由拟定（例如按主题、按起承转合、按人物视角、按事件板块），不必套用任何固定范式；每章都归入某维度、一章不落即可。`;

/** 统一「结构任务块 · 主线条 · 兜底」：仅当用户【未选中任何结构范式】时才推。
 *  S1 之后，选中结构时主线条四格已内联进各 st.outlineSys（见 MAIN_LINE_BLOCK），故此处不再重复推送、避免同一 structure 被两处描述；
 *  仅未选结构时作为轻量主线条骨架要求，让 AI 产出 mainLine/subLines/hiddenLine/pivotPlan（主线必有、副暗汇合有则带、无则空，绝不硬造）。 */
const STRUCTURE_MAIN_SYS = `\n\n【长篇结构设计 · 主线条（未选结构范式时，请一并输出，作为轻量结构骨架）】
请在返回 JSON 顶层的 "structure" 字段中，按下面契约输出一份基础情节骨架：
"structure":{
  "mainLine":"全书唯一主线/核心走向（必有：这本到底讲什么）",
  "subLines":["副线1：内容","副线2：内容"],  // 有则带；若故事确实没有副线就空数组或省略，绝不硬造
  "hiddenLine":"暗线内容（如何埋设、何时揭晓）",  // 有则带；若没有暗线就空字符串或省略，绝不硬造
  "pivotPlan":"汇合/大逆转所在章（点式，如 第20章三方对峙）"  // 有则带；无则该字段省略
}
请完成：① 定全书唯一主线/走向（必填：这本到底讲什么）→ ② 若故事确有副线/暗线/汇合才补，没有就空着、别硬造。
绝不为了"凑三线"而编造不存在的副线暗线；汇合只在确实有多条线交织时才点出。`;

/** 统一「结构任务块 · 章节计划」：仅【无结构专属章节映射】的范式（网状多线 mesh / 单线因果 causal）才输出。
 *  英雄之旅→stageChapters、节拍表→beats、七点→points、分层→volumes 由各自专属字段承载章节映射，故不在此重复要求。 */
const STRUCTURE_PLAN_SYS = `\n\n【长篇结构设计 · 章节计划（仅网状多线 / 单线因果等"无专属章节映射"的结构才一并输出）】
如果所选范式没有自带"阶段 / 节拍 / 锚点 / 卷"式的章节映射字段，请在上述 JSON 的 "structure" 中补一个 "chapterPlan" 字段：
"structure":{
  "chapterPlan":{  // ★必有：维度名 → 章标题列表；书中每一章都要被归入某个维度，一章不落、最后一章也要归组
    "维度名1":["章标题","章标题"],
    "维度名2":["章标题"]
  }
}
维度名按所选范式叫法（网状多线用各线索名、单线因果用各关卡名），反映的都是"章节→维度"的分组，每一章都归入某维度、一章不落。`;

// 结构是否自带"章节→维度"的专属映射字段（英雄之旅 stageChapters / 节拍表 beats / 七点 points / 分层 volumes）。
// 选这类结构时，章节安排用专属字段承载，不再要求统一 chapterPlan，避免两份互斥 schema 同时注入。
function stHasStageMap(st){ return !!st && ['hero','savecat','seven','layered'].includes(st.id); }

// 取"全部章节安排"呈现数据：优先结构专属章节映射（stageChapters/beats/points），回退统一 chapterPlan。返回 {map} 或 null。
// 分层 volume 单独处理；此函数供 structureCard / structurePlanBlock 共用，便于以后扩展新结构字段。
function structureChapterPlan(s, o){
  if(s && s.stageChapters && typeof s.stageChapters==='object' && Object.keys(s.stageChapters).length) return { map: s.stageChapters };
  if(s && s.beats && typeof s.beats==='object' && Object.keys(s.beats).length) return { map: s.beats };
  if(s && s.points && typeof s.points==='object' && Object.keys(s.points).length) return { map: s.points };
  if(s && s.chapterPlan && typeof s.chapterPlan==='object' && Object.keys(s.chapterPlan).length) return { map: s.chapterPlan };
  return null;
}

function buildOutlineSys(){
  const st = selStructure(), rh = selRhythm();
  const parts = [];
  // 顺序：①篇幅体量(章节数)最先 → ②节奏(选中才推) → ③结构(选中才推) → ④主线条任务块(仅未选结构推·兜底) → ⑤基础大纲契约 OUTLINE_GEN_SYS(未选结构才推·兜底) → ⑥v8 词典块。
  // 用户提示词作为 user 消息已在最前；章节数先告知；节奏先于结构——先定风格基调/调性，结构骨架再落在统一节奏里。
  // ① 篇幅体量（含用户定死的章节数）：最先，让后续所有结构安排都基于已知的 N 章
  parts.push('\n【篇幅体量】\n'+outlineSizeNote());
  // ①-2 标题风格槽位：v10.18 起标题风格由顶部「写作风格 → ① 标题风格」提供（含原「标题风格」维度迁入的 归纳/画龙点睛/文学语句/字数工整）。
  //   旧版 recipeSet.titleStyle 遗留数据兜底兼容；未选则不发任何标题要求，AI 自由发挥。
  const ttNote = (titleStyleNote() + writeStyleTitleBlock() + '\n').replace(/\n{3,}/g,'\n\n');
  if(ttNote.trim()) parts.push('\n'+ttNote.trim());
  // ② 节奏槽位：v10.18 起「节奏风格」维度已从生成大纲界面移除，此槽位恒空（无 UI 入口则不复用），仅为旧数据兼容保留。
  if(rh && rh.outlineNote) parts.push('\n【节奏风格 · '+rh.name+'】\n'+rh.outlineNote);
  // ③ 结构槽位：范式「选中才推」。选中结构时推其专属大纲生成命令（含大纲+结构，主线条四格已内联在 st.outlineSys 中）；
  //    ★未选结构时此槽位为空、不推任何结构命令给 AI（结构与节奏一致：未选则不注入结构），由 AI 按用户提示词自然发挥。
  if(st) parts.push(st.outlineSys);
  // ④ 统一「主线条」任务块：仅未选结构时推（兜底）。
  //    选中结构时主线条四格已由 st.outlineSys 内联提供（S1，见 MAIN_LINE_BLOCK），此处不再重复推送，避免同一 structure 被两处描述；
  //    未选结构时作为唯一轻量结构骨架要求，让 AI 产出主线/副暗/汇合（有则带、无则空，绝不硬造）。
  if(!st) parts.push(STRUCTURE_MAIN_SYS);
  // 统一「章节计划」任务块：仅无专属章节映射的范式（网状多线/单线因果）才推，避免与英雄之旅/节拍表/七点/分层的专属字段重复。
  if(st && !stHasStageMap(st)) parts.push(STRUCTURE_PLAN_SYS);
  // ⑤ 基础大纲契约 OUTLINE_GEN_SYS（title/logline/chapters 的 JSON 契约）：置于词典之前。
  //    互斥原则：选中结构时该契约已由 st.outlineSys 独家承担（大纲契约+结构一体），故不重复推，避免两套 schema 同时注入；
  //    仅未选结构时推，作为稳定产出大纲骨架的兜底。
  if(!st) parts.push(OUTLINE_GEN_SYS);
  // ⑤-2 未选结构时：要求 AI 自由分组输出 chapterPlan（按主题/起承转合），作为"全部章节写作安排"的呈现。
  if(!st) parts.push(CHAPTER_PLAN_FREE_SYS);
  parts.push(outlineGlossaryInject(state.pendingGlossary));   // ⑥ v8 双轨：有导引用权威块，无导入保持原「请自造词典」块
  parts.push('\n\n'+ORIGINALITY_OUTLINE_SYS);                   // ⑦ v10.12 原创性要求（防雷同）· 大纲侧，全部结构范式生效
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
  const cs=(g.characters||[]).map(c=>{
    const head=[c.identity||'',(c.age?`${c.age}岁`:''),c.gender||''].filter(Boolean).join('·');
    const tail=[c.appearance?`外貌:${c.appearance}`:'',c.hobby?`爱好:${c.hobby}`:'',c.relation?`关系:${c.relation}`:'',c.trait?`性格:${c.trait}`:''].filter(Boolean).join('｜');
    return `${c.name}${(head||tail)?`（${head}${tail?'｜'+tail:''}）`:''}`;
  }).join('； ');
  const ps=(g.places||[]).map(p=>`${p.name}${p.type?`（${p.type}）`:''}${p.note?`｜${p.note}`:''}`).join('； ');
  const pn=(g.propernouns||[]).map(p=>`${p.name}${p.note?`（${p.note}）`:''}`).join('； ');
  const fill = state.glossAllowFill ? '\n允许并鼓励你在不在底稿中的新设定上自由新增人物/地名/专名。' : '\n除非必要，避免无谓地新增与底稿无关的实体。';
  return `\n\n【复用词典 · 权威一致性底稿（v8）】以下是既有的权威词典，请在返回 JSON 顶层照常追加 glossary 字段，并以本底稿为主集：${adherenceSys(state.glossAdherence, state.glossAllowFill)}
"glossary":{"characters":[{"name":"人物姓名","identity":"身份/职业/社会身份","age":"岁数/年龄","gender":"性别","appearance":"外貌特征","hobby":"爱好/习惯","relation":"与该人的血缘/人际关联（妹妹/姐姐/朋友/仆人等）","trait":"性格要点"}],"places":[{"name":"地名","type":"类型","note":"设定"}],"propernouns":[{"name":"专名","note":"含义"}]}
人物：${cs||'（无）'}
地点：${ps||'（无）'}
专名：${pn||'（无）'}
底稿中已有人名/地名/专名一律沿用，不得推倒重造一套；只按本作大纲补充新增条目，新增条目 schema 与该类别保持一致。新增/沿用人物均须区分 relation（血缘/人际关联，带"谁的"，如「林晚的妹妹」「她的仆人」）与 identity（职业/社会身份，可独立成句，如「捕快」「市长」），禁止把身份词写进 relation。${fill}`;
}
// v8 阶段3：本体词典块（章节正文共同复用）。取合并后的大纲词典，生成「严格服从」一致性基准。
// v8b（建议1）：正文也全量带词典详情（人物关系/身份/外貌/爱好/性格、地点类型/说明、专名含义），
// 不再做瘦身上限——详情对提高重生成的上下文一致性收益大于其微小 token 开销（约 +300~500 token/章）。
// 统一「长篇结构设计」纯文本块。所有范式共用：主线 → 副线/暗线/汇合（有则带、无则空、不硬造）→ 全章节计划。
// 被逐章梗概生成（genChapterPlans）注入 AI 消费，保证生成上下文与全文结构一致。
// 若缺 mainLine/chapterPlan，自动做最小兜底（与 genOutline 的兜底逻辑一致），保证始终有内容。
function structurePlanBlock(o){
  if(!o || typeof o !== 'object') return '';
  const s = (o.structure && typeof o.structure === 'object') ? o.structure : {};
  const lines = [];
  const mainLine = s.mainLine || o.logline || '';
  if(mainLine) lines.push('主线：'+mainLine);
  if(s.subLines && s.subLines.length) lines.push('副线：'+(s.subLines||[]).join('；'));
  if(s.hiddenLine) lines.push('暗线：'+s.hiddenLine);
  if(s.pivotPlan) lines.push('汇合/大逆转：'+s.pivotPlan);
  // 全章节计划：优先结构专属章节映射，回退 chapterPlan；分层卷结构单独成行。
  const plan = structureChapterPlan(s, o);
  if(plan){
    lines.push('全章节计划：');
    Object.keys(plan.map).forEach(k=>{
      const arr = Array.isArray(plan.map[k]) ? plan.map[k] : [plan.map[k]];
      if(arr.length) lines.push('·（'+k+'）'+arr.join('、'));
    });
  } else if((o.chapters||[]).length){
    lines.push('全章节计划：');
    lines.push('·（全章规划）'+ (o.chapters||[]).map(c=>c&&c.title).filter(Boolean).join('、'));
  }
  // 分层递归卷结构
  if(o.volumes && o.volumes.length){
    lines.push('卷结构：');
    o.volumes.forEach(v=>{
      const chs = (v.chapters||[]).map(c=>c&&c.title).filter(Boolean);
      if(chs.length) lines.push('·（'+(v.name||'卷')+'）'+chs.join('、'));
    });
  }
  return lines.join('\n');
}

// v2.4 结构注入「无标题版」：只输出 主线/副线/暗线/汇合，不输出"全章节计划/卷结构"的章节标题清单。
// 供章节生成注入使用（v2.3 用户要求：全部章节标题不夹带在大纲/结构/词典里）；structurePlanBlock 保留给大纲卡片/词典📄面板/逐章梗概生成。
function structurePlanBlockNoTitles(o){
  if(!o || typeof o !== 'object') return '';
  const s = (o.structure && typeof o.structure === 'object') ? o.structure : {};
  const lines = [];
  const mainLine = s.mainLine || o.logline || '';
  if(mainLine) lines.push('主线：'+mainLine);
  if(s.subLines && s.subLines.length) lines.push('副线：'+(s.subLines||[]).join('；'));
  if(s.hiddenLine) lines.push('暗线：'+s.hiddenLine);
  if(s.pivotPlan) lines.push('汇合/大逆转：'+s.pivotPlan);
  return lines.join('\n');
}

// 追加·传给 AI 的词典：完整保留原始内容（不删重复、不合并、不改结构），仅做「分类 + 排序 + 重复检测标注」。
// 1) 三类各自保留 ALL 条目（含重复名称），不删除任何文字与人名——重复情况只「检测并标注」，供 AI 知悉而非删改；
// 2) 每类按名称中文排序，条理化、易扫读（排序不改变数据本身）；
// 3) 检测同类内重名与跨类同名，返回 repeat 报告（仅提示，不动数据）。
// 仅作用于生成上下文，绝不改动 state 里的原始词典。
function glossaryForAI(){
  const g = (state.outline && state.outline.glossary) || {};
  const nrm = s => String(s||'').trim();
  const sortByName = arr => (arr||[]).slice().sort((a,b)=>String(a&&a.name||'').localeCompare(String(b&&b.name||''),'zh-Hans-CN'));
  const characters = sortByName(g.characters);
  const places     = sortByName(g.places);
  const propernouns= sortByName(g.propernouns);
  // 同类内重名检测（仅统计，不删）：返回 [{name, count}]
  const repeatIn = arr => {
    const m = {};
    arr.forEach(it=>{ const n = nrm(it.name); if(n) m[n] = (m[n]||0)+1; });
    return Object.keys(m).filter(n=>m[n]>1).map(n=>({name:n, count:m[n]})).sort((a,b)=>b.count-a.count);
  };
  // 跨类同名检测：同一名称出现在多类，提示 AI 视作同一实体而非重复
  const tag = {characters:'人物', places:'地点', propernouns:'专名'};
  const seen = {};
  [[characters,'characters'],[places,'places'],[propernouns,'propernouns']].forEach(([arr,cat])=>{
    arr.forEach(it=>{ const n = nrm(it.name); if(n) (seen[n]=seen[n]||[]).push(cat); });
  });
  const cross = Object.keys(seen).filter(n=>seen[n].length>1).map(n=>({name:n, cats:seen[n].map(c=>tag[c])}));
  return { characters, places, propernouns, repeatIn, cross, empty: sourceHasGlossary(g) ? '' : '（无）' };
}
// 词典「重复情况检查」只读提示，供用户在词典卡片直接看到是否有重复（仅提示，绝不动数据）
function glossaryDupNoteHtml(){
  const rf = glossaryForAI();
  const repLabels = {characters:'人物', places:'地点', propernouns:'专名'};
  const lines = [];
  [['characters',rf.characters],['places',rf.places],['propernouns',rf.propernouns]].forEach(([cat,arr])=>{
    const dup = rf.repeatIn(arr);
    if(dup.length) lines.push(`${repLabels[cat]}：「${dup.map(d=>`${d.name}×${d.count}`).join('」、')}」`);
  });
  if(rf.cross.length) lines.push('跨类同名：'+rf.cross.map(x=>`${x.name}（${x.cats.join('+')}）`).join('、'));
  if(!lines.length) return '';
  return `<div class="gs-panel gs-dup-note"><div class="gs-panel-title">⚠️ 重复情况检查（仅提示，未做任何删除/合并；原词典原样保留）</div>
    <pre class="gs-pre">${esc(lines.join('\n'))}</pre></div>`;
}

// 每次生成新章节时，向 AI 提供「全局创作上下文」：
// A) 【内容】块——故事大纲(logline) → 逐章梗概(全章) → 长篇结构设计。恒定注入，让 AI 始终了解整本小说大纲、走向架构与每章内容，不依赖词典是否存在；
// B) 【设定词典】——人物/地点/专名（完整保留、分类排序、同名仅提示不删）。仅当词典有条目时注入，避免空标签浪费 token。
function chapterGlossaryBlock(){
  const o = state.outline;
  if(!o) return '';
  // v10.18 不再注入【内容】块（logline+长篇结构设计）——章节 AI 只收词典一致性基准；
  // 结构定位改由 longChapterContext 以精简形式注入；逐章梗概生成改用 structurePlanBlockNoTitles 提供结构走向（不含标题清单，遵 v2.3）。
  let body = `\n\n【全局创作上下文（严格服从，禁止自造新名）】`;
  const g = (o && o.glossary) || {};
  if(sourceHasGlossary(g)){
    const rf = glossaryForAI();
    const cDetail = c => [c.identity?`身份:${c.identity}`:'', c.age?`岁数:${c.age}`:'', c.gender?`性别:${c.gender}`:'', c.appearance?`外貌:${c.appearance}`:'', c.hobby?`爱好:${c.hobby}`:'', c.relation?`关系:${c.relation}`:'', c.trait?`性格:${c.trait}`:''].filter(Boolean).join('；');
    const pDetail = p => [p.type?`类型:${p.type}`:'', p.note?`说明:${p.note}`:''].filter(Boolean).join('；');
    const cs = rf.characters.map(c=> `${c.name}${cDetail(c)?`（${cDetail(c)}）`:''}`).join('、');
    const ps = rf.places.map(p=> `${p.name}${pDetail(p)?`（${pDetail(p)}）`:''}`).join('、');
    const pn = rf.propernouns.map(p=> `${p.name}${p.note?`（${p.note}）`:''}`).join('、');
    // 同类内重名：仅检测并标注提示 AI（条目本身原样全保留，不删除任何一例）
    const repLabels = {characters:'人物', places:'地点', propernouns:'专名'};
    const repeatNotes = [];
    [['characters',rf.characters],['places',rf.places],['propernouns',rf.propernouns]].forEach(([cat,arr])=>{
      const dup = rf.repeatIn(arr);
      if(dup.length) repeatNotes.push(`${repLabels[cat]}：${dup.map(d=>`「${d.name}」×${d.count}`).join('、')}`);
    });
    const repeatNote = repeatNotes.length ? `\n【词典同名提示（非删除，仅供知悉）】以下名称在同一类别中出现多次，均按原样保留：${repeatNotes.join('；')}` : '';
    // 追加·跨类同名提示：让 AI 识别「同一实体分属多类」，而非当作重复避免自造新名
    const crossNote = rf.cross.length ? `\n【跨类同名提示】以下名称在多类中出现（系同一实体分属多类，原样保留，不要当成两条新增，也不要据此另造新名）：${rf.cross.map(x=>`${x.name}（${x.cats.join('+')}）`).join('、')}` : '';
    body += `\n·【设定词典】（给定的人/地/专名，正文一律采用，人名/地名/专名不可自造新名，人物关系/性格、地点类型、专名含义按此保持统一）\n人物：${cs||'（无）'}\n地点：${ps||'（无）'}\n专名：${pn||'（无）'}${repeatNote}${crossNote}`;
  }
  return body;
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
// v2.4 人物字段契约（与大纲词典 GLOSSARY_SYS 完全一致：name + 7 字段）；词典卡字段检查共用
const CHAR_FIELDS = ['identity','age','gender','appearance','hobby','relation','trait'];
const CHAR_FIELD_LABEL = { identity:'身份', age:'岁数', gender:'性别', appearance:'外貌', hobby:'爱好', relation:'关系', trait:'性格' };
// v2.4 提取结果补全：空字段一律填「未知」，保证新人物 7 字段齐全再入库（禁止"只有名字的新人物"）
function completeCharFields(c){
  CHAR_FIELDS.forEach(k=>{ if(c[k]==null || String(c[k]).trim()==='') c[k] = '未知'; });
  return c;
}
// v8c 词典增量补全——从已生成正文提取「未收录」新实体（人物/地名/专名），字段白名单过滤后返回
async function extractNewGlossary(bodyTexts){
  const g = (state.outline && state.outline.glossary) || {};
  const body = (bodyTexts||[]).filter(Boolean).map(String).join('\n\n').slice(0, 15000);  // 正文截断上限，控 token
  if(!body.trim()) return {characters:[], places:[], propernouns:[]};
  const dict = [['characters','人物'],['places','地点'],['propernouns','专名']].map(([k,label])=>{
    const arr = (g[k]||[]).map(x=>x&&x.name).filter(Boolean);
    return arr.length ? `${label}：${arr.join('、')}` : `${label}：（无）`;
  }).join('\n');
  const user = `【现有词典】\n${dict}\n\n【本章正文】\n${body}`;
  const txt = await callDeepSeek(GLOSSARY_EXTRACT_SYS, user, {maxTokens: 2000, temperature: resolveActiveSpec().qcTemp});   // v10.8 质检/提取温度
  const j = parseJson(txt) || {};
  const keepChar = c => {
    if(c.name == null || !String(c.name).trim()) return null;
    const o = { name: String(c.name).trim() };
    CHAR_FIELDS.forEach(k=>{ if(c[k]!=null) o[k] = String(c[k]).trim(); });
    return completeCharFields(o);   // v2.4 缺字段补「未知」，保证 7 字段齐全
  };
  const keepPlace = p => { const o = {}; ['name','type','note'].forEach(k=>{ if(p[k]!=null) o[k]=String(p[k]).trim(); }); return o.name ? o : null; };
  const keepProp = p => { const o = {}; ['name','note'].forEach(k=>{ if(p[k]!=null) o[k]=String(p[k]).trim(); }); return o.name ? o : null; };
  return {
    characters: (Array.isArray(j.characters)?j.characters:[]).map(keepChar).filter(Boolean),
    places:     (Array.isArray(j.places)?j.places:[]).map(keepPlace).filter(Boolean),
    propernouns:(Array.isArray(j.propernouns)?j.propernouns:[]).map(keepProp).filter(Boolean)
  };
}
// 把提取结果按 name 去重（同名以现有为准）并入词典；新增条目打 _auto 标记（供清理弹窗默认勾选）。返回 {c,p,k,total}
function mergeExtractedGlossary(ext){
  const o = state.outline; if(!o) return {c:0,p:0,k:0,total:0};
  if(!o.glossary) o.glossary = {characters:[], places:[], propernouns:[]};
  const gl = o.glossary;
  const n = {c:0, p:0, k:0};
  const mergeArr = (cur, add, tag) => {
    const have = new Set((cur||[]).map(x=>String(x&&x.name||'').trim()).filter(Boolean));
    (add||[]).forEach(it=>{
      const nm = String(it.name||'').trim(); if(!nm || have.has(nm)) return;
      cur.push({ ...it, _auto:true }); have.add(nm); n[tag]++;
    });
  };
  mergeArr(gl.characters, ext.characters, 'c');
  mergeArr(gl.places, ext.places, 'p');
  mergeArr(gl.propernouns, ext.propernouns, 'k');
  n.total = n.c + n.p + n.k;
  return n;
}
// 批量生成章节后的自动补全入口：开关开 + 词典已建立才执行；失败静默不阻塞
async function autoExtractGlossary(){
  if(!isLong() || !state.glossAutoFill) return;
  if(!state.outline || !sourceHasGlossary(state.outline.glossary)) return;
  const written = state.chapters.filter(c=> c && c.content && String(c.content).trim()).map(c=>c.content);
  if(!written.length) return;
  try{
    const ext = await extractNewGlossary(written);
    const n = mergeExtractedGlossary(ext);
    if(n.total > 0){ persist(); toast(`词典已补全：+${n.c} 人物（含完整设定）、+${n.p} 地名、+${n.k} 专名`); }
  }catch(e){ /* 静默失败，不阻塞章节生成 */ }
}
// 全部已生成正文中「零出现」的词典条目（可能因重生成覆盖而失效；复用 checkGlossaryCoverage 的统计）
function scanUnusedGlossary(){
  const s = checkGlossaryCoverage();
  const g = (state.outline && state.outline.glossary) || {};
  const withAuto = (unused, src) => (unused||[]).map(x => {
    const it = (src||[]).find(y=> String(y&&y.name||'').trim() === x.name);
    return { name: x.name, _auto: !!(it && it._auto) };
  });
  return {
    characters: withAuto(s.chars.unused, g.characters),
    places:     withAuto(s.places.unused, g.places),
    propernouns:withAuto(s.props.unused, g.propernouns)
  };
}
// 手动「📥 提取新增」：对全部已生成正文提取一次（补历史遗漏），与自动补全共用提取/合并逻辑
async function manualExtractGlossary(){
  const written = state.chapters.filter(c=> c && c.content && String(c.content).trim()).map(c=>c.content);
  if(!written.length){ toast('尚无已生成章节正文'); return; }
  toast('正在提取新增词典条目…');
  try{
    const ext = await extractNewGlossary(written);
    const n = mergeExtractedGlossary(ext);
    if(n.total > 0){ persist(); render(); toast(`词典已补全：+${n.c} 人物（含完整设定）、+${n.p} 地名、+${n.k} 专名`); }
    else toast('未发现词典未收录的新实体');
  }catch(e){ toast('提取失败：'+e.message); }
}
// v8c 清理弹窗：列出全部已生成正文「零出现」的条目，勾选后确认删除（防误删：自动补全条目默认勾选，原始条目不勾选）
function openCleanPanel(){
  const closePanel = ()=>{ const p=$('#cleanPanel'); if(p) p.remove(); };
  const s = scanUnusedGlossary();
  const written = state.chapters.filter(c=>c && c.content && String(c.content).trim()).length;
  const row = (arr, icon) => arr.length ? arr.map(x=>`
    <label class="gs-hit"><input type="checkbox" class="gs-clean-cb" data-name="${esc(x.name)}" ${x._auto?'checked':''} />
      <span>${esc(x.name)}</span>${x._auto?'<i class="gs-auto-tag">🆕 自动补全</i>':'<i class="gs-orig-tag">原始条目</i>'}</label>`).join('') : '';
  const empty = !s.characters.length && !s.places.length && !s.propernouns.length;
  const ov = document.createElement('div');
  ov.id='cleanPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>🧹 清理未使用条目</b><button class="gs-x" data-clean-close>✕</button></div>
      <div class="gs-modal-sub">已生成 ${written} 章。以下条目在全部已生成正文中均未出现，可能因重生成覆盖而失效；尚未写的章节可能仍会用到，请谨慎勾选。</div>
      <div class="gs-body">
        ${empty ? '<p class="muted">✓ 没有需要清理的条目（全部词典条目都已在正文中出现）。</p>' : `
          ${s.characters.length?`<div class="gs-q">👤 人物</div>${row(s.characters,'👤')}`:''}
          ${s.places.length?`<div class="gs-q">🏞️ 地名</div>${row(s.places,'🏞️')}`:''}
          ${s.propernouns.length?`<div class="gs-q">📌 专名</div>${row(s.propernouns,'📌')}`:''}
        `}
      </div>
      ${empty
        ? `<div class="gs-modal-head" style="justify-content:flex-end;border:none"><button class="btn ghost" data-clean-close>关闭</button></div>`
        : `<div class="gs-modal-head" style="justify-content:flex-end;border:none"><button class="btn ghost" data-clean-close>取消</button><button class="btn primary" data-clean-do>确认删除勾选项</button></div>`}
    </div>`;
  document.body.appendChild(ov);
  $$('[data-clean-close]').forEach(b=> b.onclick = closePanel);
  const doBtn = $('[data-clean-do]');
  if(doBtn) doBtn.onclick = ()=>{
    const picked = $$('.gs-clean-cb:checked').map(cb=> cb.dataset.name);
    if(!picked.length){ toast('未勾选任何条目'); return; }
    const g = state.outline && state.outline.glossary; if(!g){ closePanel(); return; }
    let c=0,p=0,k=0;
    g.characters = (g.characters||[]).filter(x=>{ if(picked.includes(String(x&&x.name||'').trim())){ c++; return false; } return true; });
    g.places     = (g.places||[]).filter(x=>{ if(picked.includes(String(x&&x.name||'').trim())){ p++; return false; } return true; });
    g.propernouns= (g.propernouns||[]).filter(x=>{ if(picked.includes(String(x&&x.name||'').trim())){ k++; return false; } return true; });
    persist(); closePanel(); render();
    toast(`已清理：-${c} 人物、-${p} 地名、-${k} 专名`);
  };
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
// 体量提示（拼入章节正文提示词）：只交代全书章节数与当前章位，不给任何字数限制
function sizeChapterInjection(){
  const n = chapterCountVal();
  const total = n ? `全书共 ${n} 章；` : '';
  return `${total}本章正文不设字数上限，按剧情需要自然成稿，章与章之间衔接顺畅、节奏自然。`;
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
function buildChapterSys(styleOverride){
  const st = selStructure(), rh = selRhythm();
  const parts = [];
  parts.push(st ? st.chapterSys : PROMPTS.longChapterSys);
  const styleNote = chapterStyleNote(styleOverride);   // v2.4 风格块提到 System 开头（身份之后第一块，最高优先）
  if(styleNote) parts.push(styleNote);
  if(rh && rh.chapterNote) parts.push('\n【节奏风格 · '+rh.name+'】\n'+rh.chapterNote);
  parts.push('\n【篇幅体量】\n'+sizeChapterInjection());
  parts.push('\n\n'+ORIGINALITY_CHAPTER_SYS);   // v10.12 原创性要求（防雷同）· 章节侧，单章/批量/重生成统一生效
  return parts.join('\n\n');
}
// 兼容旧调用入口
function longRecipe(){ return selStructure() || STRUCTURES[0]; }
function longOutlineSys(){ return buildOutlineSys(); }
function longChapterSys(styleOverride){ return buildChapterSys(styleOverride); }

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
    desc:'先确立世界观、人物小传与伏笔架构再动笔；章章服务整体。',
    sys:'动笔前先确立清晰的世界观（时代/地理/力量或社会规则）、主要人物小传（动机/弧光/关系网）与贯穿全书的伏笔与核心冲突。每一章都须服务于整体架构，避免随意发散。' },
  { id:'webnovel',    name:'黄金网文节奏', short:'网文节奏',
    desc:'开篇抛冲突与悬念；因果链清晰、抉择有代价、阶梯递进、情绪张弛有度。',
    sys:'遵循强节奏网文写法：开篇尽快抛出核心冲突与悬念（金手指/秘密）；每章保证因果链清晰、角色抉择有代价、实力或关系阶梯递进、情绪节奏有张有弛（爽点-压抑-爆发交替）；以对话推动剧情、少冗长描写。' },
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
/* 故事页内联创作规范选择器（替代原顶栏规范弹层） */
function specPickerHtml(){
  const cur = getSpec().id;
  return `<div class="spec-pick" id="specPicker">
    <div class="spec-pick-head"><span>📐 创作规范（作用于「写小说」）</span></div>
    <div class="spec-pick-opts">${SPECS.map(s=>`<button type="button" class="spec-opt ${s.id===cur?'active':''}" data-spec="${s.id}" title="${esc(s.desc)}">${esc(s.short)}</button>`).join('')}</div>
  </div>`;
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
    histRows = state.titleHistory.map((h,idx)=>
      `<div class="hist-row"><span class="hist-name">${esc(h.name)}</span><span class="hist-date">${esc(h.date)}</span>
        <span class="hist-ops">
          <button type="button" class="icon-btn hist-op" data-hist-restore="${esc(h.name)}" title="恢复为此名">↩</button>
          <button type="button" class="icon-btn hist-op" data-hist-del="${idx}" title="删除该记录">🗑</button>
        </span></div>`
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

// 故事页面上部「创作范式」摘要：展示本次长篇所选的结构/节奏/质量/体量，供用户生成大纲后随时回看。
// 未选的项目如实显示"未选/未指定"；结构未选时按既定规则保持留空（让 AI 按构想发挥）。
function recipeSummaryBar(){
  if(!isLong()) return '';
  const st = selStructure();
  const ccNum = chapterCountVal();
  const szLabel = ccNum ? `全书 ${ccNum} 章` : '未填章节数';
  const qLabel = state.autoQC ? '自动质检' : '已关闭';
  const labelSt = st ? st.name : (state.recipeSet && (state.recipeSet.structure===null||state.recipeSet.structure===undefined) ? '由 AI 按构想发挥' : '未选');
  const pill = (label, val) => `<span class="rs-item">${label}<b>${esc(val)}</b></span>`;
  return `<div class="card recipe-summary">
    <div class="rs-title">🏗️ 创作范式</div>
    <div class="rs-row">
      ${pill('结构', labelSt)}
      ${pill('质量', qLabel)}
      ${pill('章节数', szLabel)}
    </div>
  </div>`;
}

/* =========================================================
 * v2.0 写作风格选择器：主卡片 + 预设 + 收藏 + 词库管理
 * ========================================================= */
const WRITE_PRESETS = [
  { id:'clear',          name:'🧹 默认（无风格）', tags:[], intensity:2 },
  { id:'preset-humor',   name:'😂 网感轻喜',  tags:['humor','memes','plain'], intensity:2 },
  { id:'preset-art',     name:'🌸 文艺唯美',  tags:['ornate','poetry','implicit'], intensity:2 },
  { id:'preset-classic', name:'🏛️ 古典正剧',  tags:['solemn','classic','idiom'], intensity:3 },
  { id:'preset-modern',  name:'📖 现代文学',  tags:['modern','aphorism','cold'], intensity:2 },
  { id:'preset-passion', name:'🔥 热血燃向',  tags:['passion','shortbeat'], intensity:3 }
];
function writeStyleState(){ return state.chapterStyle = state.chapterStyle || { tags:[], intensity:2, collapsed:false }; }
// v2.1 主卡「生效确认」：草稿态（内存，不参与生成）vs 生效态（state.chapterStyle）
let wsDraft = null;   // null=未编辑（与生效一致）；非 null=有草稿待应用
function wsDraftInit(){
  if(!wsDraft){ const st = writeStyleState(); wsDraft = { tags:(st.tags||[]).slice(), intensity: st.intensity||2 }; }
  return wsDraft;
}
function wsDraftDirty(d, st){
  const a = ((d&&d.tags)||[]).slice().sort().join(',');
  const b = ((st&&st.tags)||[]).slice().sort().join(',');
  return a !== b || ((d&&d.intensity)||2) !== ((st&&st.intensity)||2);
}
// 局部刷新主卡 UI（不重建 DOM，避免丢焦点）：chips 高亮 / 摘要行双态 / 应用按钮 / 提示行
function refreshWsUI(){
  const st = writeStyleState();
  const dirty = !!wsDraft && wsDraftDirty(wsDraft, st);
  const draft = wsDraft || st;
  const intTxt = ['','轻','中','重'][draft.intensity] || '中';
  const selName = (draft.tags||[]).map(id=>{ const s=writeStyleById(id); return s?s.name:id; }).join(' + ') || '无';
  const sum = $('.ws-sum');
  if(sum){ sum.textContent = (dirty?'⚠️ 待应用':'✔ 已生效')+' · '+(draft.tags||[]).length+' 项 · '+intTxt+' · '+selName; sum.classList.toggle('dirty', dirty); }
  $$('[data-ws-tag]').forEach(b=> b.classList.toggle('on', (draft.tags||[]).includes(b.dataset.wsTag)));
  $$('[data-ws-int]').forEach(b=> b.classList.toggle('on', draft.intensity === +b.dataset.wsInt));
  const ap = $('[data-ws-apply]');
  if(ap){ ap.disabled = !dirty; ap.classList.toggle('disabled', !dirty); }
  const hint = $('.ws-dirty-hint');
  if(hint) hint.style.display = dirty ? '' : 'none';
}
// 通用 chips / 浓度段选渲染（主卡片与重生成弹窗复用；dataPrefix 区分绑定域）
// opts.plus：每组末尾加「＋」添加入口；opts.cardFold：主卡启用「章节风格」折叠（默认收拢）
// v10.19 写作风格三组配色方案：色序固定 [标题(tone), 梗概(texture), 章节(element)]（即上/中/下）
// 来自用户提供的 11 套三色搭配图；空字符串代表「默认无配色」。存入 cfg.styleCustom.colorScheme（存索引，''=默认）
const WS_COLOR_SCHEMES = [
  { id:'none',    name:'默认（无配色）', c:[] },
  { id:'s1',  name:'活力橙紫青', c:['#f84914','#59187e','#2fb4af'] },
  { id:'s2',  name:'海洋蓝青',   c:['#1e95d4','#78cede','#b1e4e7'] },
  { id:'s3',  name:'皇家蓝绛红', c:['#0176bb','#c42536','#dcb582'] },
  { id:'s4',  name:'蔷薇粉紫',   c:['#f6afad','#c49ee4','#e2d8ef'] },
  { id:'s5',  name:'绯红玫紫',   c:['#f83177','#c6979c','#fcbed4'] },
  { id:'s6',  name:'绯红钢青',   c:['#fa2742','#7384af','#f8b79a'] },
  { id:'s7',  name:'青黄珊瑚',   c:['#54d5c7','#edba38','#f65150'] },
  { id:'s8',  name:'深蓝明黄',   c:['#17519e','#f7dd2f','#4fcbe9'] },
  { id:'s9',  name:'薄荷明黄',   c:['#8fedc2','#fdd741','#24b4a5'] },
  { id:'s10', name:'暖金珊瑚',   c:['#f4d474','#ef5a56','#f9e9da'] },
  { id:'s11', name:'自然翠金',   c:['#67d47e','#efeb86','#f5b11e'] },
];
/* ===== 配色管理（v10.20）：内置11套 + 我的自定义；支持删除 / 撤销 / 恢复全部 / 新建三色 ===== */
function wsColorCfgOf(c){ c.styleCustom = c.styleCustom || { notes:{},added:[],removed:[] }; c.styleCustom.colorSchemes = c.styleCustom.colorSchemes || { custom:[], removedCustom:[], removedBuiltin:[], undo:[] }; return c.styleCustom.colorSchemes; }
function wsColorCfg(){ return wsColorCfgOf(getCfg()); }               // 只读访问
function wsCustomColors(){ return wsColorCfg().custom || []; }        // 未删除的自定义
function wsRemovedBuiltin(){ return wsColorCfg().removedBuiltin || []; }
function wsRemovedCustom(){ return wsColorCfg().removedCustom || []; }
function wsUndoLog(){ return wsColorCfg().undo || []; }
// 展示用完整方案列表：内置（未删）+ 我的自定义（未删）
function wsColorSchemesList(){
  const rm = wsRemovedBuiltin();
  return WS_COLOR_SCHEMES.filter(s=>!rm.includes(s.id)).concat(wsCustomColors());
}
// 取某方案的三色（含已删除的自定义，供撤销恢复用）；无配色返回空数组
function wsSchemeColors(id){
  if(id==='none') return [];
  const s = WS_COLOR_SCHEMES.find(x=>x.id===id) || wsCustomColors().find(x=>x.id===id) || wsRemovedCustom().find(x=>x.id===id);
  return s ? (s.c||[]) : [];
}
function wsSchemeName(id){
  if(id==='none') return '默认（无配色）';
  const s = WS_COLOR_SCHEMES.find(x=>x.id===id) || wsCustomColors().find(x=>x.id===id);
  return s ? s.name : id;
}
// 当前选中方案；若所选配色已被删除则回落「默认」
function wsColorSchemeId(){
  const sc = getCfg().styleCustom||{};
  const id = sc.colorScheme || 'none';
  if(id==='none') return 'none';
  if(WS_COLOR_SCHEMES.find(s=>s.id===id) && !wsRemovedBuiltin().includes(id)) return id;
  if(wsCustomColors().find(s=>s.id===id)) return id;
  return 'none';
}
// 重建「我的自定义」配色的注入 CSS（[data-cs="cu_*"] → 三色变量），供卡片/重生成弹窗即时着色
function rebuildCustomColorCss(){
  let el = document.getElementById('wsCustomCss');
  if(!el){ el = document.createElement('style'); el.id='wsCustomCss'; document.head.appendChild(el); }
  el.textContent = wsCustomColors().map(s=>`[data-cs="${s.id}"]{--c-tone:${s.c[0]};--c-texture:${s.c[1]};--c-element:${s.c[2]}}`).join('\n');
}
function writeStyleChipsHtml(sel, dataPrefix, opts){
  opts = opts || {};
  const lib = writeStyleLib();
  const st = writeStyleState();
  const elemOpen = !!st.elemOpen;   // 章节风格默认收拢
  // v10.19 章节风格(element)组内按来源分类：语气基调(tone)/文风质感(texture)/语言元素(element)/自定义(custom)
  const CAT_LABEL = { tone:'▍语气基调', texture:'▍文风质感', element:'▍语言元素', custom:'▍我的自定义' };
  const CAT_ORDER = ['tone','texture','element','custom'];
  return ['tone','texture','element'].map(g=>{
    const items = lib.filter(s=>s.group===g);
    const mkChip = s=>`<button type="button" class="ws-chip ${(sel.tags||[]).includes(s.id)?'on':''}" data-${dataPrefix}-tag="${s.id}" title="${esc(s.note)}">${esc(s.name)}</button>`;
    const plus = opts.plus ? `<button type="button" class="ws-chip ws-chip-plus" data-${dataPrefix}-add="${g}" title="点击新建「${WRITE_GROUP_LABEL[g].replace(/^\d+[.、]?\s*/,'')}」词条">＋</button>` : '';
    // 章节风格：额外按 cat 分块，块与块间加分隔标题，块尾保留「＋」
    if(g==='element'){
      const blocks = CAT_ORDER.map(cat=>{
        const its = items.filter(s=>(s.cat||'element')===cat);
        if(!its.length) return '';
        return `<div class="ws-subcat"><div class="ws-subcat-t">${CAT_LABEL[cat]||cat}</div><div class="ws-chips">${its.map(mkChip).join('')}</div></div>`;
      }).filter(Boolean).join('');
      if(opts.cardFold){
        return `<div class="ws-group ws-fold-group" data-g="element">
          <div class="ws-group-t" data-ws-elemfold role="button" tabindex="0" title="展开/收起">${WRITE_GROUP_LABEL[g]}<span class="sc-fold-ico">${elemOpen?'▾':'▸'}</span></div>
          <div class="ws-chips-list"${elemOpen?'':' hidden'}>${blocks}<div class="ws-chips">${plus}</div></div>
        </div>`;
      }
      return `<div class="ws-group" data-g="element">
        <div class="ws-group-t">${WRITE_GROUP_LABEL[g]}${opts.plus?`<span class="ws-group-tip">可多选</span>`:''}</div>
        <div class="ws-chips-list">${blocks}<div class="ws-chips">${plus}</div></div>
      </div>`;
    }
    return `<div class="ws-group" data-g="${g}">
      <div class="ws-group-t">${WRITE_GROUP_LABEL[g]}${opts.plus?`<span class="ws-group-tip">可多选</span>`:''}</div>
      <div class="ws-chips">${items.map(mkChip).join('')}${plus}</div>
    </div>`;
  }).join('');
}
function writeStyleIntHtml(sel, dataPrefix){
  return [1,2,3].map(v=>`<button type="button" class="ws-int ${sel.intensity===v?'on':''}" data-${dataPrefix}-int="${v}">${['轻','中','重'][v-1]}</button>`).join('');
}
// 风格 chip 切换公共逻辑：v10.17 三组（标题/梗概/章节）互斥——选中任一组，其余两组已有选择全部清除；组内仍可多选
function toggleWriteTag(sel, id){
  const s = writeStyleById(id); if(!s) return;
  if(sel.tags.includes(id)){
    sel.tags = sel.tags.filter(x=>x!==id);
  } else {
    // 三组互斥：仅保留同组选择，再追加本次
    sel.tags = sel.tags.filter(x=>{ const o=writeStyleById(x); return o && o.group===s.group; });
    sel.tags.push(id);
  }
}
function writePresetOptions(){
  const sys = WRITE_PRESETS.map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
  const cfg = getCfg();
  const mine = (Array.isArray(cfg.stylePresets)?cfg.stylePresets:[]).map(p=>`<option value="u:${p.id}">⭐ ${esc(p.name||'未命名')}</option>`).join('');
  return sys + (mine ? `<optgroup label="⭐ 我的收藏">${mine}</optgroup>` : '');
}
// 主卡片
function writeStyleCard(){
  const st = writeStyleState();
  const draft = wsDraft || st;
  const dirty = !!wsDraft && wsDraftDirty(wsDraft, st);
  const intTxt = ['','轻','中','重'][draft.intensity] || '中';
  const selName = (draft.tags||[]).map(id=>{ const s=writeStyleById(id); return s?s.name:id; }).join(' + ') || '无';
  const sumTxt = (dirty?'⚠️ 待应用':'✔ 已生效')+' · '+(draft.tags||[]).length+' 项 · '+intTxt+' · '+selName;
  return `<div class="card ws-card${st.collapsed?' ws-collapsed':''}" data-cs="${wsColorSchemeId()}">
    <div class="ws-head" data-ws-fold role="button" tabindex="0" title="展开/收起">
      <h3 style="margin:0">✍️ 写作风格</h3>
      <span class="ws-sum${dirty?' dirty':''}">${sumTxt}</span>
      <button type="button" class="btn ghost ws-manage-btn" data-ws-lib title="编辑风格词库与我的收藏">⚙️ 管理</button>
      <span class="sc-fold-ico">${st.collapsed?'▸':'▾'}</span>
    </div>
    <div class="ws-body"${st.collapsed?' hidden':''}>
      ${writeStyleChipsHtml(draft, 'ws', { plus:true, cardFold:true })}
      <div class="ws-tools">
        <span class="ws-int-row">浓度：${writeStyleIntHtml(draft, 'ws')}</span>
        <label class="ws-preset"><span>预设</span>
          <select id="wsPreset"><option value="">— 选择预设 —</option>${writePresetOptions()}</select>
        </label>
        <button type="button" class="btn small primary ws-apply${dirty?'':' disabled'}" data-ws-apply ${dirty?'':'disabled'} title="把当前草稿设为生效配置（从此生成用这套风格）">✔ 应用并保存</button>
        <button type="button" class="btn small ghost" data-ws-save title="把当前草稿收藏为预设（跨作品可用）">💾 收藏当前</button>
        <button type="button" class="btn small ghost" data-ws-clear>✕ 清空</button>
      </div>
      <p class="ws-dirty-hint" style="display:${dirty?'':'none'}">⚠️ 当前为草稿（${(draft.tags||[]).length} 项未生效），点「✔ 应用并保存」后开始生效；生成章节读的是已生效配置。</p>
      <p class="muted" style="margin:6px 0 0;font-size:11px">三组互斥（同一时刻只启用一组，组内可多选）：①标题风格影响书名与章节标题（重生成全部标题）；②梗概风格影响逐章梗概/创作方向；③章节风格影响章节正文（单章/批量/重生成，默认折叠展开查看）。换组会清空其它两组的选择；选完点「✔ 应用并保存」才生效。</p>
    </div>
  </div>`;
}
function bindWriteStyle(){
  const st = writeStyleState();
  const head = $('[data-ws-fold]');
  if(head) head.onclick = ()=>{
    st.collapsed = !st.collapsed; persist();
    const body = $('.ws-body'); if(body) body.hidden = st.collapsed;
    const ico = head.querySelector('.sc-fold-ico'); if(ico) ico.textContent = st.collapsed?'▸':'▾';
  };
  // v2.1：chips/浓度/预设/清空 一律改「草稿」→ 局部刷新 → 点「✔ 应用并保存」才生效
  $$('[data-ws-tag]').forEach(b=> b.onclick = ()=>{
    toggleWriteTag(wsDraftInit(), b.dataset.wsTag);
    refreshWsUI();
  });
  $$('[data-ws-int]').forEach(b=> b.onclick = ()=>{ wsDraftInit().intensity = +b.dataset.wsInt; refreshWsUI(); });
  const sel = $('#wsPreset');
  if(sel) sel.onchange = ()=>{ const v = sel.value; if(!v) return; applyWritePresetDraft(v); sel.value=''; };
  // 应用并保存：草稿 → 生效配置 → persist → toast
  const ap = $('[data-ws-apply]');
  if(ap) ap.onclick = ()=>{
    if(!wsDraft) return;
    const st2 = writeStyleState();
    st2.tags = wsDraft.tags.slice(); st2.intensity = wsDraft.intensity;
    persist();
    const name = wsDraft.tags.map(id=>{ const s=writeStyleById(id); return s?s.name:id; }).join(' + ') || '无';
    wsDraft = null;
    refreshWsUI();
    toast('写作风格已生效：'+(name==='无'?'无风格（AI 默认文风）':name));
  };
  // 收藏当前：收藏草稿组合（未编辑时即生效配置）
  const sv = $('[data-ws-save]');
  if(sv) sv.onclick = ()=>{
    const cur = wsDraft || writeStyleState();
    if(!cur.tags.length){ toast('当前无风格，无需收藏'); return; }
    const cfg = getCfg(); if(!Array.isArray(cfg.stylePresets)) cfg.stylePresets = [];
    const name = prompt('给这个风格组合起个名字：', '我的风格'+(cfg.stylePresets.length+1));
    if(!name || !name.trim()) return;
    cfg.stylePresets.push({ id:'sp'+Date.now().toString(36), name:name.trim(), tags:cur.tags.slice(), intensity:cur.intensity });
    saveCfg(cfg); render();
    toast('已收藏：'+name.trim());
  };
  const lb = $('[data-ws-lib]');
  if(lb) lb.onclick = (e)=>{ e.stopPropagation(); openStyleLibPanel(); };
  // 清空：只清草稿，点应用才生效（语义统一）
  const cl = $('[data-ws-clear]');
  if(cl) cl.onclick = ()=>{ const d = wsDraftInit(); d.tags=[]; d.intensity=2; refreshWsUI(); toast('已清空草稿，点「✔ 应用并保存」生效'); };
  // v10.17 章节风格组折叠（默认收拢）
  const ef = $('[data-ws-elemfold]');
  if(ef) ef.onclick = ()=>{
    const s = writeStyleState(); s.elemOpen = !s.elemOpen; persist();
    const body = ef.parentNode && ef.parentNode.querySelector('.ws-chips-list');
    if(body) body.hidden = !s.elemOpen;
    const ico = ef.querySelector('.sc-fold-ico'); if(ico) ico.textContent = s.elemOpen?'▾':'▸';
  };
  // v10.17 每组末尾「＋」→ 弹窗新建该组风格词条
  $$('[data-ws-add]').forEach(b=> b.onclick = ()=> openStyleNewDialog(b.dataset.wsAdd));
}
// v10.17 新建风格词条弹窗（归属分组固定为调用它的那组；确认后立即入库并出现在该组）
function openStyleNewDialog(group){
  closeStyleNewDialog();
  const ov = document.createElement('div'); ov.id='wsNewPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>＋ 新建「${WRITE_GROUP_LABEL[group]}」词条</b>
        <button class="gs-x" data-wsn-close>✕</button></div>
      <div class="cv-body">
        <label style="font-size:12px;color:var(--sub)">风格名称（≤20字）*</label>
        <input type="text" id="wsnName" maxlength="20" placeholder="如：民国腔调 / 冷硬悬疑" style="margin:4px 0 10px" />
        <label style="font-size:12px;color:var(--sub)">指令文本（≤500字）</label>
        <textarea id="wsnNote" rows="4" maxlength="500" placeholder="推荐三行配方：&#10;写法：…&#10;避免：…&#10;自查：…" style="margin:4px 0 6px"></textarea>
        <div class="muted" style="font-size:11px">确认后将立即加入「${WRITE_GROUP_LABEL[group]}」并默认勾选（草稿态，点「✔ 应用并保存」正式生效）。</div>
      </div>
      <div class="modal-actions" style="padding:12px 16px;border-top:1px solid var(--line)">
        <button type="button" class="btn ghost" data-wsn-close2>取消</button>
        <button type="button" class="btn primary" data-wsn-ok>✔ 确认新建</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const close = ()=> closeStyleNewDialog();
  ov.querySelector('[data-wsn-close]').onclick = close;
  ov.querySelector('[data-wsn-close2]').onclick = close;
  ov.addEventListener('click', e=>{ if(e.target===ov) close(); });
  ov.querySelector('[data-wsn-ok]').onclick = ()=>{
    const name = ($('#wsnName') && $('#wsnName').value.trim()) || '';
    if(!name){ toast('请填写风格名称'); return; }
    const note = ($('#wsnNote') && $('#wsnNote').value.trim().slice(0,500)) || '';
    const c = getCfg(); c.styleCustom = c.styleCustom || { notes:{}, added:[], removed:[] };
    c.styleCustom.added = c.styleCustom.added || [];
    const id = 'c'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
    c.styleCustom.added.push({ id, group, name, note });
    saveCfg(c);
    // 立即加入本组并默认勾选（草稿态待应用）
    const d = wsDraftInit(); if(!d.tags.includes(id)) d.tags.push(id);
    closeStyleNewDialog();
    render();
    toast('已新建并加入「'+name+'」');
  };
  const inp = $('#wsnName'); if(inp) inp.focus();
}
function closeStyleNewDialog(){ const p=$('#wsNewPanel'); if(p) p.remove(); }
// v2.1 预设 → 填入草稿（不直接生效）
function applyWritePresetDraft(v){
  const d = wsDraftInit();
  if(v === 'clear'){ d.tags=[]; d.intensity=2; }
  else if(v.indexOf('u:')===0){
    const cfg = getCfg();
    const p = (Array.isArray(cfg.stylePresets)?cfg.stylePresets:[]).find(x=>x.id===v.slice(2));
    if(p){ d.tags = (p.tags||[]).slice(); d.intensity = p.intensity||2; }
  } else {
    const p = WRITE_PRESETS.find(x=>x.id===v);
    if(p){ d.tags = p.tags.slice(); d.intensity = p.intensity; }
  }
  refreshWsUI();
}
// 词库管理弹窗：系统项 note 可改 / 自定义项可增删改 / 收藏可删 / 恢复默认
function openStyleLibPanel(){
  closeStyleLibPanel();
  const cfg = getCfg();
  if(!cfg.styleCustom) cfg.styleCustom = { notes:{}, added:[], removed:[] };
  const lib = writeStyleLib();
  const groups = ['tone','texture','element'];
  const notes = cfg.styleCustom.notes || {};
  // v10.17 管理面板：各分组默认折叠、点击展开（新增风格保持展开）
  const groupHtml = groups.map(g=>{
    const its = lib.filter(s=>s.group===g);
    return `<div class="ws-lib-group ws-lib-fold">
      <div class="ws-lib-fold-t" data-lib-fold="${g}" role="button" tabindex="0" title="展开/收起">
        <span>${WRITE_GROUP_LABEL[g]}${its.length?`（${its.length}）`:'（空）'}</span><span class="sc-fold-ico">▸</span>
      </div>
      <div class="ws-lib-fold-b" hidden>
        ${its.map(s=>`
        <div class="ws-lib-item">
          <div class="ws-lib-name">${esc(s.name)}${notes[s.id]?'<span class="ws-changed">已改</span>':''}${s.custom?'<span class="ws-custom">自定义</span>':''}</div>
          <textarea class="ws-lib-note" data-lib-note="${s.id}" rows="2" maxlength="500" placeholder="指令文本（≤500字；可用 写法:/避免:/自查: 三行写配方）">${esc(s.note||'')}</textarea>
          <div class="ws-lib-tools">
            ${s.custom?`<button type="button" class="btn small ghost" data-lib-del="${s.id}" title="删除该自定义词条">🗑 删除</button>`:`<button type="button" class="btn small ghost" data-lib-hide="${s.id}" title="从选择中移除该词条（「恢复默认」可还原）">🚫 停用</button>`}
          </div>
        </div>`).join('')}
        ${its.length?'':`<p class="muted" style="margin:4px 0">该组暂无词条：回到写作风格卡片点该组「＋」新建，或在上方「新增风格」选择本组添加。</p>`}
      </div>
    </div>`;
  }).join('');
  const mine = (Array.isArray(cfg.stylePresets)?cfg.stylePresets:[]).map((p,i)=>`
    <div class="ws-lib-item">
      <div class="ws-lib-name">⭐ ${esc(p.name||'未命名')}</div>
      <span class="muted" style="font-size:11px">${(p.tags||[]).map(id=>{const s=writeStyleById(id); return s?s.name:id;}).join('+')||'无'} · ${['','轻','中','重'][p.intensity]||'中'}</span>
      <button type="button" class="btn small ghost del" data-sp-del="${i}">删</button>
    </div>`).join('') || '<p class="muted">暂无收藏。</p>';
  const ov = document.createElement('div'); ov.id='wsLibPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>⚙️ 写作风格管理</b>
        <span style="display:flex;gap:6px">
          <button class="btn small ghost" data-lib-reset>恢复默认</button>
          <button class="gs-x" data-lib-close>✕</button>
        </span></div>
      <div class="cv-body">
        <div class="ws-lib-add">
          <div class="ws-group-t">＋ 新增风格</div>
          <div class="ws-add-row">
            <select id="wsAddGroup">
              <option value="tone">① 标题风格</option>
              <option value="texture">② 梗概风格</option>
              <option value="element">③ 章节风格</option>
            </select>
            <input type="text" id="wsAddName" placeholder="风格名称（如：民国腔调）" maxlength="20" />
          </div>
          <textarea id="wsAddNote" rows="4" maxlength="500" placeholder="指令文本（≤500字）。推荐三行配方：&#10;写法：…&#10;避免：…&#10;自查：…"></textarea>
          <button type="button" class="btn small primary" data-lib-add>＋ 新增</button>
        </div>
        <div class="cv-div">每组词条均可修改指令（打"已改"标记）、可停用内置项（🚫）、可删除自定义项（🗑）；也可在卡片内该组「＋」或此处新增自定义风格。内置项被停用后由「恢复默认」一并还原；「恢复默认」清空全部词库改动。改动即时生效。</div>
        ${groupHtml}
        <div class="ws-lib-group ws-lib-fold">
          <div class="ws-lib-fold-t" data-lib-fold="mine" role="button" tabindex="0" title="展开/收起">
            <span>⭐ 我的收藏</span><span class="sc-fold-ico">▸</span>
          </div>
          <div class="ws-lib-fold-b" hidden>${mine}</div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-lib-close]').onclick = closeStyleLibPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeStyleLibPanel(); });
  // v10.17 分组/我的收藏折叠开关（默认折叠，点击展开）
  ov.querySelectorAll('[data-lib-fold]').forEach(h=> h.onclick = ()=>{
    const b = h.nextElementSibling; if(!b) return;
    const ico = h.querySelector('.sc-fold-ico'); if(ico) ico.textContent = b.hidden ? '▾' : '▸';
    b.hidden = !b.hidden;
  });
  // note 编辑即存
  ov.querySelectorAll('[data-lib-note]').forEach(ta=>{
    ta.onchange = ()=>{
      const id = ta.dataset.libNote;
      const v = ta.value.trim().slice(0,500);
      if(v) cfg.styleCustom.notes[id] = v; else delete cfg.styleCustom.notes[id];
      saveCfg(cfg);
      // 就近更新「已改」标记（不整层重建，避免打断编辑/丢焦点）
      const it = ta.closest('.ws-lib-item'); const nm = it && it.querySelector('.ws-lib-name');
      if(nm){
        let badge = nm.querySelector('.ws-changed');
        if(v){ if(!badge){ badge=document.createElement('span'); badge.className='ws-changed'; badge.textContent='已改'; nm.appendChild(badge); } }
        else if(badge) badge.remove();
      }
      toast('已保存指令');
    };
  });
  // 删除自定义项
  ov.querySelectorAll('[data-lib-del]').forEach(b=>{
    b.onclick = ()=>{
      cfg.styleCustom.added = (cfg.styleCustom.added||[]).filter(x=>x.id!==b.dataset.libDel);
      saveCfg(cfg); render(); toast('已删除自定义风格');
      closeStyleLibPanel(); openStyleLibPanel();   // 立即刷新面板，删除项即时消失
    };
  });
  // v10.19 停用系统词条：加入 removed（从选择中移除；「恢复默认」可还原）
  ov.querySelectorAll('[data-lib-hide]').forEach(b=>{
    b.onclick = ()=>{
      if(!window.confirm('停用后该词条将从选择中移除，可通过「恢复默认」还原。确定停用？')) return;
      cfg.styleCustom.removed = cfg.styleCustom.removed || [];
      if(!cfg.styleCustom.removed.includes(b.dataset.libHide)) cfg.styleCustom.removed.push(b.dataset.libHide);
      saveCfg(cfg); render(); toast('已停用该词条');
      closeStyleLibPanel(); openStyleLibPanel();
    };
  });
  // 删除收藏
  ov.querySelectorAll('[data-sp-del]').forEach(b=>{
    b.onclick = ()=>{
      cfg.stylePresets.splice(+b.dataset.spDel,1);
      saveCfg(cfg); render(); toast('已删除收藏');
      closeStyleLibPanel(); openStyleLibPanel();   // 立即刷新面板，删除项即时消失
    };
  });
  // 恢复默认
  ov.querySelector('[data-lib-reset]').onclick = ()=>{
    if(!window.confirm('恢复默认将清空全部词库改动（自定义新增也会删除）。确定？')) return;
    cfg.styleCustom = { notes:{}, added:[], removed:[] };
    saveCfg(cfg); render(); toast('已恢复默认词库');
    closeStyleLibPanel(); openStyleLibPanel();   // 立即重建面板：清掉「已改」标记、自定义项与编辑过的指令
  };
  // 新增风格
  ov.querySelector('[data-lib-add]').onclick = ()=>{
    const name = ($('#wsAddName') && $('#wsAddName').value.trim()) || '';
    const note = ($('#wsAddNote') && $('#wsAddNote').value.trim().slice(0,500)) || '';
    if(!name){ toast('请填写风格名称'); return; }
    const group = ($('#wsAddGroup') && $('#wsAddGroup').value) || 'tone';
    cfg.styleCustom.added = cfg.styleCustom.added || [];
    cfg.styleCustom.added.push({ id:'c'+Date.now().toString(36), group, name, note });
    saveCfg(cfg); render();
    toast('已新增风格：'+name);
    closeStyleLibPanel(); openStyleLibPanel();   // 刷新弹窗让新项立即可见
  };
}
function closeStyleLibPanel(){ const p=$('#wsLibPanel'); if(p) p.remove(); }

function viewStory(){
  if(!state.outline){
    const homeSub = isLong()
      ? `用几句话描述你的长篇构想（世界观、主角、核心冲突都行）。AI 会扩写成全书 ${chapterCountHint()} 大纲，之后按「生成章节」逐步写完。`
      : '用几句话描述你的点子（世界观、主角、核心冲突都行）。AI 会扩写成完整故事大纲与章节。';
    return CYBER_HOME_GRID + `
    <div class="card">
      <h3>① 输入故事构想</h3>
      <p class="sub">${homeSub}</p>
      <div class="idea-row">
        <textarea id="ideaInput" placeholder="">${esc(state.idea)}</textarea>
      </div>
      <div class="btn-row">
        <button id="btnPolishIdea" class="btn ghost" title="把构想优化成结构化高质量版本">✨ 优化构想</button>
        <label class="pol-multi" title="构想不完整时，生成多份不同方向的构想供选择"><input type="checkbox" id="chkPolishMulti"> 多方案</label>
      </div>
      <div id="polishBox" class="pol-box" style="display:none">
        <div class="pol-head"><b>✨ 优化稿</b>
          <span class="pol-tools">
            <button id="btnPolishCopy" class="btn small ghost">📋 复制</button>
            <button id="btnPolishSave" class="btn small ghost" title="把当前编辑内容保存为新方案（不覆盖原方案）">💾 保存此版为方案</button>
            <button id="btnPolishUse" class="btn small primary">✔ 采用此方案</button>
            <button id="btnPolishDiscard" class="btn small ghost">✕ 收起</button>
          </span>
        </div>
        <div id="polishAdvice" class="pol-advice" style="display:none"></div>
        <div id="polishTabs" class="pol-tabs" style="display:none"></div>
        <textarea id="polishText" class="pol-text" placeholder="可直接编辑此优化稿"></textarea>
      </div>
      ${ polishKeepBar() }
      ${ isLong() ? recipePicker() : specPickerHtml() }
      <div class="btn-row">
        <button id="btnGenOutline" class="btn primary block">${isLong()?'📚 生成长篇大纲':'✨ 生成故事大纲'}</button>
      </div>
      <p id="outlineStatus" class="status"></p>
    </div>`;
  }
  // 大纲已生成
  const o = state.outline;
  let html = `
    ${ origIdeaCard() }
    ${ writeStyleCard() }
    ${ recipeSummaryBar() }
    <div class="card">
      <div class="card-head-row">
        <h3 style="margin:0">📋 故事大纲</h3>
        ${hasOutlineHistory()?`<button type="button" class="btn small ghost" id="btnOutlineHist" title="查看并恢复历史大纲版本">📚 大纲版本(${outlineHistoryCount()})</button>`:''}
        ${titleManagerHtml()}
      </div>
      <p class="sub">${esc(o.logline||'')}</p>
      <div class="outline-strip">${ (o.chapters||[]).map((c,i)=>`<span class="outline-pill">${i+1}. ${esc(c.title)}</span>`).join('') }</div>
      ${ chapterTitleBlock() }
      ${ structureCard(o) }
      ${ state.outlineConfirmed ? `
        <div class="btn-row"><span class="pill tag-ok">✓ 大纲已确认</span></div>
        ${ isLong() ? chapterPlanBlock() : '' }
        ${ isLong() ? glossaryCardHtml() : '' }
        ${ isLong() ? `<div class="btn-row" style="margin-top:8px">
          <label class="long-jump"><span>跳到章节：</span>
          <select id="longJump"><option value="">— 选择章节阅读 —</option>${state.chapters.map((c,i)=>`<option value="${i}">第${i+1}章 ${esc(cleanChapterTitle(c.title))}</option>`).join('')}</select></label>
        </div>` : '' }
        <div class="ch-toolbar">
          <span class="ch-toolbar-t">📚 章节列表（共 ${state.chapters.length} 章，已生成 ${state.chapters.filter(c=>c.content && String(c.content).trim()).length} 章）</span>
          <button type="button" class="btn small ${state.autoQC?'tag-ok':'ghost'}" data-autogc title="生成后是否自动两段式质检（草扫硬伤+段落精修）；关闭则直接落库、省调用">🧪 自动质检：${state.autoQC?'开':'关'}</button>
        </div>
        <div id="chaptersWrap"></div>
        <div class="btn-row" style="margin-top:12px">
          <button id="btnGenAllChapters" class="btn primary">${isLong()?'⚡ 生成下一批 2 章':'⚡ 一键生成全部章节'}</button>          ${ isLong() ? `<span class="multi-gen">
            <input id="genCountIn" type="number" min="1" max="999" step="1" value="2" class="gen-count-in" aria-label="一次生成章数">
            <button id="btnGenMany" class="btn blue">⚡ 多章生成</button>
          </span>` : '<button id="btnReOutline" class="btn ghost">重生成大纲</button>' }
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

// v10.2 原始构想只读卡：故事页最顶部展示生成大纲时的用户构想原文（快照 outline.userIdea，
// 缺省回退当前 state.idea）。只读不可编辑、可复制；默认收缩，点击展开。纯前端、无 AI 参与。
function origIdeaCard(){
  const o = state.outline;
  const idea = (o && typeof o.userIdea === 'string' && o.userIdea.trim())
    ? o.userIdea : (state.idea || '');
  return `<div class="card orig-card">
    <div class="orig-head" role="button" tabindex="0" data-orig-toggle title="展开/收起">
      <span class="orig-t">📝 原始构想</span>
      <span class="orig-fold">▸</span>
    </div>
    <div class="orig-body" hidden>
      <textarea readonly class="orig-text" spellcheck="false">${esc(idea || '（无构想记录）')}</textarea>
      <div class="orig-actions">
        <button type="button" class="btn ghost gs-tool" data-orig-copy>📋 复制</button>
        <span class="muted orig-note">只读展示，不可编辑；修改构想需重新生成大纲才会更新此快照。</span>
      </div>
    </div>
  </div>`;
}

// v10.2 原始构想只读卡绑定：展开/收缩切换 + 复制（复用全局 copyText，自带 toast）
function bindOrigIdea(){
  const og = $('[data-orig-toggle]');
  if(og) og.onclick = ()=>{
    const body = $('.orig-body'); if(!body) return;
    const on = !body.hidden;
    body.hidden = on;
    const fold = og.querySelector('.orig-fold');
    if(fold) fold.textContent = on ? '▸' : '▾';
  };
  const cpy = $('[data-orig-copy]');
  if(cpy) cpy.onclick = ()=>{
    const ta = $('.orig-text'); if(!ta) return;
    copyText(ta.value);
  };
}
// v10.3 长篇结构设计栏折叠绑定：点击标题收起/展开，状态持久化
function bindStructureFold(){
  const h = $('[data-st-fold]');
  if(h) h.onclick = ()=>{
    state.stCollapsed = !state.stCollapsed;
    const body = $('.sc-body');
    if(body) body.hidden = state.stCollapsed;
    const ico = h.querySelector('.sc-fold-ico');
    if(ico) ico.textContent = state.stCollapsed ? '▸' : '▾';
    persist();
  };
}
// v10.14 章节标题管理：大纲生成后用户可编辑全部章节标题，一键同步两数据源 + 复制全部标题。
// 数据源说明：o.chapters[i].title（大纲骨架）与 state.chapters[i].title（章节状态）在大纲确认时复制一次，
// 之后各自独立——编辑必须经 setChapterTitle 同步两处，否则消费点错位。
function setChapterTitle(i, title){
  const t = String(title||'').trim();
  const o = state.outline;
  if(o && Array.isArray(o.chapters) && o.chapters[i]){
    // P1-2：改前记录旧标题入 o.chTitleHistory（上限10，最新在前）
    const oldT = (o.chapters[i].title||'').trim();
    if(oldT && oldT !== t && o.chapters[i].title !== undefined){
      if(!Array.isArray(o.chTitleHistory)) o.chTitleHistory = [];
      o.chTitleHistory.unshift({ i, title: oldT, ts: Date.now() });
      if(o.chTitleHistory.length > 10) o.chTitleHistory.splice(10);
    }
    o.chapters[i].title = t;
  }
  if(state.chapters && state.chapters[i]) state.chapters[i].title = t;
  persist();
}
// P1-2 标题曾用记录辅助
function chTitleHistory(){ const o=state.outline; return (o && Array.isArray(o.chTitleHistory)) ? o.chTitleHistory : []; }
function hasChTitleHistory(){ return chTitleHistory().length > 0; }

// 生成"第N章 标题"纯文本（仅章节+标题，无多余内容），供一键复制。
// 标题常自带"第N章"前缀（cleanChapterTitle 去前缀后再统一加"第N章 "，避免"第1章 第1章 起点"）
function chapterTitleListText(){
  const o = state.outline;
  const arr = (o && Array.isArray(o.chapters)) ? o.chapters : [];
  return arr.map((c,i)=>`第${i+1}章 ${cleanChapterTitle((c&&c.title)||'')}`.replace(/\s+$/,'')).filter(Boolean).join('\n');
}

// v10.14 章节标题管理块：工具行（复制全部）+ 每行标题 + ✎ 编辑
function chapterTitleBlock(){
  const o = state.outline;
  const arr = (o && Array.isArray(o.chapters)) ? o.chapters : [];
  if(!arr.length) return '';
  // P1-4 标题质检持久化：render 时从 o.titleQC 恢复标红（不再只存活一次渲染）
  const qc = (o.titleQC && Array.isArray(o.titleQC.issues)) ? o.titleQC.issues : [];
  const rows = arr.map((c,i)=>`
    <div class="ct-row ${qc.some(q=>+q.index===i)?'ct-issue':''}" data-ct-row="${i}">
      <span class="ct-no">第${i+1}章</span>
      <span class="ct-title" title="${esc((c&&c.title)||'')}">${esc((c&&c.title)||('第'+(i+1)+'章'))}</span>
      <button type="button" class="ct-edit" data-ct-edit="${i}" title="编辑标题">✎</button>
    </div>`).join('');
  return `<div class="ct-block">
    <div class="ct-head">
      <b>📚 章节标题</b>
      <span class="ct-tools">
        <label class="cp-style-toggle" title="开启后，重生成全部标题会按顶部写作风格（语气/质感/元素/浓度）作为首位硬要求约束 AI；关闭则不受风格影响（开关随本书保存）">
          <input type="checkbox" data-rt-style ${state.titleStyleOn?'checked':''}/> 标题风格约束
        </label>
        ${hasChTitleHistory()?`<button type="button" class="btn small ghost" data-ct-hist>🕘 曾用标题(${chTitleHistory().length})</button>`:''}
        ${chTitleBatches().length?`<button type="button" class="btn small ghost" data-ct-batch title="查看并可整批回退「重生成全部标题」的历史版本">🔁 标题版本(${chTitleBatches().length}/5)</button>`:''}
        <button type="button" class="btn small ghost" data-ct-copy>📋 复制全部章节标题</button>
        <button type="button" class="btn small ghost" data-rt-gen>🔄 重生成全部标题</button>
      </span>
    </div>
    <input type="text" class="rt-input" id="rtInput" placeholder="重生成要求（选填）：如『标题更有悬念感』『避免剧透式标题』『每章标题用双字词』" />
    <div class="ct-list">${rows}</div>
  </div>`;
}

// v10.14 章节标题绑定：复制全部 / ✎ 进入编辑态（失焦或回车存、Esc 还原、同刻单行互斥）
function bindChapterTitles(){
  const cp = $('[data-ct-copy]');
  if(cp) cp.onclick = ()=>{ copyText(chapterTitleListText()); };
  const ch = $('[data-ct-hist]');
  if(ch) ch.onclick = ()=> openChTitleHistoryPanel();
  const ctb = $('[data-ct-batch]');
  if(ctb) ctb.onclick = ()=> openChTitleBatchPanel();
  const rg = $('[data-rt-gen]');
  if(rg) rg.onclick = ()=> regenAllTitles(rg);   // v10.15 重生成全部标题
  // 标题风格约束开关：写回 state.titleStyleOn（独立、随本书），即时生效
  const ts = $('[data-rt-style]');
  if(ts) ts.onchange = ()=>{
    state.titleStyleOn = !!ts.checked;
    persist();
    toast(state.titleStyleOn ? '重生成标题：已开启写作风格约束（首位要求）' : '重生成标题：已关闭写作风格约束');
  };
  $$('[data-ct-edit]').forEach(btn=>{
    btn.onclick = ()=>{
      const i = +btn.dataset.ctEdit;
      const row = $('[data-ct-row="'+i+'"]'); if(!row) return;
      const span = row.querySelector('.ct-title'); if(!span) return;
      // 先提交其他处于编辑态的行（单行互斥）
      $$('.ct-edit-input').forEach(inp=> commitChapterTitle(inp));
      const inp = document.createElement('input');
      inp.className = 'ct-edit-input';
      inp.value = span.textContent;
      span.replaceWith(inp);
      inp.focus(); inp.select();
      inp.onkeydown = e=>{
        if(e.key==='Enter'){ e.preventDefault(); commitChapterTitle(inp); }
        else if(e.key==='Escape'){ commitChapterTitle(inp, true); }
      };
      inp.onblur = ()=> commitChapterTitle(inp);
    };
  });
}
function commitChapterTitle(inp, revert){
  if(!inp || inp.dataset.done) return;
  inp.dataset.done = '1';
  const row = inp.closest('[data-ct-row]');
  const i = row ? +row.dataset.ctRow : -1;
  const o = state.outline;
  const oldT = (o && o.chapters && o.chapters[i] && o.chapters[i].title) || ('第'+(i+1)+'章');
  const val = inp.value.trim();
  if(!revert && i>=0 && val) setChapterTitle(i, val);
  const span = document.createElement('span');
  span.className = 'ct-title';
  const finalT = (revert||!val) ? oldT : val;
  span.textContent = finalT;
  span.title = finalT;
  inp.replaceWith(span);
}

// v10.16 批量更新全部章节标题：直接写两处数据源（不逐条走 setChapterTitle，避免污染单条曾用标题）；返回实际更新数
function setAllTitles(titles){
  const o = state.outline;
  const n = (o && Array.isArray(o.chapters)) ? o.chapters.length : 0;
  let cnt = 0;
  (titles||[]).forEach((t,i)=>{
    if(i<n && String(t||'').trim()){
      const tt = String(t).trim();
      if(o && o.chapters[i]) o.chapters[i].title = tt;
      if(state.chapters && state.chapters[i]) state.chapters[i].title = tt;
      cnt++;
    }
  });
  if(o) o.titleQC = undefined;   // 标题被整体替换后，旧质检标红失效，清空待新质检
  persist();
  return cnt;
}

/* ---------- P1-2 章节标题曾用记录：🕘 弹窗查看 + 一键恢复（上限10） ---------- */
function openChTitleHistoryPanel(){
  closeChTitleHistoryPanel();
  const hist = chTitleHistory(); if(!hist.length){ toast('暂无曾用标题'); return; }
  const fmtTs = ts=>{ const d=new Date(ts); return (d.getMonth()+1)+'-'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
  const o = state.outline;
  const rows = hist.map((h,idx)=>`
    <div class="cv-row">
      <div class="cv-meta" style="flex:1;min-width:0"><div class="cv-time">第${h.i+1}章 · ${fmtTs(h.ts)}</div><div class="cv-t" style="font-size:12px;color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(h.title||'')}</div></div>
      <div class="cv-actions" style="display:flex;gap:6px;flex-shrink:0">
        <button type="button" class="btn ghost cv-b" data-cth-restore="${idx}">↩ 恢复为此标题</button>
        <button type="button" class="btn ghost cv-b" data-cth-del="${idx}">🗑 删除</button>
      </div>
    </div>`).join('');
  const ov = document.createElement('div'); ov.id='cthPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>🕘 章节标题 · 曾用记录（${hist.length}/10）</b>
        <button class="gs-x" data-cth-close>✕</button></div>
      <div class="cv-body">
        <div class="cv-div">手动改名或批量重生成前的标题都会记录在这里；可一键恢复或删除某条记录。恢复会把当前标题也记入曾用。</div>
        ${rows}
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-cth-close]').onclick = closeChTitleHistoryPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeChTitleHistoryPanel(); });
  ov.addEventListener('click', e=>{
    const rb = e.target.closest('[data-cth-restore]'); if(!rb) return;
    const h = hist[+rb.dataset.cthRestore]; if(!h) return;
    if(!window.confirm(`把第${h.i+1}章标题恢复为「${h.title}」？`)) return;
    setChapterTitle(h.i, h.title);
    closeChTitleHistoryPanel(); render();
    toast('已恢复该标题');
  });
  ov.addEventListener('click', e=>{
    const db = e.target.closest('[data-cth-del]'); if(!db) return;
    const idx = +db.dataset.cthDel;
    const o2 = state.outline;
    if(o2 && Array.isArray(o2.chTitleHistory)) o2.chTitleHistory.splice(idx,1);
    persist(); closeChTitleHistoryPanel(); render();
    toast('已删除该记录');
  });
}
function closeChTitleHistoryPanel(){ const p=$('#cthPanel'); if(p) p.remove(); }

/* ---------- v10.16 章节标题·批量版本回退（整批快照 ≤5 份，独立于单条曾用标题） ---------- */
function chTitleBatches(){ const o=state.outline; return (o && Array.isArray(o.chTitleBatches)) ? o.chTitleBatches : []; }
// 把「当前全部章节标题」整批压入版本栈（最新在前；与最新一份相同则跳过去重；上限5）
function snapshotTitleBatch(label){
  const o = state.outline; if(!o) return;
  const titles = (o.chapters||[]).map(c=> (c&&c.title)||'');
  const bt = chTitleBatches();
  if(bt.length && JSON.stringify(bt[0].titles) === JSON.stringify(titles)) return;
  bt.unshift({ ts: Date.now(), label: label||'快照', titles });
  if(bt.length > 5) bt.length = 5;
  persist();
}
// 整批应用某版本：先把当前态也归档（保留再回退机会），再覆盖全部标题
function applyTitleBatch(idx){
  const bt = chTitleBatches(); const b = bt[idx]; if(!b) return;
  const n = (b.titles||[]).length;
  if(!confirm(`整批恢复「${idx+1}. ${b.label||'标题版本'}」（共 ${n} 章）？将覆盖当前全部章节标题。`)) return;
  snapshotTitleBatch('切换前');
  const titles = (Array.isArray(b.titles)?b.titles:[]).map(t=>String(t||'').trim()).filter(Boolean);
  setAllTitles(titles);
  closeTitleBatchPreview(); closeChTitleBatchPanel();
  render();
  toast(`已整批应用该版本标题（${titles.length} 章）`);
}
function deleteTitleBatch(idx){
  const o = state.outline; if(!o) return;
  const bt = chTitleBatches(); if(!bt.length) return;
  bt.splice(idx,1);
  if(!bt.length) delete o.chTitleBatches; else o.chTitleBatches = bt;
  persist();
  closeTitleBatchPreview(); closeChTitleBatchPanel(); openChTitleBatchPanel();
  toast('已删除该版本');
}
function openChTitleBatchPanel(){
  closeChTitleBatchPanel();
  const bt = chTitleBatches();
  if(!bt.length){ toast('暂无批量版本，执行「重生成全部标题」后自动记录'); return; }
  const fmtTs = ts=>{ const d=new Date(ts); return (d.getMonth()+1)+'-'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
  const rows = bt.map((b,idx)=>`
    <div class="cv-row">
      <div class="cv-meta" style="flex:1;min-width:0">
        <div class="cv-time">${idx+1}. ${esc(b.label||'标题版本')} · ${fmtTs(b.ts)} · ${(b.titles||[]).length} 章</div>
        <div class="cv-t" style="font-size:12px;color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((b.titles||[]).slice(0,2).join(' / '))||'（空）'}…</div>
      </div>
      <div class="cv-actions" style="display:flex;gap:6px;flex-shrink:0">
        <button type="button" class="btn ghost cv-b" data-batch-view="${idx}">👁 预览</button>
        <button type="button" class="btn primary cv-b" data-batch-apply="${idx}">应用</button>
        <button type="button" class="btn ghost cv-b" data-batch-del="${idx}">🗑</button>
      </div>
    </div>`).join('');
  const ov = document.createElement('div'); ov.id='ctbPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>🔁 章节标题 · 批量版本（${bt.length}/5）</b>
        <button class="gs-x" data-ctb-close>✕</button></div>
      <div class="cv-body">
        <div class="cv-div">「重生成全部标题」会把改动前/后的整批标题各归档一份（≤5 份可回退）；每行可👁预览整批，或点「应用」整批恢复。单条手改标题的记录仍在「🕘 曾用标题」查看。</div>
        ${rows}
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-ctb-close]').onclick = closeChTitleBatchPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeChTitleBatchPanel(); });
  ov.querySelectorAll('[data-batch-view]').forEach(b=> b.onclick = ()=> openTitleBatchPreview(+b.dataset.batchView));
  ov.querySelectorAll('[data-batch-apply]').forEach(b=> b.onclick = ()=> applyTitleBatch(+b.dataset.batchApply));
  ov.querySelectorAll('[data-batch-del]').forEach(b=> b.onclick = ()=> deleteTitleBatch(+b.dataset.batchDel));
}
function closeChTitleBatchPanel(){ const p=$('#ctbPanel'); if(p) p.remove(); }
// 单版整批标题完整预览（可自由切换查看）；点「应用此版本」才真正生效
function openTitleBatchPreview(idx){
  closeTitleBatchPreview();
  const bt = chTitleBatches(); const b = bt[idx]; if(!b) return;
  const fmtTs = ts=>{ const d=new Date(ts); return (d.getMonth()+1)+'-'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
  const list = (b.titles||[]).map((t,i)=>`<div class="cv-row"><div class="cv-t" style="font-size:12px">第${i+1}章　${esc(t||'')}</div></div>`).join('') || '<p class="muted">（空批）</p>';
  const ov = document.createElement('div'); ov.id='ctbPreview'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>👁 版本预览 · ${esc(b.label||'标题版本')}（${fmtTs(b.ts)} · ${(b.titles||[]).length} 章）</b>
        <button class="gs-x" data-ctbp-close>✕</button></div>
      <div class="cv-body"><div style="max-height:60vh;overflow:auto">${list}</div></div>
      <div class="modal-actions" style="padding:12px 16px;border-top:1px solid var(--line)">
        <button type="button" class="btn ghost cv-b" data-ctbp-close2>取消</button>
        <button type="button" class="btn primary cv-b" data-ctbp-apply>✔ 应用此版本</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-ctbp-close]').onclick = closeTitleBatchPreview;
  ov.querySelector('[data-ctbp-close2]').onclick = closeTitleBatchPreview;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeTitleBatchPreview(); });
  ov.querySelector('[data-ctbp-apply]').onclick = ()=> applyTitleBatch(idx);
}
function closeTitleBatchPreview(){ const p=$('#ctbPreview'); if(p) p.remove(); }

// v10.15 重生成全部章节标题：保留梗概/结构/词典，只重出标题；可选用户建议；生成后自动标题质检（qcTemp）
async function regenAllTitles(btn){
  const o = state.outline;
  if(!o || !Array.isArray(o.chapters) || !o.chapters.length){ toast('尚无章节标题'); return; }
  if(!confirm('将覆盖全部章节标题，确认重生成？')) return;
    const req = ($('#rtInput') && $('#rtInput').value.trim()) || '';
    if(btn) busy(btn,true,'重生成标题中…');
    // 创建预览区（仅流式可用时显示）
    const ctBlock = btn && btn.closest('.ct-block');
    let preview = null;
    const isStream = currentIsDeepSeek();
    if(isStream && ctBlock){
      preview = document.createElement('pre');
      preview.className = 'cp-stream-preview'; preview.textContent = '正在生成标题…';
      ctBlock.appendChild(preview);
    }
    // 显示停止按钮
    const stopParent = btn && btn.parentNode;
    if(stopParent) showStopBtn(stopParent);
    let _streamBuf = '';
    try{
      const spec = resolveActiveSpec();
      const st = o.structure || {};
      const gloss = chapterGlossaryBlock();
      const parts = [];
      // ★ 首位要求：若开启标题风格约束且已选「标题风格」，把风格指令插到最前（实时读 state.chapterStyle；未选自动空串）
      if(state.titleStyleOn){
        const sb = writeStyleTitleBlock();
        if(sb) parts.push('【标题风格约束（首位要求，须优先遵循）】\n'+sb);
      }
      parts.push(`小说标题：${o.title||''}\n一句话梗概：${o.logline||''}\n\n【长篇结构设计】\n${JSON.stringify(st).slice(0,800)}\n\n【设定词典】\n${gloss}\n\n【现有章节标题】\n${(o.chapters||[]).map((c,i)=>`第${i+1}章 ${(c&&c.title)||''}`).join(' / ')}${req?`\n\n【重生成要求】\n${req}`:''}`);
      const user = parts.join('\n\n');
    const onStream = delta => {
      _streamBuf += String(delta||'');
      if(preview){ preview.textContent = _streamBuf; preview.scrollTop = preview.scrollHeight; }
    };
    const txt = await callDeepSeek(REGEN_TITLES_SYS, user, {temperature: spec.titleTemp, onStream: isStream ? onStream : null, signal: _abortCtl?.signal});
    const j = parseJson(txt) || {};
    const titles = Array.isArray(j.titles) ? j.titles.map(t=>String(t||'').trim()).filter(Boolean) : [];
    if(!titles.length){ toast('未解析到新标题，请重试'); return; }
    snapshotTitleBatch('重生成前');   // 把改动前的整批标题归档为可回退版本（≤5）
    const cnt = setAllTitles(titles);
    // 就地更新标题行，不刷新全页（保留预览区）
    document.querySelectorAll('.ct-row').forEach((row,i)=>{
      const el = row.querySelector('.ct-title');
      if(el && o.chapters[i] && o.chapters[i].title){
        el.textContent = o.chapters[i].title;
        el.title = o.chapters[i].title;
      }
    });
    // 立即刷新「标题版本」按钮（若已存在批次则显示）
    const ctBlock2 = document.querySelector('.ct-block');
    const ctTools = ctBlock2 && ctBlock2.querySelector('.ct-tools');
    if(ctTools){
      const existingBtn = ctTools.querySelector('[data-ct-batch]');
      const btCount = chTitleBatches().length;
      if(btCount && !existingBtn){
        const b = document.createElement('button');
        b.type='button'; b.className='btn small ghost'; b.dataset.ctBatch='';
        b.title='查看并可整批回退「重生成全部标题」的历史版本';
        b.innerHTML = '🔁 标题版本('+btCount+'/5)';
        b.onclick = ()=> openChTitleBatchPanel();
        // 插在复制按钮之前
        const copyBtn = ctTools.querySelector('[data-ct-copy]');
        if(copyBtn) ctTools.insertBefore(b, copyBtn);
        else ctTools.appendChild(b);
      }else if(btCount && existingBtn){
        existingBtn.innerHTML = '🔁 标题版本('+btCount+'/5)';
      }
    }
    // 清除旧标题质检数据（禁用标题质检）
    if(o) o.titleQC = undefined;
    // 移除所有行上的红色质检标记
    document.querySelectorAll('.ct-row').forEach(row=> row.classList.remove('ct-issue'));
    // 自动标题质检（已禁用）
    toast(`已重生成 ${cnt} 个章节标题`);
  }catch(e){
    if(e.name==='AbortError'){ toast('已停止重生成标题'); }
    else { toast('重生成标题失败：'+e.message); }
  }
  finally{ hideStopBtn(); if(preview) preview.remove(); if(btn) busy(btn,false); }
}

// v10.15 标题质检：qcTemp 0.2 调用 TITLE_QC_SYS；问题标题行标红 + toast（失败静默跳过）
async function runTitleQC(titles){
  const o = state.outline;
  if(!o) return;
  try{
    const spec = resolveActiveSpec();
    const user = `【标题列表】\n${(titles||[]).map((t,i)=>`${i}. ${t}`).join('\n')}\n\n【设定基准】\n小说：${o.title||''}\n梗概：${o.logline||''}\n${chapterGlossaryBlock()}`;
    const txt = await callDeepSeek(TITLE_QC_SYS, user, {temperature: spec.qcTemp});
    const j = parseJson(txt) || {};
    const issues = Array.isArray(j.issues) ? j.issues : [];
    // P1-4 标题质检持久化：结果含时间戳存入 outline.titleQC，标红从数据恢复
    o.titleQC = { ts: Date.now(), issues: issues.map(it=>({ index:+it.index, type:String(it.type||''), fix:String(it.fix||'') })) };
    persist();
    // 标红问题标题行
    document.querySelectorAll('.ct-row').forEach(row=> row.classList.remove('ct-issue'));
    (issues||[]).forEach(it=>{
      const idx = +it.index;
      const row = document.querySelector('[data-ct-row="'+idx+'"]');
      if(row) row.classList.add('ct-issue');
    });
    if(issues.length) toast(`${issues.length} 个标题可能有问题（红色标记，可 ✎ 修改）`);
  }catch(e){ /* 质检失败静默跳过，不影响标题使用 */ }
}

// v10.19 逐章梗概区块：暗红渐变色卡片，独立设计通用于所有主题
function chapterPlanBlock(){
  const o = state.outline;
  const plans = (o && Array.isArray(o.chapterPlans)) ? o.chapterPlans : [];
  const hasPlans = plans.some(Boolean);
  const collapsed = !!state.cpCollapsed;
  const items = plans.map((t,i)=>`
    <div class="cp-item">
      <span class="cp-no">${i+1}</span>
      <textarea class="cp-input" rows="3" data-cp-set="${i}" data-orig="${esc(t)}" placeholder="本章梗概（可编辑）">${esc(t)}</textarea>
      <span class="cp-wc">${t.length}字</span>
    </div>`).join('');
  return `<div class="card cp-card">
    <div class="cp-head" data-cp-fold role="button" tabindex="0" title="展开/收起">
      <div class="cp-head-top">
        <div class="cp-head-left">
          <h3>🧭 逐章梗概 <span class="cp-arrow">${collapsed?'▸':'▾'}</span></h3>
        </div>
        <span class="cp-head-tools">
          <label class="cp-style-toggle" title="开启后，生成逐章梗概会以顶部写作风格（语气/质感/元素/浓度）作为首位硬要求约束 AI；关闭则不受风格影响（开关随本书保存）">
            <input type="checkbox" data-cp-style ${state.planStyleOn?'checked':''}/> 风格约束
          </label>
        </span>
      </div>
      <div class="cp-head-row action-row">
        ${hasChapterPlansHistory()?`<button type="button" class="btn ghost" data-cp-hist>📚 版本(${chapterPlansHistoryCount()})</button>`:''}
        <button type="button" class="cp-gen-btn" data-cp-gen>${hasPlans?'🔄 重生成梗概':'📝 生成逐章梗概'}</button>
      </div>
    </div>
    <div class="cp-body"${collapsed?' hidden':''}>
      ${hasPlans ? `<div class="cp-list">${items}</div>
        <p class="muted" style="margin:6px 0 0">每条可编辑，失焦即存；写正文时注入为【本章梗概】。</p>`
        : `<p class="sub">可选步骤：为每章写一段本章梗概（核心事件/起因经过结果/走向），写正文时据此执笔，统一各章走向。不做也不影响默认流程。</p>`}
    </div>
  </div>`;
}

// v10.19 梗概卡折叠绑定：点击标题行切换，状态持久化
function bindChapterPlanFold(){
  const head = $('[data-cp-fold]');
  if(!head) return;
  head.onclick = (e)=>{
    if(e.target.closest('.cp-style-toggle') || e.target.closest('[data-cp-hist]') || e.target.closest('[data-cp-gen]')) return;   // 不拦截风格约束/版本/生成按钮
    state.cpCollapsed = !state.cpCollapsed;
    persist();
    const body = $('.cp-body'); if(body) body.hidden = state.cpCollapsed;
    const ico = head.querySelector('.cp-arrow'); if(ico) ico.textContent = state.cpCollapsed ? '▸' : '▾';
  };
}
// v10.11 逐章梗概绑定：生成（含覆盖确认）/ 逐条编辑即存
function bindChapterPlan(){
  const gen = $('[data-cp-gen]');
  if(gen) gen.onclick = ()=>{
    const o = state.outline;
    const has = o && Array.isArray(o.chapterPlans) && o.chapterPlans.some(Boolean);
    if(has && !confirm('将覆盖现有逐章梗概（旧版会存入历史），继续？')) return;
    genChapterPlans(gen);
  };
  // 风格约束开关：写回 state.planStyleOn（随本书），即时生效（下次生成生效，不回填已生成梗概）
  const tog = $('[data-cp-style]');
  if(tog) tog.onchange = ()=>{
    state.planStyleOn = !!tog.checked;
    persist();
    toast(state.planStyleOn ? '逐章梗概：已开启写作风格约束（首位要求）' : '逐章梗概：已关闭写作风格约束');
  };
  const hist = $('[data-cp-hist]');
  if(hist) hist.onclick = ()=> openChapterPlansHistoryPanel();
  $$('[data-cp-set]').forEach(inp=>{
    // 实时更新字数
    inp.oninput = ()=>{
      const wc = inp.parentNode && inp.parentNode.querySelector('.cp-wc');
      if(wc) wc.textContent = inp.value.length + '字';
    };
    inp.onchange = ()=>{
      const o = state.outline; if(!o) return;
      if(!Array.isArray(o.chapterPlans)) o.chapterPlans = [];
      const i = +inp.dataset.cpSet;
      if(inp.value === inp.dataset.orig) return;
      o.chapterPlans[i] = inp.value;
      inp.dataset.orig = inp.value;
      persist();
      toast('本章梗概已保存，后续生成章节生效');
    };
  });
}

// v2.4 词典人物字段检查：7 字段完整性三态（缺失红 / 未知黄 / 齐全 ✅）
function glossaryFieldCheck(){
  const g = (state.outline && state.outline.glossary) || {};
  const rows = [];
  (g.characters||[]).forEach(c=>{
    const missing = CHAR_FIELDS.filter(k=> c[k]==null || String(c[k]).trim()==='');
    const unknown = CHAR_FIELDS.filter(k=> String(c[k]||'').trim()==='未知');
    if(missing.length || unknown.length) rows.push({ name: String(c.name||'未命名').trim(), missing, unknown });
  });
  return rows;
}
function glossaryCheckCount(){ return glossaryFieldCheck().length; }
function openGlossaryCheckPanel(){
  closeGlossaryCheckPanel();
  const rows = glossaryFieldCheck();
  const body = rows.length ? rows.map(r=>{
    const m = r.missing.map(k=>CHAR_FIELD_LABEL[k]).join('、');
    const u = r.unknown.map(k=>CHAR_FIELD_LABEL[k]).join('、');
    return `<div class="cv-row">
      <div class="cv-meta" style="flex:1;min-width:0">
        <div class="cv-time">${esc(r.name)}</div>
        <div class="cv-t" style="font-size:12px;line-height:1.6">
          ${m?`<span class="gs-miss">缺失：${m}</span>`:''} ${u?`<span class="gs-unk">未知：${u}（建议补全）</span>`:''}
        </div>
      </div>
    </div>`;
  }).join('') : '<p class="muted">✅ 全部人物字段齐全（身份/岁数/性别/外貌/爱好/关系/性格），无缺失、无未知。</p>';
  const ov = document.createElement('div'); ov.id='gsCheckPanel'; ov.className='gs-overlay';
  ov.innerHTML = `<div class="gs-modal">
    <div class="gs-modal-head"><b>🔍 词典人物字段检查（${rows.length}）</b><button class="gs-x" data-gsck-close>✕</button></div>
    <div class="cv-body">
      <div class="cv-div">生成章节时，人物 7 字段会完整注入给章节 AI；字段缺失或「未知」会导致 AI 信息不足而写错内容。可点开对应词典条目补全，补全后对后续生成的章节生效。</div>
      ${body}
    </div></div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-gsck-close]').onclick = closeGlossaryCheckPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeGlossaryCheckPanel(); });
}
function closeGlossaryCheckPanel(){ const p=$('#gsCheckPanel'); if(p) p.remove(); }

// 万物词典「设定表」卡片：展示人物/地名/专名，用户可更正错名（决策9）
// 词典是全文一致性准则，可小幅修正，但禁用删除（应由大纲确立）。
function glossaryCardHtml(){
  const g = (state.outline && state.outline.glossary) || {characters:[], places:[], propernouns:[]};
  const gl = ()=>state.outline.glossary = state.outline.glossary || {characters:[],places:[],propernouns:[]};
  const empty = !(g.characters&&g.characters.length) && !(g.places&&g.places.length) && !(g.propernouns&&g.propernouns.length);
  const hasBody = state.chapters.some(c=>c && c.content);   // 是否有正文可做覆盖面统计（阶段4）
  const tools = `<span class="gs-tools">
    <button type="button" class="btn ghost gs-tool" data-gs-history>🕘 历史更改</button>
    <button type="button" class="btn ghost gs-tool" data-gs-check ${glossaryCheckCount()?'':'hidden'} title="人物 7 字段完整性：缺失/未知标出，建议补全">🔍 字段检查${glossaryCheckCount()?`<b class="gs-check-badge">${glossaryCheckCount()}</b>`:''}</button>
    <button type="button" class="btn ghost gs-tool" data-gs-coverage ${hasBody?'':'hidden'}>📊 覆盖面</button>
    <button type="button" class="btn ghost gs-tool" data-gs-extract ${hasBody?'':'hidden'} title="从已生成正文提取词典未收录的新人物/地名/专名并入库">📥 提取新增</button>
    <button type="button" class="btn ghost gs-tool" data-gs-clean ${hasBody?'':'hidden'} title="清理在全部已生成正文中均未出现的条目（如重生成覆盖后失效的旧人物）">🧹 清理未使用</button>
    <button type="button" class="btn ghost gs-tool" data-gs-export>导出 JSON</button>
    <button type="button" class="btn ghost gs-tool" data-gs-import>导入 JSON</button>
    <label class="gs-autofill" title="批量生成章节后自动提取新实体入词典"><input type="checkbox" data-gs-autofill ${state.glossAutoFill?'checked':''} /> 自动补全</label>
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
  const kLabel = k => ({name:'名称', identity:'身份', age:'岁数', gender:'性别', appearance:'外貌', hobby:'爱好', relation:'关系', trait:'性格', type:'类型', note:'说明'}[k]||k);
  const chars = (g.characters||[]).map((c,i)=>entry(c,'char',i,['identity','gender','age'],['name','identity','age','gender','appearance','hobby','relation','trait'])).join('');
  const places = (g.places||[]).map((p,i)=>entry(p,'place',i,['type','note'],['name','type','note'])).join('');
  const props = (g.propernouns||[]).map((p,i)=>entry(p,'proper',i,['note'],['name','note'])).join('');
  const collapsed = !!state.gsCollapsed;
  const total = (g.characters||[]).length + (g.places||[]).length + (g.propernouns||[]).length;
  return `<div class="card gs-card${collapsed?' gs-collapsed':''}">
    <div class="gs-card-head">
      <h3 class="gs-card-title" role="button" tabindex="0" data-gs-card-toggle>
        <span class="gs-card-t"><span class="gs-card-arrow">${collapsed?'▸':'▾'}</span>📇 设定表 · 万物词典（${total} 条）</span>
        ${tools}
      </h3>
    </div>
    <div class="gs-card-body"${collapsed?' style="display:none"':''}>
    <p class="sub">全文一致性基准：生成正文时一律使用以下人名/地名/专名，不得自造新名。生成章节时，人物身份/岁数/性别/外貌/爱好/关系/性格会<b>完整注入</b>章节 AI（字段留空则不注入）；自动提取的新人物会带全 7 项设定（推断不出填「未知」）。建议用「🔍 字段检查」确认人物字段齐全，避免 AI 信息不足写错。</p>
    <div class="gs-panel" id="gsHistory" hidden><div class="gs-panel-title">🕘 历史更改</div><div id="gsHistoryList"></div></div>
    <div class="gs-group" data-gs-type="char"><div class="gs-title">👤 人物（${g.characters.length}）</div>
      ${chars||'<span class="muted">（无）</span>'}</div>
    <div class="gs-group" data-gs-type="place"><div class="gs-title">🗺️ 地点（${g.places.length}）</div>
      ${places||'<span class="muted">（无）</span>'}</div>
    <div class="gs-group" data-gs-type="proper"><div class="gs-title">📌 专名（${g.propernouns.length}）</div>
      ${props||'<span class="muted">（无）</span>'}</div>
    ${glossaryDupNoteHtml()}
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
  // 整卡收缩/展开：点击标题栏（与逐章梗概一致）；点工具按钮不触发折叠；词条始终保持默认折叠
  const gsHead = $('[data-gs-card-toggle]');
  if(gsHead){
    const toggleCard = ()=>{
      state.gsCollapsed = !state.gsCollapsed;
      persist();
      const card = gsHead.closest('.gs-card');
      const body = card && card.querySelector('.gs-card-body');
      if(body){ body.style.display = state.gsCollapsed ? 'none' : ''; }
      const arrow = gsHead.querySelector('.gs-card-arrow');
      if(arrow) arrow.textContent = state.gsCollapsed ? '▸' : '▾';
      if(state.gsCollapsed){ // 收缩整卡时把所有词条一并折叠（展开整卡时词条保持折叠态，由用户逐个点击展开）
        card && $$('.gs-entry', card).forEach(en=>{ en.classList.remove('open'); const h=en.querySelector('.gs-fold-ico'); if(h) h.textContent='▸'; });
      }
    };
    gsHead.onclick = (e)=>{ if(e.target.closest('.gs-tools')) return; toggleCard(); };
    gsHead.onkeydown = (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); if(e.target.closest('.gs-tools')) return; toggleCard(); } };
  }
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
      glossaryHistoryPush(`修改 ${isName?'名称':'字段'}「${type}·${idx}」`); // 追加·历史更改记录
      inp.dataset.orig = newVal;               // 该输入框的 basline 更新
      // 触发「改动透明化」评估：长篇（有正文生成）时弹选择卡
      if(isLong()){
        openGlossaryPanel({type, idx, isName, key, oldVal, newVal});
      }
    };
  });
  // 覆盖面自检（阶段4）：需有正文后才可见
  $$('[data-gs-coverage]').forEach(b=> b.onclick = openCoveragePanel);
  // v2.4 字段检查
  $$('[data-gs-check]').forEach(b=> b.onclick = openGlossaryCheckPanel);
  // v8c 提取新增：手动对全部已生成正文提取词典未收录的新实体
  $$('[data-gs-extract]').forEach(b=> b.onclick = ()=>{ manualExtractGlossary(); });
  // v8c 清理未使用：弹窗勾选确认删除全部正文零出现的条目
  $$('[data-gs-clean]').forEach(b=> b.onclick = openCleanPanel);
  // v8c 词典自动补全开关（默认开）：批量生成后自动提取；关则仅保留手动按钮
  $$('[data-gs-autofill]').forEach(b=> b.onchange = ()=>{
    state.glossAutoFill = b.checked; persist();
    toast(state.glossAutoFill ? '词典自动补全已开启（批量生成后自动提取新实体）' : '词典自动补全已关闭（仅保留手动「📥 提取新增」）');
  });
  // 导出词典 JSON（项6）
  $$('[data-gs-export]').forEach(b=> b.onclick = exportGlossaryJson);
  // 导入词典 JSON（项7）
  $$('[data-gs-import]').forEach(b=> b.onclick = ()=> { const f=$('#gsImportFile'); if(f) f.click(); });
  const imp = $('#gsImportFile'); if(imp) imp.onchange = e=>{ const file = e.target.files && e.target.files[0]; if(file) importGlossaryJson(file); e.target.value=''; };
  // 追加规划·「历史更改」按钮：展开/收起历史记录列表
  $$('[data-gs-history]').forEach(b=> b.onclick = ()=>{
    const panel = $('#gsHistory');
    if(!panel) return;
    const show = panel.hidden;
    if(show) renderGlossaryHistory();
    panel.hidden = !show;
    $$('.gs-panel').forEach(p=>{ if(p.id!=='gsHistory') p.hidden = true; }); // 与内容互斥显示
    if(show) b.classList.add('gs-tool-on'); else b.classList.remove('gs-tool-on');
  });
  }

// 快照（项5）：记录任一条目改动前的整本词典，供「改动透明化弹窗」内的即时回退；最多保留 10 步防无限膨胀
let gsUndoStack = [];
const GS_UNDO_MAX = 10;
function gsPushUndo(){
  const g = state.outline && state.outline.glossary;
  if(g) gsUndoStack.push(JSON.stringify(g));
  if(gsUndoStack.length > GS_UNDO_MAX) gsUndoStack.shift();
}
// 追加规划·词典「历史更改」：持久化记录每次真实修改，供长期回溯。
// 存于 state.outline.glossary._history（上限 30 条），与 gsUndoStack(一次性近撤销) 并存。
function glossaryHistoryPush(desc){
  const g = state.outline && state.outline.glossary;
  if(!g) return;
  const h = Array.isArray(g._history) ? g._history : (g._history = []);
  h.push({ ts: Date.now(), desc: desc || '修改词典', snapshot: JSON.stringify({characters:g.characters||[], places:g.places||[], propernouns:g.propernouns||[]}) });
  if(h.length > 30) h.splice(0, h.length - 30);
  persist();
}
// 渲染「历史更改」列表：按时间倒序，每条可「还原到此」或「查看此版」
function renderGlossaryHistory(){
  const list = $('#gsHistoryList');
  if(!list) return;
  const g = state.outline && state.outline.glossary;
  const h = Array.isArray(g && g._history) ? g._history : [];
  if(!h.length){ list.innerHTML = '<p class="muted">暂无历史更改记录。修改词典后会自动记录。</p>'; return; }
  list.innerHTML = h.slice().reverse().map((r,i)=>{
    const idx = h.length - 1 - i;               // 正序索引
    const d = new Date(r.ts);
    const pad = n => n<10?('0'+n):n;
    const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    return `<div class="gs-hist-row" data-gs-hist="${idx}">
      <span class="gs-hist-ts">回退到第 ${h.length-idx} 次 · ${t}</span>
      <span class="gs-hist-desc">${esc(r.desc||'')}</span>
      <span class="gs-hist-actions">
        <button type="button" class="btn ghost gs-tool" data-gs-hist-view="${idx}">查看</button>
        <button type="button" class="btn ghost gs-tool" data-gs-hist-restore="${idx}">还原</button>
      </span>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-gs-hist-view]').forEach(b=>{
    b.onclick = ()=>{ try{ applyGlossaryHistorySnapshot(+b.dataset.gsHistView); }catch(e){} };
  });
  list.querySelectorAll('[data-gs-hist-restore]').forEach(b=>{
    b.onclick = ()=>{ applyGlossaryHistorySnapshot(+b.dataset.gsHistRestore); glossaryHistoryPush('还原到历史版本'); };
  });
}
// 应用历史快照到当前词典
function applyGlossaryHistorySnapshot(idx){
  const g = state.outline && state.outline.glossary;
  const h = Array.isArray(g && g._history) ? g._history : [];
  const r = h[idx]; if(!r) return;
  let snap; try{ snap = JSON.parse(r.snapshot); }catch(e){ return; }
  if(!snap) return;
  g.characters = snap.characters || [];
  g.places = snap.places || [];
  g.propernouns = snap.propernouns || [];
  persist();
  // 关闭历史面板并整卡重绘以同步词典条目
  const panel = $('#gsHistory'); if(panel) panel.hidden = true;
  if(typeof renderGlossaryOnly === 'function') renderGlossaryOnly(); else render();
  toast('已应用所选历史版本');
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

  const labels = {name:'名称', identity:'身份', age:'岁数', gender:'性别', appearance:'外貌', hobby:'爱好', relation:'关系', trait:'性格', type:'类型', note:'说明'};
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
    gsUndoStack.pop();   // 已生效，丢弃快照
    closeGlossaryPanel();
    toast('已保存，仅对后续新章生效');
  };
  ov.querySelector('[data-gs-undo]').onclick = ()=>{
    const snap = gsUndoStack.pop();
    if(snap){ try{ state.outline.glossary = JSON.parse(snap); persist(); }catch(e){} }
    closeGlossaryPanel(); renderGlossaryOnly(); toast('已恢复改动前词典');
  };
  const regenBtn = ov.querySelector('[data-gs-regen]');
  if(regenBtn) regenBtn.onclick = ()=>{
    const sel = $$('.gs-hit-cb:checked', ov).map(b=>+b.dataset.ch);
    gsUndoStack.pop();   // 用户已确认批量重生成，丢弃快照（重生成后为新一致性）
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

/* ---------- P0-3 章节正文手动编辑撤销（editHistory 上限10） ---------- */
function hasEditHistory(i){ const c=state.chapters[i]; return !!(c && Array.isArray(c.editHistory) && c.editHistory.length); }
// 撤销一次手动编辑：弹出最后一条旧值覆盖当前内容（pop 后不写回，支持连续往回撤）
function undoChapterEdit(i){
  const c = state.chapters[i];
  if(!c || !Array.isArray(c.editHistory) || !c.editHistory.length){ toast('没有可撤销的编辑'); return; }
  c.content = c.editHistory.pop();
  persist(); renderChapters(); updateWcTotal();
  toast('已撤销一次编辑');
}

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
      <div class="gs-modal-head"><b>📚 版本历史 · 第${i+1}章「${esc(cleanChapterTitle(title))}」</b>
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
          <h3 style="margin:0;flex:1;word-break:break-word;line-height:1.35" title="第${i+1}章 · ${esc(cleanChapterTitle(c.title))}">第${i+1}章 · ${esc(cleanChapterTitle(c.title))}</h3>
          <span class="pill ${stTag}" data-ch-state>${stTxt}</span>
          ${wcBadge(c.content, `data-wc-ch="${i}"`)}
        </div>
        <div class="ch-body${foldedCls}">
          <textarea data-ch="${i}" style="margin-top:8px">${esc(c.content)}</textarea>
          <div class="btn-row">
            <button class="btn ghost" data-regen="${i}" ${state.generating?'disabled':''}>🔄 重生成</button>
            <button class="btn ghost" data-read="${i}">📖 阅读</button>
            ${hasChVersions(i)?`<button class="btn ghost" data-ver="${i}">📚 版本(${chVersions(i).length})</button>`:''}
            ${hasEditHistory(i)?`<button class="btn ghost" data-undo="${i}" title="撤销最近一次手动编辑">↩ 撤销编辑</button>`:''}
            ${isLong() && c.qcRecord ? `<button class="btn ghost" data-qc="${i}" title="查看本次生成的质检记录（AI 改了哪里）">🧪 质检记录</button>`:''}
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
            <h3 style="margin:0;word-break:break-word;line-height:1.35" title="第${i+1}章 · ${esc(cleanChapterTitle(c.title))}">第${i+1}章 · ${esc(cleanChapterTitle(c.title))}</h3>
            ${wcBadge(c.content, `data-wc-ch="${i}"`)}
          </div>
          <span class="pill ${c.confirmed?'tag-ok':'tag-warn'}">${c.confirmed?'✓ 已确认':'待确认'}</span>
        </div>
        <textarea data-ch="${i}" style="margin-top:8px">${esc(c.content)}</textarea>
        <div class="btn-row">
          <button class="btn ghost" data-regen="${i}">🔄 重生成</button>
          <button class="btn ghost" data-read="${i}">📖 阅读</button>
          ${hasChVersions(i)?`<button class="btn ghost" data-ver="${i}">📚 版本(${chVersions(i).length})</button>`:''}
          ${hasEditHistory(i)?`<button class="btn ghost" data-undo="${i}" title="撤销最近一次手动编辑">↩ 撤销编辑</button>`:''}
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
    return `<button type="button" class="toc-item${active}${done}" data-toc="${i}"><span class="toc-idx">${i+1}</span><span class="toc-t">${esc(cleanChapterTitle(c.title)||('第'+(i+1)+'章'))}</span></button>`;
  }).join('');
}
// 阿拉伯数字 → 汉字（用于阅读界面汉字章序）
function toCnNum(n){
  const cn=['零','一','二','三','四','五','六','七','八','九'];
  if(n < 10) return cn[n];
  if(n < 20) return '十' + (n%10 ? cn[n%10] : '');
  if(n < 100){ const t=Math.floor(n/10), u=n%10; return cn[t]+'十'+(u?cn[u]:''); }
  if(n < 1000){ const h=Math.floor(n/100), r=n%100; return cn[h]+'百'+(r? (r<10?'零'+cn[r] : toCnNum(r)) : ''); }
  return String(n);
}
// 剥离章节标题里自带的章序前缀（模型生成 title 常带「第三章 / 第3章 / 第十章」），
// 只保留纯章节名，避免与 UI 统一的「第N章」前置重复成「第3章 · 第三章」。
function cleanChapterTitle(title){
  if(!title) return '';
  let t = String(title).trim();
  t = t.replace(/^(第\s*[0-9一二三四五六七八九十百千两0-9]+\s*章|[一二三四五六七八九十百千]+章)(\s*[·、：:．.，,，\-–—]\s*|\s*)/,'');
  return t.trim();
}
function openReader(i){
  const c = state.chapters[i]; if(!c) return;
  const ov = $('#readerOverlay'); if(!ov) return;
  $('#readerTitle').textContent = `第${toCnNum(i+1)}章 · ${cleanChapterTitle(c.title)}`;
  const paras = String(c.content||'').split(/\n+/).map(p=>p.trim()).filter(Boolean);
  // 无正文时：展示本章梗概（逐章梗概 chapterPlans），让「空章也可预览剧情定位」
  let fallback = `<p class="muted">（本章尚未生成正文）</p>`;
  const plan = (state.outline && Array.isArray(state.outline.chapterPlans) && state.outline.chapterPlans[i])
    ? String(state.outline.chapterPlans[i]).trim() : '';
  if(plan) fallback = `<p class="muted">🧭 本章梗概：${esc(plan)}</p>
    <p class="muted" style="margin-top:6px">生成正文后将在此展示全文。可用下方「重生成」或「一键批量生成」补写。</p>`;
  $('#readerBody').innerHTML = paras.length ? paras.map(p=>`<p>${esc(p)}</p>`).join('') : fallback;
  // 构建目录并定位当前章
  renderToc(i);
  readerCur = i;
  ov.classList.remove('hidden');
  document.body.classList.add('reader-lock'); // 锁定背景滚动
  // P3-3 续读进度（fixed8 修订）：打开时先归零——首开/切到未读过的章一律从开头显示，不再残留上一章滚动位置；
  // 再尝试恢复「本章」上次关闭前的位置（按 项目id + 章节 分别记忆，弃用旧单章 key fyp_rp_${curId}）。
  const body0 = $('#readerBody');
  if(body0) body0.scrollTop = 0;
  try{
    const rp = JSON.parse(localStorage.getItem('fyp_rp_' + (lib.curId||'x') + '_' + i) || 'null');
    if(rp && rp.top){
      requestAnimationFrame(()=>{ const b=$('#readerBody'); if(b) b.scrollTop = rp.top; });
    }
  }catch(e){}
}
// P3-3 续读进度：阅读中节流记录滚动位置（关闭/切换章节后再次打开可续读）
function bindReaderScrollSave(){
  const b = $('#readerBody'); if(!b || b.dataset.rpBound) return;
  b.dataset.rpBound = '1';
  let _t = null;
  b.addEventListener('scroll', ()=>{
    if(_t) return;
    _t = setTimeout(()=>{
      _t = null;
      try{
        // fixed8：按 项目id + 章节 分别记忆，每章各自续读上次关闭前位置
        localStorage.setItem('fyp_rp_' + (lib.curId||'x') + '_' + readerCur, JSON.stringify({ top: b.scrollTop }));
      }catch(e){}
    }, 400);
  }, {passive:true});
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
  bindReaderScrollSave();   // P3-3 续读进度：滚动位置节流保存
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
  // 目录展开时，点击面板其它区域（正文/顶栏空白处）自动收起，无需再点 ✕
  const panel = ov.querySelector('.reader-panel');
  if(panel && toc && tocBtn){
    panel.addEventListener('click', (e)=>{
      if(toc.classList.contains('hidden')) return;      // 目录已收起，无需处理
      if(e.target.closest('#readerToc')) return;        // 点目录内部不收起
      if(e.target.closest('#readerTocBtn')) return;     // 点目录开关不收起（交由自身 toggle）
      toc.classList.add('hidden');
      tocBtn.classList.remove('on');
    });
  }
  // 目录项点击跳转
  const list = $('#tocList');
  if(list && toc) list.onclick = (e)=>{
    const item = e.target.closest('[data-toc]'); if(!item) return;
    openReader(+item.dataset.toc);
  };
  // fixed8：底部中央「概」按钮 → 显示本章梗概（与「逐章梗概」卡片同源：state.outline.chapterPlans[章序号]）
  const synBtn = $('#readerSynBtn'), synPop = $('#readerSynPop'), synCard = $('#readerSynCard');
  if(synBtn && synPop && synCard){
    synBtn.onclick = (e)=>{
      e.stopPropagation();
      const plan = (state.outline && Array.isArray(state.outline.chapterPlans) && state.outline.chapterPlans[readerCur])
        ? String(state.outline.chapterPlans[readerCur]).trim() : '';
      synCard.innerHTML = plan
        ? `<h4>第${toCnNum(readerCur+1)}章 · 梗概</h4><div class="syn-body">${esc(plan)}</div>`
        : `<h4>第${toCnNum(readerCur+1)}章 · 梗概</h4><div class="syn-body muted">（本章暂无梗概）</div>`;
      synPop.classList.remove('hidden');
    };
    synPop.onclick = (e)=>{ if(e.target === synPop) synPop.classList.add('hidden'); };  // 点遮罩关闭
  }
}
document.addEventListener('keydown', (e)=>{
  if(e.key === 'Escape'){
    const sp = $('#readerSynPop');
    if(sp && !sp.classList.contains('hidden')){ sp.classList.add('hidden'); return; }  // fixed8：先收起梗概浮层
    closeReader();
    const h = $('#histPanel'); if(h && !h.classList.contains('hidden')) closeHistPanel();
    const t = $('#themePanel'); if(t && !t.classList.contains('hidden')) closeThemePanel();
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
  const ccNum = chapterCountVal();
  const cap = ccNum ? `全书 ${ccNum} 章` : '';
  el.innerHTML = `<span class="pill">写作进度：${done}/${total} 章</span> <span class="pill">已写约 ${chars.toLocaleString('en-US')} 字${cap ? ' · '+cap : ''}</span>`;
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
        <span class="btn-row" style="margin:0">
          ${hasAssetHist('characters')?`<button id="btnCharHist" class="btn ghost">🕘 历史(${assetHistCount('characters')})</button>`:''}
          <button id="btnGenChars" class="btn ghost">🔄 重生成</button>
        </span>
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
  // P1-3 角色卡内字段可编辑：profile 键值 → input，prompts → textarea，失焦即存
  const kv = Object.entries(pf).map(([k,v])=>`<div class="kv"><span class="k">${esc(k)}</span><input type="text" class="char-edit" data-char-kv="${idx}" data-key="${esc(k)}" data-orig="${esc(v)}" value="${esc(v)}" /></div>`).join('');
  const order = ['定妆图','三视图','表情','服饰细节','道具','配色','材质'];
  const pr = c.prompts||{};
  const cards = order.map(k=>pr[k]==null?'':`
    <div class="subcard">
      <div class="lbl">${esc(k)}<button class="copy" data-copy="${esc(pr[k])}">复制</button></div>
      <textarea class="char-edit" data-char-prompt="${idx}" data-key="${esc(k)}" data-orig="${esc(pr[k])}" rows="3">${esc(pr[k])}</textarea>
    </div>`).join('');
  const allText = Object.values(pf).join(' ') + ' ' + Object.values(pr).join(' ');
  return `<div class="card" id="char-${idx}">
    <h3 style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${esc(c.name||'未命名')} <span class="pill">${esc(c.role||'')}</span> ${wcBadge(allText)}</h3>
    <div class="subcard">${kv}</div>
    ${cards}
    <p class="muted" style="margin:4px 0 0;font-size:11px">字段可直接编辑，失焦即存（不触发 AI）。</p>
  </div>`;
}
// P1-3 角色卡编辑绑定：失焦即存（profile 键值 / prompts 提示词）
function bindCharEdit(){
  $$('[data-char-kv],[data-char-prompt]').forEach(inp=>{
    inp.onchange = ()=>{
      const idx = inp.hasAttribute('data-char-kv') ? +inp.dataset.charKv : +inp.dataset.charPrompt;
      const c = state.characters[idx]; if(!c) return;
      const k = inp.dataset.key;
      const v = inp.value;
      if(v === inp.dataset.orig) return;
      if(inp.hasAttribute('data-char-kv')){
        if(!c.profile) c.profile = {};
        c.profile[k] = v;
      } else {
        if(!c.prompts) c.prompts = {};
        c.prompts[k] = v;
      }
      inp.dataset.orig = v;
      persist();
      toast('角色卡已保存');
    };
  });
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
  bindCharEdit();
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
        <span class="btn-row" style="margin:0">
          ${hasAssetHist('cover')?`<button type="button" class="btn ghost" data-cover-hist>🕘 历史(${assetHistCount('cover')})</button>`:''}
          <span class="pill" id="coverModeLab">${modeLab}</span>
        </span>
      </div>
      ${seg}
      <p class="sub">${modeHint}</p>
      ${state.coverPrompt ? `
        <div class="subcard"><div class="lbl">封面提示词<button class="copy" data-copy="${esc(state.coverPrompt)}">复制</button></div><div class="prompt-text">${esc(state.coverPrompt)}</div></div>
        <label class="field" style="margin-top:8px"><span>✎ 编辑封面提示词（失焦即存，不触发 AI）</span>
          <textarea class="cover-edit" data-cover-edit>${esc(state.coverPrompt)}</textarea></label>
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
      <span class="btn-row" style="margin:0">
        ${hasAssetHist('scenes')?`<button id="btnSceneHist" class="btn ghost">🕘 历史(${assetHistCount('scenes')})</button>`:''}
        <button id="btnGenScenes" class="btn ghost">🔄 重生成</button>
      </span></div></div>` +
    state.scenes.map((s,si)=>`
    <div class="card">
      <h3 style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <input type="text" class="scene-edit-name" data-scene-name="${si}" value="${esc(s.name||'')}" placeholder="场景名" style="flex:0 0 auto;min-width:120px;max-width:220px" />
        <span class="pill tag-env">🌿 纯环境·无人物</span> ${wcBadge((s.description||'')+' '+(s.prompt||''))}</h3>
      <p class="sub">作用：<input type="text" class="scene-edit-role" data-scene-role="${si}" value="${esc(s.作用||'')}" style="flex:1;min-width:160px" /></p>
      <div class="subcard"><div class="lbl">场景设定</div><textarea class="scene-edit-desc" data-scene-desc="${si}" rows="2">${esc(s.description||'')}</textarea></div>
      <div class="subcard"><div class="lbl">即梦出图提示词<button class="copy" data-copy="${esc(s.prompt||'')}">复制</button></div><textarea class="scene-edit-prompt" data-scene-prompt="${si}" rows="3">${esc(s.prompt||'')}</textarea></div>
      <p class="muted" style="margin:4px 0 0;font-size:11px">字段可直接编辑，失焦即存（不触发 AI）。</p>
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
      <span class="btn-row" style="margin:0">
        ${hasAssetHist('storyboard')?`<button id="btnBoardHist" class="btn ghost">🕘 历史(${assetHistCount('storyboard')})</button>`:''}
        <button id="btnGenBoard" class="btn ghost">🔄 重生成</button>
      </span>
    </div>${rows}
    <div class="card board-total">⏱ 全局：<b id="boardTotal">共 ${state.storyboard.length} 镜 · 总时长 ${totalSec}s</b><span class="muted">（每镜时长可点击数字直接修改，统计实时联动）</span></div>`
    + fallbackRaw('storyboard');
}
function shotHtml(i){
  const s = state.storyboard[i];
  // P1-3 分镜卡字段可编辑：text 字段 → input/textarea（失焦即存，不触发 AI）
  const ed = (key, tag='input', rows=2)=> tag==='textarea'
    ? `<textarea class="shot-edit" data-shot="${i}" data-key="${esc(key)}" rows="${rows}">${esc(s[key]||'')}</textarea>`
    : `<input type="text" class="shot-edit" data-shot="${i}" data-key="${esc(key)}" value="${esc(s[key]||'')}" />`;
  return `<div class="shot">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span class="no">镜 ${esc(s.镜号)}</span>
      <span class="dur">⏱ <input type="number" class="dur-input" data-dur="${i}" value="${esc(s.时长??3)}" min="0.5" max="30" step="0.5"> 秒</span>
      ${wcBadge((s.画面描述||'')+' '+(s.出图提示词||''))}
    </div>
    <div class="meta">
      ${['景别','角度','运镜','光线','转场'].map(k=> s[k]?`<span class="pill">${esc(s[k])}</span>`:'').join('')}
    </div>
    ${s.主体!==undefined && s.主体!=='' ? `<div class="prompt-text" style="margin-top:6px"><b>主体：</b>${ed('主体')}</div>`:''}
    ${s.构图!==undefined && s.构图!=='' ? `<div class="prompt-text" style="margin-top:4px"><b>构图：</b>${ed('构图')}</div>`:''}
    <div class="prompt-text" style="margin-top:6px">${ed('画面描述','textarea',2)}</div>
    ${ s.对白 ? `<div class="sub" style="margin-top:6px">💬 ${ed('对白')}</div>`:'' }
    <div class="subcard" style="margin-top:8px"><div class="lbl">出图提示词<button class="copy" data-copy="${esc(s.出图提示词||'')}">复制</button></div>${ed('出图提示词','textarea',3)}</div>
    ${ s.连续性 ? `<div class="muted" style="margin-top:6px">🔗 连续性：${ed('连续性')}</div>`:'' }
    ${ s.剪辑动机 ? `<div class="muted" style="margin-top:4px">🎯 剪辑动机：${ed('剪辑动机')}</div>`:'' }
    <p class="muted" style="margin:4px 0 0;font-size:11px">字段可直接编辑，失焦即存（不触发 AI）。</p>
  </div>`;
}
// P1-3 分镜卡编辑绑定：失焦即存
function bindShotEdit(){
  $$('[data-shot]').forEach(inp=>{
    inp.onchange = ()=>{
      const s = state.storyboard[+inp.dataset.shot]; if(!s) return;
      s[inp.dataset.key] = inp.value;
      persist();
      toast('分镜已保存');
    };
  });
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
// P3-4 长篇导出勾选持久化：勾选状态存 state.expSel，随项目快照持久化（刷新/切换不丢）

function viewExport(){
  // 长篇模式：多选章节 + TXT / EPUB / DOCX 导出
  if(isLong()) return longExportView();
  // 门槛只要求「已生成大纲」：大纲一产出即展示「一、故事大纲」；生成章节后「二、章节正文」随之填充，始终可导
  if(!state.outline) return `<div class="center-empty">尚无可导出的内容。请先生成并确认故事大纲。</div>`;
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
  if(!state.outline) return `<div class="center-empty">尚无可导出的内容。请先生成故事大纲。</div>`;
  const written = state.chapters.filter(c=> c.content && String(c.content).trim()).length;
  // 清理已失效的勾选（章节被重生成等）
  state.expSel = state.expSel.filter(i=> state.chapters[i] && state.chapters[i].content && String(state.chapters[i].content).trim());
  const title = state.outline?.title || '未命名长篇小说';
  const md = buildLongMarkdown();
  // 资产包（story 大纲 + 章节梗概 + 章节全文）前置，与普通模式 viewExport 同款；原长篇选择/格式导出后置
  return `
    <div class="card">
      <h3>📦 导出资产包 · ${esc(title)}</h3>
      <p class="sub">汇总故事大纲 / 章节梗概 / 章节全文，复制后粘贴到文档，或下载 .md。</p>
      <div class="btn-row">
        <button id="lnCopyAll" class="btn primary">📋 复制全部</button>
        <button id="lnDownload" class="btn ghost">⬇️ 下载 .md</button>
      </div>
    </div>
    <div class="card"><textarea id="lnExportArea" style="min-height:300px" readonly>${esc(md)}</textarea></div>
    <div class="card">
      <h3>📦 导出成书（选章节 + 三种格式）</h3>
      <p class="sub">勾选要导出的章节（单章 / 多章 / 全部）。不勾选直接点导出将默认导出全部已写章节。支持三种格式：<b>TXT</b> 纯文本、<b>EPUB</b> 电子书、<b>DOCX</b> 文档。</p>
      <div class="btn-row">
        <button id="expSelAll" class="btn ghost">☑️ 全选已写</button>
        <button id="expSelNone" class="btn ghost">⬜ 清空</button>
        <span class="muted" id="expCount">已选 ${state.expSel.length} / 已写 ${written} 章（共 ${state.chapters.length} 章）</span>
      </div>
      <div class="exp-ch-list">
        ${state.chapters.map((c,i)=>{
          const ok = c.content && String(c.content).trim();
          return `<label class="exp-ch ${ok?'':'disabled'}">
            <input type="checkbox" data-expch="${i}" ${state.expSel.includes(i)?'checked':''} ${ok?'':'disabled'}>
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
// 长篇导出「资产包」内容：故事大纲 + 逐章梗概 + 章节全文（与普通 buildMarkdown 的结构对齐，取长篇字段）
function buildLongMarkdown(){
  const o = state.outline;
  let md = `# ${o?.title||'未命名长篇小说'}\n\n`;
  md += `## 一、故事大纲\n**梗概**：${o?.logline||''}\n\n`;
  (o?.chapters||[]).forEach((c,i)=>{
    // v10.18 逐章梗概（chapterPlans）优先展示；实际发生以章节正文为准（事后回填已去除）
    const plan = (Array.isArray(o.chapterPlans) && o.chapterPlans[i] && String(o.chapterPlans[i]).trim())
      ? String(o.chapterPlans[i]).trim() : '';
    md += `${i+1}. **${c.title||''}**${plan?` — 梗概：${plan}`:'（未生成梗概）'}\n`;
  });
  md += `\n## 二、章节正文\n`;
  // 长篇：仅列出已写章；大纲刚生成、尚未写正文时给占位提示，大纲/梗概仍可先行导出
  const writtenChs = state.chapters.filter(c=> c.content && String(c.content).trim());
  if(writtenChs.length){
    state.chapters.forEach((c,i)=>{
      if(!c.content || !String(c.content).trim()) return;   // 未写章节不落入正文
      md += `\n### 第${i+1}章 ${cleanChapterTitle(c.title)||''}\n${String(c.content).trim()}\n`;
    });
  } else {
    md += `（尚无成章正文，生成章节后自动填充）\n`;
  }
  return md;
}
function activeChapters(){
  let idx = state.expSel.filter(i=> state.chapters[i] && state.chapters[i].content && String(state.chapters[i].content).trim()).sort((a,b)=>a-b);
  if(!idx.length) idx = state.chapters.map((c,i)=> (c.content && String(c.content).trim())?i:null).filter(x=>x!==null);
  return idx;
}
function syncExpChecks(){
  $$('#view [data-expch]').forEach(cb=> cb.checked = state.expSel.includes(+cb.dataset.expch));
  const cnt = $('#expCount'); if(cnt) cnt.textContent = `已选 ${state.expSel.length} / 已写 ${state.chapters.filter(c=>c.content&&String(c.content).trim()).length} 章（共 ${state.chapters.length} 章）`;
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
  idx.forEach(i=>{ const c=state.chapters[i]; t += `\n第${i+1}章 ${cleanChapterTitle(c.title)||''}\n\n${String(c.content||'').trim()}\n`; });
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
    const h1 = `第${i+1}章 ${esc(cleanChapterTitle(c.title)||'')}`;
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
    paras.push(`<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">第${i+1}章 ${xmlEsc(cleanChapterTitle(c.title)||'')}</w:t></w:r></w:p>`);
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
  // 仅在已有成章正文时列出；大纲刚生成、正文未写时此段为空（大纲/角色等资产仍可先行导出）
  const writtenChs = state.chapters.filter(c=> c.content && String(c.content).trim());
  if(writtenChs.length){
    state.chapters.forEach((c,i)=> md += `\n### 第${i+1}章 ${cleanChapterTitle(c.title)}\n${c.content}\n`);
  } else {
    md += `（尚无成章正文，生成章节后自动填充）\n`;
  }
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
  bindCharEdit();      // P1-3 角色卡字段编辑
  bindShotEdit();      // P1-3 分镜卡字段编辑

  // 赛博朋克首页入口卡片
  $$('.cyber-home-grid [data-step]').forEach(b=> b.onclick = ()=>{ currentStep = +b.dataset.step; render(); window.scrollTo(0,0); });

  // P1
  const idea = $('#ideaInput'); if(idea){
    idea.oninput = ()=> state.idea = idea.value;
    bindPolishIdea();   // v10.13 优化构想按钮 + 优化区绑定
    $('#btnGenOutline').onclick = genOutline;
  }
  // v10.18 结构骨架 / 可复用词典折叠（默认收起，点标题展开）
  $$('[data-rec-fold]').forEach(h=> h.onclick = ()=>{
    const key = h.dataset.recFold;
    state.recipeSet = state.recipeSet || {structure:null,rhythm:null,quality:[]};
    if(!state.recipeSet.recFold) state.recipeSet.recFold = {};
    state.recipeSet.recFold[key] = !state.recipeSet.recFold[key];
    const body = h.parentNode && h.parentNode.querySelector('.recipe-fold-b');
    if(body) body.hidden = !state.recipeSet.recFold[key];
    const ico = h.querySelector('.rec-fold-ico'); if(ico) ico.textContent = state.recipeSet.recFold[key]?'▾':'▸';
    h.setAttribute('aria-expanded', String(state.recipeSet.recFold[key]));
    persist();
  });
  // 长篇：三维写作范式选择（结构单选 / 节奏单选 / 质量多选 / 体量二选一）
  $$('[data-structure]').forEach(b=> b.onclick = ()=>{
    const id = b.dataset.structure;
    state.recipeSet = state.recipeSet || {structure:null,rhythm:null,quality:[]};
    if(state.recipeSet.structure === id){ /* 已选中，可取消 */ state.recipeSet.structure = null; }
    else { state.recipeSet.structure = id; }
    persist(); render();
  });
  // 自动质检开关（取代旧「质量机制」多选）：点击切换 开/关
  $$('[data-autogc]').forEach(b=> b.onclick = ()=>{
    state.autoQC = !((typeof state.autoQC === 'boolean') ? state.autoQC : true);
    persist(); render();
  });
  // 全书章节数：直接填整数（1-200 必填）。失焦/回车提交 → 设定或解锁范式
  const ccIn = $('#totalWordsIn');
  if(ccIn){
    ccIn.addEventListener('keydown', e=>{ if(e.key==='Enter') ccIn.blur(); });
    ccIn.addEventListener('change', ()=>{
      const v = Math.floor(Number(ccIn.value));
      if(Number.isInteger(v) && v>=1 && v<=200) state.chapterCount = v;
      else { state.chapterCount = null; toast('章节数需为 1-200 的整数'); }
      persist(); render();
    });
  }
  bindGlossary();
  bindOrigIdea();     // v10.2 原始构想只读卡绑定
  bindStructureFold();// v10.3 长篇结构设计栏折叠绑定
  bindStructureEdit();// P0-2 结构设计行内编辑（失焦即存 + 追加副线）
  bindChapterPlan();  // v10.11 逐章梗概区块绑定
  bindChapterPlanFold(); // v10.14 梗概卡折叠绑定
  bindChapterTitles();// v10.14 章节标题编辑 + 复制绑定
  bindWriteStyle();   // v2.0 写作风格卡片绑定（chips/浓度/预设/收藏/管理/清空）
  bindPendingGlossary();
  // 故事页内联规范选择器
  $$('.spec-opt').forEach(b=> b.onclick = ()=>{ selectSpec(b.dataset.spec); });
  const btnCO = $('#btnConfirmOutline'); if(btnCO) btnCO.onclick = ()=>{ state.outlineConfirmed=true; persist(); render(); };
  const btnOH = $('#btnOutlineHist'); if(btnOH) btnOH.onclick = ()=> openOutlineHistoryPanel();
  const btnRO = $('#btnReOutline'); if(btnRO) btnRO.onclick = ()=>{ state.outline=null; state.outlineConfirmed=false; state.chapters=[]; persist(); render(); };
  const btnGA = $('#btnGenAllChapters'); if(btnGA) btnGA.onclick = genAllChapters;
  // 多章生成：读取用户填写的章数（默认 2，可 1~任意），一次连续生成该数量章节。
  // 复刻「一键批量生成 2 章」的全部规则，仅章数由输入决定。
  const btnGenMany = $('#btnGenMany');
  const genCountIn = $('#genCountIn');
  if(genCountIn) genCountIn.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); if(btnGenMany) btnGenMany.click(); } });
  if(btnGenMany) btnGenMany.onclick = ()=>{
    let n = Math.floor(Number(genCountIn && genCountIn.value));
    if(!n || n < 1 || n > 999){ toast('请输入有效的生成章数（1~999）'); return; }
    genManyChapters(n);
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
  // P3-1 曾用名：一键恢复（改回该名，当前名自动记入曾用）/ 删除该条记录
  $$('#tmHist [data-hist-restore]').forEach(b=> b.onclick = (e)=>{
    e.stopPropagation();
    if(!confirm(`将书名恢复为「${b.dataset.histRestore}」？（当前名会记入曾用名）`)) return;
    renameTitle(b.dataset.histRestore);
    histPanel_.classList.add('hidden');
    const tri = $('#btnTmTri'); if(tri) tri.classList.remove('on');
  });
  $$('#tmHist [data-hist-del]').forEach(b=> b.onclick = (e)=>{
    e.stopPropagation();
    if(!confirm('删除该条曾用名记录？')) return;
    state.titleHistory.splice(+b.dataset.histDel, 1);
    persist(); render();
    toast('已删除该记录');
  });
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
  const btnCH = $('#btnCharHist'); if(btnCH) btnCH.onclick = ()=> openAssetHistPanel('characters');
  // P3
  const btnGS = $('#btnGenScenes'); if(btnGS) btnGS.onclick = genScenes;
  const btnCV = $('#btnGenCover'); if(btnCV) btnCV.onclick = genCover;
  const btnCVH = $('[data-cover-hist]'); if(btnCVH) btnCVH.onclick = ()=> openAssetHistPanel('cover');
  // P1-3 封面提示词行内编辑：失焦即存（不触发 AI）
  $$('[data-cover-edit]').forEach(ta=>{
    ta.onchange = ()=>{ state.coverPrompt = ta.value; persist(); toast('封面提示词已保存'); };
  });
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
  const btnBH = $('#btnBoardHist'); if(btnBH) btnBH.onclick = ()=> openAssetHistPanel('storyboard');
  const btnSH = $('#btnSceneHist'); if(btnSH) btnSH.onclick = ()=> openAssetHistPanel('scenes');
  // P1-3 场景卡行内编辑：失焦即存
  $$('[data-scene-name]').forEach(inp=> inp.onchange = ()=>{ const s=state.scenes[+inp.dataset.sceneName]; if(s){ s.name=inp.value; persist(); } });
  $$('[data-scene-role]').forEach(inp=> inp.onchange = ()=>{ const s=state.scenes[+inp.dataset.sceneRole]; if(s){ s.作用=inp.value; persist(); } });
  $$('[data-scene-desc]').forEach(ta=> ta.onchange = ()=>{ const s=state.scenes[+ta.dataset.sceneDesc]; if(s){ s.description=ta.value; persist(); } });
  $$('[data-scene-prompt]').forEach(ta=> ta.onchange = ()=>{ const s=state.scenes[+ta.dataset.scenePrompt]; if(s){ s.prompt=ta.value; persist(); toast('场景提示词已保存'); } });
  // P5
  const btnCA = $('#btnCopyAll'); if(btnCA) btnCA.onclick = ()=> copyText(buildMarkdown());
  const btnDL = $('#btnDownload'); if(btnDL) btnDL.onclick = ()=> download(`影视资产包_${state.outline?.title||'story'}.md`, buildMarkdown());
  // 长篇：多选章节 + 三种格式导出
  if(isLong()){
    // 资产包（与普通模式同款）：复制全部 / 下载 .md
    const lnCA = $('#lnCopyAll'); if(lnCA) lnCA.onclick = ()=> copyText(buildLongMarkdown());
    const lnDL = $('#lnDownload'); if(lnDL) lnDL.onclick = ()=> download(`长篇资产包_${state.outline?.title||'story'}.md`, buildLongMarkdown());
    $$('#view [data-expch]').forEach(cb=> cb.onchange = ()=>{
      const i = +cb.dataset.expch;
      if(cb.checked){ if(!state.expSel.includes(i)) state.expSel.push(i); } else state.expSel = state.expSel.filter(x=>x!==i);
      persist();   // P3-4 勾选随项目快照持久化
      syncExpChecks();
    });
    const selAll = $('#expSelAll'); if(selAll) selAll.onclick = ()=>{ state.expSel = state.chapters.map((c,i)=> (c.content && String(c.content).trim())?i:null).filter(x=>x!==null); persist(); syncExpChecks(); };
    const selNone = $('#expSelNone'); if(selNone) selNone.onclick = ()=>{ state.expSel=[]; persist(); syncExpChecks(); };
    const bt = $('#expTxt'); if(bt) bt.onclick = expText;
    const be = $('#expEpub'); if(be) be.onclick = expEpub;
    const bd = $('#expDocx'); if(bd) bd.onclick = expDocx;
  }

  // 章节编辑/重生成/确认/阅读（动态）
  renderChapters();
  // 用事件委托处理章节区内部点击：分页/折叠会重建部分按钮，委托在 #chaptersWrap 上保证始终生效（Bug2 修复）
  const chaptersDelegate = (e)=>{
    const t = e.target.closest('[data-regen],[data-toggle],[data-read],[data-fold],[data-page],[data-ver],[data-undo],[data-qc]');
    if(!t) return;
    if(t.hasAttribute('data-ver')){ openChapterVersionPanel(+t.dataset.ver); }
    else if(t.hasAttribute('data-undo')){ undoChapterEdit(+t.dataset.undo); }
    else if(t.hasAttribute('data-qc')){ openChapterQcPanel(+t.dataset.qc); }
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
    // P0-3 手动编辑撤销：聚焦时记录原值，失焦（change）时若有变化把旧值快照入 editHistory（上限10）
    cw.addEventListener('focusin', (e)=>{
      const ta = e.target.closest('textarea[data-ch]'); if(!ta) return;
      const c = state.chapters[+ta.dataset.ch];
      ta._orig = c ? (c.content||'') : '';
    });
    cw.addEventListener('change', (e)=>{
      const ta = e.target.closest('textarea[data-ch]'); if(!ta) return;
      const i = +ta.dataset.ch; const c = state.chapters[i]; if(!c) return;
      const old = (ta._orig !== undefined) ? ta._orig : (c.content||'');
      if(ta.value !== old && String(ta.value||'') !== String(old||'')){
        if(!Array.isArray(c.editHistory)) c.editHistory = [];
        c.editHistory.push(old);
        if(c.editHistory.length > 10) c.editHistory.splice(0, c.editHistory.length - 10);   // 上限10
        persist(); renderChapters(); updateWcTotal();
        toast('已记录编辑快照，可用「↩ 撤销编辑」回退');
      }
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
/* ---------- P0-1 大纲版本历史：覆盖前快照 + 📚 弹窗预览/恢复（上限10） ---------- */
function snapshotOutline(){
  const o = state.outline;
  if(!o || typeof o !== 'object') return;
  const copy = JSON.parse(JSON.stringify(o));
  state.outlineHistory.unshift({ outline: copy, ts: Date.now() });
  if(state.outlineHistory.length > 10) state.outlineHistory.splice(10);
}
function hasOutlineHistory(){ return Array.isArray(state.outlineHistory) && state.outlineHistory.length > 0; }
function outlineHistoryCount(){ return hasOutlineHistory() ? state.outlineHistory.length : 0; }
function openOutlineHistoryPanel(){
  closeOutlineHistoryPanel();
  if(!hasOutlineHistory()){ toast('暂无历史版本'); return; }
  const fmtTs = ts=>{ const d=new Date(ts); return (d.getFullYear())+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
  const wc = o => { const s = JSON.stringify(o||{}); return (s.length||0); };
  const rows = state.outlineHistory.map((h,idx)=>{
    const o = h.outline || {};
    const n = (o.chapters||[]).length;
    return `<div class="cv-row">
      <div class="cv-meta" style="flex:1;min-width:0"><div class="cv-time">${fmtTs(h.ts)}</div><div class="cv-t" style="font-size:12px;color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(o.title||'未命名')} · ${n} 章 · ${wc(o)} 字符</div></div>
      <div class="cv-actions" style="display:flex;gap:6px;flex-shrink:0">
        <button type="button" class="btn ghost cv-b" data-ov-prev="${idx}">预览</button>
        <button type="button" class="btn ghost cv-b" data-ov-restore="${idx}">↩ 恢复</button>
      </div>
    </div>`;
  }).join('');
  const ov = document.createElement('div'); ov.id='ovPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>📚 大纲版本历史（${state.outlineHistory.length}/10）</b>
        <button class="gs-x" data-ov-close>✕</button></div>
      <div class="cv-body">
        <div class="cv-row cur"><div class="cv-meta"><span class="cv-time">当前版本</span><span class="cv-wc">${esc((state.outline&&state.outline.title)||'未命名')} · ${(state.outline&&state.outline.chapters||[]).length} 章</span></div></div>
        <div class="cv-div">历史版本：恢复前会把当前大纲自动存入历史；恢复后章节列表按该版大纲重建（正文清空，已写章节保留在版本内可回退）。</div>
        ${rows}
        <div class="cv-preview hidden" id="ovPreview">
          <div class="cv-prev-head"><b id="ovPrevTitle">版本预览</b><button class="gs-x" data-ov-prev-close>✕</button></div>
          <div class="cv-pre" id="ovReader"></div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-ov-close]').onclick = closeOutlineHistoryPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeOutlineHistoryPanel(); });
  ov.addEventListener('click', e=>{
    const p = e.target.closest('[data-ov-prev]'); if(!p) return;
    const h = state.outlineHistory[+p.dataset.ovPrev]; if(!h) return;
    const o = h.outline||{};
    const pr=$('#ovPreview'), rd=$('#ovReader'), pt=$('#ovPrevTitle');
    if(pr && rd){
      pt.textContent = '预览 · '+fmtTs(h.ts);
      rd.innerHTML = `<b>${esc(o.title||'')}</b><br><span class="muted">${esc(o.logline||'')}</span><br><br>` +
        (o.chapters||[]).map((c,i)=>`${i+1}. ${esc((c&&c.title)||'')}`).join('<br>');
      pr.classList.remove('hidden');
    }
  });
  ov.querySelector('[data-ov-prev-close]').onclick = ()=>{ const pr=$('#ovPreview'); if(pr) pr.classList.add('hidden'); };
  ov.addEventListener('click', e=>{
    const rb = e.target.closest('[data-ov-restore]'); if(!rb) return;
    const h = state.outlineHistory[+rb.dataset.ovRestore]; if(!h) return;
    if(!window.confirm('恢复该版大纲将覆盖当前大纲（当前大纲自动存入历史，不会丢失）。若新旧章节数一致，已写正文会保留；否则章节列表按该版重建。确定恢复吗？')) return;
    snapshotOutline();                       // 当前大纲入历史
    const newOutline = JSON.parse(JSON.stringify(h.outline));
    const oldOutline = state.outline;
    state.outline = newOutline;
    state.outlineConfirmed = false;
    if(state.chapters.length === (newOutline.chapters||[]).length && oldOutline && (oldOutline.chapters||[]).length === state.chapters.length){
      // 章节数一致：保留已写正文，仅同步标题（避免恢复大纲把正文冲掉）
      state.chapters.forEach((c,i)=>{ const oc=newOutline.chapters[i]; if(oc) c.title = oc.title; });
    } else {
      state.chapters = (newOutline.chapters||[]).map(c=>({title:(c&&c.title)||'', content:'', summary:'', confirmed:false}));
    }
    persist(); closeOutlineHistoryPanel(); render();
    toast('已恢复历史大纲');
  });
}
function closeOutlineHistoryPanel(){ const p=$('#ovPanel'); if(p) p.remove(); }

async function genOutline(){
  const btn = $('#btnGenOutline'); busy(btn,true,'生成大纲中…');
  const st = $('#outlineStatus'); st.className='status'; st.textContent='';
  state.idea = $('#ideaInput').value.trim();
  if(!state.idea){ toast('先写几句构想'); busy(btn,false); return; }
  // 长篇：生成大纲前必须已设定书籍章节数（1-200 必填）
  if(isLong() && !chapterCountVal()){ toast('请先填写全书章节数（1-200）'); busy(btn,false); return; }
  // 显示停止按钮
  const stopParent = btn.parentNode;
  showStopBtn(stopParent);
  // 未选结构时的处理：结构标签留空，让 AI 完全按用户提示词自然发挥组织结构，不做随机锁定、不做固定默认
  try{
    const sys = isLong() ? longOutlineSys() : PROMPTS.outlineSys + specSysAddition();
    const txt = await callDeepSeek(sys, '故事构想：'+state.idea, {temperature: resolveActiveSpec().outlineTemp, signal: _abortCtl?.signal});   // v10.8 大纲温度
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
    // 追加规划·长篇携带结构设计：任选结构/未选，都保证 o.structure 存在。
    //    - 选中结构：st.outlineSys 已内联主线条四格（S1，见 MAIN_LINE_BLOCK）+ 结构专属章节映射，满足统一契约（副/暗/汇含有则带无则空）
    //    - 未选结构：STRUCTURE_MAIN_SYS 已要求 AI 产出主线条四格；chapterPlan 由 CHAPTER_PLAN_FREE_SYS 自由分组，失败才兜底，不硬造
      if(isLong()){
        const st = selStructure();
        if(!o.structure || typeof o.structure !== 'object') o.structure = {};
        const s = o.structure;
        if(!s.mainLine) s.mainLine = o.logline || '';
        if(st){
          // 章节安排兜底：若结构自带专属章节映射（stageChapters/beats/points/volumes），则不强行生成 chapterPlan，
          //   前端会优先用专属映射呈现；否则（网状多线/单线因果）兜底生成 chapterPlan，保证"全部章节安排"一格不空。
          const hasStage = s.stageChapters || s.beats || s.points || (o.volumes && o.volumes.length);
          if(!hasStage){
            if(!s.chapterPlan || typeof s.chapterPlan !== 'object' || !Object.keys(s.chapterPlan).length){
              const flat = {};
              const planKey = (o.chapters && o.chapters[0] && o.chapters[0].volume) ? '全卷章节' : '全章规划';
              flat[planKey] = (o.chapters||[]).map((c,i)=>{ const t=(c&&c.title)||('第'+(i+1)+'章'); return `${t}`; });
              s.chapterPlan = flat;
            }
          }
          // 铁律：subLines/hiddenLine/pivotPlan 空即为空，不做任何填充
          if(!s.subLines) s.subLines = [];
          if(!s.hiddenLine) s.hiddenLine = '';
          if(!s.pivotPlan) s.pivotPlan = '';
        } else {
          // 未选结构：兜底 chapterPlan（AI 自由分组失败也至少保证"全部章节安排"一格不空）
          if(!s.chapterPlan || typeof s.chapterPlan !== 'object' || !Object.keys(s.chapterPlan).length){
            const flat = {};
            const planKey = (o.chapters && o.chapters[0] && o.chapters[0].volume) ? '全卷章节' : '全章规划';
            flat[planKey] = (o.chapters||[]).map((c,i)=>{ const t=(c&&c.title)||('第'+(i+1)+'章'); return `${t}`; });
            s.chapterPlan = flat;
          }
          // 轻量结构骨架：主线已由上方兜底为 logline；副/暗/汇合按"有则带无则空"归一，保证渲染契约一致
          if(!s.subLines) s.subLines = [];
          if(!s.hiddenLine) s.hiddenLine = '';
          if(!s.pivotPlan) s.pivotPlan = '';
        }
      // 结构模式：已选结构则用其名；未选结构则留空（AI 按用户提示词自然发挥，结构标签不做固定默认）
      if(!s.mode) s.mode = (st && st.name) || '';
    }
    // P0-1：新大纲覆盖前，先把旧大纲快照入版本历史（上限10）
    snapshotOutline();
    state.outline = o; state.outlineConfirmed=false;
    // 万物词典：新生成大纲默认含 glossary（人物/地名/专名）；旧大纲缺省时给空，UI 提示重生成可启用
    if(!o.glossary || (!o.glossary.characters && !o.glossary.places && !o.glossary.propernouns)){
      o.glossary = { characters:[], places:[], propernouns:[] };
    }
    // v10.2 原始构想快照：与大纲同生命周期，供「原始构想」只读区展示（不随后续修改构想而漂移）
    o.userIdea = state.idea;
    // v10.11 逐章梗概：新大纲生成时重置为空（防旧梗概错配新章节数/新标题）；兜底非数组
    if(!Array.isArray(o.chapterPlans)) o.chapterPlans = [];
    o.chapterPlans.length = 0;
    // v8 双轨合并：若构想阶段挂载过辅轨词典，按遵从度把它与新作大纲词典合并为权威词典，再清空辅轨槽位
    let mergeNote = '';
    if(state.pendingGlossary && sourceHasGlossary(state.pendingGlossary)){
      const m = glossaryMerge(state.pendingGlossary, o.glossary, state.glossAdherence, state.glossAllowFill);
      o.glossary = m.glossary;
      mergeNote = ` · 词典已并入（沿用 ${m.kept} · 新增 ${m.added}${m.rec?` · 覆盖 ${m.rec}`:''}）`;
      state.pendingGlossary = null; state.glossAllowFill = false;
    }
    state.chapters = o.chapters.map(c=>({title:c.title, content:'', summary:'', confirmed:false}));
    persist(); render();
    toast('大纲已生成'+mergeNote);
  }catch(e){
    if(e.name==='AbortError'){ st.className='status'; st.textContent='已停止生成'; }
    else { st.className='status err'; st.textContent = e.message; }
  }finally{ hideStopBtn(); busy(btn,false); }
}

// v10.18 逐章梗概生成：一次请求产出全部章节的本章梗概（chapterPlans，非一句话方向，写清本章发生之事）。
// 输入 = 标题列表 + logline + 结构设计 + 设定词典，保证与全局一致。
// 失败保持原值不清空；覆盖由调用方 confirm 把关。
async function genChapterPlans(btn){
  const o = state.outline;
  if(!isLong() || !o) return;
  if(btn){ btn.classList.add('cp-gen-btn-loading'); busy(btn,true,'生成逐章梗概中…'); }
  // 创建临时预览区（仅流式可用时显示）
  const cpBody = btn && btn.closest('.cp-card') && btn.closest('.cp-card').querySelector('.cp-body .cp-list');
  let preview = null;
  const isStream = currentIsDeepSeek();
  if(isStream && cpBody){
    preview = document.createElement('pre');
    preview.className = 'cp-stream-preview'; preview.textContent = '正在生成梗概…';
    cpBody.parentNode.insertBefore(preview, cpBody);
  }
  // 显示停止按钮
  const stopParent = btn && btn.closest('.action-row') ? btn.closest('.action-row') : (btn&&btn.parentNode);
  if(stopParent) showStopBtn(stopParent);
  let _streamBuf = '';
  try{
    const titles = (o.chapters||[]).map((c,i)=> `第${i+1}章《${c&&c.title||''}》`).filter(Boolean).join(' / ');
    if(!titles){ toast('尚无章节标题'); return; }
    const parts = [];
    // ★ 首位要求：若开启风格约束且已选「梗概风格」，把风格指令插到最前（实时读 state.chapterStyle）。未选时自动空串，降级为无约束。
    if(state.planStyleOn){
      const styleBlock = writeStylePlanBlock();
      if(styleBlock) parts.push('【写作风格约束（首位要求，须优先遵循）】\n'+styleBlock);
    }
    parts.push(`小说标题：${o.title||''}\n一句话梗概：${o.logline||''}\n全部章节标题：${titles}`);
    parts.push(structurePlanBlockNoTitles(o));   // 长篇结构设计（主线/副线/暗线/汇合，不含章节标题清单，避免与上方「全部章节标题」重复夹带，遵 v2.3）
    parts.push(chapterGlossaryBlock());
    const user = parts.join('\n\n') + '\n\n' + ORIGINALITY_OUTLINE_SYS;   // v10.12 防套路：方向防套路 + 人名规避（复用大纲侧）
    const onStream = delta => {
      _streamBuf += String(delta||'');
      if(preview){ preview.textContent = _streamBuf; preview.scrollTop = preview.scrollHeight; }
    };
    const txt = await callDeepSeek(CHAPTER_PLAN_SYS, user, {temperature: resolveActiveSpec().planTemp, onStream: isStream ? onStream : null, signal: _abortCtl?.signal});
    const j = parseJson(txt) || {};
    const arr = Array.isArray(j.chapterPlans) ? j.chapterPlans.map(x=>String(x||'').trim()) : [];
    if(!arr.length || !arr.some(Boolean)){ toast('未解析到梗概，请重试'); return; }
    // 数量与章节对齐：不足补齐占位，超出截断
    const n = (o.chapters||[]).length;
    const plans = Array.from({length:n},(_,i)=> arr[i] || '');
    // P1-1v3 覆盖前把旧整批归档为可回退版本（整批、上限5、去重）
    pushChapterPlansSnapshot();
    o.chapterPlans = plans;
    persist();
    // 就地更新梗概列表，不刷新全页（保留预览区；同时更新「版本」按钮）
    const cpList = document.querySelector('.cp-card .cp-list');
    if(cpList){
      const items = plans.map((t,i)=>`
        <div class="cp-item">
          <span class="cp-no">${i+1}</span>
          <textarea class="cp-input" rows="3" data-cp-set="${i}" data-orig="${esc(t)}" placeholder="本章梗概（可编辑）">${esc(t)}</textarea>
          <span class="cp-wc">${t.length}字</span>
        </div>`).join('');
      cpList.innerHTML = items;
      // 重新绑定失焦存 + 字数统计
      $$('.cp-input').forEach(inp=>{
        inp.oninput = ()=>{
          const wc = inp.parentNode && inp.parentNode.querySelector('.cp-wc');
          if(wc) wc.textContent = inp.value.length + '字';
        };
        inp.onchange = ()=>{
          const o = state.outline; if(!o) return;
          if(!Array.isArray(o.chapterPlans)) o.chapterPlans = [];
          const i = +inp.dataset.cpSet;
          if(inp.value === inp.dataset.orig) return;
          o.chapterPlans[i] = inp.value;
          inp.dataset.orig = inp.value;
          persist();
        };
      });
    }
    // 刷新「版本」按钮
    const actionRow = document.querySelector('.cp-card .action-row');
    if(actionRow){
      const histBtn = actionRow.querySelector('[data-cp-hist]');
      const histCount = chapterPlansHistoryCount();
      if(histCount && !histBtn){
        const b = document.createElement('button');
        b.type='button'; b.className='btn ghost'; b.dataset.cpHist='';
        b.innerHTML = '📚 版本('+histCount+')';
        b.onclick = ()=> openChapterPlansHistoryPanel();
        actionRow.insertBefore(b, actionRow.querySelector('.cp-gen-btn'));
      }else if(histCount && histBtn){
        histBtn.innerHTML = '📚 版本('+histCount+')';
      }
    }
    // 重新绑定折叠事件防止冲突
    bindChapterPlanFold();
    toast(`已生成 ${plans.filter(Boolean).length} 条逐章梗概`);
  }catch(e){
    if(e.name==='AbortError'){ toast('已停止生成梗概'); }
    else { toast('梗概生成失败：'+e.message); }
  }
  finally{ hideStopBtn(); if(preview) preview.remove(); if(btn){ btn.classList.remove('cp-gen-btn-loading'); busy(btn,false); } }
}

/* ---------- P1-1v3 逐章梗概批量版本（整批快照 ≤5 份，应用后生效） ---------- */
function chapterPlansHistory(){ const o=state.outline; return (o && Array.isArray(o.chapterPlansHistory)) ? o.chapterPlansHistory : []; }
function hasChapterPlansHistory(){ return chapterPlansHistory().length > 0; }
function chapterPlansHistoryCount(){ return chapterPlansHistory().length; }
// 把「当前全部逐章梗概」整批压入版本栈（最新在前、去重、上限5）；空则不记
function pushChapterPlansSnapshot(){
  const o = state.outline;
  if(!Array.isArray(o.chapterPlans) || !o.chapterPlans.some(Boolean)) return;
  if(!Array.isArray(o.chapterPlansHistory)) o.chapterPlansHistory = [];
  const snap = o.chapterPlans.slice();
  if(o.chapterPlansHistory.length && JSON.stringify(o.chapterPlansHistory[0].plans) === JSON.stringify(snap)) return;
  o.chapterPlansHistory.unshift({ plans: snap, ts: Date.now() });
  if(o.chapterPlansHistory.length > 5) o.chapterPlansHistory.length = 5;
}
// 整批应用某版：先把当前态归档（保留再回退机会），再覆盖全部逐章梗概
function applyChapterPlansVersion(idx){
  const o = state.outline; const hist = chapterPlansHistory(); const h = hist[idx]; if(!h) return;
  if(!window.confirm(`整批应用「${idx+1}. 逐章梗概」版本（共 ${(h.plans||[]).filter(Boolean).length} 条）？将覆盖当前逐章梗概。`)) return;
  pushChapterPlansSnapshot();
  o.chapterPlans = (h.plans||[]).slice();
  persist(); closeChapterPlansHistoryPanel(); render();
  toast('已整批应用该版逐章梗概');
}
function deleteChapterPlansVersion(idx){
  const o = state.outline; const hist = chapterPlansHistory(); if(!hist.length) return;
  hist.splice(idx,1);
  if(!hist.length) delete o.chapterPlansHistory; else o.chapterPlansHistory = hist;
  persist(); closeChapterPlansHistoryPanel(); openChapterPlansHistoryPanel();
  toast('已删除该版本');
}
function openChapterPlansHistoryPanel(){
  closeChapterPlansHistoryPanel();
  const hist = chapterPlansHistory(); if(!hist.length){ toast('暂无历史版本'); return; }
  const o = state.outline;
  const fmtTs = ts=>{ const d=new Date(ts); return (d.getMonth()+1)+'-'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
  const rows = hist.map((h,idx)=>{
    const n = (h.plans||[]).filter(Boolean).length;
    const first = (h.plans||[]).slice(0,2).filter(Boolean).join(' / ');
    return `<div class="cv-row">
      <div class="cv-meta" style="flex:1;min-width:0"><div class="cv-time">${idx+1}. ${fmtTs(h.ts)} · ${n} 条</div><div class="cv-t" style="font-size:12px;color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(first||'')}</div></div>
      <div class="cv-actions" style="display:flex;gap:6px;flex-shrink:0">
        <button type="button" class="btn ghost cv-b" data-cph-prev="${idx}">👁 预览</button>
        <button type="button" class="btn primary cv-b" data-cph-apply="${idx}">应用</button>
        <button type="button" class="btn ghost cv-b" data-cph-del="${idx}">🗑</button>
      </div>
    </div>`;
  }).join('');
  const ov = document.createElement('div'); ov.id='cphPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>🧭 逐章梗概 · 批量版本（${hist.length}/5）</b>
        <button class="gs-x" data-cph-close>✕</button></div>
      <div class="cv-body">
        <div class="cv-row cur"><div class="cv-meta"><span class="cv-time">当前版本</span><span class="cv-wc">${(Array.isArray(o.chapterPlans)?o.chapterPlans:[]).filter(Boolean).length} 条</span></div></div>
        <div class="cv-div">「生成/重生成逐章梗概」会把改动前后的整批各归档一份（≤5 份可回退）；可👁预览切换，点「应用」整批生效——只有应用后才覆盖当前梗概。</div>
        ${rows}
        <div class="cv-preview hidden" id="cphPreview">
          <div class="cv-prev-head"><b id="cphPrevTitle">版本预览</b><button class="gs-x" data-cph-prev-close>✕</button></div>
          <div class="cv-pre" id="cphReader"></div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-cph-close]').onclick = closeChapterPlansHistoryPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeChapterPlansHistoryPanel(); });
  ov.addEventListener('click', e=>{
    const p = e.target.closest('[data-cph-prev]'); if(!p) return;
    const h = hist[+p.dataset.cphPrev]; if(!h) return;
    const pr=$('#cphPreview'), rd=$('#cphReader'), pt=$('#cphPrevTitle');
    if(pr && rd){ pt.textContent = '预览 · '+fmtTs(h.ts); rd.textContent = (h.plans||[]).map((t,i)=>`第${i+1}章 ${t||''}`).join('\n'); pr.classList.remove('hidden'); }
  });
  ov.querySelector('[data-cph-prev-close]').onclick = ()=>{ const pr=$('#cphPreview'); if(pr) pr.classList.add('hidden'); };
  ov.querySelectorAll('[data-cph-apply]').forEach(b=> b.onclick = ()=> applyChapterPlansVersion(+b.dataset.cphApply));
  ov.querySelectorAll('[data-cph-del]').forEach(b=> b.onclick = ()=> deleteChapterPlansVersion(+b.dataset.cphDel));
}
function closeChapterPlansHistoryPanel(){ const p=$('#cphPanel'); if(p) p.remove(); }

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
      ctx += `\n\n【本卷定位】\n所属卷：${c.volume}\n本卷主题与情绪基调：${c.volumeTheme||''}`;
    }
  }
  // 结构设计：只要大纲携带 structure（含兜底）就注入【整体结构】，与统一契约一致
  if(o.structure && typeof o.structure === 'object'){
    const s = o.structure;
    const flat = [];
    if(s.mode) flat.push('结构模式：'+s.mode);
    const curTitle = (o.chapters[i] && o.chapters[i].title) || '';
    // 定位本章归属维度：优先结构专属章节映射（stageChapters/beats/points），回退统一 chapterPlan
    const planMap = (s && (s.stageChapters || s.beats || s.points || s.chapterPlan)) || null;
    const curGroup = chapterGroupOf(i, planMap, curTitle);
    if(curGroup && curGroup !== '（未匹配，按大纲推进即可）') flat.push('【本章归属】维度「'+curGroup+'」');
    const nt = structurePlanBlockNoTitles(o);   // v2.4 无标题版（主线/副/暗/汇合，不含全章节计划标题清单）
    if(nt) flat.push(nt);
    ctx += '\n\n【整体结构】\n' + flat.join('\n');
  }
  return ctx;
}

// 定位“本章属于哪个分组/维度”——遍历 chapterPlan（维度名 → 章列表），通过章节下标或标题命中
function chapterGroupOf(i, map, curTitle){
  return stageOfChapter(i, map, curTitle);
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
// 自动质检开关（取代旧「质量机制」三选多选框，按 安排token.md §13.3）：默认开，生成后自动两段式查错修正
function qualityToggleHtml(){
  const on = (typeof state.autoQC === 'boolean') ? state.autoQC : true;
  return `
    <div class="poly-dim">
      <div class="poly-head"><span class="poly-ic">🛡️</span><b>自动质检</b><span class="poly-rule">默认开 · 生成后自动查错修正（逻辑/人物/专名/文笔），无错即通过</span></div>
      <div class="poly-grid">
        <button type="button" class="autoqc-toggle ${on?'active':''}" data-autogc role="switch" aria-checked="${on}">
          <span class="aqc-track"><span class="aqc-knob"></span></span>
          <span class="aqc-label">${on?'已开启':'已关闭'}</span>
        </button>
      </div>
    </div>`;
}
// 长篇：写作范式选择器（结构 + 质量 + 可复用词典，均折叠；节奏/标题两维度 v10.18 移除）
function recipePicker(){
  const rs = state.recipeSet || {structure:null,rhythm:null,quality:[]};
  const selSt = selStructure();
  // 组合摘要
  const labelSt = selSt ? selSt.name : '未选';
  const labelQ = state.autoQC ? '自动质检' : '已关闭';
  // 体量小结：以章节数为准
  const cc = chapterCountVal();
  const szLabel = cc ? `全书 ${cc} 章` : '未填章节数';
  // 章节数是否已就绪（决定范式区是否解锁）
  const ccOn = !!cc;
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
  // v10.18 可折叠维度：默认折叠，点标题展开/收起（state.recipeSet.recFold 记忆状态）
  const fold = (icon, title, rule, key, cardsHtml) => {
    const foldState = (state.recipeSet && state.recipeSet.recFold) || {};
    const open = !!foldState[key];
    return `
    <div class="poly-dim recipe-fold">
      <div class="poly-head recipe-fold-t" data-rec-fold="${key}" role="button" tabindex="0" aria-expanded="${open}">
        <span class="poly-ic">${icon}</span><b>${title}</b><span class="poly-rule">${rule}</span><span class="rec-fold-ico">${open?'▾':'▸'}</span>
      </div>
      <div class="poly-grid recipe-fold-b" ${open?'':'hidden'}>${cardsHtml}</div>
    </div>`;
  };
  // 章节数必填后，范式区才展开
  const core = ccOn ? `
    ${fold('🏗️','结构骨架','单选 · 可选其一', 'structure', STRUCTURES.map(it=>card(it,'structure', it.id===rs.structure)).join(''))}
    ${qualityToggleHtml()}
    ${fold('📇','可复用词典','跨作品词典作一致性底稿', 'glossary', pendingGlossaryPanel())}
    <p class="muted" style="margin:8px 0 0">结构、质量均可选可不选；全部不选时 AI 将按构想自由发挥。章节数已在「全书章节数」填定。结构骨架/可复用词典默认折叠，点标题展开。</p>`
    : `<div class="tw-lock"><span class="tw-lock-ic">🔒</span><span>待填写全书章节数后，此处才展开“写作范式”设定。</span></div>`;
  return `<div class="card recipe-card poly-card">
    <div class="tw-panel">
      <div class="poly-head"><span class="poly-ic">📐</span><b>全书章节数</b><span class="poly-rule">生成大纲前唯一必填数字 · 填 1-200 的整数</span></div>
      <div class="tw-row">
        <input type="number" id="totalWordsIn" class="tw-in cc-in" min="1" max="200" step="1" inputmode="numeric" placeholder="如 30" value="${cc||''}" ${ccOn?'':'data-first'} />
        <span class="tw-unit">章</span>
        ${ccOn ? `<span class="pill tag-ok">${chapterCountHint()}</span>` : ''}
      </div>
      <p class="size-hint" id="twHint">${ccOn ? '章节数已设定，下方写作范式据此展开；字数不做任何限制。' : '填写全书章节数（1-200）。此项必填，填完才解锁下方“写作范式”设置。'}</p>
    </div>
    <div class="poly-combo">
      <span class="pc-lbl">当前组合</span>
      <span class="pc-item">结构：${labelSt}</span>
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
  if(!isLong() || !o || typeof o !== 'object') return '';
  const s = (o.structure && typeof o.structure === 'object') ? o.structure : {};
  const rows = [`<b>结构模式</b><span>${esc(s.mode || '按用户构想')}</span>`];
  // P0-2：主线/副线/暗线/汇合 四行改为「行内可编辑」（失焦即存，零 AI 调用），
  // 与词典字段编辑同交互：常显 input，onchange 写回 state + persist。
  const editRow = (k,t,v,fmt)=>{
    const str = fmt ? fmt(v) : String(v==null?'':v);
    return `<b>${t}</b><input type="text" class="sc-edit-in" data-sc-key="${k}" data-orig="${esc(str)}" value="${esc(str)}" placeholder="${t}" />`;
  };
  // 主线兜底：s.mainLine 空时用 o.logline 兜底
  let mainLine = s.mainLine;
  if(!mainLine || !String(mainLine).trim()) mainLine = o.logline || '';
  rows.push(editRow('mainLine','主线', mainLine));
  // 副线：数组 ↔ 顿号/分号分隔文本（可加可删）
  const subLines = Array.isArray(s.subLines) ? s.subLines.filter(Boolean) : [];
  rows.push(editRow('subLines','副线', subLines.join('；')));
  rows.push(editRow('hiddenLine','暗线', s.hiddenLine || ''));
  rows.push(editRow('pivotPlan','汇合/大逆转', s.pivotPlan || ''));
  const addSubBtn = `<button type="button" class="btn small ghost sc-add-sub" data-sc-add-sub title="追加一条副线">＋ 副线</button>`;
  // 全章节安排：优先结构专属章节映射（英雄之旅 stageChapters / 节拍表 beats / 七点 points），回退统一 chapterPlan；分层卷结构作为另一种合法呈现。
  const plan = structureChapterPlan(s, o);
  if(plan){
    Object.keys(plan.map).forEach(k=>{
      const arr = Array.isArray(plan.map[k]) ? plan.map[k].filter(Boolean) : [];
      if(arr.length) rows.push(`<b>${esc(k)}</b><span>${esc(arr.join('、'))}</span>`);
    });
  } else if(o.volumes && o.volumes.length){
    // 分层递归：卷结构（o.volumes）作为"全部章节安排"的一种合法形式
    o.volumes.forEach(v=>{
      const chs = (v.chapters||[]).map(c=>c&&c.title).filter(Boolean);
      if(chs.length) rows.push(`<b>卷·${esc(v.name||'第'+(o.volumes.indexOf(v)+1)+'卷')}</b><span>${esc(chs.join('、'))}</span>`);
    });
  } else if((o.chapters||[]).length){
    rows.push(`<b>全章节计划</b><span>${esc((o.chapters||[]).map(c=>c&&c.title).filter(Boolean).join('、'))}</span>`);
  }
  return `<div class="card structure-card">
    <div class="sc-head" data-st-fold role="button" tabindex="0" title="展开/收起">
      <h3 style="margin:0">🏗️ 长篇结构设计</h3>
      <span class="sc-fold-ico">${state.stCollapsed?'▸':'▾'}</span>
    </div>
    <div class="sc-body"${state.stCollapsed?' hidden':''}>
      ${rows.map(r=>`<div class="sc-row">${r}</div>`).join('')}
      ${addSubBtn}
      <p class="muted" style="margin:6px 0 0;font-size:11px">主线/副线/暗线/汇合可直接编辑，失焦即存（不触发 AI）；副线多条用「；」分隔。</p>
    </div>
  </div>`;
}
// P0-2 结构设计行内编辑绑定：失焦即存 + 「＋副线」追加
function bindStructureEdit(){
  const o = state.outline; if(!o || !isLong()) return;
  if(!o.structure || typeof o.structure !== 'object') o.structure = {};
  const s = o.structure;
  $$('[data-sc-key]').forEach(inp=>{
    inp.onchange = ()=>{
      const k = inp.dataset.scKey;
      let v = inp.value.trim();
      if(k === 'subLines'){
        // 数组字段：按「；」/「;」/「、」/「，」分隔，过滤空
        const arr = v.split(/[；;、，,]+/).map(x=>x.trim()).filter(Boolean);
        s.subLines = arr;
        inp.value = arr.join('；');
      } else {
        s[k] = v;
      }
      if(k === 'mainLine' && !v) s[k] = o.logline || '';   // 主线不允许清空，回退 logline
      inp.dataset.orig = inp.value;
      persist(); toast('结构设计已保存');
    };
  });
  $$('[data-sc-add-sub]').forEach(btn=>{
    btn.onclick = ()=>{
      if(!Array.isArray(s.subLines)) s.subLines = [];
      s.subLines.push('新副线：');
      persist(); render();
      // 自动滚动到新输入行并聚焦
      const inp = $('.sc-edit-in[data-sc-key="subLines"]');
      if(inp){ inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    };
  });
}
// 写一条章节正文（依所勾选质量机制 post-processing：dual 双审 / selfref 自省 / plothole 伏笔洞检测）
// 省 token 策略：正文与初审均带上 max_tokens 上限；各机制一律「段落级重写」而非整章重写，
// v10.11 已去除「AI 返回本章梗概」契约（事后回填 summary 移除）：AI 输出全文即正文，直接过质检。
function splitChapterOutput(txt){
  return { content: String(txt||'').trim(), summary: '' };
}
async function writeOneChapterContent(i, user, onPhase, onStream, styleOverride, signal){
  const mt = chapterMaxTokens();
  onPhase = onPhase || (()=>{});
  // onPhase 阶段上报；onStream 若提供则开启流式边收边显示（成本0，实时进度），否则一次性返回全文
  onPhase('撰写本章正文…');
  let txt = await callDeepSeek(longChapterSys(styleOverride), user, {maxTokens: mt, onStream, temperature: resolveActiveSpec().chapterTemp, signal: signal || _abortCtl?.signal});   // v10.8 章节温度 / v2.0 风格覆盖
  // v10.11 全文即正文（无【本章梗概】标记需要拆分），直接过质检
  const sp = splitChapterOutput(txt);
  const { final, record } = await applyChapterQuality(sp.content, user, mt, onPhase);   // P1-4/P2-2：返回 {定稿, 质检记录}
  if(state.chapters[i]) state.chapters[i].qcRecord = record;   // 质检记录（含初稿/定稿对照）挂到本章
  return final;
}
// 对单章正文执行统一「两段式自动质检」：草扫(scanDraft)判定有无硬伤 + 精修(rewriteSegment)只改错误段落。
// 取代旧的三种质量范式（dual 双审 / selfref 自省 / plothole 伏笔洞），一套规则、无错即过、零无效输出（按 安排token.md §10-§15）。
// 草扫只发本章，判定「逻辑/人物关系/人名专名/写作」四类硬伤；无错 → pass:true 零改写；有错 → 对每个 anchor 定位的错误段做局部精修，绝不重发全文。
// 由 buildGen 与批量（2章/多章）共用；autoQC 关闭时直接过，不产生质检请求。
// P1-4/P2-2：返回 { final, record }——final 为定稿文本；record 为质检记录（scan 判定 + 初稿/定稿对照），供「🧪 质检记录」弹窗展示。
async function applyChapterQuality(txt, user, mt, onPhase){
  const noRecord = (f)=> ({ final: String(f||'').trim(), record: null });
  if(!isLong()) return noRecord(txt);
  if(typeof state.autoQC !== 'undefined' && !state.autoQC) return noRecord(txt);   // 自动质检开关：关则直接落库
  mt = mt || chapterMaxTokens();
  onPhase = onPhase || (()=>{});
  // 第一步：草扫——只判「有无硬伤 + anchor 定位」，禁止返回改写正文（省最贵的输出 token）
  onPhase('自动质检（判定）…');
  let scan;
  const SCAN_SYS = `你是长篇小说的硬伤审核编辑。请通读【本章初稿】，只判定以下四类硬伤是否存在：①逻辑错误（因果/时间线/前后矛盾）；②人物关系错误（角色关系、称谓、性格与前文不一致）；③人名/地名/专名错误（与前文一致性基准不同或自造拼写）；④写作错误（错字、破损句、明显低质段落）。
规则：只有确实存在、会损害连贯性或质量的硬伤才标记；本章无明显硬伤则 pass=true。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"pass":true|false,"issues":[{"type":"逻辑|人物|专名|文笔","anchor":"错误所在段的原文一句，用于精确整段定位替换"}]}
当 pass=true 时只输出 {"pass":true}，禁止输出 issues/rewritten/how/任何正文。`;
  let issues;
  try{
    const j = parseJson(await callDeepSeek(SCAN_SYS, '【本章初稿】\n'+txt.trim(), {temperature: resolveActiveSpec().qcTemp}));   // v10.8 质检温度
    issues = (j && !j.pass && Array.isArray(j.issues)) ? j.issues.filter(x=>x && x.anchor && String(x.anchor).trim()) : [];
  }catch(e){ issues = []; }
  const record = { ts: Date.now(), passed: !issues.length, issues: [], draft: String(txt||'').trim(), final: '' };
  if(!issues.length){ record.final = dedupAdjacentParagraphs(txt).trim(); return { final: record.final, record }; }   // 无错即过，零改写（省返回 token）
  // 第二步：精修——只发「错误段 + 一致性词典 + 词典基准」做局部重写，逐段落回，不重发全文
  let budget = 3;                                   // 精修次数上限（防止极端硬伤输出放大）
  let out = txt;
  const gloss = chapterGlossaryBlock();
  for(const it of issues){
    if(budget <= 0) break;
    const seg = locateSegment(out, it.anchor);
    if(seg == null) continue;                        // anchor 定位不到该段则跳过精修
    budget--;
    onPhase('修正：'+(it.type||'问题')+'…');
    let rw;
    try{
      rw = String((await callDeepSeek(
        `你是长篇小说的段落改写编辑。只针对【需修正段落】中符合【错误类型】的部分做局部修正，其余文字保持原文、风格与世界观一致，人名/地名/专名一律遵循【一致性基准】，禁止自造新拼写。只输出修正后的段落完整文字，不要解释、不要标题、不要标记。`,
        `${gloss}\n【错误类型】${it.type||''}\n\n【需修正段落】\n${seg}`,
        {temperature: resolveActiveSpec().qcTemp}   // v10.8 质检温度
      )).trim());
    }catch(e){ rw = ''; }
    if(rw && rw.length > 8){
      record.issues.push({ type: it.type||'', anchor: it.anchor, orig: seg, rewritten: rw });   // P1-4：记录原文段 → 修正段对照
      out = applyPatches(out, [{anchor:it.anchor, rewritten:rw}]);
    }
  }
  record.final = dedupAdjacentParagraphs(out).trim();
  record.passed = !record.issues.length;
  return { final: record.final, record };
}
/* ---------- P1-4/P2-2 质检记录弹窗：scan 判定 + 原文/修正对照 + 初稿/定稿 ---------- */
function openChapterQcPanel(i){
  closeChapterQcPanel();
  const c = state.chapters[i]; if(!c || !c.qcRecord) { toast('本章暂无质检记录'); return; }
  const r = c.qcRecord;
  const fmtTs = ts=>{ const d=new Date(ts); return (d.getMonth()+1)+'-'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
  const issuesHtml = r.issues.length ? r.issues.map((it,idx)=>`
    <div class="qc-issue">
      <div class="qc-issue-t">${idx+1}. 类型：<b>${esc(it.type||'未分类')}</b><span class="muted"> · anchor：${esc(it.anchor||'')}</span></div>
      <div class="qc-pair">
        <div class="qc-side"><div class="qc-side-t">✂️ 原文段（AI 判定的问题段）</div><div class="qc-pre">${esc(it.orig||'')}</div></div>
        <div class="qc-side"><div class="qc-side-t">✅ 修正后段落</div><div class="qc-pre qc-fixed">${esc(it.rewritten||'')}</div></div>
      </div>
    </div>`).join('') : '<p class="muted">草扫未发现硬伤，零改写通过。</p>';
  const ov = document.createElement('div'); ov.id='qcPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>🧪 质检记录 · 第${i+1}章「${esc(cleanChapterTitle(c.title))}」</b>
        <button class="gs-x" data-qc-close>✕</button></div>
      <div class="cv-body">
        <div class="cv-row cur"><div class="cv-meta"><span class="cv-time">${fmtTs(r.ts)}</span><span class="cv-wc">${r.passed ? '✅ 通过（零改写）' : '⚠️ 已修正 '+r.issues.length+' 处'}</span></div></div>
        <div class="cv-div">AI 质检改了哪些地方、初稿 vs 定稿，都在这里可查。</div>
        ${issuesHtml}
        <div class="cv-div" style="margin-top:10px">📄 初稿 / 定稿 对照（仅展示，正文以当前章节内容为准）</div>
        <div class="qc-pair">
          <div class="qc-side"><div class="qc-side-t">初稿（AI 原始返回，QC 前）</div><div class="qc-pre">${esc((r.draft||'').slice(0,1200))}${(r.draft||'').length>1200?'…':''}</div></div>
          <div class="qc-side"><div class="qc-side-t">定稿（QC 修正后落库）</div><div class="qc-pre qc-fixed">${esc((r.final||'').slice(0,1200))}${(r.final||'').length>1200?'…':''}</div></div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-qc-close]').onclick = closeChapterQcPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeChapterQcPanel(); });
}
function closeChapterQcPanel(){ const p=$('#qcPanel'); if(p) p.remove(); }
// 依 anchor 定位其在整章中的所在段原文（供精修第二步只发该段；复用 applyPatches 的段落边界逻辑）
function locateSegment(txt, anchor){
  const a = String(anchor || '').trim();
  if(!txt || !a) return null;
  const idx = txt.indexOf(a);
  if(idx < 0) return null;
  const segStart = txt.lastIndexOf('\n\n', idx) + 2;
  let segEnd = txt.indexOf('\n\n', idx + a.length);
  if(segEnd < 0) segEnd = txt.length;
  return txt.slice(segStart, segEnd);
}
// 组装单章生成的 user 提示词。恒定前缀块（标题/梗概/全部章节标题/一致性词典）保持在前、全章不变，
// 以最大化 DeepSeek 上下文缓存命中；可变信息（上一章全文/结构注入）尽量放后。
// opt.regenerating=true 时（单章重生成）额外注入下章概要，保证前后连贯（建议5/决策5）。
// 衔接来源 = 上一章完整正文（替代旧的本章概要/上章结尾200字，避免丢信息），批内多章一体时更由前文临时写入承接。
// 章节标题列表（v9 曾全列；v2.4 起不再注入章节生成——用户要求全部章节标题零夹带，逐章梗概生成自行拼标题列表）
// 承接来源（v10）：只提供「上一章真实正文」，取代旧的全量前文（cumulativeChapters）。恒定内容块承载全书脉络。
// 上一章标签统一为【上一章（第 N 章《标题》）】，i 为当前章 0 基下标；第 1 章（i<=0）无前文返回空。
function prevChapter(i){
  if(i <= 0) return '';
  const c = state.chapters[i-1];
  if(!(c && c.content && String(c.content).trim())) return '';
  return `【上一章（第 ${i} 章《${c.title||''}》）真实正文】\n${String(c.content).trim()}`;
}
// 批间累积前缀（v9）：拼接第 1..(i-1) 章完整正文，放进恒定前缀区（从第0个token起与前序请求完整复用 → 缓存命中，见 安排token.md §14）。
// 每写一章只在末尾追加上一章，前缀部分整段命中；为尽量减少宽占用可根据体量不超上下文，单章下限亦覆盖。
// 注：v10 生成的「AI 注入」改用 prevChapter（仅上一章）；本函数保留供阅读/导出等仍用全量文本的地方复用，勿删。
function cumulativeChapters(i){
  const out = [];
  const start = 0;
  for(let k=start; k<i; k++){
    const c = state.chapters[k];
    if(c && c.content && String(c.content).trim()) out.push(`【第${k+1}章】${c.title||''}\n${c.content}`);
  }
  return out.join('\n\n');
}
// v2.4 章节 User 组装：按用户指定优先级（最高→次高）——
// ① 写作风格（重申）② 上一章真实正文（必须接着写）③ 本章任务+本章梗概 ④ 本章/下一章边界（禁越界，末章收束）⑤ 大纲/结构/词典 ⑥ 人工干预（重生成）
// 不注入"全部章节标题"（v2.3 零夹带）；词典全字段经 chapterGlossaryBlock 注入。
function buildChapterUser(i, opt={}){
  const o = state.outline;
  const chap = state.chapters[i];
  const curN = i + 1;
  const parts = [];
  // ① 写作风格重申（完整配方在 System，此处点名提示；仅列「章节风格」词条，标题/梗概风格不干扰正文）
  const st = curWriteStyle(opt.styleOverride);
  const chapNames = (Array.isArray(st.tags)?st.tags:[]).map(id=>{ const s=writeStyleById(id); return s&&s.group==='element'?s.name:null; }).filter(Boolean).join('、');
  if(chapNames){
    const intTxt = ['','轻','中','重'][st.intensity] || '中';
    parts.push(`【写作风格（最高优先）】写作风格：${chapNames}（${intTxt}浓度）。完整要求见 System 中的【写作风格】块，务必遵守。`);
  }
  // ② 上一章真实正文（必须接着上一章写下去）
  if(i > 0){
    const pc = state.chapters[i-1];
    if(pc && pc.content && String(pc.content).trim()){
      parts.push(`【上一章真实正文（第 ${i} 章《${pc.title||''}》）】\n你必须接着上一章的结尾继续写：承接其情节、人物状态与情绪，不推倒重来、不重述已发生的事。\n${String(pc.content).trim()}`);
    } else {
      parts.push(`【上一章说明】上一章（第 ${i} 章）尚无正文，本章按大纲独立展开，但不得违背全局设定。`);
    }
  } else {
    parts.push(`【开篇说明】本章为全书第一章，无前文，请直接开篇立住基调。`);
  }
  // ③ 本章任务 + 本章梗概
  let task = `【本章任务】第 ${curN} 章《${chap.title}》`;
  const plan = (Array.isArray(o.chapterPlans) && o.chapterPlans[i]) ? String(o.chapterPlans[i]).trim() : '';
  if(plan) task += `\n【本章梗概】\n${plan}\n按此梗概写本章，细节自行展开、可合理微调。`;
  parts.push(task);
  // ④ 本章边界 + 下一章边界（禁越界）/ 末章收束
  const isLast = (i + 1) >= (o.chapters||[]).length;
  let boundary = `【本章边界】本章内容须紧扣本章标题展开、不得偏离；已发生的剧情不重复叙述。`;
  if(isLast){
    boundary += `\n【全书收束】本章为全书最后一章：请收束全书，交代主要线索与人物归宿，给出结局，不留开放式烂尾。`;
  } else {
    const nextC = o.chapters[i+1];
    const nextPlan = (Array.isArray(o.chapterPlans) && o.chapterPlans[i+1]) ? String(o.chapterPlans[i+1]).trim() : '';
    boundary += `\n【下一章边界】下一章为第 ${i+2} 章《${(nextC&&nextC.title)||''}》${nextPlan?`，其梗概：${nextPlan}`:''}。\n本章严禁展开、暗示或提前完成下一章内容；下一章的情节一律留到下一章再写。`;
  }
  parts.push(boundary);
  // ⑤ 大纲 / 结构（无标题版）/ 词典（全字段）
  let ref = `【小说大纲】书名：${o.title||''}｜一句话梗概：${o.logline||''}`;
  const structCtx = longChapterContext(i);   // 含【整体结构】主线/副/暗/汇合/本章归属/卷定位（无章节标题清单）
  if(structCtx) ref += structCtx;
  ref += chapterGlossaryBlock();
  parts.push(ref);
  // ⑥ 人工干预要求（重生成时）
  if(opt.advice){
    parts.push(`【人工干预要求（用户指定，务必优先遵循）】\n${opt.advice}\n请在重写本章时落实以上要求，其余不受影响的内容仍保持既有文风与世界观一致。`);
  }
  return parts.join('\n\n');
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
// v10.3：记录每次用户干预（regenHistory，每章独立、上限 10 条），下次打开可查看并点击回填。
function openChapterRegenPanel(i){
  closeChapterRegenPanel();
  const c = state.chapters[i];
  const title = c && c.title ? c.title : ('第'+(i+1)+'章');
  // 历史干预：仅用户手动重生成经过此弹窗，批量/首次生成不记录
  const hist = Array.isArray(c && c.regenHistory) ? c.regenHistory : [];
  const pushRegen = (mode, advice)=>{
    const h = Array.isArray(state.chapters[i].regenHistory) ? state.chapters[i].regenHistory : (state.chapters[i].regenHistory = []);
    h.push({ ts: Date.now(), mode, advice: String(advice||'') });
    if(h.length > 10) h.splice(0, h.length - 10);
    persist();
  };
  const pad = n => n<10?('0'+n):n;
  const histHtml = hist.length ? `
    <div class="rp-hist">
      <div class="rp-hist-title">📜 历史干预（点击回填到上方输入框）</div>
      ${hist.slice().sort((a,b)=>b.ts-a.ts).map(r=>{
        const d = new Date(r.ts);
        const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const txt = r.advice || '（直接重生成，无干预）';
        return `<div class="rp-hist-item" data-rp-fill="${esc(txt)}" title="${esc(txt)}">
          <span class="rp-hist-ts">${t}</span>
          <span class="rp-hist-txt">${esc(txt)}</span>
        </div>`;
      }).join('')}
    </div>` : '';
  // v2.0 本章风格覆盖 + 双风格对比的局部状态（一次性，不持久化）
  const rpOv = { on:false, tags:[], intensity:2 };
  const rpCmpB = { tags:[], intensity:2 };
  let rpOvApplied = null;     // 覆盖块「应用」确认快照 {on,tags,intensity}；null=未确认（未点应用则重生成不生效）
  let rpCmpBApplied = null;   // 对比块「应用」确认快照 {tags,intensity}；null=未确认（未点应用则 B 稿不生效）
  const ov = document.createElement('div');
  ov.id = 'regenPanel'; ov.className = 'gs-overlay';
  ov.setAttribute('data-cs', wsColorSchemeId());   // v10.19 让重生成弹窗内 chips 跟随所选配色
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>🔄 重生成 · 第${i+1}章「${esc(cleanChapterTitle(title))}」</b>
        <button class="gs-x" data-rp-close>✕</button></div>
      <div class="gs-body">
        <p class="gs-q"><b>想如何改动这一章？</b> 可在下方填写你的具体要求（改动方向、补充设定、错误修正等）；留空则按现有风格直接重写。</p>
        <textarea id="rpAdvice" class="rp-advice" placeholder="例如：这一章节奏太慢，请压缩到 1500 字以内；女主的性格再外放一点；增加与上一章结尾的衔接…（可选）"></textarea>
        ${histHtml}
        <div class="rp-style">
          <div class="rp-style-head" data-rpov-fold role="button" tabindex="0">
            <span>🎨 本章风格覆盖 <span class="rp-style-arrow">▸</span></span>
            <span class="muted" style="font-size:11px;font-weight:400">默认跟随全书 · 一次性不保存</span>
          </div>
          <div class="rp-style-body hidden">
            <label class="rp-radio-row"><input type="radio" name="rpov" value="off" checked> 跟随全书风格</label>
            <label class="rp-radio-row"><input type="radio" name="rpov" value="on"> 仅本章覆盖（重生成这章时用下面的风格，不保存）</label>
            <div class="rp-style-sub hidden" id="rpOvBox">
              <div class="rp-style-label">覆盖风格（语气单选 · 质感/元素多选）</div>
              ${writeStyleChipsHtml(rpOv, 'rpov')}
              <div class="rp-style-label">浓度：${writeStyleIntHtml(rpOv, 'rpov')}</div>
              <div class="rp-apply-row">
                <button type="button" class="btn small primary" data-rpov-apply disabled title="确认本次覆盖风格，重生成时方才生效">✔ 应用</button>
                <span class="rp-apply-status" id="rpOvStatus">⚠️ 待应用</span>
              </div>
            </div>
          </div>
        </div>
        <div class="rp-style disabled" data-rpcmp-box>
          <div class="rp-style-head" data-rpcmp-fold role="button" tabindex="0">
            <span>⚡ 双风格对比生成 <span class="rp-style-arrow">▸</span></span>
            <span class="muted" style="font-size:11px;font-weight:400">需先开启上方本章覆盖</span>
          </div>
          <div class="rp-style-body hidden">
            <p class="rp-cmp-lock-hint">🔒 未开启「仅本章覆盖」时不可用；先在上一区选择「仅本章覆盖」以解锁。</p>
            <p class="muted" style="font-size:12px;margin:4px 0 8px">A 稿 = 本章覆盖风格；B 稿 = 下方所选（留空 = 无风格直白版）。</p>
            <div class="rp-style-label">B 稿对比风格</div>
            ${writeStyleChipsHtml(rpCmpB, 'rpcmp')}
            <div class="rp-style-label">B 稿浓度：${writeStyleIntHtml(rpCmpB, 'rpcmp')}</div>
            <div class="rp-apply-row">
              <button type="button" class="btn small primary" data-rpcmp-apply disabled title="确认 B 稿对比风格，再点上方按钮生成两稿">✔ 应用</button>
              <span class="rp-apply-status" id="rpCmpStatus">⚠️ 待应用 B 稿</span>
            </div>
            <button class="btn blue" data-rp-compare>⚡ 生成 A/B 两稿并对比</button>
          </div>
        </div>
      </div>
      <div class="gs-actions">
        <button class="btn" data-rp-plain>直接重生成（无干预）</button>
        <button class="btn primary" data-rp-with>💡 带我的建议重生成</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-rp-close]').onclick = closeChapterRegenPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeChapterRegenPanel(); });
  // v2.1 对比区可用性：未开启「仅本章覆盖」→ 整区置灰锁定
  const rpCmpBox = ov.querySelector('[data-rpcmp-box]');
  const refreshRpCmpState = ()=>{
    if(!rpCmpBox) return;
    const locked = !rpOv.on;
    rpCmpBox.classList.toggle('disabled', locked);
    const hint = rpCmpBox.querySelector('.rp-cmp-lock-hint');
    if(hint) hint.style.display = locked ? 'block' : 'none';
    const head = rpCmpBox.querySelector('.rp-style-head .muted');
    if(head) head.textContent = locked ? '需先开启上方本章覆盖' : '两次调用 · 左右对照选稿';
  };
  // v2.0 折叠区开关
  const foldOv = ov.querySelector('[data-rpov-fold]');
  if(foldOv) foldOv.onclick = ()=>{
    const body = ov.querySelector('.rp-style-body'); if(!body) return;
    const on = body.classList.toggle('hidden');
    const arrow = foldOv.querySelector('.rp-style-arrow'); if(arrow) arrow.textContent = on?'▸':'▾';
  };
  const foldCmp = ov.querySelector('[data-rpcmp-fold]');
  if(foldCmp) foldCmp.onclick = ()=>{
    const body = foldCmp.closest('.rp-style').querySelector('.rp-style-body'); if(!body) return;
    const on = body.classList.toggle('hidden');
    const arrow = foldCmp.querySelector('.rp-style-arrow'); if(arrow) arrow.textContent = on?'▸':'▾';
  };
  // 默认折叠（与逐章梗概一致）：每次打开面板两块均折叠，箭头显示 ▸（模板已带 hidden，此处再次兜底）
  ov.querySelectorAll('.rp-style-body').forEach(b=> b.classList.add('hidden'));
  ov.querySelectorAll('.rp-style-arrow').forEach(a=> a.textContent = '▸');
  // v2.x 风格块「应用」：确认当前选择，生成只读已确认快照（模仿顶部风格卡「应用并保存」的草稿→生效语义）
  function refreshRpOvApply(){
    const ap = ov.querySelector('[data-rpov-apply]'); const st = ov.querySelector('#rpOvStatus');
    if(!ap) return;
    ap.disabled = !rpOv.on; ap.classList.toggle('disabled', !rpOv.on);
    if(st){ st.textContent = rpOvApplied ? '✔ 已确认' : (rpOv.on ? '⚠️ 待应用' : '跟随全书，无需应用'); st.classList.toggle('ok', !!rpOvApplied); }
  }
  function refreshRpCmpApply(){
    const ap = ov.querySelector('[data-rpcmp-apply]'); const st = ov.querySelector('#rpCmpStatus');
    if(!ap) return;
    const locked = !rpOv.on;
    ap.disabled = locked; ap.classList.toggle('disabled', locked);
    if(st){ st.textContent = rpCmpBApplied ? '✔ 已确认 B 稿' : (locked ? '需先开启本章覆盖' : '⚠️ 待应用 B 稿'); st.classList.toggle('ok', !!rpCmpBApplied); }
  }
  const rpovApplyBtn = ov.querySelector('[data-rpov-apply]');
  if(rpovApplyBtn) rpovApplyBtn.onclick = ()=>{
    if(!rpOv.on) return;
    rpOvApplied = { on:true, tags: rpOv.tags.slice(), intensity: rpOv.intensity };
    refreshRpOvApply();
    toast('本章风格覆盖已应用，重生成时生效（仅本次）');
  };
  const rpcmpApplyBtn = ov.querySelector('[data-rpcmp-apply]');
  if(rpcmpApplyBtn) rpcmpApplyBtn.onclick = ()=>{
    if(!rpOv.on) return;
    rpCmpBApplied = { tags: rpCmpB.tags.slice(), intensity: rpCmpB.intensity };
    refreshRpCmpApply();
    toast('B 稿对比风格已应用，生成 A/B 两稿时生效');
  };
  // v2.0 本章覆盖：radio 切换 + chips + 浓度（任一改动后清空确认态，须重新点「应用」）
  ov.querySelectorAll('input[name="rpov"]').forEach(r=> r.onchange = ()=>{
    rpOv.on = r.value === 'on';
    rpOvApplied = null;
    const box = ov.querySelector('#rpOvBox'); if(box) box.classList.toggle('hidden', !rpOv.on);
    refreshRpCmpState();
    refreshRpOvApply(); refreshRpCmpApply();   // 覆盖开关影响两块的应用按钮可用性
  });
  ov.querySelectorAll('[data-rpov-tag]').forEach(b=> b.onclick = ()=>{ toggleWriteTag(rpOv, b.dataset.rpovTag); ov.querySelectorAll('[data-rpov-tag]').forEach(x=> x.classList.toggle('on', rpOv.tags.includes(x.dataset.rpovTag))); rpOvApplied = null; refreshRpOvApply(); });
  ov.querySelectorAll('[data-rpov-int]').forEach(b=> b.onclick = ()=>{ rpOv.intensity = +b.dataset.rpovInt; ov.querySelectorAll('[data-rpov-int]').forEach(x=> x.classList.toggle('on', rpOv.intensity===+x.dataset.rpovInt)); rpOvApplied = null; refreshRpOvApply(); });
  // v2.0 对比 B 风格：chips + 浓度（任一改动后清空确认态，须重新点「应用」）
  ov.querySelectorAll('[data-rpcmp-tag]').forEach(b=> b.onclick = ()=>{ toggleWriteTag(rpCmpB, b.dataset.rpcmpTag); ov.querySelectorAll('[data-rpcmp-tag]').forEach(x=> x.classList.toggle('on', rpCmpB.tags.includes(x.dataset.rpcmpTag))); rpCmpBApplied = null; refreshRpCmpApply(); });
  ov.querySelectorAll('[data-rpcmp-int]').forEach(b=> b.onclick = ()=>{ rpCmpB.intensity = +b.dataset.rpcmpInt; ov.querySelectorAll('[data-rpcmp-int]').forEach(x=> x.classList.toggle('on', rpCmpB.intensity===+x.dataset.rpcmpInt)); rpCmpBApplied = null; refreshRpCmpApply(); });
  // 生成按钮：携带「已应用」的本章覆盖（未应用则不生效，回归全书风格）
  ov.querySelector('[data-rp-plain]').onclick = ()=>{
    const btn = document.querySelector('[data-regen="'+i+'"]');
    closeChapterRegenPanel();
    pushRegen('plain','');
    const ovr = rpOvApplied ? { styleOverride: { tags: rpOvApplied.tags.slice(), intensity: rpOvApplied.intensity } } : {};
    if(rpOv.on && !rpOvApplied) toast('已按全书风格重生成（未点「✔ 应用」的覆盖不生效）');
    genOneChapter(i, btn, ovr);
  };
  ov.querySelector('[data-rp-with]').onclick = ()=>{
    const advice = $('#rpAdvice').value.trim();
    const btn = document.querySelector('[data-regen="'+i+'"]');
    closeChapterRegenPanel();
    pushRegen('advice', advice);
    const ovr = rpOvApplied ? { advice, styleOverride: { tags: rpOvApplied.tags.slice(), intensity: rpOvApplied.intensity } } : { advice };
    if(rpOv.on && !rpOvApplied) toast('已按全书风格重生成（未点「✔ 应用」的覆盖不生效）');
    genOneChapter(i, btn, ovr);
  };
  // 对比生成：A/B 均须先「应用」确认，未确认则提示
  ov.querySelector('[data-rp-compare]').onclick = ()=>{
    if(!rpOvApplied){ toast('请先在「🎨 本章风格覆盖」点「✔ 应用」确认 A 稿风格'); return; }
    if(!rpCmpBApplied){ toast('请先在「⚡ 双风格对比」点「✔ 应用」确认 B 稿风格'); return; }
    const btn = document.querySelector('[data-regen="'+i+'"]');
    const styleA = { tags: rpOvApplied.tags.slice(), intensity: rpOvApplied.intensity };
    closeChapterRegenPanel();
    genChapterCompare(i, styleA, { tags: rpCmpBApplied.tags.slice(), intensity: rpCmpBApplied.intensity });
  };
  refreshRpCmpState();   // v2.1 初始即按「跟随全书」置灰对比区
  // 历史条目点击回填
  ov.querySelectorAll('[data-rp-fill]').forEach(el=>{
    el.onclick = ()=>{
      const ta = $('#rpAdvice'); if(ta) ta.value = el.dataset.rpFill;
      el.classList.add('rp-fill-on');
      ta && ta.focus();
    };
  });
  const ta = $('#rpAdvice'); if(ta) ta.focus();
}
function closeChapterRegenPanel(){ const p=$('#regenPanel'); if(p) p.remove(); }

/* ---------- v2.0 双风格对比生成：A=当前生效风格 / B=所选对比风格，两次调用后左右对照选稿 ---------- */
async function genChapterCompare(i, styleA, styleB){
  const c = state.chapters[i]; if(!c) return;
  const btn = document.querySelector('[data-regen="'+i+'"]');
  chState[i] = 'generating'; state.generating = true; patchChapter(i);
  if(btn) busy(btn,true,'对比生成中…');
  const st = $('#chStatus');
  const setPhase = m => { if(st){ st.className='status'; st.textContent = `第 ${i+1}/${state.chapters.length} 章：${m||''}`; } };
  try{
    const user = buildChapterUser(i, {regenerating:true});
    setPhase('生成 A 稿（当前风格）…');
    const txtA = await writeOneChapterContent(i, user, setPhase, null, styleA);
    const qcA = state.chapters[i] && state.chapters[i].qcRecord ? state.chapters[i].qcRecord : null;
    setPhase('生成 B 稿（对比风格）…');
    const txtB = await writeOneChapterContent(i, user, setPhase, null, styleB);
    const qcB = state.chapters[i] && state.chapters[i].qcRecord ? state.chapters[i].qcRecord : null;
    chState[i] = 'done';
    openComparePanel(i, txtA, txtB, qcA, qcB);
    if(st){ st.className='status ok'; st.textContent = `第 ${i+1} 章双风格对比稿已生成，请在弹窗中选择采用。`; }
    toast('两稿已生成，请选择采用');
  }catch(e){
    chState[i] = 'error'; patchChapter(i);
    if(st){ st.className='status err'; st.textContent = '对比生成失败：'+e.message; }
    toast('对比生成失败：'+e.message);
  }finally{
    state.generating = false;
    if(btn) busy(btn,false);
    patchChapter(i);
  }
}
// 对比结果弹窗：左右两栏（复用 .qc-pair）+ 采用 A/B + 未采用稿与旧正文一并入版本历史
function openComparePanel(i, a, b, qcA, qcB){
  closeComparePanel();
  const c = state.chapters[i];
  const title = c && c.title ? c.title : ('第'+(i+1)+'章');
  const ov = document.createElement('div'); ov.id='cmpPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>⚡ 双风格对比 · 第${i+1}章「${esc(cleanChapterTitle(title))}」</b>
        <button class="gs-x" data-cmp-close>✕</button></div>
      <div class="cv-body">
        <div class="cv-div">A 稿 = 当前生效风格；B 稿 = 对比风格。采用后，未采用稿会连同旧正文一起存入版本历史（📚 版本 可回退）。</div>
        <div class="qc-pair">
          <div class="qc-side"><div class="qc-side-t">A 稿 · 当前生效风格（${countWords(a).total} 字）</div><div class="qc-pre cmp-pre">${esc(a)}</div></div>
          <div class="qc-side"><div class="qc-side-t">B 稿 · 对比风格（${countWords(b).total} 字）</div><div class="qc-pre cmp-pre">${esc(b)}</div></div>
        </div>
        <div class="gs-actions" style="margin-top:10px">
          <button class="btn primary" data-cmp-use="a">✔ 采用 A 稿</button>
          <button class="btn primary" data-cmp-use="b">✔ 采用 B 稿</button>
          <button class="btn" data-cmp-close>暂不采用（两稿都存历史）</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelectorAll('[data-cmp-close]').forEach(b=> b.onclick = closeComparePanel);
  ov.addEventListener('click', e=>{ if(e.target===ov) closeComparePanel(); });
  ov.addEventListener('click', e=>{
    const u = e.target.closest('[data-cmp-use]'); if(!u) return;
    const isA = u.dataset.cmpUse === 'a';
    const pick = isA ? a : b;
    const other = isA ? b : a;
    snapshotChapterVersion(i);                    // 旧正文入历史
    const ch = ensureChapterHistory(i);
    ch.content = pick;
    if(other && String(other).trim()) ch.history.push({ content: other, ts: Date.now() });   // 未采用稿也入历史备查
    if(ch.history.length > 30) ch.history.splice(0, ch.history.length - 30);
    ch.qcRecord = isA ? (qcA||null) : (qcB||null);   // 质检记录与采用稿对齐，避免误导
    persist(); closeComparePanel(); renderChapters(); updateWcTotal();
    toast('已采用 '+(isA?'A':'B')+' 稿');
  });
}
function closeComparePanel(){ const p=$('#cmpPanel'); if(p) p.remove(); }

// 单章生成（🔄 重生成，决策5：只重写目标章，注入上章结尾+下章概要+全局词典）
// opt.advice：可选的人工干预要求（建议3·此轮），随 buildChapterUser 注入模型
// opt.styleOverride：可选的本章风格覆盖 {tags,intensity}（v2.0：仅本章生效，一次性消费）
async function genOneChapter(i, btn, opt={}){
  chState[i] = 'generating'; state.generating = true; patchChapter(i);
  if(btn) busy(btn,true,'生成中…');
  // 显示停止按钮：放在「阅读」按钮右侧
  const stopParent = btn && btn.closest('.btn-row') ? btn.closest('.btn-row') : null;
  if(stopParent){
    if(!_abortBtn){ _abortBtn = makeStopBtn(); document.body.appendChild(_abortBtn); }
    _abortCtl = new AbortController();
    _abortBtn.style.display = '';
    const readBtn = stopParent.querySelector(`[data-read="${i}"]`);
    if(readBtn && readBtn.nextSibling){
      stopParent.insertBefore(_abortBtn, readBtn.nextSibling);
    } else {
      stopParent.appendChild(_abortBtn);
    }
  }
  // 进度区：与「一键批量生成」同源。单章也在此实时显示「第几章 + 当前阶段」。
  const st = $('#chStatus');
  const setPhase = msg => { if(st){ st.className='status'; st.textContent = `第 ${i+1}/${state.chapters.length} 章：${msg||''}`; } };
  setPhase('准备中…');
  let _fullContent = '';
  try{
    const user = buildChapterUser(i, {regenerating:true, advice:opt.advice, styleOverride: opt.styleOverride});   // v2.4 本章覆盖时 user 风格重申同步
    // 实时进度：流式内容实时推送到文本区
    const stStream = $('#chStatus');
    let _s = 0;
    const onStream = currentIsDeepSeek() ? (delta => {
      const d = String(delta||'');
      _s += d.length; _fullContent += d;
      if(stStream){ stStream.className='status'; stStream.textContent = `第 ${i+1}/${state.chapters.length} 章：撰写中 · 已生成 ${_s} 字`; }
      // 实时推送内容到文本区
      const ta = document.querySelector(`textarea[data-ch="${i}"]`);
      if(ta){ ta.value = _fullContent; ta.scrollTop = ta.scrollHeight; }
    }) : null;
    const txt = await writeOneChapterContent(i, user, setPhase, onStream, opt.styleOverride);   // 各阶段经 setPhase 上报，正文流式实时字数经 onStream；v2.0 支持本章风格覆盖
    snapshotChapterVersion(i);            // v7.2：覆盖前存旧版，支持回退
    state.chapters[i].content = txt;
    chState[i] = 'done';
    if(!isLong()) state.chapters[i].confirmed = false;
    persist();                       // 不整页 render，仅定点刷新
    patchChapter(i);
    if(st){ st.className='status ok'; st.textContent = `第 ${i+1} 章已生成。`; }
    toast('第'+(i+1)+'章完成');
  }catch(e){
    if(e.name==='AbortError'){ if(st) st.textContent = '第'+(i+1)+'章已停止生成'; }
    else { chState[i] = 'error'; patchChapter(i); if(st){ st.className='status err'; st.textContent = '第'+(i+1)+'章生成失败：'+e.message; } toast('第'+(i+1)+'章生成失败：'+e.message); }
  }
  finally{ hideStopBtn(); state.generating = false; if(btn) busy(btn,false); patchChapter(i); autoExtractGlossary(); }
}

// 一次写 2 章（v10）：由「一次请求连写两章再切分」改为逐章顺序生成——每章独立一个请求，
// 第 k 章用「上一章」刚生成的（或此前已写）真实正文承接，产出即章节，无需【第N章】切分，杜绝两章挤一格/错切。
// 章节定位契约（统一编号）在 buildChapterUser 内体现；恒定的词典/内容块/章节定位随每章完整注入。
async function genTwoChapters(pairStart){
  for(let k=0;k<2;k++){
    const idx = pairStart + k;
    // 每章完整上下文：词典+内容块（大纲/结构/逐章梗概）+ longChapterContext（卷/阶段/结构）+ 上一章真实正文
    let _s2 = 0; let _full2 = '';
    const onStream = currentIsDeepSeek() ? (delta => {
      const d = String(delta||'');
      _s2 += d.length; _full2 += d;
      const ta = document.querySelector(`textarea[data-ch="${idx}"]`);
      if(ta){ ta.value = _full2; ta.scrollTop = ta.scrollHeight; }
    }) : null;
    const txt = await writeOneChapterContent(idx, buildChapterUser(idx), null, onStream);
    snapshotChapterVersion(idx);            // v7.2：覆盖前存旧版，支持回退
    state.chapters[idx].content = txt;
  }
}

// 一次写 n 章（v10）：由「一次请求连写 n 章再 splitNChapters 切分」改为逐章顺序生成——每章独立一个请求，
// 第 k 章用上一章刚生成/已写的真实正文承接；产出即章节，无需切分器判归属，杜绝整批错切/缺章/挤一格。
// 篇幅均衡自动由每章独立生成其区间保证；质检随 writeOneChapterContent 逐章执行；失败向上抛错交由批次停批。
async function genNChapters(start, n){
  if(n <= 0) return;
  for(let k=0;k<n;k++){
    const idx = start + k;
    // 上一章真实正文已被本循环上一轮写入 state.chapters[start+k-1].content，
    // buildChapterUser 的 prevChapter 自动读它为承接（genTwoChapters 同）。
    let _sN = 0; let _fullN = '';
    const onStream = currentIsDeepSeek() ? (delta => {
      const d = String(delta||'');
      _sN += d.length; _fullN += d;
      const ta = document.querySelector(`textarea[data-ch="${idx}"]`);
      if(ta){ ta.value = _fullN; ta.scrollTop = ta.scrollHeight; }
    }) : null;
    const txt = await writeOneChapterContent(idx, buildChapterUser(idx), null, onStream);
    snapshotChapterVersion(idx);            // v7.2：覆盖前存旧版，支持回退
    state.chapters[idx].content = txt;
  }
}

// 多章生成入口（复刻 genAllChapters 的批次驱动，仅批内一体生成改为用户输入的 n 章）。
// 定位从第一个尚无正文的章节起，本次生成用户填写的章数；若剩余空章不足则生成剩余全部。
// 任一章失败即停批（建议2 复刻），进度区 #chStatus 实时更新，页面不锁死。
async function genManyChapters(count){
  const btn = $('#btnGenMany'); if(btn) busy(btn,true,'逐章生成中…');
  const st = $('#chStatus'); if(st){ st.className='status'; st.textContent=''; }
  if(!isLong()){ if(btn) busy(btn,false); return; }   // 多章生成仅针对长篇连续章节
  // 显示停止按钮
  const stopParent = btn && btn.parentNode;
  if(stopParent) showStopBtn(stopParent);
  const firstEmpty = state.chapters.findIndex(c=> !(c.content && String(c.content).trim()));
  if(firstEmpty < 0){ if(st){st.className='status ok'; st.textContent='所有章节均已生成。';} busy(btn,false); hideStopBtn(); return; }
  const start = firstEmpty;
  const n = Math.max(1, Math.min(count, state.chapters.length - start));
  if(n <= 0){ if(st){st.className='status ok'; st.textContent='全部章节已生成。';} busy(btn,false); hideStopBtn(); return; }
  state.generating = true;
  for(let k=0;k<n;k++){ chState[start+k] = 'generating'; patchChapter(start+k); }
  if(st) st.textContent = `正在生成第 ${start+1}~${start+n} 章（共 ${n} 章）…`;
  try{
    await genNChapters(start, n);
    for(let k=0;k<n;k++){ chState[start+k] = 'done'; patchChapter(start+k); }
    if(st){ st.className='status ok'; st.textContent = isLong()
      ? `本批共 ${n} 章已生成。可继续填写数量再点「多章生成」，或点「生成下一批 2 章」直到写完全部。`
      : '本章已生成，请审阅并标记确认。'; }
    // 若生成落在当前页之外，切到其所在页以便用户看到（建议3 复刻）
    const targetPage = Math.floor(start / CH_PAGE_SIZE);
    if(Math.abs(chPage - targetPage) >= 1){ chPage = targetPage; renderChapters(); }
  }catch(e){
    for(let k=0;k<n;k++){ if(chState[start+k] === 'generating'){ chState[start+k]='error'; } patchChapter(start+k); }
    if(st){ st.className='status err'; st.textContent = `第${start+1}~${start+n}章生成失败（${e.message}）。已停止本批，请修复后重试。`; }
    toast(`第${start+1}~${start+n}章生成失败：${e.message}`);
  }finally{
    state.generating = false; hideStopBtn();
    if(btn) busy(btn,false);
    autoExtractGlossary();   // v8c 词典自动补全：本批成功后提取新实体入库（失败静默）
  }
}

// 批量生成：长篇每批固定 2 章（决策6）/ 短片全部。进度区 #chStatus 实时更新，页面不锁死。
async function genAllChapters(){
  const btn = $('#btnGenAllChapters'); busy(btn,true,'逐章生成中…');
  const st = $('#chStatus'); if(st){ st.className='status'; st.textContent=''; }
  // 显示停止按钮
  const stopParent = btn && btn.parentNode;
  if(stopParent) showStopBtn(stopParent);
  let batchFailed = false;                             // 建议2：批次是否因任一章失败而中止
  const batchSize = isLong() ? 2 : state.chapters.length;   // 决策6：每批固定 2 章
  let start = 0;
  if(isLong()){
    const firstEmpty = state.chapters.findIndex(c => !(c.content && c.content.trim()));
    start = firstEmpty >= 0 ? firstEmpty : 0;
  }
  const genCount = Math.min(batchSize, state.chapters.length - start);
  if(genCount <= 0){ if(st){st.className='status ok'; st.textContent='全部章节已生成。';} busy(btn,false); hideStopBtn(); return; }
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
        const txt = await callDeepSeek(PROMPTS.chapterSys + specSysAddition() + '\n\n' + ORIGINALITY_CHAPTER_SYS + chapterStyleNote(), buildChapterUser(i), {temperature: resolveActiveSpec().chapterTemp, signal: _abortCtl?.signal});   // v10.8 章节温度 / v10.12 防套路 / v2.0 写作风格
        snapshotChapterVersion(i);            // v7.2：覆盖前存旧版，支持回退
        state.chapters[i].content = txt; state.chapters[i].confirmed=false;
        chState[i]='done';
      }
      persist(); patchChapter(i);
      // 若生成落在当前页之外，切到其所在页以便用户看到（建议3）
      const targetPage = Math.floor(i / CH_PAGE_SIZE);
      if(isLong() && Math.abs(chPage - targetPage) >= 1){ chPage = targetPage; renderChapters(); }
    }catch(e){
      if(e.name==='AbortError'){ chState[i]='error'; patchChapter(i); if(st) st.textContent = '已停止生成'; batchFailed = true; break; }
      chState[i]='error'; patchChapter(i);
      if(st){ st.className='status err'; st.textContent += ` 第${i+1}章失败(${e.message})。`; }
      // 建议2：长篇批量必须两章都对，任一对出错即停批，不继续生成后续章节
      if(isLong()){ if(st){ st.textContent += ' 已停止本批，请修复后重试。'; } batchFailed = true; break; }
      // 短片模式保留既有错误隔离（跳过继续），符合短片中单章失败不影响整批的预期
      state.chapters[i].content = state.chapters[i].content || '';
    } finally { state.generating = false; }
  }
  if(st && !batchFailed && !_abortCtl){ st.className='status ok'; st.textContent = isLong()
    ? `本批共 ${genCount} 章已处理。继续点「生成下一批 2 章」直到写完全部。`
    : '全部章节已生成，请审阅并标记确认。'; }
  hideStopBtn(); busy(btn,false);
  if(!isLong()) render();            // 短片模式可整页刷新（无折叠/分页负担）
  else { renderChapters(); }         // 长篇仅重绘章节区，保留顶部/大纲不动
  autoExtractGlossary();             // v8c 词典自动补全：本批成功后提取新实体入库（失败静默）
}

// 无 UI 阻塞版（供短片循环调用，保留）
async function genOneChapterNoUI(i){
  const user = buildChapterUser(i);
  try{
    const txt = isLong()
      ? await writeOneChapterContent(i, user)
      : (await callDeepSeek(PROMPTS.chapterSys + specSysAddition() + '\n\n' + ORIGINALITY_CHAPTER_SYS + chapterStyleNote(), user, {temperature: resolveActiveSpec().chapterTemp})).trim();   // v10.8 章节温度 / v10.12 防套路 / v2.0 写作风格
    state.chapters[i].content = txt;
    persist();
  }catch(e){ /* 继续后续 */ }
}

/* ---------- P1-3 角色/场景/封面/分镜：覆盖前快照 + 历史弹窗（各上限10） ---------- */
function pushAssetHist(kind, data){
  if(data == null) return;
  if(!state.hist) state.hist = { characters:[], scenes:[], cover:[], storyboard:[] };
  const arr = state.hist[kind]; if(!Array.isArray(arr)) return;
  arr.unshift({ data: JSON.parse(JSON.stringify(data)), ts: Date.now() });
  if(arr.length > 10) arr.splice(10);
}
function assetHistCount(kind){ return Array.isArray(state.hist && state.hist[kind]) ? state.hist[kind].length : 0; }
function hasAssetHist(kind){ return assetHistCount(kind) > 0; }
const ASSET_LABEL = { characters:'角色定妆', scenes:'场景提示词', cover:'封面提示词', storyboard:'分镜' };
function openAssetHistPanel(kind){
  closeAssetHistPanel();
  const hist = Array.isArray(state.hist && state.hist[kind]) ? state.hist[kind] : [];
  if(!hist.length){ toast('暂无历史版本'); return; }
  const fmtTs = ts=>{ const d=new Date(ts); return (d.getMonth()+1)+'-'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
  const rows = hist.map((h,idx)=>{
    const d = h.data;
    let brief = '';
    if(kind==='characters') brief = (Array.isArray(d)?d.map(x=>x&&x.name).filter(Boolean).join('、'):'');
    else if(kind==='scenes') brief = (Array.isArray(d)?d.map(x=>x&&x.name).filter(Boolean).join('、'):'');
    else if(kind==='cover') brief = String(d||'').slice(0,40);
    else if(kind==='storyboard') brief = `${Array.isArray(d)?d.length:0} 镜`;
    const cnt = Array.isArray(d) ? d.length : 1;
    return `<div class="cv-row">
      <div class="cv-meta" style="flex:1;min-width:0"><div class="cv-time">${fmtTs(h.ts)} · ${cnt} 条</div><div class="cv-t" style="font-size:12px;color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(brief||'')}</div></div>
      <div class="cv-actions" style="display:flex;gap:6px;flex-shrink:0">
        <button type="button" class="btn ghost cv-b" data-ah-prev="${idx}">预览</button>
        <button type="button" class="btn ghost cv-b" data-ah-restore="${idx}">↩ 恢复</button>
      </div>
    </div>`;
  }).join('');
  const ov = document.createElement('div'); ov.id='ahPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>🕘 ${ASSET_LABEL[kind]} · 历史版本（${hist.length}/10）</b>
        <button class="gs-x" data-ah-close>✕</button></div>
      <div class="cv-body">
        <div class="cv-row cur"><div class="cv-meta"><span class="cv-time">当前版本</span><span class="cv-wc">${kind==='cover' ? (state.coverPrompt?'有':'空') : (Array.isArray(state[kind==='characters'?'characters':(kind==='scenes'?'scenes':'storyboard')])?state[kind==='characters'?'characters':(kind==='scenes'?'scenes':'storyboard')].length:0)+' 条'}</span></div></div>
        <div class="cv-div">重生成前旧版会自动存入这里；恢复会覆盖当前内容（当前版也先存入历史）。</div>
        ${rows}
        <div class="cv-preview hidden" id="ahPreview">
          <div class="cv-prev-head"><b id="ahPrevTitle">版本预览</b><button class="gs-x" data-ah-prev-close>✕</button></div>
          <div class="cv-pre" id="ahReader"></div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-ah-close]').onclick = closeAssetHistPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeAssetHistPanel(); });
  ov.addEventListener('click', e=>{
    const p = e.target.closest('[data-ah-prev]'); if(!p) return;
    const h = hist[+p.dataset.ahPrev]; if(!h) return;
    const pr=$('#ahPreview'), rd=$('#ahReader'), pt=$('#ahPrevTitle');
    if(pr && rd){
      pt.textContent = '预览 · '+fmtTs(h.ts);
      const d = h.data;
      let txt = '';
      if(kind==='characters') txt = (d||[]).map(x=>`${x.name||''}（${x.role||''}）\n${JSON.stringify(x.profile||{},null,1)}`).join('\n\n');
      else if(kind==='scenes') txt = (d||[]).map(x=>`${x.name||''}（${x.作用||''}）\n${x.description||''}`).join('\n\n');
      else if(kind==='cover') txt = String(d||'');
      else if(kind==='storyboard') txt = (d||[]).map(x=>`镜${x.镜号||''}：${x.画面描述||''}`).join('\n');
      rd.textContent = txt.slice(0,1500) + (txt.length>1500?'\n…':''); 
      pr.classList.remove('hidden');
    }
  });
  ov.querySelector('[data-ah-prev-close]').onclick = ()=>{ const pr=$('#ahPreview'); if(pr) pr.classList.add('hidden'); };
  ov.addEventListener('click', e=>{
    const rb = e.target.closest('[data-ah-restore]'); if(!rb) return;
    const h = hist[+rb.dataset.ahRestore]; if(!h) return;
    if(!window.confirm(`恢复该版${ASSET_LABEL[kind]}将覆盖当前内容（当前版先存入历史）。确定恢复吗？`)) return;
    const curData = kind==='cover' ? (state.coverPrompt||'') : state[kind==='characters'?'characters':(kind==='scenes'?'scenes':'storyboard')];
    pushAssetHist(kind, curData);
    if(kind==='cover') state.coverPrompt = String(h.data||'');
    else state[kind==='characters'?'characters':(kind==='scenes'?'scenes':'storyboard')] = JSON.parse(JSON.stringify(h.data||[]));
    persist(); closeAssetHistPanel(); render();
    toast('已恢复历史版本');
  });
}
function closeAssetHistPanel(){ const p=$('#ahPanel'); if(p) p.remove(); }

async function genCharacters(){
  const btn = $('#btnGenChars'); busy(btn,true,'生成角色中…');
  try{
    // P1-3 覆盖前快照
    if(state.characters && state.characters.length) pushAssetHist('characters', state.characters);
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
    // P1-3 覆盖前快照
    if(state.scenes && state.scenes.length) pushAssetHist('scenes', state.scenes);
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
    // P1-3 覆盖前快照
    if(state.coverPrompt) pushAssetHist('cover', state.coverPrompt);
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
      const user = `【本章】第${i+1}章 ${ch.title||oc.title||''}\n本章梗概：${(state.outline&&Array.isArray(state.outline.chapterPlans)&&state.outline.chapterPlans[i])||''}\n本章正文：\n${content.slice(0,1500)}${content.length>1500?'…':''}\n\n${base}`;
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
    // P1-3 覆盖前快照
    if(state.storyboard && state.storyboard.length) pushAssetHist('storyboard', state.storyboard);
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
        <button class="hist-del" data-fypexp="${p.id}" title="导出 .fyp 项目">📤</button>
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
  // 历史作品一键导出整本 .fyp 项目
  $$('#histList [data-fypexp]').forEach(b=> b.onclick = (e)=>{ e.stopPropagation(); exportProjectFile(b.dataset.fypexp); });
  // 折叠/展开单条项目详情：只影响当前项，不影响其它项的选择
  $$('#histList .hist-head').forEach(h=> h.onclick = (e)=>{
    if(e.target.closest('[data-switch]')) return;   // 点标题=切换项目，不折叠
    if(e.target.closest('[data-del]')) return;      // 删除按钮不触发折叠
    if(e.target.closest('[data-fypexp]')) return;   // .fyp 导出按钮不触发折叠
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
    const rows = chapters.slice(0, 8).map((c,i)=>`<div class="hist-p-row">第${i+1}章 · ${esc(cleanChapterTitle(c.title)||'')}</div>`).join('');
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
  // 上限：满 MAX_PROJECTS 弹 confirm 是否删除最旧以新建
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
  // 历史弹层头部「📥 导入 .fyp」：触发隐藏 file input
  const imp = $('#btnImportFyp');
  if(imp) imp.onclick = (e)=>{ e.stopPropagation(); const fi = $('#fypImportInput'); if(fi) fi.click(); };
  // 隐藏 file input 改变即解析导入
  const fi = $('#fypImportInput');
  if(fi) fi.onchange = (e)=>{ const f = e.target.files && e.target.files[0]; if(f) importProjectFile(f); e.target.value = ''; };
}

/* =========================================================
 * 整本项目导入 / 导出（自创 .fyp 格式）
 * 格式：{ format:'fyp-project', version:1, kind:'complete', exportedAt, app, book:{完整项目快照} }
 * book 与 lib.items[i] 同结构，导入后整体还原到历史列表并可打开。
 * ========================================================= */
function buildFyp(project){
  return {
    format: 'fyp-project',
    version: 1,
    kind: 'complete',
    exportedAt: new Date().toISOString(),
    app: 'storyfactory',
    appVersion: APP_VERSION,   // 导出时的应用版本号，供对方工具识别本项目由哪一版生成
    book: project   // 完整项目快照（与 lib.items[i] 同结构）
  };
}
function parseFyp(text){
  const obj = JSON.parse(text);
  if(!obj || typeof obj !== 'object') throw new Error('文件不是合法 JSON');
  if(obj.format !== 'fyp-project') throw new Error('不是 .fyp 项目文件（format 字段不匹配）');
  if(!obj.book || typeof obj.book !== 'object') throw new Error('.fyp 缺少 book 字段');
  return obj.book;
}
// 导出指定 id 的整本项目为 .fyp 文件（含大纲/全部章节正文/梗概/词典/结构/角色/场景/分镜/版本历史/写作风格/进度）
function exportProjectFile(id){
  const p = lib.items.find(i=> i.id === id);
  if(!p){ toast('未找到该作品'); return; }
  const fyp = buildFyp(p);
  const title = String(p.title || 'story').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 40);
  const blob = new Blob([JSON.stringify(fyp, null, 2)], { type:'application/octet-stream' });
  downloadBlob(`${title}.fyp`, blob);
  toast('已导出 .fyp 项目文件');
}
// 导入 .fyp 文件：解析后整体还原到历史列表，经 IDB 落盘并打开
function importProjectFile(file){
  if(!file) return;
  const big = file.size > 5 * 1024 * 1024;
  toast(big ? '文件较大，解析中…' : '正在导入项目…');
  const r = new FileReader();
  r.onload = function(){
    try{
      const book = parseFyp(String(r.result));
      // 重新生成 id，避免与现有项目同 id 冲突覆盖
      const newId = makeId();
      const item = Object.assign({}, book, { id: newId, updatedAt: Date.now() });
      if(!item.title) item.title = (item.outline && item.outline.title) || '导入的作品';
      lib.items.unshift(item);
      // 超限淘汰（与 newProject 一致）：删最旧非当前
      if(lib.items.length > MAX_PROJECTS){
        const others = lib.items.filter(i=> i.id !== lib.curId && i.id !== newId);
        others.sort((a,b)=> (a.updatedAt||0) - (b.updatedAt||0));
        const victim = others[0];
        if(victim){ lib.items = lib.items.filter(i=> i.id !== victim.id); idbDelete(victim.id).catch(function(){}); }
      }
      lib.curId = newId;
      applyProject(item);
      saveLib(); // 经 IDB 落盘（fire-and-forget）
      closeHistPanel();
      render();
      window.scrollTo(0,0);
      toast(`已导入「${item.title}」并打开`);
    }catch(err){
      toast('导入失败：' + (err && err.message ? err.message : '文件格式错误'));
    }
  };
  r.onerror = function(){ toast('读取文件失败'); };
  r.readAsText(file);
}

/* =========================================================
 * 创作规范：故事页内联选择器（仅作用于写小说）
 * ========================================================= */
function selectSpec(id){
  const cfg = getCfg(); cfg.spec = id; saveCfg(cfg);
  toast('创作规范：'+getSpec().name+'（仅作用于写小说）');
  if(currentStep===1) render(); // 刷新故事页规范高亮
}

/* ===== 配色弹层（顶栏 🎨 颜色）：选择 / 删除 / 撤销 / 恢复全部 / 新建三色 v10.20 ===== */
function wsColorToolbarHtml(){
  const undoN = wsUndoLog().length, rmB = wsRemovedBuiltin().length;
  return `<div class="ws-cs-toolbar">
    <button type="button" class="cs-tool" data-cs-undo ${undoN?'':'disabled'} title="撤销上一步删除">↩ 撤销</button>
    <button type="button" class="cs-tool" data-cs-restore ${rmB?'':'disabled'} title="仅恢复项目自带的 11 套内置配色（不影响你自建的配色）">↺ 恢复全部</button>
    <span class="ws-cs-spacer"></span>
    <button type="button" class="cs-tool cs-tool-new" data-cs-new title="新建一套三色配色">＋ 新建配色</button>
  </div>`;
}
function wsColorGridHtml(){
  const cur = wsColorSchemeId();
  const customIds = wsCustomColors().map(s=>s.id);
  return wsColorSchemesList().map(s=>{
    const isCustom = customIds.includes(s.id);
    return `<div class="ws-cs-item${cur===s.id?' active':''}" data-cs="${s.id}" title="点击应用「${esc(s.name)}」">
      <div class="ws-cs-top">
        <span class="ws-cs-name">${esc(s.name)}${isCustom?'<i class="ws-cs-tag">我的</i>':''}</span>
        ${s.id==='none'?'':`<button type="button" class="ws-cs-del" data-cs-del="${s.id}" title="删除此配色">✕</button>`}
      </div>
      <div class="ws-cs-bars">
        ${(s.c&&s.c.length)? s.c.map(c=>`<i style="background:${c}"></i>`).join('') : `<i class="ws-cs-none">无</i>`}
      </div>
    </div>`;
  }).join('');
}
function wsColorNewFormHtml(){
  return `<div id="wsCsForm" class="ws-cs-form hidden">
    <div class="ws-cs-form-row"><label>名称</label><input id="csName" class="cs-inp" type="text" maxlength="12" placeholder="例如：晚霞粉蓝"></div>
    <div class="ws-cs-form-row"><label>上 · 标题</label><input id="csC0" class="cs-color" type="color" value="#e25a6a"></div>
    <div class="ws-cs-form-row"><label>中 · 梗概</label><input id="csC1" class="cs-color" type="color" value="#5b8def"></div>
    <div class="ws-cs-form-row"><label>下 · 章节</label><input id="csC2" class="cs-color" type="color" value="#3fc6a0"></div>
    <div class="ws-cs-form-ops">
      <button type="button" class="btn" data-cs-cancel>取消</button>
      <button type="button" class="btn primary" data-cs-confirm>确认新建</button>
    </div>
  </div>`;
}
function renderWsColorPanel(){
  const box = $('#wsColorBody'); if(!box) return;
  box.innerHTML = wsColorToolbarHtml() + `<div class="ws-cs-grid">${wsColorGridHtml()}</div>` + wsColorNewFormHtml();
}
function openWsColorPanel(){ const p=$('#wsColorPanel'); if(!p) return; renderWsColorPanel(); p.classList.remove('hidden'); }
function closeWsColorPanel(){ const p=$('#wsColorPanel'); if(p) p.classList.add('hidden'); }
// 保存 → 重建自定义css → 重渲面板 + 主卡
function wsColorRepaint(){ rebuildCustomColorCss(); renderWsColorPanel(); render(); }
// —— 动作 ——
function wsColorSelect(id){
  const c=getCfg(); c.styleCustom = c.styleCustom||{};
  c.styleCustom.colorScheme = id; saveCfg(c);
  wsColorRepaint(); toast('已切换写作风格配色：'+wsSchemeName(id));
}
function wsColorDelete(id){
  if(id==='none') return;
  const c=getCfg(); const cs=wsColorCfgOf(c);
  const active=(c.styleCustom||{}).colorScheme;
  const bi=WS_COLOR_SCHEMES.find(x=>x.id===id);
  if(bi){
    if(cs.removedBuiltin.includes(id)) return;
    cs.removedBuiltin.push(id); cs.undo.push({type:'builtin',id:id});
  } else {
    const s=cs.custom.find(x=>x.id===id); if(!s) return;
    cs.custom=cs.custom.filter(x=>x.id!==id);
    cs.removedCustom=cs.removedCustom.concat([s]); cs.undo.push({type:'custom',id:id});
  }
  if(active===id) c.styleCustom.colorScheme='none';
  saveCfg(c); wsColorRepaint();
  toast('已删除配色：'+wsSchemeName(id)+(active===id?'（当前配色已回退默认）':''));
}
function wsColorUndo(){
  const c=getCfg(); const cs=wsColorCfgOf(c); const last=cs.undo.pop(); if(!last) return;
  let label=last.id;
  if(last.type==='builtin'){ cs.removedBuiltin=cs.removedBuiltin.filter(x=>x!==last.id); }
  else { const s=cs.removedCustom.find(x=>x.id===last.id); if(s){ cs.custom=cs.custom.concat([s]); cs.removedCustom=cs.removedCustom.filter(x=>x.id!==last.id); label=s.name; } }
  saveCfg(c); wsColorRepaint(); toast('已撤销删除：'+label);
}
function wsColorRestoreAll(){
  const c=getCfg(); const cs=wsColorCfgOf(c);
  cs.removedBuiltin=[];
  cs.undo = cs.undo.filter(u=>u.type!=='builtin');   // 内置已全部恢复，仅清除其对应的撤销记录；保留自建配色的删除与撤销记录
  saveCfg(c); wsColorRepaint(); toast('已恢复全部内置配色（自建配色不受影响）');
}
function wsColorCreate(){
  const name=((($('#csName')||{}).value)||'').trim();
  const c0=(($('#csC0')||{}).value)||'', c1=(($('#csC1')||{}).value)||'', c2=(($('#csC2')||{}).value)||'';
  if(!name){ toast('请先填写配色名称'); return; }
  const c=getCfg(); const cs=wsColorCfgOf(c);
  cs.custom=cs.custom.concat([{id:'cu_'+(Date.now()), name:name, c:[c0,c1,c2]}]);
  saveCfg(c); rebuildCustomColorCss();
  const f=$('#wsCsForm'); if(f) f.classList.add('hidden');
  wsColorRepaint(); toast('已新建配色：'+name);
}
// 绑定配色面板：面板内容会被动态重建，故在容器上做事件委托
function rebindWsColorPanel(){
  const btn = $('#btnWsColor');
  if(btn) btn.onclick = (e)=>{ e.stopPropagation(); const p=$('#wsColorPanel'); if(p.classList.contains('hidden')) openWsColorPanel(); else closeWsColorPanel(); };
  const body = $('#wsColorBody');
  if(body) body.onclick = (e)=>{
    const del = e.target.closest('[data-cs-del]'); if(del){ e.stopPropagation(); wsColorDelete(del.dataset.csDel); return; }
    const item = e.target.closest('.ws-cs-item[data-cs]'); if(item){ e.stopPropagation(); if(!item.classList.contains('active')) wsColorSelect(item.dataset.cs); return; }
    if(e.target.closest('[data-cs-new]')){ e.stopPropagation(); const f=$('#wsCsForm'); if(f) f.classList.toggle('hidden'); return; }
    if(e.target.closest('[data-cs-undo]')){ e.stopPropagation(); wsColorUndo(); return; }
    if(e.target.closest('[data-cs-restore]')){ e.stopPropagation(); wsColorRestoreAll(); return; }
    if(e.target.closest('[data-cs-confirm]')){ e.stopPropagation(); wsColorCreate(); return; }
    if(e.target.closest('[data-cs-cancel]')){ e.stopPropagation(); const f=$('#wsCsForm'); if(f) f.classList.add('hidden'); return; }
  };
  rebuildCustomColorCss();   // 刷新后自定义配色仍能正确上色
}
function openThemePanel(){
  const p = $('#themePanel'); if(!p) return;
  // 同步高亮当前主题
  const cur = (document.documentElement.getAttribute('data-theme')) || 'dark';
  $$('.theme-btns .theme').forEach(b=> b.classList.toggle('active', b.dataset.theme===cur));
  // v10.16 温度已移入主题面板：打开时回显当前配置
  editCfg = JSON.parse(JSON.stringify(getCfg()));
  echoTemps();
  p.classList.remove('hidden');
}
function closeThemePanel(){ const p=$('#themePanel'); if(p) p.classList.add('hidden'); }

/* =========================================================
 * 设置弹窗（多 AI 模型：服务列表 → 组详情 → 三级联动选择）
 * 红色护栏：生成来源永远只有一个 editCfg.active 指向的账号/模型，绝不并发多模型请求。
 * ========================================================= */
let editCfg = null;        // 弹窗编辑中的工作副本（打开时从 getCfg 深拷贝）
let selGroupId = null;     // 当前「组详情」区选中的组

function openSettings(){
  editCfg = JSON.parse(JSON.stringify(getCfg()));
  selGroupId = editCfg.active ? editCfg.active.groupId : (editCfg.groups[0] && editCfg.groups[0].id);
  $('#settingsModal').classList.remove('hidden');
  echoTemps();
  const st = $('#cfgStatus'); if(st){ st.className='status'; st.textContent=''; }
  renderGroupsList(); renderGroupDetail(); renderActiveSelects(); updateCfgBadge();
}
function closeSettings(){ $('#settingsModal').classList.add('hidden'); }

// v10.16 温度回显（设置弹窗与主题面板共用；id 查找与 DOM 位置无关）
function echoTemps(){
  const c = editCfg || getCfg();
  $('#cfgTemp').value = (c.temperature==null ? '' : c.temperature);
  $('#cfgTempOutline').value = (c.outlineTemp==null ? '' : c.outlineTemp);
  $('#cfgTempIdea').value = (c.ideaTemp==null ? '' : c.ideaTemp);
  $('#cfgTempTitle').value = (c.titleTemp==null ? '' : c.titleTemp);
  $('#cfgTempPlan').value = (c.planTemp==null ? '' : c.planTemp);
  $('#cfgTempChapter').value = (c.chapterTemp==null ? '' : c.chapterTemp);
  $('#cfgTempQC').value = (c.qcTemp==null ? '' : c.qcTemp);
}

// v10.16 温度保存（从 saveSettings 拆出，主题面板「保存温度」与设置弹窗「保存」共用）
function saveTemps(){
  const rd = (id, def)=>{ const v=parseFloat($(id) && $(id).value); return isNaN(v)?def:v; };
  editCfg.temperature = rd('#cfgTemp', 0.7);
  editCfg.outlineTemp = rd('#cfgTempOutline', 0.7);
  editCfg.ideaTemp    = rd('#cfgTempIdea', 0.5);
  editCfg.titleTemp   = rd('#cfgTempTitle', 0.5);
  editCfg.planTemp    = rd('#cfgTempPlan', 0.4);
  editCfg.chapterTemp = rd('#cfgTempChapter', 0.5);
  editCfg.qcTemp      = rd('#cfgTempQC', 0.2);
}

function _curSpec(){
  const cfg = (editCfg && editCfg.groups) ? editCfg : getCfg();
  const act = cfg.active || {};
  const g = cfg.groups.find(x=>x.id===act.groupId) || cfg.groups[0];
  const m = g && (g.models.find(x=>x.name===act.model) || g.models[0]);
  const k = g && (g.keys.find(x=>x.id===act.keyId) || g.keys[0]);
  return { group: g?g.label:'', key: k?k.label:'', model: m?m.name:'', flash: !!(m && m.kind==='flash') };
}
function shortModel(name){
  if(!name) return '';
  if(name.indexOf('deepseek-v4-')===0) return name.replace('deepseek-v4-','');
  const parts=name.split('-');
  return parts.length>1 ? parts.slice(-1)[0] : name;
}
function updateCfgBadge(){
  const b=$('#cfgBadge'); if(!b) return;
  const s=_curSpec();
  b.textContent = (s.group?'':'AI') + s.group + ' · ' + (shortModel(s.model)||'未选') + (s.flash?' ⚡':'');
  if(b.title != null) b.title='当前模型：'+s.group+' · '+s.key+' · '+s.model+'（点击切换）';
}

/* --- 第一段：服务列表 --- */
function renderGroupsList(){
  const el=$('#groupsList'); if(!el) return;
  el.innerHTML='';
  if(!editCfg.groups.length){ el.innerHTML='<div class="muted">暂无服务，点上方「＋ 新增组」添加。</div>'; return; }
  editCfg.groups.forEach(g=>{
    if(!selGroupId) selGroupId=g.id;
    const d=document.createElement('div');
    d.className='group-item' + (g.id===selGroupId ? ' active' : '');
    d.innerHTML = `<span class="gi-label">${esc(g.label)}</span><span class="gi-meta">${g.keys.length} 账号 · ${g.models.length} 模型</span>`;
    d.onclick = ()=>{ selGroupId=g.id; renderGroupsList(); renderGroupDetail(); };
    el.appendChild(d);
  });
}

/* --- 第二段：组详情（baseUrl + 多账号 + 模型清单） --- */
function _dg(){ return editCfg.groups.find(x=>x.id===selGroupId) || editCfg.groups[0]; }
function renderGroupDetail(){
  const el=$('#groupDetail'); if(!el) return;
  const g=_dg();
  if(!g){ el.innerHTML='<div class="muted">选择左侧一个服务，或点上方「＋ 新增组」添加。</div>'; return; }
  selGroupId=g.id;
  el.innerHTML = `
    <div class="set-block-head">
      <span>${esc(g.label)} · 详情</span>
      <span class="gd-acts">
        <button class="btn small ghost" data-act="addkey" type="button">＋ 账号</button>
        <button class="btn small ghost" data-act="addmodel" type="button">＋ 模型</button>
        ${g.id!=='deepseek' ? '<button class="btn small ghost del" data-act="delgroup" type="button">删组</button>' : ''}
      </span>
    </div>
    <label class="field"><span>接口地址（OpenAI 兼容协议）</span>
      <input class="g-base" type="text" value="${esc(g.baseUrl)}" placeholder="https://api.deepseek.com">
    </label>
    <div class="gd-title">账号（API Key 仅存本机，多账号=多卡分流）</div>
    ${g.keys.length ? g.keys.map((k,i)=>`
      <div class="key-row">
        <input class="k-lab" data-idx="${i}" type="text" value="${esc(k.label)}" placeholder="备注">
        <input class="k-key" data-idx="${i}" type="password" value="${esc(k.key)}" placeholder="sk-..." autocomplete="off">
        <button class="btn small ghost k-eye" data-key-eye="${i}" type="button" title="显示/隐藏 Key">👁</button>
        <button class="btn small ghost k-copy" data-key-copy="${i}" type="button" title="复制 Key">📋</button>
        <button class="btn small ghost del" data-act="delkey" data-id="${k.id}" type="button">删</button>
      </div>`).join('') : '<div class="muted">该组还没有账号，点「＋ 账号」粘贴 API Key。</div>'}
    <div class="gd-title">模型清单</div>
    ${g.models.length ? g.models.map(m=>`
      <div class="model-row">
        <span class="m-name">${esc(m.name)}</span>
        ${m.kind==='flash' ? '<span class="pill tag-warn">最快/最便宜</span>' : ''}
        <button class="btn small ghost del" data-act="delmodel" data-name="${esc(m.name)}" type="button">删</button>
      </div>`).join('') : '<div class="muted">请点「＋ 模型」添加模型名。</div>'}
  `;
  el.onclick = onDetail;
  el.querySelectorAll('.k-lab').forEach(inp=> inp.onchange=()=>{ const gg=_dg(); gg.keys[+inp.dataset.idx].label = inp.value || ('账号'+(+inp.dataset.idx+1)); });
  el.querySelectorAll('.k-key').forEach(inp=> { inp.onchange=()=>{ const gg=_dg(); gg.keys[+inp.dataset.idx].key = inp.value.trim(); updateCfgBadge(); }; });
  // v10.4 眼睛：显示/隐藏 Key（password ⇄ text，图标 👁/🙈 同步）
  el.querySelectorAll('[data-key-eye]').forEach(btn=>{
    btn.onclick = ()=>{
      const inp = el.querySelector('.k-key[data-idx="'+btn.dataset.keyEye+'"]');
      if(!inp) return;
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      btn.textContent = show ? '🙈' : '👁';
      btn.title = show ? '隐藏 Key' : '显示 Key';
    };
  });
  // v10.4 复制：一键复制该 Key（复用全局 copyText，自带 toast 反馈）
  el.querySelectorAll('[data-key-copy]').forEach(btn=>{
    btn.onclick = ()=>{
      const inp = el.querySelector('.k-key[data-idx="'+btn.dataset.keyCopy+'"]');
      if(!inp || !inp.value.trim()){ toast('该账号暂无 Key'); return; }
      copyText(inp.value.trim());
    };
  });
  const base = el.querySelector('.g-base'); if(base) base.onchange=(ev)=>{ const gg=_dg(); gg.baseUrl = ev.target.value.trim(); };
}
function onDetail(ev){
  const b = ev.target && ev.target.closest('[data-act]'); if(!b) return;
  const act = b.dataset.act, g = _dg(); if(!g) return;
  if(act==='addkey'){
    const v=prompt('粘贴该账号的 API Key（sk-...）：');
    if(v==null) return;
    if(!v.trim()){ toast('Key 为空，未添加'); return; }
    g.keys.push({ id: uid('k'), label:'账号'+(g.keys.length+1), key:v.trim() });
  } else if(act==='addmodel'){
    const n=prompt('模型名（如 deepseek-v4-flash 或第三方模型名）：');
    if(n==null) return;
    if(!n.trim()){ toast('模型名为空，未添加'); return; }
    g.models.push({ name:n.trim(), label:n.trim(), kind:'' });
  } else if(act==='delkey'){
    g.keys = g.keys.filter(x=>x.id!==b.dataset.id);
  } else if(act==='delmodel'){
    g.models = g.models.filter(x=>x.name!==b.dataset.name);
  } else if(act==='delgroup'){
    editCfg.groups = editCfg.groups.filter(x=>x.id!==g.id);
    selGroupId = null;
  }
  refreshAfter();
}
function refreshAfter(){ renderGroupsList(); renderGroupDetail(); renderActiveSelects(); updateCfgBadge(); }

function addGroup(){
  const label=prompt('新服务名称（如：Kimi / 智谱 / 我的中转）：');
  if(label==null) return;
  if(!label.trim()){ toast('名称为空，未添加'); return; }
  const base=prompt('接口地址（OpenAI 兼容，如 https://api.deepseek.com）：','');
  const g={ id:uid('g'), kind:'openai', label:label.trim(), baseUrl:(base||'').trim(), keys:[], models:defaultModels() };
  editCfg.groups.push(g); selGroupId=g.id; refreshAfter();
}

/* --- 第三段：三级联动「当前生成使用」 --- */
function renderActiveSelects(){
  const selG=$('#c_selGroup'), selK=$('#c_selKey'), selM=$('#c_selModel');
  if(!selG || !editCfg) return;
  const act = editCfg.active || {};
  selG.innerHTML = editCfg.groups.map(g=>`<option value="${esc(g.id)}">${esc(g.label)}</option>`).join('');
  selG.value = editCfg.groups.some(g=>g.id===act.groupId) ? act.groupId : (editCfg.groups[0]?editCfg.groups[0].id:'');
  const g = editCfg.groups.find(x=>x.id===selG.value) || editCfg.groups[0];
  const keys = g?g.keys:[];
  selK.innerHTML = keys.map(k=>`<option value="${esc(k.id)}">${esc(k.label)}${k.key?'':'（未填）'}</option>`).join('');
  selK.value = keys.some(k=>k.id===act.keyId) ? act.keyId : (keys[0]?keys[0].id:'');
  const models = g?g.models:[];
  selM.innerHTML = models.map(m=>`<option value="${esc(m.name)}">${esc(m.label)}${m.kind==='flash'?' ⚡':''}</option>`).join('');
  selM.value = models.some(m=>m.name===act.model) ? act.model : (models[0]?models[0].name:'');
}

function saveSettings(){
  if(!editCfg){ return; }
  saveTemps();   // v10.16 温度保存已拆出（与主题面板共用）
  const selG=$('#c_selGroup'), selK=$('#c_selKey'), selM=$('#c_selModel');
  if(selG){
    const gId=selG.value || (editCfg.groups[0] && editCfg.groups[0].id);
    editCfg.active = { groupId:gId, keyId:(selK&&selK.value)||null, model:(selM&&selM.value)||'' };
  }
  saveCfg(editCfg);
  const st=$('#cfgStatus'); if(st){ st.className='status ok'; st.textContent='已保存到本机浏览器。'; }
  toast('配置已保存');
  updateCfgBadge();
}
async function testConn(){
  const st = $('#cfgStatus'); if(st){ st.className='status'; st.textContent='测试中…'; }
  saveSettings();
  try{
    const r = await callDeepSeek('你是测试助手，只回复「ok」。','你好');
    if(st){ st.className='status ok'; st.textContent='连接成功：'+r.slice(0,20); }
  }catch(e){
    if(st){
      st.className='status err';
      let msg = e.message;
      if(/insufficient balance/i.test(msg)) msg += '（账户余额不足，请到对应控制台充值，不是 Key 填错）';
      else if(/not found.*model/i.test(msg)) msg += '（模型名不存在，请检查当前所选模型）';
      st.textContent='连接失败：'+msg;
    }
  }
}

/* =========================================================
 * 初始化
 * ========================================================= */
// 启动加载遮罩（首次 await 读取 IDB，毫秒级，无感；IDB 失败也有兜底不卡死）
function showBootLoading(show){
  const el = $('#bootLoading'); if(!el) return;
  el.classList.toggle('hidden', !show);
}
async function init(){
  showBootLoading(true);
  try{ await loadState(); }catch(e){ /* 兜底：保持空白 state，不卡死 */ }
  loadGlib();                        // v8 词典库（跨作品复用）
  // 应用已保存主题（统一走 applyTheme，保证 mecha nav 显隐等副作用一致）
  const c = getCfg();
  applyTheme(c.theme || 'dark');
  // 顶栏设置
  $('#btnSettings').onclick = openSettings;
  // P2-1 顶栏「🗒️ 日志」入口
  const btnLog = $('#btnAiLog');
  if(btnLog) btnLog.onclick = (e)=>{ e.stopPropagation(); openAiLogPanel(); };
  // 历史作品按钮：展开/收起弹层；新建小说 / 新建长篇按钮
  rebindHistPanel();
  // 写作风格配色按钮（顶栏 🎨）：展开/收起配色弹层 + 选择即着色
  rebindWsColorPanel();
  // 主题按钮：展开/收起主题弹层
  const btnTheme = $('#btnTheme');
  if(btnTheme) btnTheme.onclick = (e)=>{ e.stopPropagation(); const p=$('#themePanel'); if(p.classList.contains('hidden')) openThemePanel(); else closeThemePanel(); };
  // v10.16 主题面板「保存温度」：仅保存 7 个温度字段（独立于设置弹窗，不影响其他配置）
  const btnTS = $('#btnTempSave');
  if(btnTS) btnTS.onclick = (e)=>{
    e.stopPropagation();
    if(!editCfg) editCfg = JSON.parse(JSON.stringify(getCfg()));
    saveTemps();
    saveCfg(editCfg);
    updateCfgBadge();
    toast('温度已保存');
  };
  // 点击空白处关闭主题/历史/配色弹层
  document.addEventListener('click', (e)=>{
    const t = $('#themePanel'); if(t && !t.classList.contains('hidden') && !t.contains(e.target) && !e.target.closest('#btnTheme')) closeThemePanel();
    const h = $('#histPanel'); if(h && !h.classList.contains('hidden') && !h.contains(e.target) && !e.target.closest('#btnHist')) closeHistPanel();
    const col = $('#wsColorPanel'); if(col && !col.classList.contains('hidden') && !col.contains(e.target) && !e.target.closest('#btnWsColor')) closeWsColorPanel();
  });
  $$('[data-close]').forEach(b=> b.onclick = closeSettings);
  $('#btnCfgSave').onclick = ()=>{ saveSettings(); closeSettings(); };   // v10.10 保存后自动关闭设置窗口（测试连接仍走 testConn，不关窗）
  $('#btnCfgTest').onclick = testConn;
  // 多 AI 模型控件
  const btnAddG = $('#btnAddGroup'); if(btnAddG) btnAddG.onclick = addGroup;
  const selG=$('#c_selGroup'), selK=$('#c_selKey'), selM=$('#c_selModel');
  if(selG) selG.onchange = ()=>{ if(editCfg){ editCfg.active.groupId = selG.value; renderActiveSelects(); updateCfgBadge(); } };
  if(selK) selK.onchange = ()=>{ if(editCfg){ editCfg.active.keyId = selK.value; updateCfgBadge(); } };
  if(selM) selM.onchange = ()=>{ if(editCfg){ editCfg.active.model = selM.value; updateCfgBadge(); } };
  const cfgBadge=$('#cfgBadge'); if(cfgBadge) cfgBadge.onclick = openSettings;
  updateCfgBadge();
  // 主题按钮（顶栏 🎨 弹层内）：点击即应用并收起
  $$('.theme-btns .theme').forEach(b=> b.onclick = ()=>{ applyTheme(b.dataset.theme); closeThemePanel(); });
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
  // 首次进入直接渲染主界面（不再自动弹设置；用户可随时点右上角 ☰ 配置 API Key）
  showBootLoading(false);
  render();
}
document.addEventListener('DOMContentLoaded', init);
