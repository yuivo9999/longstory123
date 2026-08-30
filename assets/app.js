/* =========================================================
 * 影视前期提示词生成器 · 纯前端 H5
 * 仅调用 DeepSeek 生成文字与提示词；出图交给「即梦」。
 * 复用参考：show-me-the-story(逐章) / character-sheet-generator(角色卡字段)
 *          / video-shot-agent(分镜结构)
 * ========================================================= */
'use strict';

/* ---------- 全局状态 ---------- */
const APP_VERSION = '1.0.33';   // 应用版本号（P1-1v4 新增：标题/单章原始AI响应手动提取按钮）：index.html 的 ?v= 资源戳与之同步递增，用于标识产物已更新
const KEY_CFG = 'fyp_cfg';
const KEY_STATE = 'fyp_state';   // 旧版单项目 key（仅用于首次迁移）
const KEY_LIB = 'fyp_lib';       // 新版多项目历史库
const KEY_GLIB = 'fyp_glib';     // v8 词典库（跨作品的多套可复用词典，独立于项目轨道）
const MAX_PROJECTS = 500;         // 历史项目上限
let lib = { curId: null, items: [] }; // {curId, items:[{id, idea, outline, ..., step, title, logline, updatedAt}]}
let gglib = [];                  // v8 词典库：[{id, name, note, savedAt, g:{characters,places,propernouns}}]

const state = {
  mode: 'shortfilm',    // 'shortfilm' 短片 / 'longnovel' 经典长篇小说
  recipe: 'mesh',       // (兼容旧字段) 旧式单一范式 id；新项目用 recipeSet
  recipeSet: { structure:null, rhythm:null, titleStyle:[] }, // 长篇写作范式：结构(单选)+标题(可多选)；默认全部不选，由 AI 按构想发挥
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
  ctCollapsed: true,    // v10.53：章节标题管理块是否收缩（默认折叠，点击标题展开）
  gsCatFold: { char:true, place:true, proper:true },   // v10.53：词典小类别（人物/地点/专名）默认折叠，点击标题展开
  useChapterPlans: true,  // v10.29：逐章梗概本稿是否参与正文生成（默认开）；关则保留内容与历史、仅不注入 AI
  chapterPlanOn: true,   // v10.58-narrow：长篇大纲是否生成"全部章节安排/分组"(structure.chapterPlan)；关则不提示、不兜底、不渲染该分组，主线四格照常。A 窄开关
  chapters: [],         // [{title, content, confirmed, editHistory:[]}]
  characters: [],       // [{name, role, profile:{...}, prompts:{...}}]
  outlineHistory: [],   // 大纲版本历史（上限10）：[{outline, ts}] 覆盖前快照，支持预览/恢复
  expSel: [],           // 长篇导出勾选的章节索引（随项目快照持久化，P3-4）
  expOpenGroups: [],    // 长篇导出章节选择：手动展开的分组序号（配合限高内滚+分组折叠，缓解超长章节列表，P5）
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
    qcTemp:      (cfg.qcTemp==null ? 0.2 : cfg.qcTemp),              // 分任务温度：词库提取（严谨低温）
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
    recipeSet: state.recipeSet || { structure:null, rhythm:null, titleStyle:[] },
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
    useChapterPlans: (typeof state.useChapterPlans === 'boolean') ? state.useChapterPlans : true,   // v10.29
    chapterPlanOn: (typeof state.chapterPlanOn === 'boolean') ? state.chapterPlanOn : true,   // v10.58-narrow
    expOpenGroups: state.expOpenGroups,   // P5 长篇导出分组折叠所展开的分组透传
    polishOptions: state.polishOptions,   // v10.16 优化构想保留方案透传
    polishAdopted: state.polishAdopted,   // v10.16 当前采用的方案名
    polishHistory: state.polishHistory,   // v10.16 优化构想批量版本（≤5）透传
    chapters: state.chapters,
    characters: state.characters,
    ctAdviceHist: Array.isArray(state.ctAdviceHist) ? state.ctAdviceHist : [],   // v10.59 章节标题 AI 建议快照
    contentAdviceHist: Array.isArray(state.contentAdviceHist) ? state.contentAdviceHist : [],   // v10.59 章节内容 AI 建议快照
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
    logline: (state.outline && state.outline.logline) || '',
    _lastCpRaw: state._lastCpRaw || '',
    _lastTitlesRaw: state._lastTitlesRaw || '',
    _lastChapterRaw: state._lastChapterRaw || {}
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
  state.useChapterPlans = (typeof p.useChapterPlans === 'boolean') ? p.useChapterPlans : true;   // v10.29 默认参与生成
  state.chapterPlanOn = (typeof p.chapterPlanOn === 'boolean') ? p.chapterPlanOn : true;   // v10.58-narrow 默认生成全部章节安排
  state.expOpenGroups = Array.isArray(p.expOpenGroups) ? p.expOpenGroups : [];   // P5 长篇导出分组折叠所展开的分组
  state.polishOptions = Array.isArray(p.polishOptions) ? p.polishOptions : undefined;   // v10.16 保留方案
  state.polishAdopted = (typeof p.polishAdopted === 'string') ? p.polishAdopted : undefined;
  state.polishHistory = Array.isArray(p.polishHistory) ? p.polishHistory : undefined;   // v10.16 优化构想批量版本
  state.chapters = p.chapters || [];
  // v10.60 去除质检：加载即从旧快照剥离已无用的 qcRecord 与标题 titleQC，避免残留数据
  (state.chapters||[]).forEach(c=>{ if(c) delete c.qcRecord; });
  if(state.outline) delete state.outline.titleQC;
  state.characters = p.characters || [];
  state.ctAdviceHist = Array.isArray(p.ctAdviceHist) ? p.ctAdviceHist : [];   // v10.59 老项目缺省空
  state.contentAdviceHist = Array.isArray(p.contentAdviceHist) ? p.contentAdviceHist : [];   // v10.59 老项目缺省空
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
  state._lastCpRaw = p._lastCpRaw || '';
  state._lastTitlesRaw = p._lastTitlesRaw || '';
  state._lastChapterRaw = (p._lastChapterRaw && typeof p._lastChapterRaw === 'object') ? p._lastChapterRaw : {};
  state.titleHistory = Array.isArray(p.titleHistory) ? p.titleHistory : [];
  state.raw = p.raw || {};
  currentStep = (p.step && p.step >= 1 && p.step <= 5) ? p.step : 1;
}
function clearState(){
  state.mode = 'shortfilm';
  state.recipe = 'mesh';
  state.recipeSet = { structure:null, rhythm:null, titleStyle:[] };
  state.wordRange = null; state.chapterRange = null; state.totalWords = null; state.chapterCount = null;
  state.idea = ''; state.outline = null; state.coverPrompt = ''; state.coverWithTitle = false; state.outlineConfirmed = false;
  state.pendingGlossary = null; state.glossAdherence = 60; state.glossAllowFill = false; state.glossAutoFill = true; state.gsCollapsed = true;
  state.useChapterPlans = true;  // v10.29 新建作品默认参与生成
  state.chapterPlanOn = true;  // v10.58-narrow 新建作品默认生成全部章节安排
  state.chapters = []; state.characters = []; state.scenes = []; state.storyboard = []; state.boardConcepts = []; state.titleHistory = []; state.raw = {};
  state.ctAdviceHist = []; state.contentAdviceHist = [];   // v10.59 随项目的 AI 建议快照（章节标题 / 章节内容）
  state.outlineHistory = []; state.expSel = [];
  state.hist = { characters:[], scenes:[], cover:[], storyboard:[] };
  state.chapterStyle = { tags: [], intensity: 2, collapsed: false, elemOpen: false };
  state._lastCpRaw = '';
  state._lastTitlesRaw = '';
  state._lastChapterRaw = {};
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
      titleStyle: Array.isArray(set.titleStyle) ? set.titleStyle.filter(id=> TITLE_STYLE_IDS.includes(id)) : []
    };
  }
  // 旧 recipe 单一 id 迁移映射
  const legacyMap = { mesh:{structure:'mesh',rhythm:null}, layered:{structure:'layered',rhythm:null}, web:{structure:null,rhythm:'web'}, web100:{structure:null,rhythm:'web'}, causal:{structure:'causal',rhythm:null} };
  return legacyMap[legacyRecipe] || { structure:null, rhythm:null };
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
        <p class="muted" style="font-size:11px">50000 字仅为日志预览上限，实际发送/接收为全量，不影响请求。</p>
      </div>
    </div>`;
  }).join('') : '<p class="muted">暂无请求记录。每次调用 AI 都会记录（最近 50 0条，仅存本机）。</p>';
  const ov = document.createElement('div'); ov.id='ailogPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>🗒️ AI 请求日志（${aiLog.length}/500）</b>
        <span style="display:flex;gap:6px">
          <button class="gs-x" data-ailog-close>✕</button>
        </span></div>
        <div style="display:flex;gap:6px;padding:0 16px 8px"><button class="btn small ghost" data-ailog-clear>🗑 清空</button></div>
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
      const hdrs = {'Content-Type':'application/json','Authorization':'Bearer '+s.apiKey};
      if(streaming){ hdrs['Accept'] = 'text/event-stream'; hdrs['Cache-Control'] = 'no-cache'; }
      res = await fetch(url, {
        method:'POST',
        headers: hdrs,
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
      _rec.resp = String(out).slice(0,50000); _rec.respLen = String(out).length; _rec.ms = Date.now()-_t0; _rec.ok = true;
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
    _rec.resp = String(full).slice(0,50000); _rec.respLen = String(full).length; _rec.ms = Date.now()-_t0; _rec.ok = true;
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
  if(on){ btn._txt = btn.innerHTML; btn.disabled = true; btn.classList.add('is-busy'); btn.innerHTML = '<span class="spinner"></span>'+(label||'生成中…'); }
  else { btn.disabled = false; btn.classList.remove('is-busy'); btn.innerHTML = btn._txt; }
}

/* ---------- 全局中止控制器（流式停止按钮用） ---------- */
let _abortCtl = null;           // 当前 AbortController
let _abortBtn = null;           // 当前可见的停止按钮 DOM
// 创建一个停止按钮
function makeStopBtn(){
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'stop-btn'; b.innerHTML = '⏹';
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
let _aiOptBusy = false;  // v10.43 AI 优化建议进行中标记（无 signal，需单独占位，供 genBusy 判定互斥）
// v10.43 全局"是否有生成任务进行中"判定：任一走 _abortCtl 的流式请求，AI 建议占位，或任意 .is-busy 按钮，均视为 busy。
// 供视图切换/重复触发入口做统一互斥拦截（避免"重生成标题 + AI建议"等多任务并发劫持 _abortCtl）。
function genBusy(){
  if(_aiOptBusy) return true;
  if(_abortCtl) return true;
  const busyAny = document.querySelector('.is-busy, [disabled].cp-gen-btn-loading');
  if(busyAny) return true;
  return false;
}
// v10.43 视图切换守卫：进行中时提示拦截。返回 true 表示允许切换；false 表示被拦截（不切换）。
function guardSwitchStep(){
  if(genBusy()){
    return confirm('当前有生成任务进行中，切换视图会中断其运行，确定继续？');
  }
  return true;
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
{"title":"故事标题","logline":"小说简介（含核心冲突）","chapters":[{"title":"第1章标题","summary":"该章核心事件与转折，1-2句"}]}
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
{"title":"小说名","logline":"小说简介（含核心冲突与深层命题）","structure":{ ${MAIN_LINE_BLOCK} },"chapters":[{"title":"第1章标题"}]}
【硬性约束】
1. structure 字段按上方 JSON 内联定义主线条四格（mainLine 必有；副/暗/汇合有则带、无则空，绝不硬造）；chapterPlan（全部章节按线索分组）由下方【长篇结构设计 · 章节计划】块补充，一章不落。
2. **chapters 只需逐章列出标题，禁止输出任何逐章梗概、内容预告、章末钩子或阶段目标**——每章的正文与梗概在写正文阶段独立生成，不在大纲阶段预写。
【自由发挥区】在满足以上约束的前提下，章节标题的立意、措辞、节奏走向由你自由构思。
`,

  longChapterSys: `你是一位严格遵循既定大纲的章节执行写手。
【核心任务】
作为严格遵循既定大纲的章节执行写手，您负责撰写指定章节的完整正文。您需基于已知的【小说书名】【整体结构】【小说简介】【本章标题】【本章梗概】【上一章标题】【上一章全部正文】【下一章标题】与【万物词典】，创作出情节连贯、人物鲜活、符合整体风格的章节内容，确保本章既独立成篇又承上启下。

【硬性约束】

0. 若用户提示中出现【写作风格】块，必须作为首位硬约束执行，其优先级高于本提示词中所有其他要求。
1. 输出格式：仅输出本章正文，不得包含任何说明、章节标题、元评论或分析。正文直接以小说段落形式呈现，不得使用markdown代码块或额外格式。
2. 严格遵循【本章梗概】所规定的核心事件和推进顺序，不得更改主要情节节点，但可合理补充细节描写、对话、环境渲染及心理活动以丰富血肉。
3. 必须参考【上一章全部正文】，确保人物情绪状态、对话话题、场景延续、时间逻辑等与上一章无缝衔接。若上一章结尾有未完成的动作或对话，本章须自然承接。
4. 必须考虑【下一章标题】，在本章结尾处埋下指向下一章的线索或悬念，但不得提前揭示下一章的具体情节。
5. 万物词典中的设定（如地名、能力、历史、物品、规则等）必须准确使用，不得出现与词典相悖的表述。
6. 人物言行需符合其性格设定（可从整体结构、小说简介或万物词典中获取），对话需具有辨识度，避免千人一面。
7. 正文长度控制在3000—7000字之间，可根据本章内容密度适当浮动，但须保证情节充实而不拖沓。
8. 章节内部应有节奏变化，例如紧张场景与舒缓场景交替，避免通篇平铺直叙。每段描写应服务于情节推进或人物塑造。
9. 内部自查（不写入输出）：输出前确认本章梗概中的所有关键事件均已覆盖，且与上一章结尾和下一章标题形成合理连接。若梗概与小说简介有细微冲突，以小说简介为准，并在正文中自然调和，不显突兀。`,

};

/* =========================================================
 * 长篇写作范式：结构 / 节奏 / 标题风格，皆可独立或组合
 * ---------------------------------------------------------
 * 结构(STRUCTURES, 单选互斥)   mesh多线网状 / causal单线因果 / layered分层递归
 *                              hero英雄之旅 / savecat节拍表 / seven七点结构
 * 节奏(RHYTHMS, 单选互斥)      web黄金网文 / repress压抑反转 / slice慢生活
 *                              mystery悬疑解谜 / epic群像史诗 / fatal悲剧宿命 / inward文艺向内
 * 标题风格(TITLE_STYLES, 可多选可空)   归纳/画龙点睛/文学语句 等
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
      ${(state.polishHistory&&state.polishHistory.length)?`<button type="button" class="btn small ghost" data-pol-keep-hist>📚 优化版本(${state.polishHistory.length}/50)</button>`:''}
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
  if(hist.length > 50) hist.length = 50;
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
      <div class="gs-modal-head"><b>💾 优化构想 · 批量版本（${hist.length}/50）</b>
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
{"title":"小说名","logline":"小说简介","structure":{ ${MAIN_LINE_BLOCK} },"chapters":[{"title":"章标题"}]}
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
{"title":"小说名","logline":"小说简介","structure":{ ${MAIN_LINE_BLOCK} },"volumes":[{"name":"第X卷卷名","theme":"本卷主题与情绪基调","chapters":[{"title":"章标题"}]}]}
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
{"title":"小说名","logline":"小说简介","structure":{"mode":"英雄之旅","designReason":"为何采用此倒逼成长框架","stageChapters":{"平凡世界":["章标题",...],"召唤":["章标题",...],"拒绝":["章标题",...],"导师":["章标题",...],"跨过门槛":["章标题",...],"试炼/盟友/敌人":["章标题",...],"深渊":["章标题",...],"一搏":["章标题",...],"回报":["章标题",...],"归来":["章标题",...],"变更":["章标题",...]}, ${MAIN_LINE_BLOCK}},"chapters":[{"title":"章标题"}]}
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
{"title":"小说名","logline":"小说简介","structure":{"mode":"Save the Cat 节拍表","designReason":"如何用 15 拍控制节奏","beats":{"开场画面":["章标题",...],"催化剂":["章标题",...],"争执":["章标题",...],"进入第二幕":["章标题",...],"B故事":["章标题",...],"中点":["章标题",...],"坏人逼近":["章标题",...],"一切尽失":["章标题",...],"黑暗时刻":["章标题",...],"进入第三幕":["章标题",...],"终局":["章标题",...],"最终画面":["章标题",...]}, ${MAIN_LINE_BLOCK}},"chapters":[{"title":"章标题"}]}
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
{"title":"小说名","logline":"小说简介","structure":{"mode":"七点结构","designReason":"七个锚点如何控制转折","points":{"Hook钩子":["章标题",...],"PlotTurn1一转折":["章标题",...],"Pinch1中点施压":["章标题",...],"Midpoint中点":["章标题",...],"Pinch2压力加码":["章标题",...],"PlotTurn2二转折":["章标题",...],"Resolution解局":["章标题",...]}, ${MAIN_LINE_BLOCK}},"chapters":[{"title":"章标题"}]}
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

const STRUCTURE_IDS = STRUCTURES.map(s=> s.id);
const RHYTHM_IDS = RHYTHMS.map(r=> r.id);

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
 * v2.0 / v10.17 写作风格选择器：内置词库 29 项，v10.17 起全部归入「章节风格(element)」组；v10.21 节奏与网感新增 6 项、语言质感新增 5 项、情绪与张力新增 5 项，内置合计 45 项
 * 组别：tone=标题风格（重生成全部标题）/ texture=梗概风格（逐章梗概）/ element=章节风格（正文）——均多选
 * 注入：章节正文用章节风格（buildChapterSys/chapterStyleNote）；标题重生成用标题风格；逐章梗概用梗概风格。
 * 每项 note 为可执行 AI 指令；注入时统一附加一致性红线。
 * ========================================================= */
const WRITE_STYLES = [
  // 写作风格词库·按五大类文风（cat）。均归入 element（章节风格）组，供章节正文生成时注入。
  // ============ ① 语言质感 ============
  { id:'wenyi',  group:'element', cat:'语言质感', name:'文艺/范儿',
    note:'意象化、通感、抒情长句、留白，重氛围轻情节（如张嘉佳、琼瑶式）。',
    tips:['多用意象化与通感修辞','抒情长句铺陈心境，节奏舒缓','点到为止，留白让余味生长'],
    avoid:['情节推进过急','直白说破情绪'],
    check:['氛围优先于情节','有 1-2 处可回味的句子'],
    demo:'散场后影厅的灯一瞬亮起，红绒座椅一排排空下去，像退潮的海。他坐在最后一排，等字幕走完，才把攥了一整场的手，慢慢松开。' },
  { id:'ornate', group:'element', cat:'语言质感', name:'华丽辞藻',
    note:'排比、对仗、四字词、浓墨重彩的画面铺陈。',
    tips:['多用排比、对仗、通感','用四字词与色彩意象铺陈','句子密度与节奏感并重'],
    avoid:['华丽但空洞（只有形容词没有实义）','堆砌到影响阅读'],
    check:['至少 2 处排比/对仗','辞藻服务于画面与情绪'],
    demo:'暮色像一匹被揉皱的绸缎，摊在山脊上，流光一寸寸洇开。' },
  { id:'minimal',group:'element', cat:'语言质感', name:'极简/冷峻',
    note:'短句、白描、不抒情，靠动作和留白传达（海明威式）。',
    tips:['短句、白描、删冗余','情绪用动作与环境暗示','把余味留给读者'],
    avoid:['直白喊出情绪','大段心理独白'],
    check:['情绪段落少于直接描写','无直白情绪标签'],
    demo:'他把刀擦干净，放回架子上。窗外雨没停。' },
  { id:'poetic', group:'element', cat:'语言质感', name:'诗化散文化',
    note:'段落像写诗，长短句错落，节奏淡雅。',
    tips:['段落如诗分行，长短句错落','用淡雅意象营造氛围','节奏舒缓、留白多'],
    avoid:['通篇无叙事推进','堆砌意象失去中心'],
    check:['文字有诗性','节奏淡雅不拖沓'],
    demo:'晨雾里，早班的船离了岸。橹声一下，一下，像在江面上，把昨夜的话一句句抹平。岸上有人立了很久，直到雾把船和人一起收走。' },
  { id:'euro',   group:'element', cat:'语言质感', name:'翻译腔/欧美范',
    note:'长定语从句、欧式标点、西式叙述节奏。',
    tips:['长定语从句与倒装','欧式破折号、分号连接','西式冷静的叙述距离感'],
    avoid:['生硬到读不通','堆砌从句失去节奏'],
    check:['有西式笔调','可读性不牺牲'],
    demo:'她把那份写了很久、又反复修改、最终也没能寄出去的告别信，连同那枚旧贝壳，一起锁进那口棕色的、她从童年起就没再打开过的箱子。' },
  { id:'classic',group:'element', cat:'语言质感', name:'古风文言',
    note:'文言字句、古韵气息，骈散兼用，含蓄蕴藉。',
    tips:['以凝练文言与四六骈句铺陈','动词古雅（顾、掷、敛、挑灯）','对话带古白话韵味，不全程掉书袋'],
    avoid:['生僻掉书袋','古腔盖过剧情可读性'],
    check:['读来有古意不晦涩','用词贴合人物身份'],
    demo:'孤鸿声里，城门缓缓阖上。他负手立于城楼，望那盏渐远的灯，终究没说一句留字。' },
  { id:'folktale',group:'element',cat:'语言质感', name:'市井评书腔',
    note:'说书人腔、话本俚俗、烟火锅气，热闹有人味。',
    tips:['以说书人视角交代，带"话说""且听"的烟火话茬','俚语俗谚与市井行话点人点事','节奏热络、听感活泛'],
    avoid:['盲目复古腔调失真','俚俗过度显油滑'],
    check:['读来像听故事','市井气服务于人物环境'],
    demo:'那王二麻子，是方圆十里出了名的抠门主儿——上他家讨口水喝，都得听他把水瓢掂量三回。' },
  { id:'epic',group:'element', cat:'语言质感', name:'史诗庄重',
    note:'沉着宏阔、碑文式质感，字句有时间的重量。',
    tips:['铺陈用宏大意象（山河、长夜、星海）','句式沉稳、节奏凝重','关键处用克制笔法写大事件'],
    avoid:['空洞的大词堆砌','沉重到拖沓'],
    check:['有厚重史诗感','宏阔处仍有具体细节穿透'],
    demo:'星海横贯头顶，是他的国；脚下冻土延展，也是他的国。一将功成，不过是这漫漫长夜里，那些无名者共用的名字。' },
  { id:'airy',group:'element', cat:'语言质感', name:'轻盈灵动',
    note:'明快清新、短句跳跃、俏皮生趣，读来轻快。',
    tips:['短句快行、节奏轻快','比喻清新俏皮、有少年气','对话灵动带小机锋'],
    avoid:['轻飘无实义','俏皮过度发腻'],
    check:['读来轻快不觉累','明快中不失真情'],
    demo:'她把作业本往桌上一拍，像只炸了毛的小猫，眉毛竖得能挂三斤酱油。' },
  { id:'cutting',group:'element', cat:'语言质感', name:'锋利冷冽',
    note:'犀利讽刺、刀刃句式、冷静不留情面。',
    tips:['短句见锋，一句切中要害','冷静语气说狠话，反差更利','讽刺藏在客观陈述里'],
    avoid:['泼妇式叫骂','为毒而毒失分寸'],
    check:['不语带脏字也伤人','锋芒服务于立场交锋'],
    demo:'他的道歉和他的承诺一样廉价——都只够说出口，不够兑现。' },
  // ============ ② 情绪与张力 ============
  { id:'suspense2',group:'element',cat:'情绪与张力', name:'悬疑压抑',
    note:'名词化、阴冷意象、制造不安感的用词。',
    tips:['制造信息差（读者知道得比角色少或多）','句尾留悬念钩子','环境意象偏暗、紧绷'],
    avoid:['提前泄底','为悬疑而故弄玄虚（逻辑不通）'],
    check:['段落间有悬念牵引','悬念符合逻辑、可回收'],
    demo:'他每天下班都路过那家窗贴磨旧、却从不见人进出的花店。今晚他忍不住推门——门没锁，柜台后的墙上挂着一排照片，每一张，都拍的是他。' },
  { id:'sweet',  group:'element', cat:'情绪与张力', name:'甜宠/温柔',
    note:'细腻心理、绵软对话、小动作描写。',
    tips:['多写微小动作与眼神','对话温和、有生活气','细节传递温度'],
    avoid:['刻意煽情','甜腻到失真'],
    check:['有生活细节体现温度','情感自然不煽情'],
    demo:'她随口说想吃那家老店的糖炒栗子。他没答话，第二天下班拎了一袋回来，隔着纸袋还是热的——袋上，他认认真真写了"趁热"两个字。' },
  { id:'heartwarm',group:'element',cat:'情绪与张力', name:'虐心催泪',
    note:'情感落差、写泪点、克制中爆发。',
    tips:['铺垫情感、制造落差','写泪点时克制不喊叫','在高点克制收束'],
    avoid:['全程强行煽情','情绪喊口号化'],
    check:['有清晰情感高点','泪点自然、铺垫足够'],
    demo:'奶奶把存折交给他，说密码是他的生日。他翻到最后一页才看清存款时间——整整三十年前，正是他出生的那年。那笔钱，她替他攒了一辈子。' },
  { id:'flame',  group:'element', cat:'情绪与张力', name:'热血燃动',
    note:'情绪爆发＋动作节奏带出「燃」，靠张力推进不靠血腥。',
    tips:['动作链密集、节奏如鼓点','短促有力的句式让语气一路走高','以意志力、逆袭转折点燃情绪，不依赖血腥'],
    avoid:['血腥暴力与感官刺激堆砌','喊口号式的假燃','靠场面硬撑而无人物情绪'],
    check:['有清晰的情绪沸点','热血但不越界','燃来自人物选择而非血腥'],
    demo:'一剑破空，少年不退反进，眼底燃起整座江湖的灯。' },
  { id:'zhanshi', group:'element', cat:'情绪与张力', name:'写实战争纪实',
    note:'写实战场实感、群像牺牲、冷峻不煽情的纪实悲壮。',
    tips:['战地细节写实、炮火烟尘与噪声具体','群像式牺牲、点到为止不渲染','冷峻克制、用个别镜头折射整体'],
    avoid:['英雄化、个人光环凌驾群像','血腥刺激堆砌','煽情喊口号'],
    check:['有战场实感与氛围','牺牲有分量不廉价','冷静呼吸、不靠煽动'],
    demo:'担架从泥泞里抬过去，谁也没停。枪声一响，他们又都趴回了开阔地。' },
  { id:'terror', group:'element', cat:'情绪与张力', name:'惊悚寒气',
    note:'具象的感官恐惧、细思极恐、寒意入骨。',
    tips:['用触感/听觉营造阴冷（汗毛、脚步声、指甲刮过）','未知比具象更毒，先露一角','恐怖藏在日常细节里'],
    avoid:['血腥猎奇堆砌','一惊一乍而无逻辑'],
    check:['读完后背发凉','恐怖有来源可解释'],
    demo:'他数完最后一级台阶，楼道灯忽然熄灭。黑暗里，有什么正跟着他的步子——他停，那声音也停；他走，那声音贴在他身后，也走。' },
  { id:'warmth', group:'element', cat:'情绪与张力', name:'温情治愈',
    note:'亲情友情的平淡暖意，柴米油盐里的光。',
    tips:['细写照顾、牵挂、笨拙的表达','暖藏在克制与日常里，不喊口号','一个细节点亮一个场景'],
    avoid:['强行煽情','甜腻到失真'],
    check:['读来心里发烫','暖点有生活依据'],
    demo:'她加班到深夜，桌角放着一碗还冒热气的面，碗边压着张纸：趁热吃。她抬头，对面那位总说"你天天不落屋"的保洁阿姨，正假装在擦她早该擦完的那块玻璃。' },
  { id:'standoff', group:'element', cat:'情绪与张力', name:'对峙张力',
    note:'两方角力、一触即发、空气凝住的压迫。',
    tips:['从动作/物件写紧绷（手按枪柄、茶水渐凉）','对话句句试探、句句留尾','用细节的"没发生"代替爆发'],
    avoid:['一上来就摊牌','张力被废话稀释'],
    check:['全程心悬着','对峙有翻盘可能'],
    demo:'他与她隔桌对坐，谁也没碰那盏茶。窗外蝉鸣陡然一停，空气像被抽干——他咽了口唾沫，那一声响，在寂静里放大如雷。' },
  { id:'melancholy', group:'element', cat:'情绪与张力', name:'苍凉悲怆',
    note:'苍茫宿命、万物有时，厚重的悲怆余味。',
    tips:['用时间与物候的流逝写无力（残碑、西风、老树）','悲在点到为止，不泣不成声','以"无归"收束，留下苍凉'],
    avoid:['滥情哀嚎','为悲而悲脱离事件'],
    check:['悲怆有重量感','克制中透出宿命感'],
    demo:'他蹲在旧碑前，指腹一点点抚过那些名字。风过，草伏下去又立起来，像是替他一排排地，给每个名字鞠了一躬。' },
  { id:'thrill', group:'element', cat:'情绪与张力', name:'惊心动魄',
    note:'千钧一发的生死瞬间、大事件高峰的震动。',
    tips:['倒计时式紧迫（再零点几秒就…）','用瞬间抉择压缩张力','高潮后留一帧静默回响'],
    avoid:['全程紧崩到麻木','为震撼而失真'],
    check:['读时屏住呼吸','高潮有回响'],
    demo:'他按下的不是按钮，是整座城的命。警报倒数最后一声时，他闭上了眼——然后睁开的，是响起的钟声。' },
  // ============ ③ 节奏与网感 ============
  { id:'fast',   group:'element', cat:'节奏与网感', name:'爽文/快节奏',
    note:'短段落、强动作链、钩子密集、打脸反转。',
    tips:['短段落、信息密度高','动作链推进、钩子密集','打脸反转干脆'],
    avoid:['长句拖慢节奏','仅爽无逻辑'],
    check:['平均句长偏短','节奏有快慢变化'],
    demo:'评委按下淘汰键。他反手把U盘插进主机。全场以为他在作死——三分钟后大屏弹出那段从未公映的预告片，满座哗然：他才是那部片的原作者。' },
  { id:'webman', group:'element', cat:'节奏与网感', name:'网文口语化',
    note:'"咱""咋""整点"这类方言口语、接地气。',
    tips:['用接地气口语','短句、像说话','贴近生活原声'],
    avoid:['文绉绉书面语','生硬翻译腔'],
    check:['读起来像听人说话','口语自然不违和'],
    demo:'老板娘扯着嗓子喊："小师傅，麻辣烫要辣不？"他头也不抬："辣！整大份，莫放香菜，多整两勺油辣子！"' },
  { id:'roast',  group:'element', cat:'节奏与网感', name:'逗趣吐槽',
    note:'吐槽回环、毒舌、冷幽默（偏"解说式吐槽"）。',
    tips:['冷幽默旁观者视角','一本正经说反话的拆台式吐槽','毒舌但留分寸'],
    avoid:['刻薄伤人的恶意嘲讽','吐槽脱离剧情变成作者乱入'],
    check:['吐槽符合人物视角','无恶意攻击'],
    demo:'他说他要开始健身了。我看了眼他怀里那袋薯片，他说这是低卡的。我点点头：对，低卡到只够长在你最不常用的那块肉上。' },
  { id:'sliceoflife',group:'element',cat:'节奏与网感', name:'慢节奏生活流',
    note:'长句舒缓、日常细节、流水账式的治愈感。',
    tips:['长句舒缓','写日常细节与烟火气','节奏慢、治愈感'],
    avoid:['节奏拖沓无信息','平淡到无趣'],
    check:['细节有生活气息','读来治愈不焦躁'],
    demo:'傍晚他去买馒头，老板娘多塞了他一根油条，说是刚出锅的。他回家掰开馒头夹上油条，就着一碗滚烫的豆浆慢慢吃完，天正好黑下来。' },
  { id:'breathe',group:'element',cat:'节奏与网感', name:'张弛起伏',
    note:'快慢交替、张弛有度，情绪张满后给回气口。',
    tips:['激烈桥段后接舒缓过渡，避免全程崩弦','单章内安排1-2次情绪高低谷','节奏服务情绪，快慢都有目的'],
    avoid:['全程高能致疲劳','拖沓无高潮'],
    check:['快慢有对比','张弛有度不闷'],
    demo:'枪声刚落，只剩瓦砾里忽明忽暗的火——他忽然很想抽一会儿烟。' },
  { id:'staccato',group:'element',cat:'节奏与网感', name:'顿挫短句',
    note:'多短句、多句号、顿挫压迫，紧张感靠断句砸出来。',
    tips:['短句密集、句号敲击节奏','关键动作用破折号或单字短句定格','对白惜字加句读制造压迫'],
    avoid:['长句堆叠泄气','顿挫变碎碎念'],
    check:['读来有敲击感','氛围紧绷不碎'],
    demo:'灯灭了。门动了。枪，上了膛。他一动不动。' },
  { id:'shot',group:'element',cat:'节奏与网感', name:'画面分镜',
    note:'镜头语言进文字：切镜、推拉、特写、蒙太奇，画面感强。',
    tips:['靠镜头视角切换组织画面','大场面用推拉/俯瞰再切特写','关键处停格特写留画面'],
    avoid:['镜头跳切无联接','纯描写拖节奏'],
    check:['画面在脑中成像','切镜服从叙事'],
    demo:'镜头从燃着的舰队拉远，落在滩头一双攥紧步枪的手上——那只手在抖。' },
  { id:'meme',group:'element',cat:'节奏与网感', name:'玩梗共鸣',
    note:'适度当代网络梗、表情包化表达，提升年轻网感共鸣。',
    tips:['梗服务于人物与情绪，不做作者乱入','用"懂的都懂"式轻梗，不用陈年老梗','一处1-2个足够，密必俗'],
    avoid:['老梗陈词','梗盖过剧情'],
    check:['无梗也能读懂','梗符合人物身份'],
    demo:'他盯着那条消息看了三遍，缓缓打出一个"6"。' },
  { id:'oneliner',group:'element',cat:'节奏与网感', name:'爆点金句',
    note:'在名场面制造一句被记住、可转发的经典台词。',
    tips:['关键转折前铺垫，台词落在一击上','简洁有锋芒，可独立成句','金句说透情绪，不只耍帅'],
    avoid:['句句都是金句反成废话','为金句硬造'],
    check:['单拎出来仍有味道','贴合人物口吻'],
    demo:'"他们都叫我无名氏，可我记得每个名字。"' },
  { id:'punchline',group:'element',cat:'节奏与网感', name:'三连递进',
    note:'三点递进式爆点：铺垫→升格→砸点，笑点/爽点有结构。',
    tips:['先铺垫再翻一转二再砸底','第二/第三点必须递进更强','结尾落点干脆不拖'],
    avoid:['三连平铺无递增','砸底拖泥带水'],
    check:['一层比一层响','落点干脆'],
    demo:'第一次叫错，他笑了；第二次叫错，他黑了脸；第三次——他教那人把名字写在自己的拳头里。' },
  // ============ ④ 叙事技法 ============
  { id:'nonlinear',group:'element',cat:'叙事技法', name:'非线性插叙',
    note:'时间跳跃、倒叙插叙、视角切换的笔法。',
    tips:['倒叙/插叙布局时间线','适时视角切换','留悬念、逐步揭开'],
    avoid:['时间线混乱难懂','为炫技而跳跃'],
    check:['读者能看懂时间线','插叙服务悬念与情感'],
    demo:'多年后他整理父亲的遗物，翻出一张褪色的火车票：终点是当年他离家那晚没到的地方。他想起来了——那晚父亲追出去，其实一直追到了站台。' },
  { id:'multipov',group:'element',cat:'叙事技法', name:'多视角群像',
    note:'视角切换带来的文体变化。',
    tips:['多角色视角切换','各视角文体略有差异','用视角差制造信息差'],
    avoid:['视角混乱','众角色声音雷同'],
    check:['视角切换清晰','各视角有辨识度'],
    demo:'她在台上笑得落落大方，转身时长裙扫过。站在二楼的他，看见的却是她攥住裙摆的手，指节白了一瞬——那是她说不出口的那记再见。' },
  { id:'jinyong', group:'element', cat:'叙事技法', name:'金庸武侠风',
    note:'白话为骨、清隽文雅，重侠义风骨与「武即德」，打斗点到即止。',
    tips:['文白相间但以白话为主，清朗不拗口','对白见人物心性，谈笑间立场分明','武学重在招如其人、胜负系于胸襟与抉择'],
    avoid:['通篇文言掉书袋','靠境界/数据堆战力而无人格','招式浮夸只剩热闹'],
    check:['打斗不靠数值堆砌','人物立得住、侠义贯穿','武与德互为表里'],
    demo:'他这一剑不伤人，只想破开迷障问一句——当年的恩怨，可曾有半分真假？' },
  { id:'cosmic', group:'element', cat:'叙事技法', name:'克苏鲁/神秘叙事',
    note:'慢热、不可名状的形容、氛围堆叠而非直接说明。',
    tips:['慢热铺垫、氛围堆叠','描述不可名状的怪诞','不直接说明，留神秘'],
    avoid:['直接点破诡异真相','描写喧宾夺主'],
    check:['氛围压抑、层层递进','神秘感不流失'],
    demo:'山谷里的小旅馆只住了他一个客人。后半夜，楼道尽头传来敲门声，两下，停，一下。他壮胆开门——走廊空无一人，而他插在门内侧的那把反锁钥匙，不知何时，已经被拔掉了。' },
  { id:'fan',    group:'element', cat:'叙事技法', name:'魔幻奇幻史诗',
    note:'魔法奇观、异界冒险、史诗宿命，奇幻世界观从容自洽。',
    tips:['魔法与异界设定自洽、有内在法则','经典奇幻的大格局与使命宿命','冒险推进带史诗感、旅程即成长'],
    avoid:['设定堆砌只炫世界','奇幻沦为无敌光环','格局大却空泛'],
    check:['世界法则自洽','冒险有史诗张力','设定服务人物与使命'],
    demo:'山脚的灯一盏盏亮起，他握着旧魔杖站在岔路出口：预言说的是他，可他只想先救下那个女孩。' },
  { id:'space',  group:'element', cat:'叙事技法', name:'宇宙史诗/星际文明',
    note:'放大星空与文明兴衰的宏大尺度，用异族视角与技术奇观铺陈未知。',
    tips:['把尺度拉到星海与文明兴衰的跨度','用技术奇观、异族视角制造宇宙感与疏离','让高于个人恩怨的文明命题作底'],
    avoid:['沦为地球都市科幻','堆设定与数据、只炫科技','把外太空当猎奇背景而无文明内核'],
    check:['有宇宙尺度与想象力','设定服务于主题','文明命题能立住'],
    demo:'当那艘沉寂了一万年的方舟重新亮灯，瞭望塔上最后一个人类忽然明白：我们从未孤独。' },
  { id:'sus3',   group:'element', cat:'叙事技法', name:'科幻惊悚衍生态',
    note:'高科技下的危险美学，惊颤与悬念延续而非设定堆砌。',
    tips:['以技术奇观放大未知威胁','惊悚源自科技的失控与人性','慢热铺垫、悬念层层加码'],
    avoid:['堆设定与术语','靠突然惊吓混悬念','高科技沦为背景板'],
    check:['威胁具体可感','悬念持续推进','科技与人性的张力兼顾'],
    demo:'培育缸里那头东西睁开眼，第一反应不是逃，而是隔着防爆玻璃，安静地打量他。' },
  // ============ ⑤ 台词设计 ============
  { id:'jifeng', group:'element', cat:'台词设计', name:'机锋对白',
    note:'短促交锋、话里有话（谍战、职场戏）。',
    tips:['对话短促交锋','话里有话、潜台词丰富','用停顿与留白施压'],
    avoid:['对白直白无张力','所有角色雷同'],
    check:['对话有子面冲突','潜台词清晰可读'],
    demo:'"你早该走了，为什么还留着？""你这话，是想我走，还是怕我听出你舍不得？"他笑了笑，把她面前那杯凉掉的茶，轻轻往她那边推了推。' },
  { id:'cross',  group:'element', cat:'台词设计', name:'插科打诨',
    note:'荤素不忌的相声式对白。',
    tips:['相声式插科打诨','对话热闹、包袱密集','符合人物身份场合'],
    avoid:['低俗失度','为逗而逗脱离剧情'],
    check:['笑点长在人物身上','不失分寸'],
    demo:'"都说了我这人不记仇。""那你上回怎么三个月没理老王？""怪他记性太好——把我早忘了的事，替他记了三个月的仇。"' },
  { id:'storyteller',group:'element',cat:'台词设计', name:'说书人腔',
    note:'旁白式"话说""且听我道来"的叙述介入。',
    tips:['旁白式"话说/且听我道来"','叙述者在场、带节奏','说书式点评与转场'],
    avoid:['旁白过度打断','腔调陈旧呆板'],
    check:['有说书节奏','旁白服务叙事'],
    demo:'话说这码头上，能叫整条船停下来等一个人的主儿，可不多。可这一位啊，偏偏就肯等；这一等，分别的，便成了一段十里八乡都讲不完的交情。' },
  { id:'moli',   group:'element', cat:'叙事技法', name:'无厘头喜剧',
    note:'荒诞夸张、无逻辑转折、错位自嘲，一本正经地胡说八道。',
    tips:['设置夸张与反差、笑点落在荒诞而非逻辑','一本正经说荒唐话、错位自嘲','梗密度高、节奏快、转场跳脱'],
    avoid:['刻意逻辑闭环','低俗恶搞无节制','为搞笑强加剧情'],
    check:['荒诞但有内在喜感','不流于恶俗','笑点服务于人物与剧情'],
    demo:'他认真地思考了三秒，然后很严肃地告诉我：人不能太有钱，因为容易长寿。' },
  { id:'shenghuo', group:'element', cat:'叙事技法', name:'生活情景喜剧',
    note:'家庭日常＋固定人物性格碰撞，误会化解保留温馨底。',
    tips:['生活场景、小冲突环环相扣','用人物固定性格制造笑点与误会','斗嘴后总会化解、留温情收尾'],
    avoid:['冲突升级成狗血','靠强设定硬造笑点','失去生活质感'],
    check:['笑点来自生活与人物关系','误会化解自然','温暖底色不丢'],
    demo:'妈妈问他为什么又考砸，他一本正经：老师把题出得太多，我一时没来得及焦虑。' },
  { id:'fangyan', group:'element', cat:'台词设计', name:'方言/口音区隔',
    note:'用方言俚语、口癖腔调让每个角色开口有辨识度，对话自带地域与身份。',
    tips:['给关键角色赋予标志性口癖与腔调','用少量方言俚语点出身与城，不整段方言','不同地角色用不同语言习惯拉开落差'],
    avoid:['全程方言、读者难读','所有角色腔调雷同','方言作为噱头却无人格'],
    check:['台词不用看名就能分人','方言服务于人物身份','可读性不因口音牺牲'],
    demo:'“听你这口音，是打潞州来的吧？”掌柜的搁下算盘，“俺们这儿不兴这个。”' },
  { id:'qinghua', group:'element', cat:'台词设计', name:'情话/浪漫对白',
    note:'含蓄走心、带诗意的浪漫对白，于细节处表深情。',
    tips:['话里有心意，点到即止不直白','借日常物象与细节表深情','留白，把余味交给读者'],
    avoid:['油腻直白的土味情话','空喊喜欢无行动落点','为美而美、脱离人物语气'],
    check:['含蓄但不晦涩','情出自细节、真实可感','符合人物身份口吻'],
    demo:'他望着她的眼睛，半天只说了句：“今年冬天的雪，我替你先堆好了。”' },
  { id:'yinghan', group:'element', cat:'台词设计', name:'冷峻短促/硬汉对白',
    note:'惜字如金、动作代答，暗示多于直陈的克制型对白。',
    tips:['句子短、信息密，能用一个字不用一句','用动作与沉默代替解释','威胁与真相藏进潜台词'],
    avoid:['废话连篇','情绪过分外露','为装酷而故作高深'],
    check:['每句对白都有信息量','沉默与动作在替人物说话','克制但不冰冷失温'],
    demo:'“去哪？”“走。”“还回来吗？”他没停步，扔下一句：“看运气。”' }
];
// v2.4 组合配方：一键把多个文风词条按层配齐（点击以「替换」方式覆盖当前选择），解决复合文类需多零件叠加的问题。
// 引用的 tags 均为 WRITE_STYLES 中真实存在的 id（经 writeStyleLib 校验）。
const WRITE_COMBOS = [
  { id:'comic',     name:'😆 轻喜剧',  desc:'对白机锋层层叠加诙谐拆台，笑点长在人物与话术上，不硬抖包袱。', tags:['jifeng','cross','roast'] },
  { id:'mystery',   name:'🕵️ 悬疑',   desc:'阴冷压抑＋非线性悬念逐步编织，靠信息差与伏笔牵引推理。', tags:['suspense2','nonlinear'] },
  { id:'burn',      name:'🔥 燃向',   desc:'快节奏加码＋强动作链与密集钩子，情绪与力度一路走高。', tags:['fast','flame'] },
  { id:'aesthetic', name:'🌸 唯美',   desc:'文艺意象＋诗化段落，抒情长句与留白共筑氛围。', tags:['wenyi','poetic'] },
  { id:'speed',     name:'⚡ 快节奏爽文', desc:'爽文节奏＋网文口语与机锋对白，段落短、信息密、不拖沓。', tags:['fast','webman','jifeng'] },
  { id:'moli-combo', name:'🤪 无厘头',     desc:'荒诞夸张、反差自嘲，梗密节奏快，笑点落在荒诞不落在逻辑。', tags:['moli','fast','cross'] },
  { id:'family',   name:'😂 欢脱日常',   desc:'家庭生活小冲突环环相扣，误会化解留温情，笑点来自关系和烟火气。', tags:['shenghuo','sliceoflife','cross'] },
  { id:'jianghu',  name:'🏮 江湖喜剧',   desc:'武侠外壳的生活喜剧：江湖群像斗嘴＋无厘头＋机锋，笑点在人情世故。', tags:['shenghuo','moli','jifeng'] },
  { id:'yosheng',  name:'🦖 侏罗纪式科幻', desc:'高科技惊悚＋冒险奇观：未知威胁延续悬念，科技失控处见人性。', tags:['suspense2','fast','sus3'] },
  { id:'gufeng',   name:'🏯 武侠古风',   desc:'金庸风骨＋古风文言，侠义作魂、古韵为衣，打斗点到即止。', tags:['jinyong','classic','flame'] },
  { id:'romance',  name:'💞 甜宠言情',   desc:'恋爱甜宠＋浪漫对白＋轻盈灵动，细节传情、小动作含糖。', tags:['sweet','qinghua','airy'] },
  { id:'epicfan',  name:'🏰 史诗奇幻',   desc:'奇幻冒险＋史诗厚重＋宇宙尺度，大格局世界观从容铺陈。', tags:['fan','epic','space'] },
  { id:'horror',   name:'👻 惊悚恐怖',   desc:'感官恐惧＋悬念压抑＋顿挫短句，寒意入骨、压迫步步收紧。', tags:['terror','suspense2','staccato'] },
  { id:'heal',     name:'💧 治愈温情',   desc:'平淡暖心＋慢节奏生活流＋轻快灵动，柴米油盐里的光。', tags:['warmth','sliceoflife','airy'] },
  { id:'scheme',   name:'⚔️ 权谋对峙',   desc:'一触即发＋锋利冷冽＋机锋对白，句句试探、胜负在话里。', tags:['standoff','cutting','jifeng'] },
];
// v2.5 组合删除支持：cfg.styleCustom.comboRemoved 记录被用户删除的组合 id；「恢复默认词库」会一并还原
// v10.28 自定义组合：cfg.styleCustom.customCombos 存用户「＋」新建的组合；并入可用列表，并过滤已被词库删除的词条引用
function availableCombos(){
  const c = getCfg().styleCustom || {};
  c.customCombos = Array.isArray(c.customCombos) ? c.customCombos : [];
  const removed = Array.isArray(c.comboRemoved) ? c.comboRemoved : [];
  const libIds = writeStyleLib().map(s=>s.id);
  const builtin = WRITE_COMBOS.filter(x=> !removed.includes(x.id));
  const mine = c.customCombos
    .map(x=>({ ...x, custom:true, tags:(x.tags||[]).filter(id=> libIds.includes(id)) }))
    .filter(x=> x.tags.length > 0);
  return builtin.concat(mine);
}
const WRITE_GROUP_LABEL = { tone:'① 标题风格', texture:'② 梗概风格', element:'③ 章节风格' };

// —— AI 配方助手（v10.30 · 仅长篇小说模式；服务写作风格卡）——
// 用户用一段话描述想要的风格/题材/氛围，AI 基于现有词库给出 2~5 个候选配方；
// 每候选含「为何这样选 / 适用场景 / 词条缺口」。缺口词条按词库完整规格返回，用户逐条确认入库，确认即纳入当前配方。
// seal 默认 0（不锁），与"词条加入词库后立即纳入当前配方"两处决策一致。
const AI_CAT_LABEL = { '语言质感':'① 语言质感', '情绪与张力':'② 情绪与张力', '节奏与网感':'③ 节奏与网感', '叙事技法':'④ 叙事技法', '台词设计':'⑤ 台词设计', custom:'⭐ 我的自定义' };
let aiRp = null; // {list:[...], err:'' } 运行期临时候选（不持久化；render 重建主卡时会保留，重启清空）
// —— v10.57 AI 配方历史快照存储（独立 key，与主 cfg 解耦；生成即存，供书本图标回看）——
const KEY_AIHIST = 'fyp_aiRecipeHist_v1';
const AIHIST_CAP = 30;                       // 快照条数上限
const AIHIST_MAX_BYTES = 3600000;            // 存储体积安全阈值（约 3.4MB）
function getAiHist(){ try{ return JSON.parse(localStorage.getItem(KEY_AIHIST)||'[]'); }catch(e){ return []; } }
function setAiHist(a){
  let list = Array.isArray(a) ? a.slice(-AIHIST_CAP) : [];
  let s;
  try{ s = JSON.stringify(list); }catch(e){ return; }
  while(list.length && s.length > AIHIST_MAX_BYTES){ list.shift(); s = JSON.stringify(list); }
  try{ localStorage.setItem(KEY_AIHIST, s); }catch(e){ /* 超限静默；设独立键，不影响主 cfg */ }
}
function addAiHist(entry){ const a = getAiHist(); a.push(entry); setAiHist(a); return a.length; }
function snapAiHist(){ return getAiHist(); }
function aiHistEntryId(){ return 'ah'+Date.now().toString(36); }
/* ---------- v10.59 随项目的 AI 建议快照（复刻配方历史的能力，存入 state、随项目存取） ---------- */
// kind: 'ct'  章节标题 AI 建议；'content'  重生成章节内容 AI 建议
function histState(kind){
  const s = state;
  if(kind === 'ct'){ if(!Array.isArray(s.ctAdviceHist)) s.ctAdviceHist = []; return s.ctAdviceHist; }
  if(kind === 'content'){ if(!Array.isArray(s.contentAdviceHist)) s.contentAdviceHist = []; return s.contentAdviceHist; }
  return [];
}
// 追加一条快照，逆序裁剪到 30 条上限并持久化
function addAdvHist(kind, entry){
  const a = histState(kind);
  a.push(entry);
  if(a.length > 30) a.splice(0, a.length - 30);   // 小体积文本，按条数截断即可
  persist();
  return a.length;
}
// 章节标题建议历史弹窗（复刻 openAiHistPanel；回填语义贴合两处：注入候选 + 回填首条到输入框）
function openAdvHistPanel(kind){
  const hist = histState(kind).slice();
  const mode = kind === 'content';
  const ov = document.createElement('div'); ov.id='advHistPanel'; ov.className='gs-overlay';
  const entHtml = (e,hi)=>{
    const ei = hist.length-1-hi;   // 倒序序号（与展示一致）
    return `<div class="ws-lib-group ws-lib-fold" style="margin-top:6px">
      <div class="ws-lib-fold-t" data-ah-fold="${ei}" role="button" tabindex="0" title="展开/收起">
        <span>${mode?'📄':'📝'} ${esc(e.desc||'')} <span class="muted" style="font-size:10px">· ${new Date(e.ts).toLocaleString('zh-CN',{hour12:false})}</span></span>
        <span class="sc-fold-ico">▸</span>
      </div>
      <div class="ws-lib-fold-body" style="display:none">
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 8px">
          <button type="button" class="btn small ghost" data-ah-apply="${ei}">↩ 回填首条建议</button>
          <button type="button" class="btn small ghost" data-ah-del="${ei}">删</button>
        </div>
        ${ (Array.isArray(e.list)&&e.list.length) ? e.list.map((c,i)=>aiAdvHistCandHtml(c,i)).join('<hr style="margin:6px 0;opacity:.2">') : '<p class="muted">无建议。</p>' }
      </div>
    </div>`;
  };
  const list = hist.slice().reverse();
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>${mode?'📄':'📝'} ${mode?'章节内容':'章节标题'} AI 建议历史（${hist.length}）</b>
        <span style="display:flex;gap:6px">
          <button class="btn small ghost" data-ah-clear>清空</button>
          <button class="gs-x" data-ah-close>✕</button>
        </span></div>
      <div class="cv-body">
        ${ list.length ? list.map(entHtml).join('') : '<p class="muted">暂无历史。用「✨ AI 优化此建议」生成后即自动保存于此，可随时回看。</p>' }
      </div>
    </div>`;
  const close = ()=>{ const p=$('#advHistPanel'); if(p) p.remove(); };
  ov.addEventListener('click', (e)=>{
    const cl = e.target.closest('[data-ah-close]'); if(cl){ close(); return; }
    const fold = e.target.closest('[data-ah-fold]');
    if(fold){ const body = fold.closest('.ws-lib-group').querySelector('.ws-lib-fold-body'); if(body){ const open = body.style.display!=='none'; body.style.display = open?'none':'block'; fold.querySelector('.sc-fold-ico').textContent = open?'▸':'▾'; } return; }
    const apply = e.target.closest('[data-ah-apply]');
    if(apply){
      const ei=+apply.dataset.ahApply; const entry=hist[ei];
      if(entry && Array.isArray(entry.list) && entry.list.length){
        if(mode){
          aiAdviceCand = entry.list.slice(0,3);
          const out = $('[data-advice-ai-out]'); if(out) out.innerHTML = aiAdviceResultHtml();
          const ta = $('#rpAdvice'); if(ta){ ta.value = (entry.list[0]&&entry.list[0].text)||''; ta.focus(); }
        }else{
          ctAdviceCand = entry.list.slice(0,3); ctAdviceFold = false; ctAdoptedIdx = -1;
          const out = $('[data-cth-ai-out]'); if(out) out.innerHTML = ctAdviceResultHtml();
          updateFoldBtn();
          const inp = $('#rtInput'); if(inp) inp.value = (entry.list[0]&&entry.list[0].text)||'';
        }
        toast('已回填该条建议');
      }
      close(); return;
    }
    const del = e.target.closest('[data-ah-del]');
    if(del){ const ei=+del.dataset.ahDel; const a=histState(kind); if(a[ei]){ a.splice(ei,1); persist(); } refreshAdvHistBadge(kind); const p=$('#advHistPanel'); if(p) p.remove(); openAdvHistPanel(kind); return; }
    const clr = e.target.closest('[data-ah-clear]');
    if(clr){ if(confirm('确认清空全部该建议历史？')){ histState(kind).length = 0; persist(); refreshAdvHistBadge(kind); close(); } return; }
    if(e.target===ov) close();
  });
  document.body.appendChild(ov);
}
// 历史条目候选的展示（{title,text}）
function aiAdvHistCandHtml(c,i){
  return `<div class="advice-ai-cand"><div class="advice-ai-head"><span class="advice-ai-idx">${'①②③'[i]||(i+1)}</span><b>${esc(c.title||('方案'+(i+1)))}</b></div><p>${esc(c.text||'')}</p></div>`;
}
// 刷新角标（kind：'ct' 在章节块内 / 'content' 在重生成面板内）
function refreshAdvHistBadge(kind){
  if(kind === 'ct'){
    const card = $('.ct-block');
    if(card){ const b = card.querySelector('[data-ctadv-hist] .ai-hist-badge'); if(b) b.textContent = histState('ct').length||''; }
  }else{
    const rp = $('#regenPanel');
    if(rp){ const b = rp.querySelector('[data-advadv-hist] .ai-hist-badge'); if(b) b.textContent = histState('content').length||''; }
  }
}
function aiRecipePrompt(userDesc){
  const lib = writeStyleLib();
  const spec = lib.map(s=> `- ${s.id}：${s.name}（${s.cat||'custom'}）`).join('\n');
  return { system:[
    '你是网文长篇小说「写作风格配方设计」专家。用户会描述一段想要的风格/题材/氛围。',
    '请为该描述设计 2~5 个【组合配方】候选，供用户挑选。每个候选必须基于【现有词库】选词。',
    '输出：仅一个 JSON 数组，无任何讲解、无 markdown 代码块前后缀。每项结构：',
    '{ "name":"配方名(简短,≤12字)", "desc":"一句话点明适用题材/氛围", "tags":["词条id",...2~5个],',
    '  "why":"为何这样选(这些词条如何配合达成质感,1-2句)", "scenario":"适用场景(题材/章节阶段/文风匹配度,1-2句)",',
    '  "gap": null } 或 "gap":[ {"name":"…","cat":"语言质感|情绪与张力|节奏与网感|叙事技法|台词设计","id":"…",',
    '  "note":"一句话指令/总纲：这个词条的核心风格定位（1句）","tips":["写法要求1","写法要求2"],',
    '  "avoid":["要避免的写法1"],"check":["自查点1"],"demo":"示范写法示例句（必填）","seal":0,"warning":"…(可选)","reasons":"为何补这个词条"} ]',
    '规则(严格)：',
    '1.tags 只能使用【现有词库】中的 id，2~5 个，禁止自造；如现有词库不足以覆盖描述，缺口部分放到 gap 里，禁止把未入词库的词条塞进 tags。',
    '2.gap 为 null 表示现有词库足够；gap 非空时每个新词条必须五维齐全（note/tips/avoid/check/demo），缺一则该条作废。',
    '3.不同候选用词尽量不同、风格拉开差异便于挑选。',
    '4.仅 JSON 输出。',
    '5.why / scenario / reasons 里引用词条时，必须使用词条的中文【name】，禁止出现英文 id；英文 id 只允许出现在 tags 字段。',
    '【现有词库 id/name/cat】：', spec
  ].join('\n'), user: userDesc };
}
// v1.0.62 上传逐章梗概 TXT → 判断该小说文风 → 给可模仿的写作配方（全文直发，不分段）
function aiPromptFromOutline(text){
  const lib = writeStyleLib();
  const spec = lib.map(s=> `- ${s.id}：${s.name}（${s.cat||'custom'}）`).join('\n');
  return { system:[
    '你是网文长篇小说「写作风格配方设计」专家。用户上传是一部小说的【逐章梗概】TXT（非正文）。',
    '请你【完整通读】这份梗概，判断该小说的文风、叙事节奏、对白与情绪质感，再为"想模仿这部小说写作"的用户设计 2~5 个【组合配方】候选。',
    '候选必须基于【现有词库】选词；词库不足以覆盖某些特征时，把缺口写到 gap。',
    '输出：仅一个 JSON 数组，无讲解、无 markdown 代码块前后缀。每项结构：',
    '{ "name":"配方名(简短,≤12字)", "desc":"一句话点明这套风格适用的题材/氛围", "tags":["词条id",...2~5个],',
    '  "why":"为何这样选(这些词条如何配合还原该小说质感,1-2句)", "scenario":"适用场景与模仿要点",',
    '  "gap": null } 或 "gap":[ {"name","cat","id","note(指令总纲)","tips","avoid","check","demo(必填示例)","seal":0,"warning","reasons"} ]',
    '规则：1.tags 只能用现有词库 id，2~5 个，禁止自造；缺口放 gap、禁止塞进 tags。',
    '2.gap 词条须五维齐全（note/tips/avoid/check/demo），缺一作废。',
    '3.不同候选用词尽量不同、风格拉开差异便于挑选。',
    '4.仅 JSON 输出。',
    '5.why / scenario / reasons 里引用词条时，必须使用词条的中文【name】，禁止出现英文 id；英文 id 只允许出现在 tags 字段。',
    '【现有词库 id/name/cat】：', spec
  ].join('\n'), user: text };
}
// v1.0.62 上传来源标记：'desc'＝描述入口 ／ 'outline'＝逐章梗概入口（仅用于结果区提示，不持久化）
let aiSource = 'desc';
// AI 配方助手卡片（仅长篇小说模式在渲染层调用）
function aiRecipeCard(){
  const lib = writeStyleLib();
  const collapsed = getCfg().aiRecipeCollapsed !== false; // v10.31 默认折叠，用户可随时展开；状态持久化
  return `<div class="card ai-recipe-card${collapsed?' collapsed':''}">
    <div class="ai-recipe-head" data-ai-recipe-fold role="button" tabindex="0" title="展开/收起">
      <h3 style="margin:0">🧪 AI 配方助手 <span class="sc-fold-ico">${collapsed?'▸':'▾'}</span></h3>
      <span class="muted" style="font-size:11px;font-weight:400">为「写作风格」而生 · 描述一段风格，或上传逐章梗概 AI 提炼配方</span>
    </div>
    <div class="ai-recipe-body">
      <div class="ai-desc-wrap">
        <span class="ai-upload-name" data-ai-upload-name></span>
        <textarea id="aiReDesc" rows="3" maxlength="300" placeholder="用一段话描述你想要的风格/题材/氛围。例如：轻松治愈的都市言情，带点温馨笑料，配角俏皮，节奏明快。" style="width:100%;box-sizing:border-box"></textarea>
      </div>
      <div class="ai-recipe-tool">
        <button type="button" class="btn primary" data-ai-recipe-gen>✨ 生成配方</button>
        <button type="button" class="btn small ghost" data-ai-recipe-clear>清空</button>
        <button type="button" class="ai-upload-btn ai-hist-btn" data-ai-recipe-hist title="AI 配方历史：回看已生成过的候选配方">📖<span class="ai-hist-badge">${snapAiHist().length||''}</span></button>
        <button type="button" class="ai-upload-btn" data-ai-recipe-file title="上传逐章梗概TXT">＋</button>
      </div>
      <input type="file" id="aiReFile" accept=".txt,text/plain" hidden />
      <div data-ai-recipe-out>${ aiRecipeResultHtml(lib) }</div>
    </div>
  </div>`;
}
function aiRecipeResultHtml(lib){
  if(aiRp && aiRp.err) return `<p class="muted" style="color:var(--danger);margin:8px 0 0">⚠️ ${esc(aiRp.err)}</p>`;
  if(!aiRp || !Array.isArray(aiRp.list) || !aiRp.list.length){
    return `<p class="muted" style="margin:8px 0 0">${ aiSource==='outline' ? '📤 已读取逐章梗概，可点「✨」从描述入口，或重新上传后 AI 再次通读。' : '👆 输入描述后点「✨ 生成配方」，AI 将给出 2~5 个组合配方；含词条缺口时会附建议新词条，可自行决定是否加入词库。' }</p>`;
  }
  // libIds 更新（可能已入库缺口词条）
  const libIds = (lib||writeStyleLib()).map(s=>s.id);
  return aiRp.list.map((c,ci)=>`
    <div class="ai-recipe-cand${ ci===aiRp.hi ? ' hi' : '' }">
      <div class="ai-recipe-cand-head">
        <b>${esc(c.name||('候选'+ (ci+1)))}</b>
        <span class="muted" style="font-size:11px">${esc(c.desc||'')}</span>
      </div>
      <div class="ai-recipe-tags">${ (c.tags||[]).map(id=>{ const s=writeStyleById(id); return `<span class="ai-recipe-tg">${esc(s?s.name:id)}</span>`; }).join('') }</div>
      <div class="ai-recipe-sec"><span class="ar-lab">为何这样选</span>${esc(wiseWhyText(c.why||''))}</div>
      <div class="ai-recipe-sec"><span class="ar-lab">适用场景</span>${esc(wiseWhyText(c.scenario||''))}</div>
      <div class="ai-recipe-gap">
        ${ gapHtml(c, ci) }
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn small primary" data-ai-recipe-pick="${ci}">✔ 选用此配方</button>
        <button type="button" class="btn small ghost" data-ai-recipe-save="${ci}" title="仅存入「我的配方」，不应用到写作风格">＋ 收藏不采用</button>
      </div>
    </div>`).join('');
}
// v10.52 gap 词条五维分列展示：优先用 AI 独立字段；老格式（note 内含写法/避免/自查）回退 parse 拆解
function gapFiveHtml(g){
  const hasStruc = Array.isArray(g.tips)||Array.isArray(g.avoid)||Array.isArray(g.check);
  const p = hasStruc
    ? { intro:g.note||'', tips:Array.isArray(g.tips)?g.tips:[], avoid:Array.isArray(g.avoid)?g.avoid:[], check:Array.isArray(g.check)?g.check:[], demo:g.demo||'' }
    : parseCustomStyleNote(g.note||'');
  const parts = [];
  if(String(p.intro||'').trim()) parts.push('<div><b>指令</b>：'+esc(p.intro)+'</div>');
  if(p.tips&&p.tips.length) parts.push('<div><b>写法</b>：'+esc(p.tips.join('；'))+'</div>');
  if(p.avoid&&p.avoid.length) parts.push('<div><b>避免</b>：'+esc(p.avoid.join('；'))+'</div>');
  if(p.check&&p.check.length) parts.push('<div><b>自查</b>：'+esc(p.check.join('；'))+'</div>');
  if(String(p.demo||'').trim()) parts.push('<div class="ar-gap-demo"><b>示例</b>：'+esc(p.demo)+'</div>');
  return parts.join('');
}
function gapHtml(c, ci){
  if(!Array.isArray(c.gap) || !c.gap.length) return `<span class="ar-ok">✓ 现有词库即可覆盖，无需新词条</span>`;
  return `<div class="ar-gaptitle">⚠️ 存在词条缺口（共 ${c.gap.length} 项，确认后立即纳入当前配方）</div>
  ${ c.gap.map((g,gi)=>`
    <div class="ai-recipe-gapitem">
      <div class="ar-gaphead"><b>${esc(g.name||'')}</b><span class="muted" style="font-size:11px">${ (AI_CAT_LABEL[g.cat]||g.cat||'custom') }</span></div>
      <div class="ar-gapwhy">${esc(g.reasons||'')}</div>
      <div class="ar-gapnote">${gapFiveHtml(g)}</div>
      ${ g.warning ? `<div class="ar-gapwarn">⚠️ ${esc(g.warning)}</div>` : '' }
      <button type="button" class="btn small ghost" data-ai-recipe-addgap="${ci}__${gi}" ${ (c.tags||[]).includes(g.id)|| libHas(g.id) ? 'disabled' : '' }>＋ 加入词库</button>
    </div>`).join('') }`;
}
function libHas(id){ return !!writeStyleById(id); }
// 生成候选配方
async function aiRecipeGen(){
  const ta = $('#aiReDesc'); if(!ta) return;
  const desc = (ta.value||'').trim();
  if(!desc){ toast('请先描述你想要的风格'); return; }
  const out = $('[data-ai-recipe-out]'); if(out) out.innerHTML = `<p class="muted" style="margin:8px 0 0">⏳ AI 正在根据你的描述设计候选配方与词条缺口……</p>`;
  const gen = $('[data-ai-recipe-gen]'); if(gen){ gen.disabled = true; gen.textContent = '生成中…'; }
  try{
    const {system, user} = aiRecipePrompt(desc);
    const raw = await callDeepSeek(system, user, {temperature:0.9, maxTokens:2500});
    const list = parseAiJsonList(raw);
    if(!list || !list.length) throw new Error('AI 未返回有效配方，请重试');
    aiRp = { list, hi: 0 };
    // v10.57 生成成功即存历史快照（书本图标可回看；outline 由 aiRecipeFromOutline 存）
    if(aiSource !== 'outline') addAiHist({ id: aiHistEntryId(), ts: Date.now(), src:'desc', desc: desc, list: JSON.parse(JSON.stringify(list)), applied:[] });
  }catch(e){
    aiRp = { list:null, err: (e&&e.message)||'生成失败' };
  }
  if(out) out.innerHTML = aiRecipeResultHtml();
  if(gen){ gen.disabled = false; gen.textContent = '✨ 生成配方'; }
}
// v1.0.62 上传逐章梗概 → 全文直发 AI 通读 → 提炼可模仿的写作配方（复用 aiRp 渲染链，不分段）
let _aiOutlineFname = ''; // v10.57 暂存上传文件名，供快照 desc 标记
async function aiRecipeFromOutline(text){
  aiSource = 'outline';
  const out = $('[data-ai-recipe-out]');
  if(out) out.innerHTML = `<p class="muted" style="margin:8px 0 0">⏳ AI 正通读逐章梗概并提炼可模仿的写作配方…</p>`;
  const gen = $('[data-ai-recipe-gen]'); if(gen){ gen.disabled = true; gen.textContent = '通读中…'; }
  try{
    const {system, user} = aiPromptFromOutline(text);
    const raw = await callDeepSeek(system, user, {temperature:0.9, maxTokens:2500});
    const list = parseAiJsonList(raw);
    if(!list || !list.length) throw new Error('AI 未返回有效配方，请重试');
    aiRp = { list, hi: 0 };
    // v10.57 生成成功即存历史快照（以梗概文件名标记来源；不存原文大文本）
    addAiHist({ id: aiHistEntryId(), ts: Date.now(), src:'outline', desc: _aiOutlineFname || '逐章梗概', list: JSON.parse(JSON.stringify(list)), applied:[] });
  }catch(e){
    aiRp = { list:null, err: (e&&e.message)||'通读失败' };
  }
  if(out) out.innerHTML = aiRecipeResultHtml();
  if(gen){ gen.disabled = false; gen.textContent = '✨ 生成配方'; }
}
// AI 返回JSON解析（防 markdown 代码块包裹）
function parseAiJsonList(raw){
  let t = String(raw||'').trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if(m) t = m[1].trim();
  try{ const a = JSON.parse(t); return Array.isArray(a)? a : null; }catch(e){
    try{ const i = t.indexOf('['), j = t.lastIndexOf(']'); if(i>=0&&j>i){ const a = JSON.parse(t.slice(i,j+1)); return Array.isArray(a)? a:null; } }catch(e2){}
    return null;
  }
}
// 选用候选配方：① 存入「我的配方」（customCombos）；②（选用时）应用到写作风格并立即持久化生效
function storeRecipeCandidate(c){
  if(!c) return null;
  const cfg = getCfg(); cfg.styleCustom = cfg.styleCustom || {};
  cfg.styleCustom.customCombos = cfg.styleCustom.customCombos || [];
  const libIds = writeStyleLib().map(s=>s.id);
  // name 冲突时追加序号
  let name = (c.name||'').trim(); if(!name) name = 'AI配方'+(cfg.styleCustom.customCombos.length+1);
  const names = cfg.styleCustom.customCombos.map(x=>x.name);
  let k = 2; while(names.includes(name)) name = (c.name||('AI配方'+(cfg.styleCustom.customCombos.length+1)))+'·'+ (k++);
  let tags = (c.tags||[]).filter(id=> libIds.includes(id));
  // 缺口词条若已入库，一并自动纳入 tags（决策2）
  (c.gap||[]).forEach(g=>{ if(g && g.id && libIds.includes(g.id) && !tags.includes(g.id)) tags.push(g.id); });
  cfg.styleCustom.customCombos.push({ id:'cu'+Date.now().toString(36)+Math.random().toString(36).slice(2,5), name, desc:(c.desc||''), why: wiseWhyText(c.why||''), tags });
  saveCfg(cfg);
  return { combo:cfg.styleCustom.customCombos[cfg.styleCustom.customCombos.length-1], name };
}
// [历史兼容] 走 aiRp 的存储封装
function aiRecipeStore(ci){
  if(!aiRp || !Array.isArray(aiRp.list)) return null;
  return storeRecipeCandidate(aiRp.list[ci]);
}
// 选用此配方 → 存储 + 立即应用（替换式写生效配置并持久化）；opts 兼容历史弹层（无需 render 主卡时传 render:false）
function applyChosenCandidate(c, opts){
  if(!c) return null;
  const stored = storeRecipeCandidate(c); if(!stored) return null;
  const libIds = writeStyleLib().map(s=>s.id);
  // v10.48 选用即应用：替换写生效配置并持久化；回退依赖「收藏当前」预设或本配方仍存于「我的配方」
  const st2 = writeStyleState();
  const d2 = wsDraftInit();                       // 从生效配置取 intensity
  d2.tags = (c.tags||[]).filter(id=> libIds.includes(id));   // 替换而非并集
  (c.gap||[]).forEach(g=>{ if(g && g.id && libIds.includes(g.id) && !d2.tags.includes(g.id)) d2.tags.push(g.id); });
  st2.tags = d2.tags.slice(); st2.intensity = d2.intensity||2;
  persist();
  wsDraft = null;                                 // 草稿与生效合一 -> 卡片显示「✔已生效」
  if(!opts || opts.render !== false) aiRp = null;
  if(!opts || opts.render !== false){ render(); refreshWsUI(); }
  toast('已应用到「写作风格」：'+stored.name);
  return stored;
}
function aiRecipePick(ci){
  if(!aiRp || !Array.isArray(aiRp.list)) return;
  applyChosenCandidate(aiRp.list[ci]);
}
// 收藏不采用：仅存入「我的配方」，不应用到写作风格
function aiRecipeSave(ci){
  if(!aiRp || !Array.isArray(aiRp.list)) return;
  const stored = aiRecipeStore(ci); if(!stored) return;
  toast('已加入「我的配方」（未应用）：'+stored.name);
}
// 确认加入缺口词条 → styleCustom.added，并立即纳入当前配方草稿（决策2）
function aiRecipeAddGap(key){
  if(!aiRp || !Array.isArray(aiRp.list)) return;
  const [ci, gi] = String(key||'').split('__').map(Number);
  const c = aiRp.list[ci]; if(!c) return;
  const g = (c.gap||[])[gi]; if(!g) return;
  if(writeStyleById(g.id)){ toast('该词条已在词库中'); return; }
  const group = ['语言质感','情绪与张力','节奏与网感','叙事技法','台词设计'].includes(g.cat) ? g.cat : 'custom';
  const cfg = getCfg(); cfg.styleCustom = cfg.styleCustom || {};
  cfg.styleCustom.added = cfg.styleCustom.added || [];
  const id = (g.id && /^[a-z][a-z0-9_]*$/i.test(g.id)) ? g.id : ('c'+Math.random().toString(36).slice(2,8));
  // id 冲突则加后缀
  let finalId = id, mx = 1; const existing = writeStyleLib().map(s=>s.id);
  while(existing.includes(finalId)) finalId = id + (mx++);
  cfg.styleCustom.added.push({ id:finalId, group, name:(g.name||'').trim(), note:(g.note||'').trim(),
    tips:Array.isArray(g.tips)?g.tips.map(x=>String(x||'').trim()).filter(Boolean):[],
    avoid:Array.isArray(g.avoid)?g.avoid.map(x=>String(x||'').trim()).filter(Boolean):[],
    check:Array.isArray(g.check)?g.check.map(x=>String(x||'').trim()).filter(Boolean):[],
    demo:(g.demo||'').trim(), seal:(g.seal===undefined?0:g.seal), warning:(g.warning||'') });
  saveCfg(cfg);
  // 立即纳入当前配方草稿 + 把该 id 补进当前候选 tag
  const d = wsDraftInit(); if(!d.tags.includes(finalId)) d.tags.push(finalId);
  if(c.tags && !c.tags.includes(finalId)) c.tags.push(finalId);
  toast('已加入词库并纳入当前配方：'+(g.name||finalId));
  const out = $('[data-ai-recipe-out]'); if(out) out.innerHTML = aiRecipeResultHtml();
}

// 运行时词库 = 内置 45 项（note 可被 cfg.styleCustom.notes 覆盖、可被 removed 删除）⊕ 用户新增
// v2.4 自定义风格 note 支持三行配方：写法:/避免:/自查:（按行解析成 tips/avoid/check）
// v10.52 扩展识别「指令/示例」前缀 + 支持「前缀：内容」同行；指令→intro(总纲)、示例→demo
function parseCustomStyleNote(note){
  const tips=[], avoid=[], check=[];
  let intro='', demo='';
  const lines = String(note||'').split(/\n/);
  let mode = null;
  lines.forEach(l=>{
    const t = String(l||'').trim();
    if(!t) return;
    let m;
    if((m=/^指令[:：]\s*(.*)$/.exec(t))){ mode='intro'; if(m[1]) intro=m[1]; return; }
    if((m=/^写法[:：]\s*(.*)$/.exec(t))){ mode='tips'; if(m[1]) tips.push(m[1].replace(/^[①②③④⑤]?[.、）)]?\s*/,'')); return; }
    if((m=/^避免[:：]\s*(.*)$/.exec(t))){ mode='avoid'; if(m[1]) avoid.push(m[1].replace(/^[✗×\-\s]+/,'')); return; }
    if((m=/^自查[:：]\s*(.*)$/.exec(t))){ mode='check'; if(m[1]) check.push(m[1].replace(/^[□✅◇\-\s]+/,'')); return; }
    if((m=/^示例[:：]\s*(.*)$/.exec(t))){ mode='demo'; if(m[1]) demo=m[1]; return; }
    // 无前缀：按当前 mode 收集（兼容前缀独立成行的旧格式）
    if(mode==='intro'){ if(!intro) intro=t; }
    else if(mode==='tips') tips.push(t.replace(/^[①②③④⑤]?[.、）)]?\s*/,''));
    else if(mode==='avoid') avoid.push(t.replace(/^[✗×\-\s]+/,''));
    else if(mode==='check') check.push(t.replace(/^[□✅◇\-\s]+/,''));
    else if(mode==='demo'){ if(!demo) demo=t; }
  });
  return { intro, tips, avoid, check, demo };
}
function writeStyleLib(){
  const c = getCfg().styleCustom || {};
  const notes = (c && c.notes) || {};
  const removed = Array.isArray(c && c.removed) ? c.removed : [];
  const added = Array.isArray(c && c.added) ? c.added : [];
  // v10.19 系统内置词条保留原始来源 cat（语气基调/文风质感/语言元素），供章节风格组内分块展示
  const base = WRITE_STYLES.filter(s=> !removed.includes(s.id)).map(s=>{
    const cat = s.cat || (s.group==='tone' ? 'tone' : (s.group==='texture' ? 'texture' : 'element'));
    return { ...s, group:'element', cat, note: notes[s.id] || s.note };
  });
  const customs = added.map(a=>{
    // v10.52 优先用入库时持久化的五维；老数据（无独立 tips/avoid/check）回退 parseCustomStyleNote 从 note 拆
    const hasStruc = (Array.isArray(a.tips)&&a.tips.length) || (Array.isArray(a.avoid)&&a.avoid.length) || (Array.isArray(a.check)&&a.check.length);
    const parsed = hasStruc ? { tips:a.tips||[], avoid:a.avoid||[], check:a.check||[], demo:a.demo||'' } : parseCustomStyleNote(a.note||'');
    // v10.20 自定义项归入用户选择的五大类分类；老数据（tone/texture/element）映射到自定义兜底
    const cat = ['语言质感','情绪与张力','节奏与网感','叙事技法','台词设计'].includes(a.group) ? a.group : 'custom';
    return { id:a.id, group:'element', name:a.name||'未命名', note:a.note||'', custom:true, cat, tips:parsed.tips||[], avoid:parsed.avoid||[], check:parsed.check||[], demo:parsed.demo||a.demo||'', seal:(a.seal===undefined?0:a.seal), warning:a.warning||'' };
  });
  // v10.18 标题风格（tone 组）内置项迁入顶部「写作风格 → ① 标题风格」；梗概风格（texture 组）内置五段骨架归入「② 梗概风格」；均受 removed/notes 管理
  const toneTitles = TONE_TITLE_STYLES.filter(s=> !removed.includes(s.id)).map(s=>({ ...s, note: notes[s.id] || s.note }));
  const texturePlans = TEXTURE_PLAN_STYLES.filter(s=> !removed.includes(s.id)).map(s=>({ ...s, note: notes[s.id] || s.note }));
  return base.concat(customs).concat(toneTitles).concat(texturePlans);
}
function writeStyleById(id){
  return writeStyleLib().find(s=> s.id === id) || null;
}
// v10.57 方案2兜底：把自由文本（why/scenario 等）里出现的英文词条 id 替换为中文 name。
// 仅替换词库内真实存在的 id；查不到（拼错/幻觉）的原样保留，不误伤；中文不受影响。
let _idNameMap = null;
function _idName(){
  if(_idNameMap) return _idNameMap;
  const m = new Map();
  writeStyleLib().forEach(s=>{ if(s.id) m.set(s.id, s.name); });
  return (_idNameMap = m);
}
function wiseWhyText(txt){
  if(!txt) return txt;
  const N = _idName();
  return String(txt).replace(/\b[A-Za-z_]\w*\b/g, w=> (N.has(w) ? N.get(w) : w));
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
  const lines = ['【' + headTitle + '（用户指定 · 最高优先指令）】', intro];
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
  return wsStyleNoteBlock(items, st, '写作风格', '本指令为本章写作的第三优先要求（低于全书要求与人工干预）：当它与节奏、篇幅、原创性等任何其他要求冲突时，以本指令为准；唯一不可逾越的红线：不得破坏人名/地名/专名一致性、不得违反基础剧情逻辑与人物设定。');
}
// 标题风格（tone 组）注入：用于「重生成全部标题」
function writeStyleTitleBlock(){
  const st = curWriteStyle(null);
  return wsStyleNoteBlock(wsGroupStyleTags(null, 'tone'), st, '标题风格', '生成本书书名与各章标题时，必须整体体现以下标题风格（仅约束标题命名，不约束正文）；标题须与章节内容相符且保持前后连贯。', '示例');
}
// 梗概风格（texture 组）注入：用于「逐章梗概（创作方向）」
function writeStylePlanBlock(){
  const st = curWriteStyle(null);
  return wsStyleNoteBlock(wsGroupStyleTags(null, 'texture'), st, '梗概风格', '本指令为本章梗概/创作方向生成时的第三优先要求（低于全书要求；全书要求未设时不冲突）：当它与节奏、篇幅等其它要求冲突时以本指令为准。', '示例');
}

// 当前所选
function selStructure(){ return state.recipeSet && STRUCTURES.find(s=> s.id === state.recipeSet.structure) || null; }
function selRhythm(){ return state.recipeSet && RHYTHMS.find(r=> r.id === state.recipeSet.rhythm) || null; }
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
{"title":"小说名","logline":"小说简介（含核心冲突与深层命题）","chapters":[{"title":"第1章标题"}]}
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
// 写正文时注入【本章梗概】。
const CHAPTER_PLAN_SYS = `你是一名全书级叙事架构师与逐章梗概生成专家。
【核心任务】负责完成全局埋点回收与节奏张弛的系统化设计，确保全书结构完整、情绪饱满。基于用户提供的小说书名、小说简介、故事大纲、全部章节标题、万物词典，为每章标注本章节奏类型及原因，同时在全书层面完成埋点与回收规划。
【硬性约束】
0. 若用户提示中出现【写作风格】块，必须作为首位硬约束执行。
1. 输出与章节数完全一致的 JSON 数组，顺序对应每一章：{"chapterPlans":["第1章：本章梗概…","第2章：本章梗概…"]}
2. 全局埋点与回收规划：先建立全书埋点清单，明确埋点章节、回收章节、关联逻辑。只在出现埋点或回收的章节梗概内写出该埋点或回收的详细剧情，且必须写清具体情境、对话或线索。
3. 全局节奏规划：为每章指定不同节奏，如急促/紧凑/舒缓/沉淀/渐进等。

4. 每章梗概强制按以下三段格式输出，不得添加任何额外文字：

【节奏】：（描述本章节奏：从急促/紧凑/舒缓/沉淀/渐进等词中选择；并在章节梗概中一句话非常简单写出本章节奏表现及原因。)

【埋点】：（填写简单概括的叙述伏笔情境+线索，无则填"无"）

【回收】：（填写回收的埋点；若有回收，按顺序在同一段内写出【原埋点】【回收方式】；【原埋点】逐字粘贴被回收章节的原文，禁止缩写与转述；【回收方式】写明本章如何呼应或收束该伏笔。无则填"无"。）

5. 不要 markdown 代码块。

6. 每一章的梗概字数控制在80—160字之间。

7. 全局规则：全书所有埋点必须回收，不得悬空，完成后自查闭环。节奏变速自检（内部执行，不写入正文）：输出前检查本章快慢、紧张度与前后章是否形成张弛交替。全书每五章内至少安排一章舒缓或沉淀作为弛段。若违反，调整本章节奏后重新生成。`;


// v10.12 原创性要求（防雷同）· 大纲侧：防套路结构 + 高频人名 + 流水线标题。
// 独立注入块而非改写各结构常量：一处定义，经组装函数自动覆盖全部结构范式与默认路径。
const ORIGINALITY_OUTLINE_SYS = `【原创性要求（防雷同）】本作追求独特设定，避免与常见网络作品雷同：
1. 拒绝套路模板：不开局退婚/系统提示音/赘婿打脸/主角降智等烂大街桥段；情节逻辑优先从本作独有设定推导，而非套用通用模板。
2. 人名规避：人物姓名避免网文高频字组合（如林晚/苏晚/顾沉/云深/顾言之类）；可采用职业特征/意象组合造名，姓名风格与世界观一致。
3. 章节标题同理：标题立意避免"xx之怒/惊变/震惊"式流水线命名。`;

// v10.12 原创性要求（防雷同）· 章节侧：防桥段套路 + 高频句式 + 无关套路元素。
const ORIGINALITY_CHAPTER_SYS = `【原创性要求（防雷同）】本章内容追求自然独特：
1. 桥段防套路：避免无理由误会、工具人反派强行送头、为冲突而冲突的降智桥段；冲突应来自前文设定与人物动机的自然推进。
2. 句式防高频：避免网文高频表达（"嘴角勾起一抹冷笑""眼神一凛"等），对话与描写尽量具体、贴合本作人物。
3. 不硬塞元素：不引入与既有设定无关的常见套路元素（金手指/系统/穿越梗等），除非本作设定明确包含。`;

// v10.15 重生成全部章节标题：保留大纲骨架，只重出标题；服从既有设定 + 用户建议 + 防套路第一优先。
const REGEN_TITLES_SYS = `你是一位深谙标题艺术的章节标题策划师。
【核心任务】根据给定的小说大纲（标题、小说简介、长篇结构设计、设定词典），在【不改变章节数量与结构安排】的前提下，为每一章重生成一个更有表现力的标题。
【硬性约束】
1. 章节数量与顺序必须与现有章节完全一致（一章不增、一章不减）；
2. 标题必须服从现有设定：与小说简介、结构设计、设定词典保持一致，不引入新人物/地名/专名；
3. 标题有表现力、立意新颖但不剧透：体现本章走向/情绪，不泄露后续反转与结局，不重复前文已用梗；
4. **防套路第一优先**：避免"xx之怒/惊变/震惊"式流水线命名与网文高频句式，也不刻意追求"钩子感"（钩子感要求已废除，防套路优先）；立意从本作独特设定推导；
5. 若用户提示中出现【写作风格约束（首位要求，须优先遵循）】块，必须作为首位硬约束执行——每条标题的措辞基调都须贴合该风格（如"严肃"则标题庄重不轻佻、"温情细腻"则带温度、"冷峻克制"则惜字如金），不得忽略或降级；
6. 若用户提供了【重生成要求】，须以要求为最高优先（高于全书要求与写作风格）；
7. 优先级契约：若【全书要求】与【写作风格约束】同时出现，以全书要求为准、写作风格其次；但二者均不得违反设定词典一致性（人名/地名/专名）；
8. 只输出 JSON 数组（不要解释、不要 markdown 代码块）：{"titles":["第1章标题","第2章标题",...]}
【自由发挥区】标题的立意、措辞、角度由你把握，让每章标题读起来各有记忆点、整批标题风格错落。`;

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
  // v10.58-narrow：A 窄开关"全部章节安排"是否开启（默认开）。关 → 不生成/不渲染 structure.chapterPlan 分组；主线四格照常。
  function chapterPlanOn(){ return state.chapterPlanOn !== false; }

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
  // v10.58-narrow：A 窄开关关闭时跳过该"章节安排/分组"块（主线四格已在上方独立注入，不受影响）。
  if(st && !stHasStageMap(st) && chapterPlanOn()) parts.push(STRUCTURE_PLAN_SYS);
  // ⑤ 基础大纲契约 OUTLINE_GEN_SYS（title/logline/chapters 的 JSON 契约）：置于词典之前。
  //    互斥原则：选中结构时该契约已由 st.outlineSys 独家承担（大纲契约+结构一体），故不重复推，避免两套 schema 同时注入；
  //    仅未选结构时推，作为稳定产出大纲骨架的兜底。
  if(!st) parts.push(OUTLINE_GEN_SYS);
  // ⑤-2 未选结构时：要求 AI 自由分组输出 chapterPlan（按主题/起承转合），作为"全部章节写作安排"的呈现。
  // v10.58-narrow：A 窄开关关闭时不要求该"章节安排/分组"（主线四格由 ④ STRUCTURE_MAIN_SYS 承载，不受影响）。
  if(!st && chapterPlanOn()) parts.push(CHAPTER_PLAN_FREE_SYS);
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
  // v10.58-narrow：A 窄开关关闭时不下发"章节安排/分组"清单，仅保留主线四格
  if(chapterPlanOn()){
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
  const txt = await callDeepSeek(GLOSSARY_EXTRACT_SYS, user, {maxTokens: 2000, temperature: resolveActiveSpec().qcTemp});   // v10.8 词库提取温度
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

/* =========================================================
 * v2.0 写作风格选择器：主卡片 + 预设 + 收藏 + 词库管理
 * ========================================================= */
const WRITE_PRESETS = [
  { id:'clear',          name:'🧹 默认（无风格）', tags:[], intensity:2 },
  { id:'preset-humor',   name:'😆 网感轻喜',  tags:['roast','webman','fast'], intensity:2 },
  { id:'preset-art',     name:'🌸 文艺唯美',  tags:['wenyi','poetic','minimal'], intensity:2 },
  { id:'preset-classic', name:'🏮 古典文学',  tags:['jinyong','ornate','storyteller'], intensity:3 },
  { id:'preset-mystery', name:'🕵️ 悬疑压抑',  tags:['suspense2','jifeng','multipov'], intensity:2 },
  { id:'preset-passion', name:'🔥 热血燃向',  tags:['fast','sliceoflife'], intensity:3 }
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
  const selName = (draft.tags||[]).map(id=>{ const s=writeStyleById(id); return s?s.name:id; }).join(' + ') || '无';
  const sum = $('.ws-sum');
  if(sum){ sum.textContent = (dirty?'⚠️ 待应用':'✔ 已生效')+' · '+(draft.tags||[]).length+' 项 · '+selName; sum.classList.toggle('dirty', dirty); }
  $$('[data-ws-tag]').forEach(b=> b.classList.toggle('on', (draft.tags||[]).includes(b.dataset.wsTag)));
  // v10.22 勾选/应用后自动展开含已选词条的分类（保证「选了就看得见」；不影响用户对手动折叠的空类偏好）
  $$('.ws-subcat').forEach(sub=>{
    if(sub.classList.contains('open')) return;
    if(sub.querySelector('.ws-opt.on')){
      sub.classList.add('open');
      const ico = sub.querySelector('.ws-subcat-t .sc-fold-ico'); if(ico) ico.textContent='▾';
    }
  });
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
  // v10.19 直接以五大类文风（cat）排列，不再分「标题/梗概/章节」三组
  const CAT_LABEL = { '语言质感':'① 语言质感', '情绪与张力':'② 情绪与张力', '节奏与网感':'③ 节奏与网感', '叙事技法':'④ 叙事技法', '台词设计':'⑤ 台词设计', custom:'⭐ 我的自定义' };
  const CAT_ORDER = ['语言质感','情绪与张力','节奏与网感','叙事技法','台词设计','custom'];
  const items = lib.filter(s=>s.group==='element');
  const mkOpt = s=>`<div class="ws-opt ${(sel.tags||[]).includes(s.id)?'on':''}" data-${dataPrefix}-tag="${s.id}">
    <div class="ws-opt-name">${esc(s.name)}</div>
    <div class="ws-opt-note">${esc(s.note)}</div>
  </div>`;
  const plus = opts.plus ? `<button type="button" class="ws-chip ws-chip-plus" data-${dataPrefix}-add="element" title="点击新建文风词条">＋</button>` : '';
  // v10.22 五大类分类折叠（仅主写作卡片 dataPrefix==='ws' 启用）：默认只开含已选词条的类，其余收成一行标题；
  // 用户手动切换后按 state.chapterStyle.catOpen 持久化；重生成/对比面板 useFold=false 保持全展开，不受影响。
  const useFold = dataPrefix === 'ws';
  const catOpen = (useFold && writeStyleState().catOpen) || {};
  const blocks = CAT_ORDER.map(cat=>{
    const its = items.filter(s=>(s.cat||'element')===cat);
    if(!its.length) return '';
    const hasSel = (sel.tags||[]).some(id=> its.some(s=>s.id===id));
    const isOpen = useFold ? ((catOpen[cat] !== undefined) ? catOpen[cat] : hasSel) : true;
    const fold = useFold ? `<span class="sc-fold-ico">${isOpen?'▾':'▸'}</span>` : '';
    return `<div class="ws-subcat${isOpen?' open':''}"${useFold?` data-ws-catfold="${cat}"`:''}>
      <div class="ws-subcat-t"${useFold?' role="button" tabindex="0" title="展开/收起"':''}>${CAT_LABEL[cat]||cat}（${its.length}）${fold}</div>
      <div class="ws-subcat-fold"><div class="ws-opt-list">${its.map(mkOpt).join('')}</div></div>
    </div>`;
  }).filter(Boolean).join('');
  // v2.4 组合配方栏：一键配齐（点击替换当前选择），仅主写作卡片展示（dataPrefix==='ws'）；重生成章节覆盖/对比面板不渲染，避免出现无法绑定的死按钮
  // v2.5 支持删除内置组合（写入 cfg.styleCustom.comboRemoved），卡片右上角 ✕ 删除；被删后显示「恢复已删组合」
  const comboList = dataPrefix==='ws' ? availableCombos() : [];
  const comboRemovedN = (getCfg().styleCustom||{}).comboRemoved && getCfg().styleCustom.comboRemoved.length ? getCfg().styleCustom.comboRemoved.length : 0;
  const customCombos = dataPrefix==='ws' ? ((getCfg().styleCustom||{}).customCombos||[]) : [];
  const comboOpen = (dataPrefix==='ws' && getCfg().styleCustom && getCfg().styleCustom.comboOpen) || {}; // v10.31 内置/我的配方独立折叠
  // 单个组合卡片模板（内置/自定义通用）
  const mkCombo = c=> `<div class="ws-opt ws-combo-btn" data-ws-combo="${c.id}"><span class="ws-combo-del" data-ws-combo-del="${c.id}" title="删除此组合">✕</span><div class="ws-opt-name">${esc(c.name)}</div><div class="ws-opt-note">${esc(c.desc||'')}</div></div>`;
  const comboBar = dataPrefix==='ws'
    ? `<div class="ws-combo${comboOpen.builtin===false?'':' open'}" data-ws-combofold="builtin">
       <div class="ws-subcat-t" role="button" tabindex="0" title="展开/收起">
         <span class="ws-combo-title"><span class="sc-fold-ico">${comboOpen.builtin===false?'▸':'▾'}</span> 🎬 组合配方 <span class="muted" style="font-size:10px;font-weight:400">点击即替换当前选择，可再叠加细项</span></span>
         ${comboRemovedN?`<button type="button" class="ws-combo-restore" data-ws-combo-restore>恢复已删组合(${comboRemovedN})</button>`:''}
       </div>
       <div class="ws-subcat-fold"><div class="ws-opt-list">${comboList.filter(c=>!c.custom).map(mkCombo).join('')}</div></div>
     </div>
     <div class="ws-combo ws-combo-mine${comboOpen.custom===false?'':' open'}" data-ws-combofold="custom">
       <div class="ws-subcat-t" role="button" tabindex="0" title="展开/收起">
         <span class="ws-combo-title"><span class="sc-fold-ico">${comboOpen.custom===false?'▸':'▾'}</span> 🏷 我的配方</span>
         <button type="button" class="ws-combo-add" data-ws-combo-add title="把当前草稿保存为自定义组合配方">＋</button>
       </div>
       <div class="ws-subcat-fold"><div class="ws-opt-list">${customCombos.map(mkCombo).join('')}</div></div>
     </div>`
    : '';
  // v10.54 加号已移入主卡片 .ws-tools 行最左；此处仅在有 plus 或需要提示时渲染底部行，避免主卡片出现孤立「可多选」
  const chipsTail = (opts.plus || opts.showTip !== false)
    ? `<div class="ws-chips">${opts.showTip !== false ? '<span class="ws-group-tip">可多选</span>' : ''}${plus}</div>` : '';
  return `${comboBar}${blocks}${chipsTail}`;
}
function writeStyleIntHtml(){} // v2.6 浓度已整体移除，保留空占位避免外部引用误伤
// 风格 chip 切换公共逻辑：五大类词条可多选、可清空
function toggleWriteTag(sel, id){
  const s = writeStyleById(id); if(!s) return;
  if(sel.tags.includes(id)){
    sel.tags = sel.tags.filter(x=>x!==id);
  } else {
    if(!sel.tags.includes(id)) sel.tags.push(id);
  }
}
// v10.53 已去除「选择预设」功能，writePresetOptions 随之删除；WRITE_PRESETS 仍被「收藏当前」解析引用
// 主卡片
function writeStyleCard(){
  const st = writeStyleState();
  const draft = wsDraft || st;
  const dirty = !!wsDraft && wsDraftDirty(wsDraft, st);
  const selName = (draft.tags||[]).map(id=>{ const s=writeStyleById(id); return s?s.name:id; }).join(' + ') || '无';
  const sumTxt = (dirty?'⚠️ 待应用':'✔ 已生效')+' · '+(draft.tags||[]).length+' 项 · '+selName;
  return `<div class="card ws-card${st.collapsed?' ws-collapsed':''}" data-cs="${wsColorSchemeId()}">
    <div class="ws-head" data-ws-fold role="button" tabindex="0" title="展开/收起">
      <h3 style="margin:0">✍️ 写作风格</h3>
      <span class="ws-sum${dirty?' dirty':''}">${sumTxt}</span>
      <button type="button" class="btn ghost ws-manage-btn" data-ws-lib title="编辑风格词库与我的收藏">⚙️ 管理</button>
      <span class="sc-fold-ico">${st.collapsed?'▸':'▾'}</span>
    </div>
    <div class="ws-body"${st.collapsed?' hidden':''}>
      <div class="ws-fold-tools">
        <button type="button" class="btn small ghost" data-ws-fold-all title="展开全部词条类别">⤵ 全部展开</button>
        <button type="button" class="btn small ghost" data-ws-fold-none title="收起全部词条类别">⤴ 全部收起</button>
      </div>
      ${writeStyleChipsHtml(draft, 'ws', { plus:false, cardFold:true, showTip:false })}
      <div class="ws-tools">
        <button type="button" class="ws-chip ws-chip-plus" data-ws-add="element" title="点击新建文风词条">＋</button>
        <button type="button" class="btn small primary ws-apply${dirty?'':' disabled'}" data-ws-apply ${dirty?'':'disabled'} title="把当前草稿设为生效配置（从此生成用这套风格）">✔ 应用并保存</button>
        <button type="button" class="btn small ghost" data-ws-save title="把当前草稿收藏为预设（跨作品可用）">💾 收藏当前</button>
        <button type="button" class="btn small ghost" data-ws-clear>✕ 清空</button>
      </div>
      <p class="ws-dirty-hint" style="display:${dirty?'':'none'}">⚠️ 当前为草稿（${(draft.tags||[]).length} 项未生效），点「✔ 应用并保存」后开始生效；生成章节读的是已生效配置。</p>
      <p class="muted" style="margin:6px 0 0;font-size:11px">按五大类文风多选，可同取多个词条叠加效果（如「文艺/范儿」＋「金句」）；浓度默认「中」，生成章节正文时生效。选完点「✔ 应用并保存」才生效。</p>
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
  // v2.4 组合配方按钮：点击即以「替换」方式覆盖草稿标签（清空当前 + 填入组合），再点「✔ 应用并保存」生效
  // v10.28 兼容自定义组合（availableCombos 返回内置+我的配方）
  $$('[data-ws-combo]').forEach(b=> b.onclick = ()=>{
    const combo = availableCombos().find(c=> c.id === b.dataset.wsCombo); if(!combo) return;
    const d = wsDraftInit();
    const libIds = writeStyleLib().map(s=>s.id);
    d.tags = (combo.tags||[]).filter(id=> libIds.includes(id));
    refreshWsUI();
    toast(`已套用组合「${combo.name}」：${(d.tags.map(id=>{const s=writeStyleById(id);return s?s.name:id}).join(' + '))||'（部分词条已删，未套用）'}，点「✔ 应用并保存」生效`);
  });
  // v2.5 组合删除：内置写入 styleCustom.comboRemoved / 自定义直接移除 customCombos → 完整 render 重建卡片
  $$('[data-ws-combo-del]').forEach(b=> b.onclick = (e)=>{
    e.stopPropagation();
    const id = b.dataset.wsComboDel; if(!id) return;
    const cfg = getCfg(); cfg.styleCustom = cfg.styleCustom || {};
    const isBuiltin = WRITE_COMBOS.some(c=> c.id === id);
    if(isBuiltin){
      const combo = WRITE_COMBOS.find(c=> c.id === id);
      if(!combo) return;
      if(!window.confirm(`删除组合「${combo.name}」后不再显示，可通过「恢复已删组合」还原。确定删除？`)) return;
      cfg.styleCustom.comboRemoved = cfg.styleCustom.comboRemoved || [];
      if(!cfg.styleCustom.comboRemoved.includes(id)) cfg.styleCustom.comboRemoved.push(id);
      saveCfg(cfg); render(); toast(`已删除组合「${combo.name}」`);
    } else {
      const combo = (cfg.styleCustom.customCombos||[]).find(c=> c.id === id);
      if(window.confirm(`删除自定义组合「${combo?combo.name:id}」？删后不可撤销。确定删除？`)){
        cfg.styleCustom.customCombos = (cfg.styleCustom.customCombos||[]).filter(x=> x.id !== id);
        saveCfg(cfg); render(); toast('已删除自定义组合');
      }
    }
  });
  // v10.28 「我的配方」加号：把当前草稿（未编辑时取生效配置）保存为自定义组合配方
  const cadd = $('[data-ws-combo-add]');
  if(cadd) cadd.onclick = ()=>{
    const cur = wsDraft || writeStyleState();
    const tags = (cur.tags||[]).slice();
    if(!tags.length){ toast('当前无风格，暂无可保存的组合配方'); return; }
    const cfg = getCfg(); cfg.styleCustom = cfg.styleCustom || {};
    cfg.styleCustom.customCombos = cfg.styleCustom.customCombos || [];
    const name = prompt('给这个组合配方起个名字：', '我的配方' + (cfg.styleCustom.customCombos.length + 1));
    if(!name || !name.trim()) return;
    const desc = tags.map(id=>{ const s=writeStyleById(id); return s? s.name : id; }).join(' + ');
    cfg.styleCustom.customCombos.push({ id:'cu'+Date.now().toString(36), name:name.trim(), desc, tags });
    saveCfg(cfg); render();
    toast('已保存为自定义组合「' + name.trim() + '」，点它即可一键套用');
  };
  const cre = $('[data-ws-combo-restore]');
  if(cre) cre.onclick = ()=>{
    if(!window.confirm('恢复全部被删除的组合配方？')) return;
    const cfg = getCfg(); cfg.styleCustom = cfg.styleCustom || {};
    cfg.styleCustom.comboRemoved = [];
    saveCfg(cfg); render(); toast('已恢复全部默认组合');
  };
  const sel = $('#wsPreset');
  // v10.53 已去除「选择预设」功能，绑定代码保留空守卫避免历史调用误伤
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
  // v10.22 五大类分类折叠（主卡，事件委托处理动态渲染）：点类标题展开/收起，偏好持久化到 state.chapterStyle.catOpen
  // 兼容重生成面板（.ws-subcat-t 无 role，不响应）；render 重建后 .ws-card 为新节点，dataset 为空会重新绑定一次
  const wsCard = $('.ws-card');
  // v10.51 一键全部展开/收起（仅作用于词条五大类 data-ws-catfold；组合配方 data-ws-combofold 不动）
  const fa = wsCard && wsCard.querySelector('[data-ws-fold-all]');
  if(fa) fa.onclick = ()=>{ const st=writeStyleState(); st.catOpen=st.catOpen||{};
    Object.keys(st.catOpen).forEach(k=> st.catOpen[k]=true);
    wsCard.querySelectorAll('[data-ws-catfold]').forEach(sub=>{ sub.classList.add('open');
      const ico=sub.querySelector('.sc-fold-ico'); if(ico) ico.textContent='▾'; });
    persist(); };
  const fn = wsCard && wsCard.querySelector('[data-ws-fold-none]');
  if(fn) fn.onclick = ()=>{ const st=writeStyleState(); st.catOpen=st.catOpen||{};
    Object.keys(st.catOpen).forEach(k=> st.catOpen[k]=false);
    wsCard.querySelectorAll('[data-ws-catfold]').forEach(sub=>{ sub.classList.remove('open');
      const ico=sub.querySelector('.sc-fold-ico'); if(ico) ico.textContent='▸'; });
    persist(); };
  if(wsCard && !wsCard.dataset.catfoldBound){
    wsCard.dataset.catfoldBound = '1';
    wsCard.addEventListener('click', e=>{
      const t = e.target.closest('.ws-subcat-t');
      if(!t || !t.hasAttribute('role')) return;
      // 组合板块的加号/恢复按钮不触发布内折叠
      if(e.target.closest('.ws-combo-add, .ws-combo-restore')) return;
      const sub = t.closest('.ws-subcat, .ws-combo');
      if(!sub) return;
      // v10.31 组合配方独立折叠（data-ws-combofold → cfg.styleCustom.comboOpen.builtin/custom）
      if(sub.dataset.wsCombofold!==undefined){
        const cfg = getCfg(); cfg.styleCustom = cfg.styleCustom || {};
        cfg.styleCustom.comboOpen = cfg.styleCustom.comboOpen || {};
        const open = !sub.classList.contains('open');
        cfg.styleCustom.comboOpen[sub.dataset.wsCombofold] = open; saveCfg(cfg);
        sub.classList.toggle('open', open);
        const ico = t.querySelector('.sc-fold-ico'); if(ico) ico.textContent = open?'▾':'▸';
        return;
      }
      // 五大类折叠（state.chapterStyle.catOpen）
      if(sub.dataset.wsCatfold===undefined) return;
      const st = writeStyleState(); st.catOpen = st.catOpen || {};
      const open = !sub.classList.contains('open');
      st.catOpen[sub.dataset.wsCatfold] = open; persist();
      sub.classList.toggle('open', open);
      const ico = t.querySelector('.sc-fold-ico'); if(ico) ico.textContent = open?'▾':'▸';
    });
  }
  // v10.17 每组末尾「＋」→ 弹窗新建该组风格词条
  $$('[data-ws-add]').forEach(b=> b.onclick = ()=> openStyleNewDialog(b.dataset.wsAdd));
}
// v10.17 新建风格词条弹窗（归属分组固定为调用它的那组；确认后立即入库并出现在该组）
function openStyleNewDialog(group){
  closeStyleNewDialog();
  const CAT_LABEL = { '语言质感':'① 语言质感', '情绪与张力':'② 情绪与张力', '节奏与网感':'③ 节奏与网感', '叙事技法':'④ 叙事技法', '台词设计':'⑤ 台词设计', custom:'⭐ 我的自定义' };
  const catLabel = ()=> CAT_LABEL[group] || '自定义';
  const ov = document.createElement('div'); ov.id='wsNewPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>＋ 新建文风词条</b>
        <button class="gs-x" data-wsn-close>✕</button></div>
      <div class="cv-body">
        <label style="font-size:12px;color:var(--sub)">归属分类</label>
        <select id="wsnCat" style="margin:4px 0 10px">
          <option value="语言质感"${group==='语言质感'?' selected':''}>① 语言质感</option>
          <option value="情绪与张力"${group==='情绪与张力'?' selected':''}>② 情绪与张力</option>
          <option value="节奏与网感"${group==='节奏与网感'?' selected':''}>③ 节奏与网感</option>
          <option value="叙事技法"${group==='叙事技法'?' selected':''}>④ 叙事技法</option>
          <option value="台词设计"${group==='台词设计'?' selected':''}>⑤ 台词设计</option>
          <option value="custom"${group==='custom'?' selected':''}>⭐ 我的自定义</option>
        </select>
        <label style="font-size:12px;color:var(--sub)">风格名称（≤20字）*</label>
        <input type="text" id="wsnName" maxlength="20" placeholder="如：民国腔调 / 冷硬悬疑" style="margin:4px 0 10px" />
        <label style="font-size:12px;color:var(--sub)">指令文本（≤500字）</label>
        <textarea id="wsnNote" rows="4" maxlength="500" placeholder="推荐三行配方：&#10;写法：…&#10;避免：…&#10;自查：…" style="margin:4px 0 6px"></textarea>
        <div class="muted" style="font-size:11px">确认后将于「<span data-wsn-catlab>${catLabel()}</span>」分类下添加并默认勾选（草稿态，点「✔ 应用并保存」正式生效）。</div>
      </div>
      <div class="modal-actions" style="padding:12px 16px;border-top:1px solid var(--line)">
        <button type="button" class="btn ghost" data-wsn-close2>取消</button>
        <button type="button" class="btn primary" data-wsn-ok>✔ 确认新建</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const lab = ov.querySelector('[data-wsn-catlab]');
  const catSel = ov.querySelector('#wsnCat');
  if(catSel && lab) catSel.onchange = ()=> lab.textContent = CAT_LABEL[catSel.value] || '自定义';
  const close = ()=> closeStyleNewDialog();
  ov.querySelector('[data-wsn-close]').onclick = close;
  ov.querySelector('[data-wsn-close2]').onclick = close;
  ov.addEventListener('click', e=>{ if(e.target===ov) close(); });
  ov.querySelector('[data-wsn-ok]').onclick = ()=>{
    const name = ($('#wsnName') && $('#wsnName').value.trim()) || '';
    if(!name){ toast('请填写风格名称'); return; }
    const note = ($('#wsnNote') && $('#wsnNote').value.trim().slice(0,500)) || '';
    const cat = (catSel && catSel.value) || group || 'custom';
    const c = getCfg(); c.styleCustom = c.styleCustom || { notes:{}, added:[], removed:[] };
    c.styleCustom.added = c.styleCustom.added || [];
    const id = 'c'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
    c.styleCustom.added.push({ id, group:cat, name, note });
    saveCfg(c);
    // 立即加入并默认勾选（草稿态待应用）
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
  if(!cfg.styleCustom) cfg.styleCustom = { notes:{}, added:[], removed:[], comboRemoved:[] };
  const lib = writeStyleLib();
  const CAT_LABEL = { '语言质感':'① 语言质感', '情绪与张力':'② 情绪与张力', '节奏与网感':'③ 节奏与网感', '叙事技法':'④ 叙事技法', '台词设计':'⑤ 台词设计', custom:'⭐ 我的自定义' };
  const groups = Object.keys(CAT_LABEL);
  const notes = cfg.styleCustom.notes || {};
  // v10.20 管理面板：按五大类文风分组、默认折叠、点击展开
  const groupHtml = groups.map(g=>{
    const its = lib.filter(s=>(s.cat||'element')===g);
    return `<div class="ws-lib-group ws-lib-fold">
      <div class="ws-lib-fold-t" data-lib-fold="${g}" role="button" tabindex="0" title="展开/收起">
        <span>${CAT_LABEL[g]}${its.length?`（${its.length}）`:'（空）'}</span><span class="sc-fold-ico">▸</span>
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
        ${its.length?'':`<p class="muted" style="margin:4px 0">该组暂无词条：回到写作风格卡片点该组「＋」新建。</p>`}
      </div>
    </div>`;
  }).join('');
  const mine = (Array.isArray(cfg.stylePresets)?cfg.stylePresets:[]).map((p,i)=>`
    <div class="ws-lib-item">
      <div class="ws-lib-name">⭐ ${esc(p.name||'未命名')}</div>
      <span class="muted" style="font-size:11px">${(p.tags||[]).map(id=>{const s=writeStyleById(id); return s?s.name:id;}).join('+')||'无'} · ${['','轻','中','重'][p.intensity]||'中'}</span>
      <button type="button" class="btn small ghost del" data-sp-del="${i}">删</button>
    </div>`).join('') || '<p class="muted">暂无收藏。</p>';
  // v10.50 全部配方查看：内置🎬 + 我的配方🏷 + AI配方（availableCombos 已合并），展示完整原始信息
  const combos_ = availableCombos();
  const combosHtml = combos_.length ? combos_.map(c=>`
    <div class="ws-lib-item">
      <div class="ws-lib-name">${c.custom?'🏷':'🎬'} ${esc(c.name||'未命名')}</div>
      <div class="ws-lib-note" style="white-space:pre-wrap;margin:2px 0 4px">${esc(c.desc||'')}</div>
      ${c.why?`<div class="ws-lib-why">💡 为何这样选：${esc(wiseWhyText(c.why))}</div>`:''}
      <span class="muted" style="font-size:11px">词条：${(c.tags||[]).map(id=>{const s=writeStyleById(id); return s?s.name:id;}).join(' + ')||'无'}</span>
    </div>`).join('') : '<p class="muted">暂无配方。</p>';
  const ov = document.createElement('div'); ov.id='wsLibPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>⚙️ 写作风格管理</b>
        <span style="display:flex;gap:6px">
          <button class="btn small ghost" data-lib-read>📖 阅读</button>
          <button class="btn small ghost" data-lib-reset>恢复默认</button>
          <button class="gs-x" data-lib-close>✕</button>
        </span></div>
      <div class="cv-body">
        <div class="ws-lib-group ws-lib-fold">
          <div class="ws-lib-fold-t" data-lib-fold="combos" role="button" tabindex="0" title="展开/收起">
            <span>🧪 全部配方（${combos_.length}）</span><span class="sc-fold-ico">▾</span>
          </div>
          <div class="ws-lib-fold-b">${combosHtml}</div>
        </div>
        <div class="cv-div">「全部配方」为只读查看区（名称/说明/所含词条）；需新增或删除配方请回到写作风格卡片操作。下方每组词条均可修改指令（打"已改"标记）、可停用内置项（🚫）、可删除自定义项（🗑）；内置项被停用后由「恢复默认」一并还原；「恢复默认」清空全部词库改动。改动即时生效。</div>
        ${groupHtml}
        <div class="ws-lib-group ws-lib-fold">
          <div class="ws-lib-fold-t" data-lib-fold="mine" role="button" tabindex="0" title="展开/收起">
            <span>⭐ 我的收藏</span><span class="sc-fold-ico">▸</span>
          </div>
          <div class="ws-lib-fold-b" hidden>${mine}</div>
        </div>
      </div>
      <div class="ws-lib-foot">
        <button type="button" class="btn small ghost" data-lib-export>⬇ 导出</button>
        <button type="button" class="btn small ghost" data-lib-import>⬆ 导入</button>
        <input type="file" id="wsLibImportFile" accept=".json,application/json" hidden />
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-lib-close]').onclick = closeStyleLibPanel;
  ov.querySelector('[data-lib-read]').onclick = () => openStyleLibReader();
  // v10.32 底部工具条：导出整套；导入触发隐藏文件选择
  ov.querySelector('[data-lib-export]').onclick = exportWsStyleBundle;
  ov.querySelector('[data-lib-import]').onclick = ()=>{ const f=$('#wsLibImportFile'); if(f) f.click(); };
  const wlImp = ov.querySelector('#wsLibImportFile'); if(wlImp) wlImp.onchange = e=>{ const file=e.target.files && e.target.files[0]; if(file) importWsStyleBundle(file); e.target.value=''; };
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
    cfg.styleCustom = { notes:{}, added:[], removed:[], comboRemoved:[] };
    saveCfg(cfg); render(); toast('已恢复默认词库');
    closeStyleLibPanel(); openStyleLibPanel();   // 立即重建面板：清掉「已改」标记、自定义项与编辑过的指令
  };
}
// v10.32 写作风格「词条+组合」整套导出：写 writing-styles-YYYYMMDD-HHmmss.json（覆盖式导入用）
function exportWsStyleBundle(){
  const c = getCfg().styleCustom || { notes:{}, added:[], removed:[], comboRemoved:[] };
  const styleCustom = {
    notes: c.notes && typeof c.notes==='object' ? c.notes : {},
    added: Array.isArray(c.added) ? c.added : [],
    removed: Array.isArray(c.removed) ? c.removed : [],
    comboRemoved: Array.isArray(c.comboRemoved) ? c.comboRemoved : [],
    customCombos: Array.isArray(c.customCombos) ? c.customCombos : []
  };
  const data = { ver:1, exportedAt:Date.now(), kind:'wsStyleBundle', styleCustom };
  const ts = new Date();
  const pad = n => String(n).padStart(2,'0');
  const stamp = `${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
  const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `writing-styles-${stamp}.json`; a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出词条与组合配方');
}
// v10.32 整套导入（覆盖式）：整体替换 styleCustom 的词条/组合定制字段，附结构校验与词条悬挂引用过滤
function importWsStyleBundle(file){
  const reader = new FileReader();
  reader.onload = ()=>{
    let data;
    try{ data = JSON.parse(reader.result); }
    catch(e){ toast('导入失败：文件不是合法 JSON'); return; }
    if(!data || typeof data !== 'object' || !data.styleCustom || typeof data.styleCustom !== 'object'){
      toast('导入失败：不是合法的写作风格配方 JSON'); return;
    }
    const sc = data.styleCustom;
    const strArr = v => Array.isArray(v) ? v.map(String).filter(x=> !!x) : [];
    const builtinIds = [].concat(WRITE_STYLES || [], TONE_TITLE_STYLES || [], TEXTURE_PLAN_STYLES || []).map(s=> s && s.id).filter(Boolean);
    const libNowIds = writeStyleLib().map(s=> s.id);
    const cfg = getCfg(); cfg.styleCustom = cfg.styleCustom || { notes:{}, added:[], removed:[], comboRemoved:[] };
    // 词条 notes：覆盖式整体替换
    cfg.styleCustom.notes = (sc.notes && typeof sc.notes==='object') ? sc.notes : {};
    // added：逐项校验 id/name；group 归入五大类否则 custom 兜底
    cfg.styleCustom.added = (Array.isArray(sc.added) ? sc.added : [])
      .filter(x=> x && x.id && x.name)
      .map(x=>({ id:String(x.id), group:['语言质感','情绪与张力','节奏与网感','叙事技法','台词设计'].includes(x.group)?x.group:'custom', name:String(x.name), note:String(x.note||''), demo:x.demo?String(x.demo):'', seal:(x.seal===undefined?0:x.seal), warning:x.warning?String(x.warning):'' }));
    // removed：仅保留存在于内置词条中的 id
    cfg.styleCustom.removed = strArr(sc.removed).filter(id=> builtinIds.includes(id));
    // comboRemoved：仅保留存在于内置组合中的 id
    cfg.styleCustom.comboRemoved = strArr(sc.comboRemoved).filter(id=> (WRITE_COMBOS||[]).some(c=> c.id === id));
    // customCombos：保留合法条目，tags 过滤为当前库内仍存在的词条 id
    cfg.styleCustom.customCombos = (Array.isArray(sc.customCombos) ? sc.customCombos : [])
      .filter(x=> x && x.id && x.name)
      .map(x=>({ id:String(x.id), name:String(x.name), desc:String(x.desc||''), tags:strArr(x.tags).filter(id=> libNowIds.includes(id)) }));
    saveCfg(cfg); render();
    toast('已导入词条与组合配方');
    closeStyleLibPanel(); openStyleLibPanel();   // 重建面板，导入内容立即可见
  };
  reader.readAsText(file);
}
function closeStyleLibPanel(){ const p=$('#wsLibPanel'); if(p) p.remove(); }

/* ---------- 写作风格配方 · 阅读视图（独立函数，复用 gs 浮层 + reader 排版） ---------- */
function openStyleLibReader(){
  closeStyleLibReader();
  // v10.55 方案B：阅读器仅展示五大类章节风格 + 我的自定义；过滤内置「标题风格(tone)/梗概风格(texture)」组（用户自定义旧数据已归入 element 组，不受影响）
  const lib = writeStyleLib().filter(s=> s.group !== 'tone' && s.group !== 'texture');
  const CAT_LABEL = { '语言质感':'① 语言质感', '情绪与张力':'② 情绪与张力', '节奏与网感':'③ 节奏与网感', '叙事技法':'④ 叙事技法', '台词设计':'⑤ 台词设计', custom:'⭐ 我的自定义' };
  const groups = {};
  lib.forEach(s=>{
    const cat = s.cat || 'custom';
    if(!groups[cat]) groups[cat] = [];
    groups[cat].push(s);
  });
  const order = Object.keys(CAT_LABEL).filter(g=>groups[g] && groups[g].length);
  (Object.keys(groups).filter(g=>!Object.prototype.hasOwnProperty.call(CAT_LABEL,g))).forEach(g=>order.push(g));
  let html = order.map(cat=>{
    let catHtml = `<h2>${CAT_LABEL[cat] || cat}（${groups[cat].length}）</h2>`;
    catHtml += groups[cat].map(s=>`
      <div class="style-recipe">
        <h3>【${esc(s.name)}】${s.custom?'<span class="ws-custom">自定义</span>':''}</h3>
        <p><strong>指令：</strong>${esc(s.note||'')}</p>
        ${s.tips && s.tips.length ? `<p><strong>写法：</strong>${s.tips.map((t,i)=>`${i+1}. ${esc(t)}`).join('；')}</p>` : ''}
        ${s.avoid && s.avoid.length ? `<p><strong>避免：</strong>${s.avoid.map(a=>'✗ '+esc(a)).join('；')}</p>` : ''}
        ${s.check && s.check.length ? `<p><strong>自查：</strong>${s.check.map(c=>'□ '+esc(c)).join('　')}</p>` : ''}
        ${s.demo ? `<p><strong>示例：</strong>「${esc(s.demo)}」</p>` : ''}
      </div>`).join('');
    return catHtml;
  }).join('');
  const ov = document.createElement('div'); ov.id='wsLibReader'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal reader-modal">
      <div class="gs-modal-head"><b>📖 写作风格配方大全</b>
        <span style="display:flex;gap:6px">
          <button class="btn small ghost" data-lib-read-copy>复制全文</button>
          <button class="gs-x" data-lib-read-close>✕</button>
        </span></div>
      <div class="cv-body"><div class="reader-body">${html}</div></div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-lib-read-close]').onclick = closeStyleLibReader;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeStyleLibReader(); });
  // 复制全文：生成纯文本配方，按分组/词条排列
  ov.querySelector('[data-lib-read-copy]').onclick = ()=>{
    let txt = '写作风格配方大全\n' + '='.repeat(24) + '\n\n';
    order.forEach(cat=>{
      txt += `${CAT_LABEL[cat] || cat}（${groups[cat].length}）\n${'-'.repeat(20)}\n`;
      groups[cat].forEach(s=>{
        txt += `\n【${s.name}】${s.custom?'[自定义]':''}\n`;
        if(s.note) txt += `指令：${s.note}\n`;
        if(s.tips && s.tips.length) txt += `写法：${s.tips.map((t,i)=>`${i+1}. ${t}`).join('；')}\n`;
        if(s.avoid && s.avoid.length) txt += `避免：✗ ${s.avoid.join('；✗ ')}\n`;
        if(s.check && s.check.length) txt += `自查：${s.check.map(c=>`□ ${c}`).join('　')}\n`;
        if(s.demo) txt += `示例：「${s.demo}」\n`;
      });
      txt += '\n';
    });
    copyText(txt);
  };
}
function closeStyleLibReader(){ const p=$('#wsLibReader'); if(p) p.remove(); }

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
    ${ isLong() ? aiRecipeCard() : '' }
    ${ writeStyleCard() }
    <div class="card">
      <div class="card-head-row">
        <h3 style="margin:0">📋 故事大纲</h3>
        ${hasOutlineHistory()?`<button type="button" class="btn small ghost" id="btnOutlineHist" title="查看并恢复历史大纲版本">📚 大纲版本(${outlineHistoryCount()})</button>`:''}
        ${titleManagerHtml()}
      </div>
      <p class="sub">${esc(o.logline||'')}</p>
      <div class="global-req">
        <textarea id="globalReqInp" rows="3" placeholder="写全书风格基准/对标本（如对标《寅次郎的故事》等），指挥标题、逐章梗概、章节正文统一基调">${esc(o.globalReq||'')}</textarea>
        <p class="global-req-hint">全书级要求：注入「重生成标题 / 逐章梗概 / 章节内容」，优先级：单章干预 &gt; 全书要求 &gt; 写作风格。</p>
      </div>
      ${ chapterTitleBlock() }
      ${ structureCard(o) }
      ${ state.outlineConfirmed ? `
        ${ isLong() ? chapterPlanBlock() : '' }
        ${ isLong() ? glossaryCardHtml() : '' }
        ${ isLong() ? `<div class="btn-row" style="margin-top:8px">
          <label class="long-jump"><span>跳到章节：</span>
          <select id="longJump"><option value="">— 选择章节阅读 —</option>${state.chapters.map((c,i)=>`<option value="${i}">第${i+1}章 ${esc(cleanChapterTitle(c.title))}</option>`).join('')}</select></label>
        </div>` : '' }
        <div class="ch-toolbar">
          <span class="ch-toolbar-t">📚 章节列表（共 ${state.chapters.length} 章，已生成 ${state.chapters.filter(c=>c.content && String(c.content).trim()).length} 章）</span>
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
// v10.30 AI 配方助手绑定（事件委托到容器，容动态渲染的候选/缺口；仅长篇小说模式有该容器）
function bindAiRecipe(){
  const card = $('.ai-recipe-card'); if(!card) return;
  const gen = card.querySelector('[data-ai-recipe-gen]');
  if(gen) gen.onclick = ()=>{ aiRecipeGen(); };
  const clr = card.querySelector('[data-ai-recipe-clear]');
  if(clr) clr.onclick = ()=>{
    const ta = $('#aiReDesc'); if(ta) ta.value = '';
    const nm = card.querySelector('[data-ai-upload-name]'); if(nm) nm.textContent = '';
    aiRp = null; aiSource = 'desc';
    const out = card.querySelector('[data-ai-recipe-out]'); if(out) out.innerHTML = aiRecipeResultHtml();
  };
  // v10.31 卡片折叠：点头部整卡展开/收起，状态持久化到 cfg.aiRecipeCollapsed（默认折叠）
  const foldHead = card.querySelector('[data-ai-recipe-fold]');
  if(foldHead) foldHead.addEventListener('click', ()=>{
    const cfg = getCfg();
    card.classList.toggle('collapsed');
    const nowCollapsed = card.classList.contains('collapsed');
    cfg.aiRecipeCollapsed = nowCollapsed; saveCfg(cfg);
    const ico = foldHead.querySelector('.sc-fold-ico'); if(ico) ico.textContent = nowCollapsed?'▸':'▾';
  });
  // v10.57 书本图标：打开 AI 配方历史弹层（徽标随快照数更新）
  const histBtn = card.querySelector('[data-ai-recipe-hist]');
  if(histBtn) histBtn.onclick = ()=>{ openAiHistPanel(); };
  // v1.0.62 上传逐章梗概 TXT：圆形加号 → FileReader.readAsText → AI 通读提炼配方
  const fIn = $('#aiReFile');
  const readOutline = (f)=>{
    if(!f) return;
    if(!/\.txt$/i.test(f.name)){ toast('请上传 .txt 文本'); return; }
    const r = new FileReader();
    r.onload = ()=>{
      const txt = String((r.result)||'').trim();
      if(!txt){ toast('文件内容为空'); return; }
      const nm = card.querySelector('[data-ai-upload-name]'); if(nm) nm.textContent = f.name;
      _aiOutlineFname = f.name;   // v10.57 供快照标记来源
      aiRecipeFromOutline(txt);
    };
    r.onerror = ()=> toast('读取文件失败');
    r.readAsText(f);
  };
  if(fIn) fIn.onchange = ()=>{ const f = fIn.files && fIn.files[0]; readOutline(f); fIn.value=''; };
  const openPick = ()=>{ if(fIn) fIn.click(); };
  const fileBtn = card.querySelector('[data-ai-recipe-file]');
  if(fileBtn) fileBtn.onclick = openPick;
  // 事件委托：选用候选 / 加入缺口词条（点选候选后内部 render()，事件需在容器上重查）
  card.addEventListener('click', (e)=>{
    const pick = e.target.closest('[data-ai-recipe-pick]');
    if(pick){ aiRecipePick(+pick.dataset.aiRecipePick); return; }
    const save = e.target.closest('[data-ai-recipe-save]');
    if(save){ aiRecipeSave(+save.dataset.aiRecipeSave); return; }
    const ag = e.target.closest('[data-ai-recipe-addgap]');
    if(ag){ aiRecipeAddGap(ag.dataset.aiRecipeAddgap); return; }
  });
}
// —— v10.57 AI 配方历史弹层（书本图标；读持久化快照，与瞬时 aiRp 解耦）——
function aiHistCandHtml(c, idx){
  if(!c) return '';
  return `<div class="ai-recipe-cand" style="margin-top:6px">
    <div class="ai-recipe-cand-head">
      <b>${esc(c.name||('候选'+(idx+1)))}</b>
      <span class="muted" style="font-size:11px">${esc(c.desc||'')}</span>
    </div>
    <div class="ai-recipe-tags">${ (c.tags||[]).map(id=>{ const s=writeStyleById(id); return `<span class="ai-recipe-tg">${esc(s?s.name:id)}</span>`; }).join('') }</div>
    <div class="ai-recipe-sec"><span class="ar-lab">为何这样选</span>${esc(wiseWhyText(c.why||''))}</div>
    <div class="ai-recipe-sec"><span class="ar-lab">适用场景</span>${esc(wiseWhyText(c.scenario||''))}</div>
    <div class="ai-recipe-gap">
      ${ Array.isArray(c.gap) && c.gap.length
        ? `<div class="ar-gaptitle">⚠️ 词条缺口（${c.gap.length} 项）</div>` + c.gap.map(g=>`
            <div class="ai-recipe-gapitem">
              <div class="ar-gaphead"><b>${esc((g&&g.name)||'')}</b><span class="muted" style="font-size:11px">${ (AI_CAT_LABEL[(g&&g.cat)||'']||((g&&g.cat)||'custom')) }</span></div>
              <div class="ar-gapwhy">${esc((g&&g.reasons)||'')}</div>
              ${gapFiveHtml(g)}
            </div>`).join('')
        : `<span class="ar-ok">✓ 现有词库即可覆盖，无需新词条</span>` }
    </div>
  </div>`;
}
function openAiHistPanel(){
  const hist = getAiHist();
  const ov = document.createElement('div'); ov.id='aiHistPanel'; ov.className='gs-overlay';
  const entHtml = (e,hi)=>{
    const ei = hist.length-1-hi;   // 倒序序号（与展示一致）
    return `<div class="ws-lib-group ws-lib-fold" style="margin-top:6px">
      <div class="ws-lib-fold-t" data-ah-fold="${ei}" role="button" tabindex="0" title="展开/收起">
        <span>${e.src==='outline'?'📑':'📝'} ${esc(e.desc||'')} <span class="muted" style="font-size:10px">· ${new Date(e.ts).toLocaleString('zh-CN',{hour12:false})}</span></span>
        <span class="sc-fold-ico">▸</span>
      </div>
      <div class="ws-lib-fold-body" style="display:none">
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 8px">
          <button type="button" class="btn small ghost" data-ah-apply="${ei}">✔ 重新采用首个</button>
          <button type="button" class="btn small ghost" data-ah-del="${ei}">删</button>
        </div>
        ${ (Array.isArray(e.list)&&e.list.length) ? e.list.map((c,i)=>aiHistCandHtml(c,i)).join('<hr style="margin:6px 0;opacity:.2">') : '<p class="muted">无候选。</p>' }
      </div>
    </div>`;
  };
  const list = hist.slice().reverse();
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>📖 AI 配方历史（${hist.length}）</b>
        <span style="display:flex;gap:6px">
          <button class="btn small ghost" data-ah-clear>清空</button>
          <button class="gs-x" data-ah-close>✕</button>
        </span></div>
      <div class="cv-body">
        ${ list.length ? list.map(entHtml).join('') : '<p class="muted">暂无历史。用「✨ 生成配方」生成后即自动保存于此，可随时回看。</p>' }
      </div>
    </div>`;
  const close = ()=>{ const p=$('#aiHistPanel'); if(p) p.remove(); };
  ov.addEventListener('click', (e)=>{
    const cl = e.target.closest('[data-ah-close]'); if(cl){ close(); return; }
    const fold = e.target.closest('[data-ah-fold]');
    if(fold){ const body = fold.closest('.ws-lib-group').querySelector('.ws-lib-fold-body'); if(body){ const open = body.style.display!=='none'; body.style.display = open?'none':'block'; fold.querySelector('.sc-fold-ico').textContent = open?'▸':'▾'; } return; }
    const apply = e.target.closest('[data-ah-apply]');
    if(apply){ const ei=+apply.dataset.ahApply; const entry=hist[ei]; if(entry&&Array.isArray(entry.list)&&entry.list.length){ applyChosenCandidate(entry.list[0], {render:false}); refreshAiHistBadge(); close(); } return; }
    const del = e.target.closest('[data-ah-del]');
    if(del){ const ei=+del.dataset.ahDel; const a=getAiHist(); if(a[ei]){ a.splice(ei,1); setAiHist(a); } refreshAiHistBadge(); const p=$('#aiHistPanel'); if(p) p.remove(); openAiHistPanel(); return; }
    const clr = e.target.closest('[data-ah-clear]');
    if(clr){ if(confirm('确认清空全部 AI 配方历史？')){ setAiHist([]); refreshAiHistBadge(); close(); } return; }
    if(e.target===ov) close();
  });
  document.body.appendChild(ov);
}
function closeAiHistPanel(){ const p=$('#aiHistPanel'); if(p) p.remove(); }
// 更新卡片书本徽标（按当前快照数）
function refreshAiHistBadge(){
  const n = getAiHist().length;
  const card = $('.ai-recipe-card');
  if(card){ const b = card.querySelector('[data-ai-recipe-hist] .ai-hist-badge'); if(b) b.textContent = n||''; }
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
      if(o.chTitleHistory.length > 50) o.chTitleHistory.splice(50);
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
  const rows = arr.map((c,i)=>`
    <div class="ct-row" data-ct-row="${i}">
      <span class="ct-no">第${i+1}章</span>
      <span class="ct-title" title="${esc((c&&c.title)||'')}">${esc((c&&c.title)||('第'+(i+1)+'章'))}</span>
      <button type="button" class="ct-edit" data-ct-edit="${i}" title="编辑标题">✎</button>
    </div>`).join('');
  return `<div class="ct-block${state.ctCollapsed?' ct-collapsed':''}">
    <div class="ct-head" data-ct-fold role="button" tabindex="0" title="展开/收起">
      <b>📚 章节标题 <span class="ct-fold-ico">${state.ctCollapsed?'▸':'▾'}</span></b>
      <span class="ct-tools">
        <button type="button" class="btn small ghost" data-ct-hist>单历(${chTitleHistory().length})</button>
        <button type="button" class="btn small ghost" data-ct-copy>📋 复制全部章节标题</button>
      </span>
    </div>
    <div class="ct-row2">
      <button type="button" class="btn small ghost" data-ct-batch title="查看并可整批回退「重生成全部标题」的历史版本">版本(${chTitleBatches().length}/50)</button>
      <button type="button" class="btn small ghost" data-ct-raw title="手动提取 AI 原始响应数据，当自动更新失败时使用">🔧</button>
    </div>
    <textarea class="rt-input" id="rtInput" placeholder="重生成要求（选填）：如『标题更有悬念感』『避免剧透式标题』『每章标题用双字词』"></textarea>
    <div class="advice-ai-row">
      <button type="button" class="btn small ghost" data-cth-ai>✨ AI 优化此建议</button>
      <button type="button" class="ai-upload-btn ai-hist-btn" data-ctadv-hist title="章节标题 AI 建议历史：回看已生成过的建议（随项目保存）">📖<span class="ai-hist-badge">${Array.isArray(state.ctAdviceHist)?state.ctAdviceHist.length:''}</span></button>
      <span class="cth-fold-btn" data-cth-ai-unfold role="button" style="display:none">↗ 展开建议</span>
      <button type="button" class="ct-rtgen" data-rt-gen>重生成</button>
    </div>
    <div data-cth-ai-out></div>
    <div class="ct-list">${rows}</div>
  </div>`;
}

// v10.14 章节标题绑定：复制全部 / ✎ 进入编辑态（失焦或回车存、Esc 还原、同刻单行互斥）
function bindChapterTitles(){
  const ctFold = $('[data-ct-fold]');
  if(ctFold) ctFold.onclick = ()=>{
    state.ctCollapsed = !state.ctCollapsed; persist();
    const blk = ctFold.closest('.ct-block'); if(blk) blk.classList.toggle('ct-collapsed', state.ctCollapsed);
    const ico = ctFold.querySelector('.ct-fold-ico'); if(ico) ico.textContent = state.ctCollapsed?'▸':'▾';
  };
  const cp = $('[data-ct-copy]');
  if(cp) cp.onclick = ()=>{ copyText(chapterTitleListText()); };
  const ch = $('[data-ct-hist]');
  if(ch) ch.onclick = ()=> openChTitleHistoryPanel();
  const ctb = $('[data-ct-batch]');
  if(ctb) ctb.onclick = ()=> openChTitleBatchPanel();
  const rg = $('[data-rt-gen]');
  if(rg) rg.onclick = ()=> regenAllTitles(rg);   // v10.15 重生成全部标题
  const rawT = $('[data-ct-raw]');
  if(rawT) rawT.onclick = ()=> openTitlesRawPanel();
  const cthA = $('[data-cth-ai]');
  if(cthA) cthA.onclick = ()=> ctAiRefineAdvice();   // v10.32 章节标题 AI 优化建议
  const cthH = $('[data-ctadv-hist]');
  if(cthH) cthH.onclick = ()=> openAdvHistPanel('ct');   // v10.59 章节标题 AI 建议历史
  const ctBlock = $('.ct-block');
  if(ctBlock) ctBlock.onclick = e=>{
    // v10.38 整卡点击：选中该项（高亮），回填输入框，保持展开不回填后收起
    const pick = e.target.closest('[data-cth-ai-pick]');
    if(pick){
      const j = +pick.dataset.cthAiPick;
      if(ctAdviceCand && ctAdviceCand[j]){
        ctAdoptedIdx = j;                           // 选中该项（高亮）
        const inp = $('#rtInput'); if(inp) inp.value = ctAdviceCand[j].text || '';
        const out = $('[data-cth-ai-out]'); if(out) out.innerHTML = ctAdviceResultHtml();
        updateFoldBtn();
        toast('已选择该建议，可直接重生成');
      }
      return;
    }
    // 折叠/展开按钮
    const unfold = e.target.closest('[data-cth-ai-unfold]');
    if(unfold){
      ctAdviceFold = !ctAdviceFold;   // v10.34 切换折叠/展开
      const out = $('[data-cth-ai-out]'); if(out) out.innerHTML = ctAdviceResultHtml();
      updateFoldBtn();
      return;
    }
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

// v10.32 章节标题 AI 优化建议：把 rtInput 里的粗略要求提炼成 3 条可直接作「重生成要求」的建议稿
let ctAdviceCand = null;   // {title,text}[] 候选，模块级；重渲会随标签重置
let ctAdviceFold = false;  // v10.33 候选是否已收起（采纳后收起，可再展开）；重渲复位
let ctAdoptedIdx = -1;     // v10.34 当前已采用的选项索引（-1 表示未采用）
function buildCtAdviceCtx(){
  const o = state.outline || {};
  const st = o.structure || {};
  return {
    小说标题: o.title || '',
    小说简介: o.logline || '',
    长篇结构设计: JSON.stringify(st).slice(0,800),
    设定词典: chapterGlossaryBlock(),
    现有章节标题: (o.chapters||[]).map((c,i)=>`第${i+1}章 ${(c&&c.title)||''}`).join(' / ')
  };
}
function ctAiRefinePrompt(ctx, raw){
  return { system:[
    '你是资深长篇小说的章标题策划师。用户在"重生成全部标题"的要求框里写了一段粗略的重生成要求（可能是风格方向、悬念感、字数对仗、避免套路等）。',
    '请把它提炼成 3 条【可直接作为重生成要求下发给标题生成 AI 的建议稿】，供用户挑选回填。',
    '输出：仅一个 JSON 数组（3 项），无任何讲解、无 markdown 代码块前后缀。每项结构：',
    '{ "title":"一句话说明这条要求侧重什么", "text":"完整重生成要求（用命令式、可执行，可直接提交给标题生成 AI）" }',
    '规则：',
    '1.充分依据给出的【现有章节标题】风格与【长篇结构】【设定词典】，让要求具体可执行，不空话。',
    '2.三条从不同角度覆盖（如：一条偏立意/悬念、一条偏字数对仗/画面感、一条偏避免套路/统一专名与人名），或按用户原话拆三个侧重点。',
    '3.text 用对标题 AI 说的命令式祈使句，明确范围与幅度，不得自造与大纲、词典冲突的设定或专名。',
    '4.若用户原话已足够明确，则逐条拆细表达而非改写其语义。'
    ].join('\n'),
    user: JSON.stringify({ 上下文: ctx, 用户原始要求: raw }, null, 1) };
}
async function ctAiRefineAdvice(){
  if(_aiOptBusy){ toast('AI 建议优化中，请稍候'); return; }
  if(genBusy()){ toast('已有生成任务进行中，请稍候'); return; }   // v10.43 互斥：重生成标题等任务进行中不并发
  _aiOptBusy = true;   // v10.43 占位，供 genBusy 判定「AI 建议进行中」
  const inp = $('#rtInput'); if(!inp){ _aiOptBusy = false; return; }
  const raw = inp.value.trim();
  if(!raw){ toast('请先填一点粗略要求，再让 AI 优化'); _aiOptBusy = false; return; }
  const out = $('[data-cth-ai-out]');
  if(out) out.innerHTML = `<p class="muted" style="margin:6px 0 0">⏳ AI 正结合现有标题与世界观优化你的建议…</p>`;
  const btn = $('[data-cth-ai]'); if(btn){ btn.disabled = true; btn.classList.add('is-busy'); btn.textContent = '优化中…'; }
  try{
    const ctx = buildCtAdviceCtx();
    const {system, user} = ctAiRefinePrompt(ctx, raw);
    const spec = resolveActiveSpec();
    const res = await callDeepSeek(system, user, {temperature: spec.titleTemp, maxTokens:1200});
    const list = parseAiJsonList(res);
    if(!Array.isArray(list) || !list.length) throw new Error('AI 未返回有效建议，请重试');
    ctAdviceCand = list.slice(0,3);
    ctAdviceFold = false;   // v10.33 新一批默认展开显示
    ctAdoptedIdx = -1;      // v10.34 新一批重置已采用状态
    // v10.59 生成成功即存项目快照（随项目保存，切页/刷新不丢；复刻配方历史）
    addAdvHist('ct', { id: aiHistEntryId(), ts: Date.now(), desc: '章节标题重生成建议', list: JSON.parse(JSON.stringify(list.slice(0,3))) });
    refreshAdvHistBadge('ct');
  }catch(e){
    ctAdviceCand = null;
    if(out) out.innerHTML = `<p class="muted" style="color:var(--danger);margin:6px 0 0">⚠️ ${esc((e&&e.message)||'优化失败')}</p>`;
  }
  _aiOptBusy = false;   // v10.43 结束/异常均复位
  if(out) out.innerHTML = ctAdviceResultHtml();
  if(btn){ btn.disabled = false; btn.textContent = '✨ AI 优化此建议'; btn.classList.remove('is-busy'); }
  // v10.34 控制折叠按钮显示
  const foldBtn = $('[data-cth-ai-unfold]');
  if(foldBtn){
    foldBtn.style.display = (ctAdviceCand && ctAdviceCand.length) ? '' : 'none';
    foldBtn.textContent = ctAdviceFold ? '↗ 展开建议' : '↘ 收起建议';
  }
}
function ctAdviceResultHtml(){
  if(!Array.isArray(ctAdviceCand) || !ctAdviceCand.length) return '';
  if(ctAdviceFold) return '';   // v10.34 折叠态由外部 cth-fold-btn 控制，此处不渲染
  return ctAdviceCand.map((a,ai)=>`
    <div class="advice-ai-cand${ctAdoptedIdx===ai?' adopted':''}" data-cth-ai-pick="${ai}">
      <div class="advice-ai-head">
        <span class="advice-ai-idx">${'①②③'[ai]||(ai+1)}</span>
        <b>${esc(a.title||('方案'+(ai+1)))}</b>
      </div>
      <p>${esc(a.text||'')}</p>
    </div>`).join('');
}
// v10.34 同步折叠按钮显示与文字
function updateFoldBtn(){
  const foldBtn = $('[data-cth-ai-unfold]');
  if(!foldBtn) return;
  foldBtn.style.display = (ctAdviceCand && ctAdviceCand.length) ? '' : 'none';
  foldBtn.textContent = ctAdviceFold ? '↗ 展开建议' : '↘ 收起建议';
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
      <div class="gs-modal-head"><b>🕘 章节标题 · 单历（${hist.length}/50）</b>
        <button class="gs-x" data-cth-close>✕</button></div>
      <div class="cv-body">
        <div class="cv-div">仅记录您手动修改单个标题前的旧标题；整批重生成/整批恢复走「版本」，不会混入本列表。可一键恢复或删除某条记录；恢复会把当前标题也记入本列表。</div>
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
  if(!Array.isArray(o.chTitleBatches)) o.chTitleBatches = [];   // fixed: 先挂回 state.outline，persist 才存得住
  const bt = o.chTitleBatches;
  if(bt.length && JSON.stringify(bt[0].titles) === JSON.stringify(titles)) return;
  const d = new Date();
  const t = (d.getMonth()+1)+'-'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
  bt.unshift({ ts: Date.now(), label: `${t} · ${label||'生成批次'}`, titles });
  if(bt.length > 50) bt.length = 50;
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
  snapshotTitleBatch('本次恢复结果');   // v10.34 记录整批恢复后的结果版本
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
        <div class="cv-time">${idx+1}. <b style="color:var(--accent2)">${esc((b.label||'').split(' · ')[0]||fmtTs(b.ts))}</b>${esc((b.label||'').split(' · ')[1]?' · '+b.label.split(' · ')[1]:'')} · ${(b.titles||[]).length} 章</div>
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
      <div class="gs-modal-head"><b>🔁 章节标题 · 批量版本（${bt.length}/50）</b>
        <button class="gs-x" data-ctb-close>✕</button></div>
      <div class="cv-body">
        <div class="cv-div">「重生成全部标题」会把改动前/后的整批标题各归档一份（≤50 份可回退）；每行可👁预览整批，或点「应用」整批恢复。单条手改标题的记录仍在「单历」查看。</div>
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

// v10.15 重生成全部章节标题：保留梗概/结构/词典，只重出标题；可选用户建议
async function regenAllTitles(btn){
  const o = state.outline;
  if(!o || !Array.isArray(o.chapters) || !o.chapters.length){ toast('尚无章节标题'); return; }
  if(!confirm('将覆盖全部章节标题，确认重生成？')) return;
  if(genBusy()){ toast('已有生成任务进行中，请稍候'); return; }   // v10.43 互斥：AI 建议等任务进行中不并发
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
      parts.push(`小说标题：${o.title||''}\n小说简介：${o.logline||''}\n\n【长篇结构设计】\n${JSON.stringify(st).slice(0,800)}\n\n【设定词典】\n${gloss}\n\n【现有章节标题】\n${(o.chapters||[]).map((c,i)=>`第${i+1}章 ${(c&&c.title)||''}`).join(' / ')}${req?`\n\n【重生成要求】\n${req}`:''}`);
      if(o.globalReq) parts.push(`【全书要求（第二优先）】\n${o.globalReq}`);   // v10.44 books 级风格/对标基准，指挥标题拟定
      const user = parts.join('\n\n');
    const onStream = delta => {
      _streamBuf += String(delta||'');
      if(preview){ preview.textContent = _streamBuf; preview.scrollTop = preview.scrollHeight; }
    };
    const txt = await callDeepSeek(REGEN_TITLES_SYS, user, {temperature: spec.titleTemp, onStream: isStream ? onStream : null, signal: _abortCtl?.signal});
    // ★ 保存原始 AI 响应，供手动提取（"原始数据"按钮用）
    state._lastTitlesRaw = txt; persist();
    const j = parseJson(txt) || {};
    const titles = Array.isArray(j.titles) ? j.titles.map(t=>String(t||'').trim()).filter(Boolean) : [];
    if(!titles.length){ toast('未解析到新标题，请重试'); return; }
    snapshotTitleBatch('重生成前');   // 把改动前的整批标题归档为可回退版本
    const cnt = setAllTitles(titles);
    snapshotTitleBatch('本次重生成结果');   // v10.34 记录本次重生成的结果版本
    // 就地更新标题行，不刷新全页（保留预览区）
    document.querySelectorAll('.ct-row').forEach((row,i)=>{
      const el = row.querySelector('.ct-title');
      if(el && o.chapters[i] && o.chapters[i].title){
        el.textContent = o.chapters[i].title;
        el.title = o.chapters[i].title;
      }
    });
    // 立即刷新「标题版本」按钮（放入 .ct-row2 最右）
    const ctBlock2 = document.querySelector('.ct-block');
    const ctRow2 = ctBlock2 && ctBlock2.querySelector('.ct-row2');
    if(ctRow2){
      const batchBtn = ctRow2.querySelector('[data-ct-batch]');
      if(batchBtn) batchBtn.innerHTML = '版本('+chTitleBatches().length+'/50)';
    }
    toast(`已重生成 ${cnt} 个章节标题`);
  }catch(e){
    if(e.name==='AbortError'){ toast('已停止重生成标题'); }
    else { toast('重生成标题失败：'+e.message); }
  }
  finally{ hideStopBtn(); if(preview) preview.remove(); if(btn) busy(btn,false); }
}

// v10.19 逐章梗概区块：暗红渐变色卡片，独立设计通用于所有主题
function chapterPlanBlock(){
  const o = state.outline;
  const plans = (o && Array.isArray(o.chapterPlans)) ? o.chapterPlans : [];
  const hasPlans = plans.some(Boolean);
  const collapsed = !!state.cpCollapsed;
  const items = plans.map((t,i)=>`
    <div class="cp-item" data-cp-item="${i}">
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
        <div class="cp-head-use">
          <button type="button" class="btn small ${state.useChapterPlans?'on':''}" data-cp-use title="关闭后逐章梗概内容保留、历史仍在，但写正文时不发送给 AI">参与章节内容生成：${state.useChapterPlans?'开':'关'}</button>
        </div>
      </div>
      <div class="cp-head-row action-row">
        <button type="button" class="btn ghost" data-cp-raw title="手动提取 AI 原始响应数据，当自动更新失败时使用">🔧</button>
        ${hasChapterPlansHistory()?`<button type="button" class="btn ghost" data-cp-hist>📚 版本(${chapterPlansHistoryCount()})</button>`:''}
        <button type="button" class="cp-gen-btn" data-cp-gen>${hasPlans?' 重生成':'新生成'}</button>
      </div>
    </div>
    <div class="cp-body"${collapsed?' hidden':''}>
      ${hasPlans ? `<div class="cp-list">${items}</div>
        ${state.useChapterPlans ? '<p class="muted" style="margin:6px 0 0">每条可编辑，失焦即存；写正文时注入为【本章梗概】。</p>' : '<p class="muted" style="margin:6px 0 0">已暂停参与生成：内容与历史版本保留，写正文时不发送给 AI；可点上方「参与章节内容生成：关」恢复。</p>'}`
        : `<p class="sub">可选步骤：为每章写一段本章梗概（核心事件/起因经过结果/走向），写正文时据此执笔，统一各章走向。不做也不影响默认流程。</p>`}
    </div>
  </div>`;
}

// v10.19 梗概卡折叠绑定：点击标题行切换，状态持久化
function bindChapterPlanFold(){
  const head = $('[data-cp-fold]');
  if(!head) return;
  head.onclick = (e)=>{
    if(e.target.closest('[data-cp-hist]') || e.target.closest('[data-cp-gen]') || e.target.closest('[data-cp-raw]') || e.target.closest('[data-cp-use]') || e.target.closest('.stop-btn')) return;   // 不拦截版本/生成/原始数据/参与生成开关/停止按钮
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
  const hist = $('[data-cp-hist]');
  if(hist) hist.onclick = ()=> openChapterPlansHistoryPanel();
  const rawBtn = $('[data-cp-raw]');
  if(rawBtn) rawBtn.onclick = ()=> openCpRawPanel();
  // v10.29 「参与生成」开关：关则保留逐章梗概内容与历史、仅不注入正文生成
  const useCp = $('[data-cp-use]');
  if(useCp) useCp.onclick = (e)=>{
    e.stopPropagation();
    state.useChapterPlans = !(typeof state.useChapterPlans === 'boolean' ? state.useChapterPlans : true);
    persist();
    useCp.classList.toggle('on', !!state.useChapterPlans);
    useCp.textContent = '参与章节内容生成：' + (state.useChapterPlans ? '开' : '关');
    toast('逐章梗概将' + (state.useChapterPlans ? '参与本章生成' : '不参与生成（内容与历史保留）'));
  };
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
    ${(['char','place','proper']).map(t=>{
      const fold = !!(state.gsCatFold && state.gsCatFold[t]);
      const arr = t==='char'?g.characters:t==='place'?g.places:g.propernouns;
      const body = t==='char'?chars:t==='place'?places:props;
      const lab = t==='char'?'👤 人物':t==='place'?'🗺️ 地点':'📌 专名';
      return `<div class="gs-group${fold?' gs-folded':''}" data-gs-type="${t}" data-gs-catfold>
        <div class="gs-title" role="button" tabindex="0" title="展开/收起">${lab}（${(arr||[]).length}）<span class="gs-cat-ico">${fold?'▸':'▾'}</span></div>
        ${body||'<span class="muted">（无）</span>'}
      </div>`;
    }).join('')}
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
  // v10.53 词典小类别折叠：点击「人物/地点/专名」标题展开/收起整组（默认折叠）
  $$('[data-gs-catfold]').forEach(grp=>{
    const t = grp.dataset.gsType;
    const toggleCat = ()=>{
      state.gsCatFold = state.gsCatFold || {};
      state.gsCatFold[t] = !state.gsCatFold[t];
      persist();
      grp.classList.toggle('gs-folded', state.gsCatFold[t]);
      const ico = grp.querySelector('.gs-cat-ico'); if(ico) ico.textContent = state.gsCatFold[t]?'▸':'▾';
    };
    const tt = grp.querySelector('.gs-title');
    if(tt){
      tt.onclick = (e)=>{ e.stopPropagation(); toggleCat(); };
      tt.onkeydown = (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggleCat(); } };
    }
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
  if(c.history.length > 50) c.history.splice(0, c.history.length - 50); // 上限50防膨胀
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
            <button class="btn ghost" data-ch-raw="${i}" title="手动提取 AI 原始响应数据，当自动更新失败时使用">🔧</button>
            ${hasChVersions(i)?`<button class="btn ghost" data-ver="${i}">📚 版本(${chVersions(i).length})</button>`:''}
            ${hasEditHistory(i)?`<button class="btn ghost" data-undo="${i}" title="撤销最近一次手动编辑">↩ 撤销编辑</button>`:''}
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
  <button class="btn ghost" data-ver="${i}" style="padding:2px 6px;font-size:11px;flex-shrink:0" title="版本历史">📚 ${chVersions(i).length}</button>
  ${wcBadge(c.content, `data-wc-ch="${i}"`)}
</div>
<span class="pill ${c.confirmed?'tag-ok':'tag-warn'}">${c.confirmed?'✓ 已确认':'待确认'}</span>
        </div>
        <textarea data-ch="${i}" style="margin-top:8px">${esc(c.content)}</textarea>
        <div class="btn-row">
          <button class="btn ghost" data-regen="${i}">🔄 重生成</button>
          <button class="btn ghost" data-read="${i}">📖 阅读</button>
          <button class="btn ghost" data-ch-raw="${i}" title="手动提取 AI 原始响应数据，当自动更新失败时使用">🔧</button>
        
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
  updateReaderProgress();   // v10.42 打开章节即复位进度条（无续读时为 0）
  try{
    const rp = JSON.parse(localStorage.getItem('fyp_rp_' + (lib.curId||'x') + '_' + i) || 'null');
    if(rp && rp.top){
      requestAnimationFrame(()=>{ const b=$('#readerBody'); if(b) b.scrollTop = rp.top; updateReaderProgress(); });
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
      updateReaderProgress();   // v10.42 滚动过程同步阅读进度条 + 悬停气泡
    }, 400);
  }, {passive:true});
}
// v10.42 阅读进度条：按 #readerBody 滚动实时计算本章进度，更新细条宽度与悬停气泡（段数/百分比）
function updateReaderProgress(){
  const b = $('#readerBody'), fill = $('#readerProgressFill'), tip = $('#readerPctTip');
  if(!b || !fill) return;
  const max = b.scrollHeight - b.clientHeight;
  const p = max>0 ? Math.min(100, Math.max(0, Math.round(b.scrollTop/max*100))) : 0;
  fill.style.width = p+'%';
  if(tip){
    const paras = b.querySelectorAll('p').length;
    tip.innerHTML = `第 <b>${p}%</b> · 全文 <b>${paras}</b> 段`;
  }
}
function closeReader(){
  const ov = $('#readerOverlay'); if(!ov) return;
  ov.classList.add('hidden');
  // 如果是导出阅读模式，恢复隐藏的按钮
  if(ov.dataset.exportReader === '1'){
    delete ov.dataset.exportReader;
    const tocBtn = $('#readerTocBtn'); if(tocBtn) tocBtn.style.display = '';
    const synBtn = $('#readerSynBtn'); if(synBtn) synBtn.style.display = '';
  }
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
  // P5 分组折叠：仅当章节数超过阈值(20)才启用；默认只展开「含已勾选章节」的分组，其余收成一行分组头（借鉴 shutters-accordion 的折叠策略 + 写作卡片的 grid 折叠动画）
  const CH_PER_GROUP = 10, EXP_GROUP_THRESHOLD = 20;
  const useGroup = state.chapters.length > EXP_GROUP_THRESHOLD;
  if(useGroup && state.expOpenGroups.length === 0){
    const selSet = new Set(state.expSel);
    const ng = Math.ceil(state.chapters.length / CH_PER_GROUP);
    state.expOpenGroups = [];
    for(let g=0; g<ng; g++){
      let has=false;
      for(let i=g*CH_PER_GROUP; i<Math.min(state.chapters.length,(g+1)*CH_PER_GROUP); i++){ if(selSet.has(i)){ has=true; break; } }
      if(has) state.expOpenGroups.push(g);
    }
  }
  const expGroupHTML = ()=>{
    const label = (c,i,ok)=> `<label class="exp-ch ${ok?'':'disabled'}"><input type="checkbox" data-expch="${i}" ${state.expSel.includes(i)?'checked':''} ${ok?'':'disabled'}><span class="exp-ch-no">第${i+1}章</span><span class="exp-ch-title">${esc(c.title||'')}</span><span class="wc">${ok? wcInner(countWords(c.content)) : '未写'}</span></label>`;
    if(!useGroup) return state.chapters.map((c,i)=> label(c,i,!!(c.content&&String(c.content).trim()))).join('');
    const n = state.chapters.length, ng = Math.ceil(n/CH_PER_GROUP);
    let out='';
    for(let g=0; g<ng; g++){
      const s=g*CH_PER_GROUP, e=Math.min(n,(g+1)*CH_PER_GROUP), open=state.expOpenGroups.includes(g);
      let items='';
      for(let i=s;i<e;i++){ const c=state.chapters[i]; items += label(c,i,!!(c.content&&String(c.content).trim())); }
      const selCnt = state.expSel.filter(i=> i>=s && i<e).length;
      out += `<div class="exp-group ${open?'open':''}" data-expgroup="${g}"><div class="exp-group-t" role="button" data-expgroup-t="${g}"><span class="exp-group-ttl">第${s+1}—${e}章</span>${selCnt?`<span class="muted exp-group-sum">已选${selCnt}</span>`:''}<span class="sc-fold-ico">${open?'▾':'▸'}</span></div><div class="exp-group-body">${items}</div></div>`;
    }
    return out;
  };
  // 资产包（story 大纲 + 章节梗概 + 章节全文）前置，与普通模式 viewExport 同款；原长篇选择/格式导出后置
  return `
    <div class="card">
      <h3>📦 导出资产包 · ${esc(title)}</h3>
      <p class="sub">汇总故事大纲 / 章节梗概 / 章节全文，复制后粘贴到文档，或下载 .md。</p>
      <div class="btn-row">
      <button id="lnCopyAll" class="btn primary">📋 复制全部</button>
<button id="lnExportReader" class="btn ghost">📖 阅读</button>
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
      <div class="exp-ch-list" data-exp-ch-list>
        ${expGroupHTML()}
      </div>
      <div class="btn-row" style="margin-top:12px">
        <button id="expTxt" class="btn">📄 导出 TXT</button>
        <button id="expEpub" class="btn">📚 导出 EPUB</button>
        <button id="expDocx" class="btn">📝 导出 DOCX</button>
      </div>
      <p id="exportStatus" class="status"></p>
    </div>`;
}

// 导出内容「阅读」模式：复用阅读器展示全文
function openExportReader(){
  const ta = $('#lnExportArea');
  if(!ta || !ta.value.trim()){ toast('暂无导出内容'); return; }
  const ov = $('#readerOverlay'); if(!ov) return;
  $('#readerTitle').textContent = `📖 全文阅读 · ${esc(state.outline?.title||'未命名')}`;
  // 解析 markdown 行，章节标题渲染为 h3，其他为段落
  const lines = ta.value.split('\n').map(l=>l.trim());
  let html = '';
  for(const l of lines){
    if(!l) continue;
    if(/^#{1,3}\s/.test(l)) html += `<h3>${esc(l.replace(/^#+\s*/,''))}</h3>`;
    else if(/^第\d+[章节]/.test(l) || /^第[一二三四五六七八九十百千]+[章节]/.test(l)) html += `<h3>${esc(l)}</h3>`;
    else html += `<p>${esc(l)}</p>`;
  }
  $('#readerBody').innerHTML = html || '<p class="muted">（暂无内容）</p>';
  // 隐藏章节目录和梗概按钮（全文阅读不适用）
  const tocBtn = $('#readerTocBtn'); if(tocBtn) tocBtn.style.display = 'none';
  const synBtn = $('#readerSynBtn'); if(synBtn) synBtn.style.display = 'none';
  // 重置滚动位置
  const body0 = $('#readerBody');
  if(body0) body0.scrollTop = 0;
  updateReaderProgress();   // v10.42 导出全文阅读打开时复位进度条
  ov.dataset.exportReader = '1';   // 标记为导出阅读模式
  ov.classList.remove('hidden');
  document.body.classList.add('reader-lock');
}

// 长篇导出「资产包」内容：故事大纲 + 逐章梗概 + 章节全文（与普通 buildMarkdown 的结构对齐，取长篇字段）
function buildLongMarkdown(){
  const o = state.outline;
  let md = `# ${o?.title||'未命名长篇小说'}\n\n`;
  md += `## 一、故事大纲\n**小说简介**：${o?.logline||''}\n\n`;
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
  md += `## 一、故事大纲\n**小说简介**：${o?.logline||''}\n\n`;
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
  $$('.cyber-home-grid [data-step]').forEach(b=> b.onclick = ()=>{ if(!guardSwitchStep()) return; currentStep = +b.dataset.step; render(); window.scrollTo(0,0); });

  // P1
  const idea = $('#ideaInput'); if(idea){
    idea.oninput = ()=> state.idea = idea.value;
    bindPolishIdea();   // v10.13 优化构想按钮 + 优化区绑定
    $('#btnGenOutline').onclick = genOutline;
  }
  // v10.18 结构骨架 / 可复用词典折叠（默认收起，点标题展开）
  $$('[data-rec-fold]').forEach(h=> h.onclick = ()=>{
    const key = h.dataset.recFold;
    state.recipeSet = state.recipeSet || {structure:null,rhythm:null,titleStyle:[]};
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
    state.recipeSet = state.recipeSet || {structure:null,rhythm:null,titleStyle:[]};
    if(state.recipeSet.structure === id){ /* 已选中，可取消 */ state.recipeSet.structure = null; }
    else { state.recipeSet.structure = id; }
    persist(); render();
  });
  // v10.58-narrow：A 窄开关「全部章节安排」：点击切换，生成大纲前选定（关则不生成/不渲染章节分组）
  $$('[data-cpon]').forEach(b=> b.onclick = ()=>{
    state.chapterPlanOn = !chapterPlanOn();
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
  bindAiRecipe();     // v10.30 AI配方助手绑定
  bindStructureFold();// v10.3 长篇结构设计栏折叠绑定
  bindStructureEdit();// P0-2 结构设计行内编辑（失焦即存 + 追加副线）
  bindChapterPlan();  // v10.11 逐章梗概区块绑定
  bindChapterPlanFold(); // v10.14 梗概卡折叠绑定
  bindChapterTitles();// v10.14 章节标题编辑 + 复制绑定
  bindWriteStyle();   // v2.0 写作风格卡片绑定（chips/浓度/预设/收藏/管理/清空）
  bindPendingGlossary();
  bindGlobalReq(); // v10.44 全书要求输入框绑定（失焦即存）
  // v10.44 全书要求：books 级风格基准，注入标题/梗概/章节内容
  function bindGlobalReq(){
    const ta = $('#globalReqInp'); if(!ta) return;
    ta.onchange = ()=>{ const oo=state.outline; if(!oo) return; oo.globalReq = ta.value.trim(); persist(); };
  }
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
 
  // 长篇：多选章节 + 三种格式导出
  if(isLong()){
    // 资产包（与普通模式同款）：复制全部 / 下载 .md
    const lnCA = $('#lnCopyAll'); if(lnCA) lnCA.onclick = ()=> copyText(buildLongMarkdown());
const lnER = $('#lnExportReader'); if(lnER) lnER.onclick = openExportReader;
    $$('#view [data-expch]').forEach(cb=> cb.onchange = ()=>{
      const i = +cb.dataset.expch;
      if(cb.checked){ if(!state.expSel.includes(i)) state.expSel.push(i); } else state.expSel = state.expSel.filter(x=>x!==i);
      persist();   // P3-4 勾选随项目快照持久化
      syncExpChecks();
    });
    const selAll = $('#expSelAll'); if(selAll) selAll.onclick = ()=>{ state.expSel = state.chapters.map((c,i)=> (c.content && String(c.content).trim())?i:null).filter(x=>x!==null); persist(); syncExpChecks(); };
    const selNone = $('#expSelNone'); if(selNone) selNone.onclick = ()=>{ state.expSel=[]; persist(); syncExpChecks(); };
    // P5 分组头点击：展开/收起该分组，状态持久化（不重渲染，仅切类）
    $$('#view [data-expgroup-t]').forEach(t=> t.onclick = ()=>{
      const g = +t.dataset.expgroupT;
      const grp = t.closest('[data-expgroup]');
      const adding = !grp.classList.contains('open');
      grp.classList.toggle('open', adding);
      const ico = t.querySelector('.sc-fold-ico'); if(ico) ico.textContent = adding ? '▾' : '▸';
      if(adding){ if(!state.expOpenGroups.includes(g)) state.expOpenGroups.push(g); }
      else state.expOpenGroups = state.expOpenGroups.filter(x=>x!==g);
      persist();
    });
    const bt = $('#expTxt'); if(bt) bt.onclick = expText;
    const be = $('#expEpub'); if(be) be.onclick = expEpub;
    const bd = $('#expDocx'); if(bd) bd.onclick = expDocx;
  }

  // 章节编辑/重生成/确认/阅读（动态）
  renderChapters();
  // 用事件委托处理章节区内部点击：分页/折叠会重建部分按钮，委托在 #chaptersWrap 上保证始终生效（Bug2 修复）
  const chaptersDelegate = (e)=>{
    const t = e.target.closest('[data-regen],[data-toggle],[data-read],[data-fold],[data-page],[data-ver],[data-undo],[data-ch-raw]');
    if(!t) return;
    if(t.hasAttribute('data-ver')){ openChapterVersionPanel(+t.dataset.ver); }
    else if(t.hasAttribute('data-undo')){ undoChapterEdit(+t.dataset.undo); }
    else if(t.hasAttribute('data-regen')){ openChapterRegenPanel(+t.dataset.regen); }
    else if(t.hasAttribute('data-ch-raw')){ openChRawPanel(+t.dataset.chRaw); }
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
  if(state.outlineHistory.length > 50) state.outlineHistory.splice(50);
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
      <div class="gs-modal-head"><b>📚 大纲版本历史（${state.outlineHistory.length}/50）</b>
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
          // v10.58-narrow：A 窄开关关闭时不做"章节安排"扁平兜底（提示词也未要求分组，保持无 chapterPlan）
          if(!hasStage && chapterPlanOn()){
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
          // v10.58-narrow：A 窄开关关闭时不兜底（无 chapterPlan），主线四格由上方 STRUCTURE_MAIN_SYS 已归一化
          if(chapterPlanOn() && (!s.chapterPlan || typeof s.chapterPlan !== 'object' || !Object.keys(s.chapterPlan).length)){
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
  if(btn){ btn.classList.add('cp-gen-btn-loading'); busy(btn,true,'生成中…'); }
  // 创建临时预览区（仅流式可用时显示）
  const cpBody = btn && btn.closest('.cp-card') && btn.closest('.cp-card').querySelector('.cp-body .cp-list');
  let preview = null;
  const isStream = currentIsDeepSeek();
  if(isStream && cpBody){
    preview = document.createElement('pre');
    preview.className = 'cp-stream-preview'; preview.textContent = '正在生成梗概…';
    cpBody.parentNode.insertBefore(preview, cpBody);
  }
  // 显示停止按钮（v10.29 挂到标题行居中；回退 action-row）
  const stopParent = btn && btn.closest('.cp-head-top') ? btn.closest('.cp-head-top') : (btn && btn.closest('.action-row') ? btn.closest('.action-row') : (btn&&btn.parentNode));
  if(stopParent) showStopBtn(stopParent);
  let _streamBuf = '';
  try{
    const titles = (o.chapters||[]).map((c,i)=> `第${i+1}章《${c&&c.title||''}》`).filter(Boolean).join(' / ');
    if(!titles){ toast('尚无章节标题'); return; }
    const parts = [];
    parts.push(`小说标题：${o.title||''}\n小说简介：${o.logline||''}\n全部章节标题：${titles}`);
    parts.push(structurePlanBlockNoTitles(o));   // 长篇结构设计（主线/副线/暗线/汇合，不含章节标题清单，避免与上方「全部章节标题」重复夹带，遵 v2.3）
    parts.push(chapterGlossaryBlock());
    if(o.globalReq) parts.push(`【全书要求（第二优先）】\n${o.globalReq}`);   // v10.44 books 级风格/对标基准，指挥逐章梗概
    const user = parts.join('\n\n') + '\n\n' + ORIGINALITY_OUTLINE_SYS;   // v10.12 防套路：方向防套路 + 人名规避（复用大纲侧）
    const onStream = delta => {
      _streamBuf += String(delta||'');
      if(preview){ preview.textContent = _streamBuf; preview.scrollTop = preview.scrollHeight; }
    };
    const txt = await callDeepSeek(CHAPTER_PLAN_SYS, user, {temperature: resolveActiveSpec().planTemp, onStream: isStream ? onStream : null, signal: _abortCtl?.signal,
  maxTokens: 15000});
    // ★ 保存原始 AI 响应，供手动提取（"原始数据"按钮用）
    state._lastCpRaw = txt; persist();
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
    
    // 从新生成梗概中提取新增实体并入词典（仿照 autoExtractGlossary 逻辑）
const planTexts = plans.filter(Boolean);
if(planTexts.length && state.glossAutoFill && sourceHasGlossary(state.outline.glossary)){
  const ext = await extractNewGlossary(planTexts);
  const n = mergeExtractedGlossary(ext);
  if(n.total > 0) persist();
}
    
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
// 把「当前全部逐章梗概」整批压入版本栈（最新在前、去重、上限50）；空则不记
function pushChapterPlansSnapshot(){
  const o = state.outline;
  if(!Array.isArray(o.chapterPlans) || !o.chapterPlans.some(Boolean)) return;
  if(!Array.isArray(o.chapterPlansHistory)) o.chapterPlansHistory = [];
  const snap = o.chapterPlans.slice();
  if(o.chapterPlansHistory.length && JSON.stringify(o.chapterPlansHistory[0].plans) === JSON.stringify(snap)) return;
  o.chapterPlansHistory.unshift({ plans: snap, ts: Date.now() });
  if(o.chapterPlansHistory.length > 50) o.chapterPlansHistory.length = 50;
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
      <div class="gs-modal-head"><b>🧭 逐章梗概 · 批量版本（${hist.length}/50）</b>
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

/* ---------- P1-1v4 手动提取 AI 原始响应（自动更新失败时手工救急） ---------- */
// 打开原始响应面板
function openCpRawPanel(){
  closeCpRawPanel();
  const o = state.outline;
  let raw = state._lastCpRaw || '';
  if(!raw && aiLog.length){
    const match = [...aiLog].reverse().find(r => r.task && r.task.includes('逐章梗概'));
    if(match && match.respLen > 0){ raw = match.resp || ''; }
  }
  const hasRaw = !!raw;
  const escRaw = esc(raw);
  const ov = document.createElement('div'); ov.id='cpRawPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal" style="max-width:780px">
      <div class="gs-modal-head"><b>🔧 原始 AI 响应 — 逐章梗概</b>
        <span style="display:flex;gap:6px">
          <button class="btn small ghost" data-cpraw-searchlog>📋 搜索最近日志</button>
          <button class="btn small ghost" data-cpraw-import>📂 导入 JSON</button>
          <button class="btn small ghost" data-cpraw-export ${hasRaw?'':'disabled'}>💾 导出 JSON</button>
          <button class="btn small ghost" data-cpraw-copy ${hasRaw?'':'disabled'}>📋 复制全部</button>
          <input type="file" id="cprawImportFile" accept=".json,application/json" hidden />
          <button class="gs-x" data-cpraw-close>✕</button>
        </span></div>
      <div class="cv-body">
        <div class="cv-div">这里是最近一次生成梗概时 AI 返回的原始 JSON 响应。如果自动更新失败，可手动点击下方按钮来提取数据。</div>
        <div class="cpraw-actions">
          <button type="button" class="btn primary" data-cpraw-apply ${hasRaw?'':'disabled'}>解析并应用到梗概</button>
          <span style="font-size:12px;color:var(--sub);align-self:center">${hasRaw?`共 ${raw.length} 字`:'（暂无原始响应数据）'}</span>
        </div>
        <div class="cpraw-tools" style="display:${hasRaw?'flex':'none'};flex-direction:column;gap:6px;border:1px solid var(--line);border-radius:8px;padding:8px 10px;background:var(--panel2);margin:6px 0">
          <div style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--sub)">
            <span>🔍 替换</span>
            <span style="font-weight:400;font-size:11px;color:var(--dim)">在下方内容中查找并替换，替换结果立即生效，点击「解析并应用到梗概」即可写入</span>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <input type="text" class="cpraw-inp" id="cprawFind" placeholder="查找..." style="flex:1;min-width:80px">
            <input type="text" class="cpraw-inp" id="cprawReplace" placeholder="替换为..." style="flex:1;min-width:80px">
            <button type="button" class="btn small" data-cpraw-replaceall>🔄 替换全部</button>
          </div>
        </div>
        <pre class="cpraw-pre">${hasRaw?escRaw:'(暂无原始响应数据。生成一次逐章梗概后，原始响应会自动保存至此。)'}</pre>
        <p class="muted" style="margin:6px 0 0;font-size:11px">💡 提示：导入 JSON 文件后自动解析并应用；替换后点「解析并应用到梗概」写入；导入的梗概会自动进入历史版本。</p>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-cpraw-close]').onclick = closeCpRawPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeCpRawPanel(); });
  // ★ 改为从 pre 元素读取最新内容（替换/导入后的内容）
  ov.querySelector('[data-cpraw-apply]').onclick = ()=>{
    const pre = ov.querySelector('.cpraw-pre');
    applyCpRawResponse(pre ? pre.textContent : raw);
  };
  ov.querySelector('[data-cpraw-searchlog]').onclick = ()=>{
    closeCpRawPanel(); openAiLogPanel();
    setTimeout(()=>{
      const rows = $$('[data-ailog-toggle]');
      if(rows.length){
        for(let i=rows.length-1; i>=0; i--){
          const taskEl = rows[i].closest('.ailog-row') && rows[i].closest('.ailog-row').querySelector('.ailog-task');
          if(taskEl && taskEl.textContent.includes('逐章梗概')){ rows[i].click(); break; }
        }
      }
    }, 300);
  };
  // 导入 JSON：点击按钮 → 触发隐藏 file input → 读取后自动调用 applyCpRawResponse
  const importBtn = ov.querySelector('[data-cpraw-import]');
  const importFile = ov.querySelector('#cprawImportFile');
  if(importBtn && importFile){
    importBtn.onclick = ()=> importFile.click();
    importFile.onchange = (e)=>{
      const f = e.target.files && e.target.files[0];
      if(f){
        const r = new FileReader();
        r.onload = ()=>{
          applyCpRawResponse(r.result);
          importFile.value = '';
        };
        r.readAsText(f);
      }
    };
  }
  // 导出 JSON：导出当前 pre 元素内容为 .json 文件
  ov.querySelector('[data-cpraw-export]').onclick = ()=>{
    const txt = ov.querySelector('.cpraw-pre').textContent;
    const blob = new Blob([txt], {type:'text/plain;charset=utf-8'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = '逐章梗概原始响应.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href); toast('✅ 已导出');
  };
  // 复制全部
  const copyBtn = ov.querySelector('[data-cpraw-copy]');
  if(copyBtn) copyBtn.onclick = ()=>{
    navigator.clipboard.writeText(ov.querySelector('.cpraw-pre').textContent)
      .then(()=> toast('✅ 已复制原始响应')).catch(()=> toast('❌ 复制失败'));
  };
  // 替换全部：替换后立即在 pre 中生效
  ov.querySelector('[data-cpraw-replaceall]').onclick = ()=>{
    const find = ov.querySelector('#cprawFind').value;
    const repl = ov.querySelector('#cprawReplace').value;
    if(!find) { toast('请输入查找内容'); return; }
    const pre = ov.querySelector('.cpraw-pre');
    const before = pre.textContent;
    const after = before.replaceAll(find, repl);
    if(before === after) { toast('未找到匹配内容'); return; }
    pre.textContent = after;
    toast('✅ 已替换 ' + (before.split(find).length - 1) + ' 处');
  };
}
function closeCpRawPanel(){ const p=$('#cpRawPanel'); if(p) p.remove(); }
// 手动解析原始响应并应用到逐章梗概
function applyCpRawResponse(raw){
  if(!raw){ toast('无原始响应数据'); return; }
  const o = state.outline;
  if(!o){ toast('无当前项目'); return; }
  try{
    const j = parseJson(raw) || {};
    const arr = Array.isArray(j.chapterPlans) ? j.chapterPlans.map(x=>String(x||'').trim()) : [];
    if(!arr.length || !arr.some(Boolean)){ toast('解析失败：未找到 chapterPlans 数组'); return; }
    const n = (o.chapters||[]).length;
    const plans = Array.from({length:n},(_,i)=> arr[i] || '');
    // 覆盖前先归档
    pushChapterPlansSnapshot();
    o.chapterPlans = plans;
    persist();
    closeCpRawPanel();
    // 就地更新 UI
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
    // 刷新版本按钮
    const actionRow = document.querySelector('.cp-card .action-row');
    if(actionRow){
      const histBtn = actionRow.querySelector('[data-cp-hist]');
      if(histBtn) histBtn.innerHTML = '📚 版本('+chapterPlansHistoryCount()+')';
    }
    bindChapterPlanFold();
    toast('✅ 已手动解析并应用 '+plans.filter(Boolean).length+' 条逐章梗概');
  }catch(e){
    toast('解析失败：'+e.message+'。请检查原始数据格式');
  }
}

/* ---------- P1-1v4 标题原始响应手动提取 ---------- */
function openTitlesRawPanel(){
  closeTitlesRawPanel();
  let raw = state._lastTitlesRaw || '';
  const hasRaw = !!raw;
  const escRaw = esc(raw);
  const ov = document.createElement('div'); ov.id='titlesRawPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal" style="max-width:780px">
      <div class="gs-modal-head"><b>🔧 原始 AI 响应 — 重生成全部标题</b>
        <span style="display:flex;gap:6px">
          <button class="btn small ghost" data-traw-searchlog>📋 搜索最近日志</button>
          <button class="gs-x" data-traw-close>✕</button>
        </span></div>
      <div class="cv-body">
        <div class="cv-div">这里是最近一次「重生成全部标题」时 AI 返回的原始 JSON 响应。如果自动更新失败，可手动点击「解析并应用到标题」来提取数据。</div>
        <div class="cpraw-actions">
          <button type="button" class="btn primary" data-traw-apply ${hasRaw?'':'disabled'}>解析并应用到标题</button>
          <span style="font-size:12px;color:var(--sub);align-self:center">${hasRaw?`共 ${raw.length} 字`:'（暂无原始响应数据）'}</span>
        </div>
        <pre class="cpraw-pre">${hasRaw?escRaw:'(暂无原始响应数据。执行一次「重生成全部标题」后，原始响应会自动保存至此。)'}</pre>
        <p class="muted" style="margin:6px 0 0;font-size:11px">💡 提示：也可点击「搜索最近日志」从 AI 请求日志中查找最近一次标题重生成响应。</p>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-traw-close]').onclick = closeTitlesRawPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeTitlesRawPanel(); });
  ov.querySelector('[data-traw-apply]').onclick = ()=> applyTitlesRawResponse(raw);
  ov.querySelector('[data-traw-searchlog]').onclick = ()=>{
    closeTitlesRawPanel(); openAiLogPanel();
    setTimeout(()=>{
      const rows = $$('[data-ailog-toggle]');
      if(rows.length){
        for(let i=rows.length-1; i>=0; i--){
          const row = rows[i]; const taskEl = row.closest('.ailog-row') && row.closest('.ailog-row').querySelector('.ailog-task');
          if(taskEl && taskEl.textContent.includes('重生成全部标题')){ row.click(); break; }
        }
      }
    }, 300);
  };
}
function closeTitlesRawPanel(){ const p=$('#titlesRawPanel'); if(p) p.remove(); }
function applyTitlesRawResponse(raw){
  if(!raw){ toast('无原始响应数据'); return; }
  const o = state.outline;
  if(!o){ toast('无当前项目'); return; }
  try{
    const j = parseJson(raw) || {};
    const titles = Array.isArray(j.titles) ? j.titles.map(t=>String(t||'').trim()).filter(Boolean) : [];
    if(!titles.length){ toast('解析失败：未找到 titles 数组'); return; }
    snapshotTitleBatch('手动提取前');
    const cnt = setAllTitles(titles);
    snapshotTitleBatch('本次提取结果');   // v10.34 记录手动提取的结果版本
    persist();
    closeTitlesRawPanel();
    // 就地更新标题行
    document.querySelectorAll('.ct-row').forEach((row,i)=>{
      const el = row.querySelector('.ct-title');
      if(el && o.chapters[i] && o.chapters[i].title){ el.textContent = o.chapters[i].title; el.title = o.chapters[i].title; }
    });
    // 刷新标题版本按钮
    const ctRow2 = document.querySelector('.ct-block .ct-row2');
    if(ctRow2){
      const batchBtn = ctRow2.querySelector('[data-ct-batch]');
      if(batchBtn) batchBtn.innerHTML = '版本('+chTitleBatches().length+'/50)';
    }
    toast('✅ 已手动解析并应用 '+cnt+' 个章节标题');
  }catch(e){ toast('解析失败：'+e.message+'。请检查原始数据格式'); }
}

/* ---------- P1-1v4 单章原始响应手动提取 ---------- */
function openChRawPanel(i){
  closeChRawPanel();
  let raw = (state._lastChapterRaw && state._lastChapterRaw[i]) || '';
  const hasRaw = !!raw;
  const escRaw = esc(raw);
  const c = state.chapters[i];
  const title = c && c.title ? c.title : ('第'+(i+1)+'章');
  const ov = document.createElement('div'); ov.id='chRawPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal" style="max-width:780px">
      <div class="gs-modal-head"><b>🔧 原始 AI 响应 — 第${i+1}章「${esc(cleanChapterTitle(title))}」</b>
        <span style="display:flex;gap:6px">
          <button class="btn small ghost" data-chraw-searchlog>📋 搜索最近日志</button>
          <button class="gs-x" data-chraw-close>✕</button>
        </span></div>
      <div class="cv-body">
        <div class="cv-div">这里是最近一次重生成本章时 AI 返回的原始响应。如果自动更新失败，可手动点击「应用原始内容到本章」来提取数据。</div>
        <div class="cpraw-actions">
          <button type="button" class="btn primary" data-chraw-apply ${hasRaw?'':'disabled'}>应用原始内容到本章</button>
          <span style="font-size:12px;color:var(--sub);align-self:center">${hasRaw?`共 ${raw.length} 字`:'（暂无原始响应数据）'}</span>
        </div>
        <pre class="cpraw-pre">${hasRaw?escRaw:'(暂无原始响应数据。执行一次本章「重生成」后，原始响应会自动保存至此。)'}</pre>
        <p class="muted" style="margin:6px 0 0;font-size:11px">💡 提示：也可点击「搜索最近日志」从 AI 请求日志中查找最近一次本章生成响应。</p>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-chraw-close]').onclick = closeChRawPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeChRawPanel(); });
  ov.querySelector('[data-chraw-apply]').onclick = ()=> applyChRawResponse(i, raw);
  ov.querySelector('[data-chraw-searchlog]').onclick = ()=>{
    closeChRawPanel(); openAiLogPanel();
    setTimeout(()=>{
      const rows = $$('[data-ailog-toggle]');
      if(rows.length){
        // 找最近一条包含"第X章"的日志（task 字段可能包含章节信息）
        const target = '第'+(i+1); // 简化匹配
        for(let i2=rows.length-1; i2>=0; i2--){
          const row = rows[i2]; const taskEl = row.closest('.ailog-row') && row.closest('.ailog-row').querySelector('.ailog-task');
          if(taskEl && taskEl.textContent.includes(target)){ row.click(); break; }
        }
      }
    }, 300);
  };
}
function closeChRawPanel(){ const p=$('#chRawPanel'); if(p) p.remove(); }
function applyChRawResponse(i, raw){
  if(!raw){ toast('无原始响应数据'); return; }
  const c = state.chapters[i];
  if(!c){ toast('无此章节'); return; }
  // 直接应用原始内容到本章
  snapshotChapterVersion(i);
  c.content = raw;
  if(!isLong()) c.confirmed = false;
  persist();
  closeChRawPanel();
  // 就地更新文本区
  const ta = document.querySelector(`textarea[data-ch="${i}"]`);
  if(ta) ta.value = raw;
  patchChapter(i);
  toast('✅ 已手动应用原始内容到第'+(i+1)+'章');
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
// v10.58-narrow：A 窄开关「全部章节安排」——生成大纲前选要/不要，"重要性高于六种结构"：关则不生成该章节分组
function chapterPlanToggleHtml(){
  const on = chapterPlanOn();
  return `
    <div class="poly-dim">
      <div class="poly-head"><span class="poly-ic">🗂️</span><b>全部章节安排</b><span class="poly-rule"></span></div>
      <div class="poly-grid">
        <button type="button" class="autoqc-toggle ${on?'active':''}" data-cpon role="switch" aria-checked="${on}">
          <span class="aqc-track"><span class="aqc-knob"></span></span>
          <span class="aqc-label">${on?'开启':'关闭'}</span>
        </button>
      </div>
    </div>`;
}

// 长篇：写作范式选择器（结构 + 可复用词典，均折叠；节奏/标题/质量 v10.18/10.60 移除）
function recipePicker(){
  const rs = state.recipeSet || {structure:null,rhythm:null};
  const selSt = selStructure();
  // 组合摘要
  const labelSt = selSt ? selSt.name : '未选';
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
    ${chapterPlanToggleHtml()}
    ${fold('🏗️','结构骨架','单选 · 可选其一', 'structure', STRUCTURES.map(it=>card(it,'structure', it.id===rs.structure)).join(''))}
    ${fold('📇','可复用词典','跨作品词典作一致性底稿', 'glossary', pendingGlossaryPanel())}
    <p class="muted" style="margin:8px 0 0">结构可选可不选；全部不选时 AI 将按构想自由发挥。章节数已在「全书章节数」填定。结构骨架/可复用词典默认折叠，点标题展开。</p>`
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
  const blocks = [];
  blocks.push(`<div class="sc-row sc-mode"><b>结构模式</b><span>${esc(s.mode || '按用户构想')}</span></div>`);
  // 主线：可编辑、不可删除（空回退 logline）
  let mainLine = s.mainLine;
  if(!mainLine || !String(mainLine).trim()) mainLine = o.logline || '';
  blocks.push(`<div class="sc-row"><b>主线</b>
    <div class="sc-editwrap">
      <textarea rows="2" class="sc-edit-in sc-edit-ta" data-sc-key="mainLine" placeholder="主线" style="resize:vertical;white-space:pre-wrap">${esc(mainLine)}</textarea>
    </div></div>`);
  // 副线：每条独立「可编辑 + ✕」；无条则显式一条空输入
  const subs = Array.isArray(s.subLines) ? s.subLines.filter(Boolean) : [];
  let subItems;
  if(!subs.length){
    subItems = `<div class="sc-editwrap">
      <input type="text" class="sc-edit-in is-empty" data-sc-edit="subLines.new" value="" placeholder="副线（空，可在此填写第一条）"/>
    </div>`;
  } else {
    subItems = subs.map((t,i)=>`<div class="sc-editwrap">
      <input type="text" class="sc-edit-in" data-sc-edit="subLines.${i}" value="${esc(String(t))}" placeholder="副线"/>
      <button type="button" class="sc-x" data-sc-del="subLines.${i}" title="删除此副线">✕</button>
    </div>`).join('');
  }
  blocks.push(`<div class="sc-row sc-sub"><b>副线</b><div class="sc-subitems">${subItems}</div></div>`);
  // 暗线 / 汇合（单值，可编辑 + ✕）
  const wrapDel = (label, key, val, ph)=>`<div class="sc-row"><b>${label}</b>
    <div class="sc-editwrap">
      <input type="text" class="sc-edit-in" data-sc-edit="${key}" value="${esc(String(val==null?'':val))}" placeholder="${ph}"/>
      <button type="button" class="sc-x" data-sc-del="${key}" title="删除此项">✕</button>
    </div></div>`;
  blocks.push(wrapDel('暗线','hiddenLine', s.hiddenLine||'', '暗线（可留空）'));
  blocks.push(wrapDel('汇合/大逆转','pivotPlan', s.pivotPlan||'', '汇合/大逆转（可留空）'));
  blocks.push(`<div class="sc-row sc-addrow"><button type="button" class="btn small ghost sc-add-sub" data-sc-add-sub>＋ 副线</button></div>`);
  // 章节安排：结构专属映射（stageChapters/beats/points）→ 回退 chapterPlan；卷/全章节为其它呈现
  // v10.58-narrow：A 窄开关关闭时整块隐藏（不渲染章节安排/分组/卷章节清单），主线四格照常显示
  if(chapterPlanOn()){
    const plan = structureChapterPlan(s, o);
    const pk = activePlanKey(s);
    if(plan && pk){
      Object.keys(plan.map).forEach(k=>{
        const arr = Array.isArray(plan.map[k]) ? plan.map[k].filter(Boolean) : [];
        blocks.push(`<div class="sc-row sc-plan"><b>${esc(k)}</b>
          <div class="sc-editwrap">
            <input type="text" class="sc-edit-in" data-sc-edit="plan:${pk}|${esc(k)}" value="${esc(arr.join('、'))}" placeholder="该维度章节（用、分隔）"/>
            <button type="button" class="sc-x" data-sc-del="plan:${pk}|${esc(k)}" title="删除该维度章节安排">✕</button>
          </div></div>`);
      });
    } else if(o.volumes && o.volumes.length){
      o.volumes.forEach((v,i)=>{
        const chs = (v.chapters||[]).map(c=>c&&c.title).filter(Boolean).join('、');
        blocks.push(`<div class="sc-row sc-vol">
          <div class="sc-volhead">
            <b>卷·${esc(v.name||('第'+(i+1)+'卷'))}</b>
            <button type="button" class="sc-x" data-sc-del="vol.${i}" title="删除整卷">✕</button>
          </div>
          <div class="sc-volbody">
            <input type="text" class="sc-edit-in" data-sc-edit="volname.${i}" value="${esc(v.name||'')}" placeholder="卷名"/>
            <input type="text" class="sc-edit-in" data-sc-edit="volchapters.${i}" value="${esc(chs)}" placeholder="该卷章节（用、分隔）"/>
          </div>
        </div>`);
      });
    }
  }
  return `<div class="card structure-card">
    <div class="sc-head" data-st-fold role="button" tabindex="0" title="展开/收起">
      <h3 style="margin:0">🏗️ 长篇结构设计</h3>
      <span class="sc-fold-ico">${state.stCollapsed?'▸':'▾'}</span>
    </div>
    <div class="sc-body"${state.stCollapsed?' hidden':''}>
      ${blocks.join('')}
      <p class="muted" style="margin:6px 0 0;font-size:11px">主线/副线/暗线/汇合/章节安排均可点 ✕ 删除（主线除外）；编辑失焦即存，不触发 AI。</p>
    </div>
  </div>`;
}
// v10.35 结构设计行内编辑：主线直写不可删；其余行 data-sc-edit 写回 / data-sc-del 删除 / sc-add-sub 追加
function activePlanKey(s){
  for(const k of ['stageChapters','beats','points','chapterPlan'])
    if(s && s[k] && typeof s[k]==='object' && Object.keys(s[k]).length) return k;
  return null;
}
function bindStructureEdit(){
  const o = state.outline; if(!o || !isLong()) return;
  if(!o.structure || typeof o.structure !== 'object') o.structure = {};
  const s = o.structure;
  // 主线：失焦即存，空回退 logline，不可删除
  $$('[data-sc-key="mainLine"]').forEach(inp=>{
    inp.onchange = ()=>{
      let v = inp.value.trim();
      if(!v) v = o.logline || '';
      s.mainLine = v; inp.value = v; inp.dataset.orig = v;
      persist(); toast('主线已保存');
    };
  });
  // 其余字段行：data-sc-edit 写回
  $$('[data-sc-edit]').forEach(inp=>{
    inp.onchange = ()=>{
      const key = inp.dataset.scEdit;
      const v = inp.value.trim();
      if(key === 'hiddenLine' || key === 'pivotPlan'){
        if(v) s[key] = v; else delete s[key];
      }
      else if(/^subLines\./.test(key)){
        if(!Array.isArray(s.subLines)) s.subLines = [];
        const idxTxt = key.split('.')[1];
        if(idxTxt === 'new') s.subLines.push(v);
        else { const idx = +idxTxt; if(idx>=0 && idx<s.subLines.length) s.subLines[idx] = v; }
        s.subLines = s.subLines.map(x=>String(x==null?'':x).trim()).filter(Boolean);
      }
      else if(/^plan:/.test(key)){
        const rest = key.slice(5), bar = rest.indexOf('|');
        if(bar >= 0){
          const pk = rest.slice(0,bar), dim = rest.slice(bar+1);
          if(s[pk] && typeof s[pk]==='object'){
            const arr = v.split(/[、，,]+/).map(x=>x.trim()).filter(Boolean);
            if(arr.length) s[pk][dim] = arr; else delete s[pk][dim];
          }
        }
      }
      else if(/^volname\./.test(key)){
        const i = +key.split('.')[1];
        if(o.volumes && o.volumes[i]) o.volumes[i].name = v;
      }
      else if(/^volchapters\./.test(key)){
        const i = +key.split('.')[1];
        const vv = o.volumes && o.volumes[i]; if(!vv) return;
        const arr = v.split(/[、，,]+/).map(x=>x.trim()).filter(Boolean);
        if(!Array.isArray(vv.chapters)) vv.chapters = [];
        arr.forEach((t,ix)=>{ if(vv.chapters[ix]) vv.chapters[ix].title = t; else vv.chapters.push({title:t}); });
        vv.chapters.length = arr.length;
      }
      inp.dataset.orig = inp.value;
      persist(); toast('结构设计已保存');
    };
  });
  // ✕ 删除
  $$('[data-sc-del]').forEach(x=>{
    x.onclick = ()=>{
      const key = x.dataset.scDel;
      if(key === 'mainLine') return;   // 主线防御：不可删除
      if(/^subLines\./.test(key)){
        const idx = +key.split('.')[1];
        if(Array.isArray(s.subLines)) s.subLines = s.subLines.filter((_,i)=>i!==idx);
      }
      else if(key === 'hiddenLine' || key === 'pivotPlan'){
        delete s[key];
      }
      else if(/^plan:/.test(key)){
        const rest = key.slice(5), bar = rest.indexOf('|');
        if(bar >= 0){
          const pk = rest.slice(0,bar), dim = rest.slice(bar+1);
          if(!confirm(`删除维度「${dim}」的章节安排？此操作不可撤销。`)) return;
          if(s[pk] && typeof s[pk]==='object') delete s[pk][dim];
          if(s[pk] && typeof s[pk]==='object' && !Object.keys(s[pk]).length) delete s[pk];
        }
      }
      else if(/^vol\./.test(key)){
        const i = +key.split('.')[1];
        const nm = (o.volumes && o.volumes[i] && o.volumes[i].name) || ('第'+(i+1)+'卷');
        if(!confirm(`删除「${nm}」？将同时移除此卷全部章节标题。`)) return;
        if(Array.isArray(o.volumes)) o.volumes.splice(i,1);
      }
      persist(); render(); toast('已删除');
    };
  });
  // ＋ 副线
  $$('[data-sc-add-sub]').forEach(btn=>{
    btn.onclick = ()=>{
      if(!Array.isArray(s.subLines)) s.subLines = [];
      s.subLines.push('新副线：');
      persist(); render();
      const inp = $('.sc-edit-in[data-sc-edit="subLines.'+(s.subLines.length-1)+'"]');
      if(inp){ inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    };
  });
}
// 拆分章节输出：AI 输出全文即正文，直接落库
// 省 token 策略：正文沿用写入时的 max_tokens 上限；
// v10.11 已去除「AI 返回本章梗概」契约（事后回填 summary 移除），v10.60 去除质检两段式修正。
function splitChapterOutput(txt){
  return { content: String(txt||'').trim(), summary: '' };
}
let _chRawBuf = null;   // P1-1v4 单章原始响应缓存，供手动提取

async function writeOneChapterContent(i, user, onPhase, onStream, styleOverride, signal){
  const mt = chapterMaxTokens();
  onPhase = onPhase || (()=>{});
  // onPhase 阶段上报；onStream 若提供则开启流式边收边显示（成本0，实时进度），否则一次性返回全文
  onPhase('撰写本章正文…');
  let txt = await callDeepSeek(longChapterSys(styleOverride), user, {maxTokens: mt, onStream, temperature: resolveActiveSpec().chapterTemp, signal: signal || _abortCtl?.signal});   // v10.8 章节温度 / v2.0 风格覆盖
  _chRawBuf = { i, raw: txt, ts: Date.now() };   // 保存原始响应供手动提取
  // v10.60 去除质检：AI 输出全文即正文，直接落库，不再做两段式查错修正
  const sp = splitChapterOutput(txt);
  return String(sp.content).trim();
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
// v2.4 章节 User 组装：按用户指定优先级（人工干预 > 全书要求 > 写作风格 > 词典）——
// ① 写作风格（第三优先）② 上一章真实正文（必须接着写）③ 本章任务+本章梗概 ④ 本章/下一章边界（禁越界，末章收束）⑤ 大纲/结构/词典+全书要求(第二优先) ⑥ 人工干预（重生成，第一优先）
// 不注入"全部章节标题"（v2.3 零夹带）；词典全字段经 chapterGlossaryBlock 注入。
const USER_PRIO_BILL = '\n\n【优先级契约】当同时存在多条用户要求时，按此裁决（高→低）：人工干预要求 > 全书要求 > 写作风格 > 设定词典。前者与后者冲突时以前者为准；设定词典（人名/地名/专名一致性）为不可逾越红线，任何要求不得破坏。';
function buildChapterUser(i, opt={}){
  const o = state.outline;
  const chap = state.chapters[i];
  const curN = i + 1;
  const parts = [];
  // ① 写作风格重申（完整配方在 System，此处点名提示；仅列「章节风格」词条，标题/梗概风格不干扰正文）
  const st = curWriteStyle(opt.styleOverride);
  const chapNames = (Array.isArray(st.tags)?st.tags:[]).map(id=>{ const s=writeStyleById(id); return s&&s.group==='element'?s.name:null; }).filter(Boolean).join('、');
  if(chapNames){
    parts.push(`【写作风格（第三优先）】写作风格：${chapNames}。完整要求见 System 中的【写作风格】块，优先级低于全书要求与人工干预，务必遵守。`);
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
  // ③ 本章任务 + 本章梗概（v10.29 「参与生成」关闭时不注入梗概，仅保留任务与自由展开）
  let task = `【本章任务】第 ${curN} 章《${chap.title}》`;
  if(state.useChapterPlans){
    const plan = (Array.isArray(o.chapterPlans) && o.chapterPlans[i]) ? String(o.chapterPlans[i]).trim() : '';
    if(plan) task += `\n【本章梗概】\n${plan}\n按此梗概写本章，细节自行展开、可合理微调。`;
  }
  parts.push(task);
  // ④ 本章边界 + 下一章边界（禁越界）/ 末章收束
  const isLast = (i + 1) >= (o.chapters||[]).length;
  let boundary = `【本章边界】本章内容须紧扣本章标题展开、不得偏离；已发生的剧情不重复叙述。`;
  if(isLast){
    boundary += `\n【全书收束】本章为全书最后一章：请收束全书，交代主要线索与人物归宿，给出结局，不留开放式烂尾。`;
  } else {
    const nextC = o.chapters[i+1];
    const nextPlan = (state.useChapterPlans && Array.isArray(o.chapterPlans) && o.chapterPlans[i+1]) ? String(o.chapterPlans[i+1]).trim() : '';
    boundary += `\n【下一章边界】下一章为第 ${i+2} 章《${(nextC&&nextC.title)||''}》${nextPlan?`，其梗概：${nextPlan}`:''}。\n本章严禁展开、暗示或提前完成下一章内容；下一章的情节一律留到下一章再写。`;
  }
  parts.push(boundary);
  // ⑤ 大纲 / 结构（无标题版）/ 词典（全字段）
  let ref = `【小说简介】书名：${o.title||''}｜一句话概览：${o.logline||''}`;
  const structCtx = longChapterContext(i);   // 含【整体结构】主线/副/暗/汇合/本章归属/卷定位（无章节标题清单）
  if(structCtx) ref += structCtx;
  ref += chapterGlossaryBlock();
  parts.push(ref);
  // ⑤b 全书要求（第二优先）：books 级风格/对标基准，指挥本章正文（低于人工干预，高于写作风格）
  if(o.globalReq){
    parts.push(`【全书要求（第二优先）】\n${o.globalReq}\n当它与写作风格或节奏要求冲突时以本书全要求为准，但仍须遵守设定词典（人名/地名/专名一致）与基础剧情逻辑。`);
  }
  parts.push(USER_PRIO_BILL);   // 统一优先级契约说明（人工干预>全书要求>写作风格>词典）
  // ⑥ 人工干预要求（重生成时）
  if(opt.advice){
    parts.push(`【人工干预要求（用户指定 · 第一优先）】\n${opt.advice}\n此为所有用户要求中的最高优先，请优先落实它；其余不受影响的内容仍保持既有文风与世界观一致（遵守设定词典红线）。`);
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
  const rpOv = { on:false, tags:[] };
  const rpCmpB = { tags:[] };
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
        <div class="advice-ai-row">
          <button type="button" class="btn small ghost" data-advice-ai="${i}">✨ AI 优化此建议</button>
          <button type="button" class="ai-upload-btn ai-hist-btn" data-advadv-hist="${i}" title="章节内容 AI 建议历史：回看已生成过的建议（随项目保存）">📖<span class="ai-hist-badge">${Array.isArray(state.contentAdviceHist)?state.contentAdviceHist.length:''}</span></button>
          <span class="muted" style="font-size:11px">AI 基于本章全文与上下文学你的要求，给出 3 个可直接采用的命令；点击即回填，可再手改</span>
        </div>
        <div data-advice-ai-out></div>
        ${histHtml}
        <div class="rp-style">
          <div class="rp-style-head" data-rpov-fold role="button" tabindex="0">
            <span>🎨 本章风格覆盖 <span class="rp-style-arrow">▸</span></span>
            <span class="muted" style="font-size:11px;font-weight:400">默认跟随全书 · 一次性不保存</span>
          </div>
          <div class="rp-style-body hidden">
           <div class="rp-ov-toggle" data-rpov-toggle>
  <span class="rp-ov-opt active" data-rpov-val="off">📖 全文</span>
  <span class="rp-ov-opt" data-rpov-val="on">🎨 仅本章</span>
</div>
            <div class="rp-style-sub hidden" id="rpOvBox">
              <div class="rp-style-label">覆盖风格（语气单选 · 质感/元素多选）</div>
              ${writeStyleChipsHtml(rpOv, 'rpov')}
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
  ov.querySelector('[data-rp-close]').onclick = closeChapterRegenPanelAll;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeChapterRegenPanelAll(); });
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
   if(st){ st.textContent = rpOvApplied ? '✔ 已确认' : (rpOv.on ? '⚠️ 待应用' : '全文，无需应用'); st.classList.toggle('ok', !!rpOvApplied); }
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
    rpOvApplied = { on:true, tags: rpOv.tags.slice() };
    refreshRpOvApply();
    toast('本章风格覆盖已应用，重生成时生效（仅本次）');
  };
  const rpcmpApplyBtn = ov.querySelector('[data-rpcmp-apply]');
  if(rpcmpApplyBtn) rpcmpApplyBtn.onclick = ()=>{
    if(!rpOv.on) return;
    rpCmpBApplied = { tags: rpCmpB.tags.slice() };
    refreshRpCmpApply();
    toast('B 稿对比风格已应用，生成 A/B 两稿时生效');
  };
  // v2.0 本章覆盖：radio 切换 + chips + 浓度（任一改动后清空确认态，须重新点「应用」）
  ov.querySelectorAll('[data-rpov-val]').forEach(el=> el.onclick = ()=>{
  ov.querySelectorAll('[data-rpov-val]').forEach(x=> x.classList.remove('active'));
  el.classList.add('active');
  rpOv.on = el.dataset.rpovVal === 'on';
  rpOvApplied = null;
  const box = ov.querySelector('#rpOvBox'); if(box) box.classList.toggle('hidden', !rpOv.on);
  refreshRpCmpState();
  refreshRpOvApply(); refreshRpCmpApply();
});

  ov.querySelectorAll('[data-rpov-tag]').forEach(b=> b.onclick = ()=>{ toggleWriteTag(rpOv, b.dataset.rpovTag); ov.querySelectorAll('[data-rpov-tag]').forEach(x=> x.classList.toggle('on', rpOv.tags.includes(x.dataset.rpovTag))); rpOvApplied = null; refreshRpOvApply(); });
  // v2.0 对比 B 风格：chips（任一改动后清空确认态，须重新点「应用」）
  ov.querySelectorAll('[data-rpcmp-tag]').forEach(b=> b.onclick = ()=>{ toggleWriteTag(rpCmpB, b.dataset.rpcmpTag); ov.querySelectorAll('[data-rpcmp-tag]').forEach(x=> x.classList.toggle('on', rpCmpB.tags.includes(x.dataset.rpcmpTag))); rpCmpBApplied = null; refreshRpCmpApply(); });
  // 生成按钮：携带「已应用」的本章覆盖（未应用则不生效，回归全书风格）
  ov.querySelector('[data-rp-plain]').onclick = ()=>{
    const btn = document.querySelector('[data-regen="'+i+'"]');
    closeChapterRegenPanel();
    pushRegen('plain','');
    const ovr = rpOvApplied ? { styleOverride: { tags: rpOvApplied.tags.slice() } } : {};
    if(rpOv.on && !rpOvApplied) toast('已按全书风格重生成（未点「✔ 应用」的覆盖不生效）');
    genOneChapter(i, btn, ovr);
  };
  ov.querySelector('[data-rp-with]').onclick = ()=>{
    const advice = $('#rpAdvice').value.trim();
    const btn = document.querySelector('[data-regen="'+i+'"]');
    closeChapterRegenPanel();
    pushRegen('advice', advice);
    const ovr = rpOvApplied ? { advice, styleOverride: { tags: rpOvApplied.tags.slice() } } : { advice };
    if(rpOv.on && !rpOvApplied) toast('已按全书风格重生成（未点「✔ 应用」的覆盖不生效）');
    genOneChapter(i, btn, ovr);
  };
  // 对比生成：A/B 均须先「应用」确认，未确认则提示
  ov.querySelector('[data-rp-compare]').onclick = ()=>{
    if(!rpOvApplied){ toast('请先在「🎨 本章风格覆盖」点「✔ 应用」确认 A 稿风格'); return; }
    if(!rpCmpBApplied){ toast('请先在「⚡ 双风格对比」点「✔ 应用」确认 B 稿风格'); return; }
    const btn = document.querySelector('[data-regen="'+i+'"]');
    const styleA = { tags: rpOvApplied.tags.slice() };
    closeChapterRegenPanel();
    genChapterCompare(i, styleA, { tags: rpCmpBApplied.tags.slice() });
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
  // v1.0.60 AI 提炼优化：触发生成 + 候选点击回填并聚焦
  const aiBtn = ov.querySelector('[data-advice-ai]');
  if(aiBtn) aiBtn.onclick = ()=>{ aiRefineAdvice(i); };
  const advH = ov.querySelector('[data-advadv-hist]');
  if(advH) advH.onclick = ()=> openAdvHistPanel('content');   // v10.59 章节内容 AI 建议历史
  ov.addEventListener('click', e=>{
    const t = e.target.closest('[data-advice-ai-pick]'); if(!t) return;
    const j = +t.dataset.adviceAiPick;
    const a = Array.isArray(aiAdviceCand) ? aiAdviceCand[j] : null; if(!a) return;
    const ta2 = $('#rpAdvice'); if(ta2){ ta2.value = a.text || ''; ta2.focus(); }
    ov.querySelectorAll('[data-advice-ai-pick]').forEach((el,k)=> el.classList.toggle('on', k===j));
  });
}
function closeChapterRegenPanel(){ const p=$('#regenPanel'); if(p) p.remove(); }

/* ---------- v1.0.60 AI 提炼优化建议（仅重生成弹窗内） ---------- */
let aiAdviceCand = null;   // {title,text}[] 候选，模块级；关闭弹窗不保留（closeChapterRegenPanel 会一并清）
function closeChapterRegenPanelAll(){ closeChapterRegenPanel(); aiAdviceCand = null; }
// 提炼 AI 所需的当前章节基础状态（上下文）
function buildAiRefineCtx(i){
  const o = state.outline || {};
  const chap = state.chapters[i] || {};
  const prev = i>0 ? (state.chapters[i-1]||{}) : null;
  const plan = (state.useChapterPlans && Array.isArray(o.chapterPlans) && o.chapterPlans[i]) ? String(o.chapterPlans[i]).trim() : '';
  const st = curWriteStyle();
  const chapNames = (Array.isArray(st.tags)?st.tags:[]).map(id=>{ const s=writeStyleById(id); return s&&s.group==='element'?s.name:null; }).filter(Boolean).join('、');
  // 人物关系摘要（词典人物）：name（身份/关系）
  const g = (o && o.glossary) || {};
  const persons = (g.characters||[]).map(c=>{
    const notes = [c.identity?`身份:${c.identity}`:'', c.relation?`关系:${c.relation}`:'', c.trait?`性格:${c.trait}`:''].filter(Boolean).join('；');
    return `${c.name||''}${notes?`（${notes}）`:''}`;
  }).join('、');
  return {
    书名: (o.title||''), 简介: (o.logline||''),
    本章标题: (chap.title||('第'+(i+1)+'章')),
    本章全文: (chap.content||''),   // 续写/扩写需全文，无字数限制，原样提供
    上一章结尾: prev && prev.content ? String(prev.content).split(/\n/).filter(Boolean).slice(-2).join('\n') : '',
    本章梗概: plan || '',
    人物关系摘要: persons || '（无）',
    当前写作风格: chapNames || '无',
    下一章标题: (o.chapters[i+1]&&o.chapters[i+1].title)||''
  };
}
function aiRefineAdvicePrompt(ctx, raw){
  return { system:[
    '你是资深网文长篇编辑。用户的建议框里写了一段粗略的修改要求（可能是续写、扩写、改段落、修正错别字、修正人物称呼等）。',
    '请把它改写成 3 条【可直接下发给章节生成 AI 的命令稿】，供用户挑选后回填。',
    '输出：仅一个 JSON 数组（3 项），无任何讲解、无 markdown 代码块前后缀。每项结构：',
    '{ "title":"一句话描述这条命令的作用", "text":"完整命令文字（可直接作为重生成建议提交）" }',
    '规则：',
    '1.充分依据给出的【上下文】（尤其本章全文、上一章结尾、本章梗概、人物关系、当前文风），让命令具体、可执行、可控幅度，不要空话。',
    '2.三条从不同角度覆盖修改需求（如：一条偏续写、一条偏扩写/细化、一条偏校改称呼与错别字），或按用户原话拆三个侧重点。',
    '3.text 用对章节 AI 说的祈使句，明确范围与幅度（增删多少、改哪一段、称呼怎么统一），不得自造与上下文冲突的设定。',
    '4.凡涉及续写/扩写，必须承接本章全文结尾、承接上一章结尾（若存在），且不越界到下一章（下一章标题为：'+ (ctx.下一章标题||'') +'）的内容。'
    ].join('\n'),
    user: JSON.stringify({ 上下文: ctx, 用户原始要求: raw }, null, 1) };
}
async function aiRefineAdvice(i){
  const ta = $('#rpAdvice'); if(!ta) return;
  const raw = ta.value.trim();
  if(!raw){ toast('请先填一点要求，再让 AI 优化'); return; }
  const out = $('[data-advice-ai-out]');
  if(out) out.innerHTML = `<p class="muted" style="margin:6px 0 0">⏳ AI 正结合本章全文优化你的建议…</p>`;
  const btn = $('[data-advice-ai]'); if(btn){ btn.disabled = true; btn.textContent = '优化中…'; }
  try{
    const ctx = buildAiRefineCtx(i);
    const {system, user} = aiRefineAdvicePrompt(ctx, raw);
    const res = await callDeepSeek(system, user, {temperature:0.6, maxTokens:1200});
    const list = parseAiJsonList(res);
    if(!Array.isArray(list) || !list.length) throw new Error('AI 未返回有效建议，请重试');
    aiAdviceCand = list.slice(0,3);
    // v10.59 生成成功即存项目快照（随项目保存，关弹窗/切页不丢；复刻配方历史）
    const _ch = state.chapters[i] || {}; const _oc = (state.outline&&state.outline.chapters&&state.outline.chapters[i])||{};
    addAdvHist('content', { id: aiHistEntryId(), ts: Date.now(), desc: '章节「'+( _ch.title || _oc.title || ('第'+(i+1)+'章') )+'」重生成建议', list: JSON.parse(JSON.stringify(list.slice(0,3))) });
    refreshAdvHistBadge('content');
  }catch(e){
    aiAdviceCand = null;
    if(out) out.innerHTML = `<p class="muted" style="color:var(--danger);margin:6px 0 0">⚠️ ${esc((e&&e.message)||'优化失败')}</p>`;
  }
  if(out) out.innerHTML = aiAdviceResultHtml();
  if(btn){ btn.disabled = false; btn.textContent = '✨ AI 优化此建议'; }
}
function aiAdviceResultHtml(){
  if(!Array.isArray(aiAdviceCand) || !aiAdviceCand.length) return '';
  return aiAdviceCand.map((a,ai)=>`
    <div class="advice-ai-cand" data-advice-ai-pick="${ai}">
      <div class="advice-ai-head">
        <span class="advice-ai-idx">${'①②③'[ai]||(ai+1)}</span>
        <b>${esc(a.title||('方案'+(ai+1)))}</b>
        <button type="button" class="advice-ai-use">✔ 采用</button>
      </div>
      <p>${esc(a.text||'')}</p>
    </div>`).join('');
}

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
    setPhase('生成 B 稿（对比风格）…');
    const txtB = await writeOneChapterContent(i, user, setPhase, null, styleB);
    chState[i] = 'done';
    openComparePanel(i, txtA, txtB);
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
function openComparePanel(i, a, b){
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
    if(ch.history.length > 50) ch.history.splice(0, ch.history.length - 50);
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
    // ★ 保存原始 AI 响应到 state，供手动提取
    if(!state._lastChapterRaw) state._lastChapterRaw = {};
    if(_chRawBuf && _chRawBuf.i === i){ state._lastChapterRaw[i] = _chRawBuf.raw; _chRawBuf = null; persist(); }
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
// 篇幅均衡自动由每章独立生成其区间保证；失败向上抛错交由批次停批。
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
  const user = `小说标题：${o.title}\n小说简介：${o.logline}\n章节：${(o.chapters||[]).map(c=>c.title).join(' / ')}\n\n请为这部小说设计封面图的出图提示词。\n模式：${state.coverWithTitle?'包含书名汉字作为封面主体文字':'纯画面、无任何文字、预留书名留白'}`;
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
        <button class="hist-del" data-del="${p.id}" title="删除作品">🗑</button>
      </div>
      <div class="hist-body">${preview}</div>
    </div>`;
  }).join('') || `<div class="hist-empty">还没有作品，点击「＋ 新建小说」开始。</div>`;
  $$('#histList [data-switch]').forEach(b=> b.onclick = ()=> switchProject(b.dataset.switch));
  $$('#histList [data-del]').forEach(b=> b.onclick = (e)=>{ e.stopPropagation(); deleteProject(b.dataset.del); });
  // 历史作品一键导出整本 .fyp 项目
  $$('#histList [data-fypexp]').forEach(b=> b.onclick = (e)=>{ e.stopPropagation(); exportProjectFile(b.dataset.fypexp); });
  // 折叠/展开单条项目详情：只影响当前项，不影响其它项的选择
  $$('#histList .hist-head').forEach(h=> h.onclick = (e)=>{
    if(e.target.closest('[data-switch]')) return;   // 点标题=切换项目，不折叠
    if(e.target.closest('[data-del]')) return;      // 删除按钮不触发折叠
    if(e.target.closest('[data-fypexp]')) return;   // .fyp 导出按钮不触发折叠
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
  $$('.tab').forEach(t=> t.onclick = ()=>{ if(!guardSwitchStep()) return; currentStep = +t.dataset.step; render(); window.scrollTo(0,0); });
  // 首次进入直接渲染主界面（不再自动弹设置；用户可随时点右上角 ☰ 配置 API Key）
  showBootLoading(false);
  render();
}
document.addEventListener('DOMContentLoaded', init);
