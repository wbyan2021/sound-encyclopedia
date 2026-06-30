/**
 * admin-server.js — 声音大百科 API 管理后台
 *
 * 本地开发工具，提供 Web 界面：
 *   1. 查看 API Key 状态和数据统计
 *   2. 触发 AI 文案/TTS 批量生成
 *   3. 重建 manifest
 *   4. 实时终端输出
 *
 * 启动：node scripts/admin-server.js
 * 打开：http://localhost:3099
 *
 * 零外部依赖，仅使用 Node.js 内置模块。
 * 安全：仅绑定 127.0.0.1，不对外暴露。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadEnv } = require('./lib/minimax');

// 启动时加载 .env 配置
loadEnv();

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const MANIFEST_PATH = path.join(ROOT, 'data', 'manifest.json');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
const PORT = 3099;

// ============================================================
// 安全工具
// ============================================================

/** 过滤换行符，防止 .env 注入 */
function sanitizeEnvValue(val) {
  if (typeof val !== 'string') return '';
  return val.replace(/[\r\n]/g, '').trim();
}

/** 安全解析 JSON body */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ============================================================
// 工具
// ============================================================

function readJSON(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return null; }
}

function readEnvVar(key, defaultValue = '') {
  try {
    const env = fs.readFileSync(ENV_PATH, 'utf-8');
    const m = env.match(new RegExp(`${key}=(.+)`, 'm'));
    return m ? m[1].trim() : defaultValue;
  } catch { return defaultValue; }
}

function getStatus() {
  // LLM 配置（新 LLM_* 优先，回退到旧的 MINIMAX_*）
  const llmApiKey = readEnvVar('LLM_API_KEY') || readEnvVar('MINIMAX_API_KEY');
  const llmEndpoint = readEnvVar('LLM_ENDPOINT', '');
  const llmModel = readEnvVar('LLM_MODEL') || readEnvVar('MINIMAX_LLM_MODEL', 'deepseek-chat');

  // TTS 配置（新 TTS_* 优先，回退到旧的 MINIMAX_*）
  const ttsApiKey = readEnvVar('TTS_API_KEY') || readEnvVar('MINIMAX_API_KEY');
  const ttsEndpoint = readEnvVar('TTS_ENDPOINT', '');
  const ttsModel = readEnvVar('TTS_MODEL') || readEnvVar('MINIMAX_TTS_MODEL', 'Speech-2.8-HD');
  const voiceZh = readEnvVar('TTS_VOICE_ZH') || readEnvVar('MINIMAX_VOICE_ZH', '');
  const voiceEn = readEnvVar('TTS_VOICE_EN') || readEnvVar('MINIMAX_VOICE_EN', '');

  const groupId = readEnvVar('MINIMAX_GROUP_ID', '');

  const manifest = readJSON(MANIFEST_PATH);
  const totalSounds = manifest?.sounds?.length || 0;

  let aiFactCount = 0, ttsCount = 0;
  if (manifest?.sounds) {
    for (const s of manifest.sounds) {
      if (s.fun_fact_ai_generated) aiFactCount++;
      if (s.tts?.name_zh || s.tts?.name_en || s.tts?.fun_fact) ttsCount++;
    }
  }

  // 动态分类计数
  const catCounts = {};
  if (manifest?.sounds) {
    for (const s of manifest.sounds) {
      catCounts[s.category] = (catCounts[s.category] || 0) + 1;
    }
  }

  return {
    llmApiKey: llmApiKey ? '✅ 已配置' : '⚠️ 未配置',
    ttsApiKey: ttsApiKey ? '✅ 已配置' : '⚠️ 未配置',
    llmEndpoint, llmModel,
    ttsEndpoint, ttsModel,
    voiceZh, voiceEn,
    groupId,
    totalSounds, aiFactCount, ttsCount, catCounts,
    version: manifest?.version || '-',
  };
}

// ============================================================
// SSE 流式输出
// ============================================================

function createSSEStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  return { send, close: () => res.end() };
}

// ============================================================
// 运行脚本
// ============================================================

function runScript(scriptName, args = [], sse) {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);

  sse.send('status', { type: 'info', text: `▶️ node ${scriptName} ${args.join(' ')}` });

  const child = spawn('node', [scriptPath, ...args], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (data) => {
    const text = data.toString();
    sse.send('output', { text });
    if (/生成(音频)?:/.test(text)) sse.send('status', { type: 'success', text: text.trim() });
  });

  child.stderr.on('data', (data) => {
    const text = data.toString();
    sse.send('output', { text, isError: true });
    if (text.includes('❌') || text.includes('错误') || text.includes('致命'))
      sse.send('status', { type: 'error', text: text.trim() });
  });

  child.on('close', (code) => {
    if (code !== 0) sse.send('status', { type: 'error', text: `进程退出码: ${code}` });
    sse.send('done', { code });
    sse.close();
  });

  child.on('error', (err) => {
    sse.send('status', { type: 'error', text: err.message });
    sse.send('done', { code: -1 });
    sse.close();
  });
}

// ============================================================
// 路由处理
// ============================================================

async function handleAPI(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // GET /api/status
  if (url.pathname === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getStatus()));
    return;
  }

  // POST /api/run — 运行脚本（SSE 流式输出）
  if (url.pathname === '/api/run' && req.method === 'POST') {
    try {
      const { script, args } = await parseBody(req);
      const allowed = ['ai-generate-fun-fact.js', 'ai-generate-tts.js', 'build-manifest.js'];
      if (!allowed.includes(script)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '不允许的脚本' }));
        return;
      }
      const safeArgs = Array.isArray(args) ? args.filter(a => typeof a === 'string' && a.length < 200) : [];
      const sse = createSSEStream(res);
      runScript(script, safeArgs, sse);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    return;
  }

  // POST /api/save-config — 保存 .env 配置（v2：LLM/TTS 分离）
  if (url.pathname === '/api/save-config' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      let env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf-8') : '';

      const setEnvVar = (key, val) => {
        if (val === undefined || val === null || val === '') return;
        const safe = sanitizeEnvValue(val);
        const re = new RegExp(`^${key}=.*$`, 'm');
        if (re.test(env)) env = env.replace(re, `${key}=${safe}`);
        else env += `${env.endsWith('\n') ? '' : '\n'}${key}=${safe}\n`;
      };

      // 通用
      if (body.groupId) setEnvVar('MINIMAX_GROUP_ID', body.groupId);

      // LLM 组
      if (body.llmEndpoint) setEnvVar('LLM_ENDPOINT', body.llmEndpoint);
      if (body.llmApiKey) setEnvVar('LLM_API_KEY', body.llmApiKey);
      if (body.llmModel) setEnvVar('LLM_MODEL', body.llmModel);

      // TTS 组
      if (body.ttsEndpoint) setEnvVar('TTS_ENDPOINT', body.ttsEndpoint);
      if (body.ttsApiKey) setEnvVar('TTS_API_KEY', body.ttsApiKey);
      if (body.ttsModel) setEnvVar('TTS_MODEL', body.ttsModel);
      if (body.voiceZh) setEnvVar('TTS_VOICE_ZH', body.voiceZh);
      if (body.voiceEn) setEnvVar('TTS_VOICE_EN', body.voiceEn);

      fs.writeFileSync(ENV_PATH, env, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
}

// ============================================================
// 管理界面 HTML
// ============================================================

function getAdminHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🔊 声音大百科 · API 管理</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, sans-serif; background: #f5f0eb; color: #3E2723; padding: 24px; }
  h1 { font-size: 1.4rem; margin-bottom: 4px; }
  h2 { font-size: 1rem; color: #795548; margin-bottom: 16px; }

  .card { background: #fff; border-radius: 16px; padding: 20px; margin-bottom: 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); }

  .status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
  .stat { text-align: center; padding: 12px; background: #FFF8E1; border-radius: 12px; }
  .stat .val { font-size: 1.8rem; font-weight: 900; color: #FF9800; }
  .stat .lbl { font-size: 0.75rem; color: #795548; margin-top: 4px; }
  .stat.success { background: #E8F5E9; }
  .stat.success .val { color: #43A047; }
  .stat.warn { background: #FFF3E0; }
  .stat.warn .val { color: #E65100; }

  .api-status { display: inline-flex; align-items: center; gap: 8px; font-size: 0.9rem; font-weight: 600; padding: 8px 16px; border-radius: 20px; margin-bottom: 12px; }
  .api-status.ok { background: #E8F5E9; color: #2E7D32; }
  .api-status.warn { background: #FFEBEE; color: #C62828; }

  .key-form { display: flex; gap: 8px; margin-top: 12px; }
  .key-form input { flex: 1; padding: 10px 14px; border: 2px solid #E0E0E0; border-radius: 10px; font-size: 0.85rem; outline: none; font-family: monospace; }
  .key-form input:focus { border-color: #FF9800; }

  .btn { padding: 10px 20px; border: none; border-radius: 10px; font-size: 0.85rem; font-weight: 700; cursor: pointer; transition: all 0.2s; }
  .btn-primary { background: #FF9800; color: #fff; }
  .btn-primary:hover { background: #E65100; }
  .btn-outline { background: #fff; color: #FF9800; border: 2px solid #FF9800; }
  .btn-outline:hover { background: #FFF3E0; }
  .btn-sm { padding: 6px 14px; font-size: 0.8rem; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .action-row { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; align-items: center; }
  .target-select { padding: 8px 12px; border: 2px solid #E0E0E0; border-radius: 10px; font-size: 0.85rem; }

  .terminal { background: #1E1E1E; color: #D4D4D4; border-radius: 12px; padding: 16px; font-family: 'SF Mono', 'Monaco', monospace; font-size: 0.75rem; max-height: 400px; overflow-y: auto; white-space: pre-wrap; line-height: 1.5; }
  .terminal .error { color: #F44747; }
  .terminal .success { color: #6A9955; }
  .terminal .info { color: #569CD6; }
</style>
</head>
<body>

<div id="app">
  <h1>🔊 声音大百科 · API 管理</h1>
  <h2>本地 AI 内容生成控制面板（仅 127.0.0.1）</h2>

  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
      <div>
        <div class="api-status" id="api-status">加载中...</div>
        <div style="font-size:0.8rem;color:#795548">
          版本: <span id="ver">-</span> &nbsp;|&nbsp;
          Group ID: <span id="group-id" style="font-family:monospace">-</span>
        </div>
      </div>
      <button class="btn btn-outline btn-sm" onclick="refreshStatus()">🔄 刷新</button>
    </div>
    <div class="key-form" style="margin-top:8px;display:grid;grid-template-columns:1fr;gap:8px">
      <div style="display:flex;flex-direction:column;gap:4px">
        <label style="font-size:0.7rem;font-weight:700;color:#795548">🆔 Group ID（通用）</label>
        <input type="text" id="group-id-input" placeholder="如：2018549330264199533" style="padding:8px 10px;border:2px solid #E0E0E0;border-radius:10px;font-size:0.8rem;font-family:monospace;outline:none" />
      </div>
    </div>
  </div>

  <!-- LLM 配置卡片 -->
  <div class="card">
    <h2 style="margin-bottom:8px">🤖 LLM 文本模型配置</h2>
    <div style="font-size:0.75rem;color:#795548;margin-bottom:8px">用于生成儿童科普文案（fun_fact）</div>
    <div style="display:grid;grid-template-columns:1fr;gap:8px">
      <div style="display:flex;flex-direction:column;gap:4px">
        <label style="font-size:0.7rem;font-weight:700;color:#795548">🔗 Endpoint URL</label>
        <input type="text" id="llm-endpoint-input" placeholder="https://api.minimax.io/v1/chat/completions" style="padding:8px 10px;border:2px solid #E0E0E0;border-radius:10px;font-size:0.8rem;font-family:monospace;outline:none" />
      </div>
      <div style="display:flex;flex-direction:column;gap:4px">
        <label style="font-size:0.7rem;font-weight:700;color:#795548">🔑 API Key</label>
        <input type="password" id="llm-api-key-input" placeholder="LLM_API_KEY（留空则不修改）" style="padding:8px 10px;border:2px solid #E0E0E0;border-radius:10px;font-size:0.8rem;font-family:monospace;outline:none" />
      </div>
      <div style="display:flex;flex-direction:column;gap:4px">
        <label style="font-size:0.7rem;font-weight:700;color:#795548">📦 模型 ID</label>
        <select id="llm-model-input" style="padding:8px 10px;border:2px solid #E0E0E0;border-radius:10px;font-size:0.8rem;font-family:monospace;outline:none">
          <option value="deepseek-chat">deepseek-chat（推荐，DeepSeek 出品）</option>
          <option value="deepseek-reasoner">deepseek-reasoner（DeepSeek 推理模型）</option>
          <option value="abab6.5s-chat">abab6.5s-chat（MiniMax 轻量快速）</option>
          <option value="abab6.5-chat">abab6.5-chat（MiniMax 更强推理）</option>
          <option value="MiniMax-M1">MiniMax-M1（MiniMax 最新）</option>
        </select>
      </div>
    </div>
  </div>

  <!-- TTS 配置卡片 -->
  <div class="card">
    <h2 style="margin-bottom:8px">🔊 TTS 语音合成模型配置</h2>
    <div style="font-size:0.75rem;color:#795548;margin-bottom:8px">用于生成中文名 / 英文名 / 科普朗读音频</div>
    <div style="display:grid;grid-template-columns:1fr;gap:8px">
      <div style="display:flex;flex-direction:column;gap:4px">
        <label style="font-size:0.7rem;font-weight:700;color:#795548">🔗 Endpoint URL</label>
        <input type="text" id="tts-endpoint-input" placeholder="https://api.minimax.io/v1/t2a_v2" style="padding:8px 10px;border:2px solid #E0E0E0;border-radius:10px;font-size:0.8rem;font-family:monospace;outline:none" />
      </div>
      <div style="display:flex;flex-direction:column;gap:4px">
        <label style="font-size:0.7rem;font-weight:700;color:#795548">🔑 API Key</label>
        <input type="password" id="tts-api-key-input" placeholder="TTS_API_KEY（留空则不修改）" style="padding:8px 10px;border:2px solid #E0E0E0;border-radius:10px;font-size:0.8rem;font-family:monospace;outline:none" />
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
        <div style="display:flex;flex-direction:column;gap:4px">
          <label style="font-size:0.7rem;font-weight:700;color:#795548">📦 模型 ID</label>
          <select id="tts-model-input" style="padding:8px 10px;border:2px solid #E0E0E0;border-radius:10px;font-size:0.8rem;font-family:monospace;outline:none">
            <option value="Speech-2.8-HD">Speech-2.8-HD（推荐，高清）</option>
            <option value="speech-02">speech-02（高质量）</option>
            <option value="speech-01-turbo">speech-01-turbo（轻量快速）</option>
          </select>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          <label style="font-size:0.7rem;font-weight:700;color:#795548">🎙️ 中文音色</label>
          <input type="text" id="voice-zh-input" placeholder="如：female-tianmei" style="padding:8px 10px;border:2px solid #E0E0E0;border-radius:10px;font-size:0.8rem;font-family:monospace;outline:none" />
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          <label style="font-size:0.7rem;font-weight:700;color:#795548">🎙️ 英文音色</label>
          <input type="text" id="voice-en-input" placeholder="如：male-qn-qingse" style="padding:8px 10px;border:2px solid #E0E0E0;border-radius:10px;font-size:0.8rem;font-family:monospace;outline:none" />
        </div>
      </div>
    </div>
    <div style="margin-top:12px">
      <button class="btn btn-primary" onclick="saveConfig()">💾 保存所有配置</button>
    </div>
  </div>

  <div class="row status-grid">
    <div class="stat"><div class="val" id="st-total">-</div><div class="lbl">声音总数</div></div>
    <div class="stat success"><div class="val" id="st-ai">-</div><div class="lbl">🤖 AI 文案</div></div>
    <div class="stat success"><div class="val" id="st-tts">-</div><div class="lbl">🔊 TTS 朗读</div></div>
    <div class="stat warn"><div class="val" id="st-todo">-</div><div class="lbl">待处理</div></div>
  </div>

  <div class="card">
    <h2 style="margin-bottom:8px">🤖 AI 批量生成</h2>
    <div class="action-row">
      <select class="target-select" id="target-cat" onchange="onTargetChange()">
        <option value="all">全部声音</option>
        <option value="animals">🐾 动物</option>
        <option value="nature">🌳 自然</option>
        <option value="transport">🚗 交通</option>
        <option value="life">🏠 生活</option>
      </select>
      <select class="target-select" id="target-sound" style="display:none">
        <option value="">选择具体声音...</option>
      </select>
    </div>
    <div class="action-row">
      <button class="btn btn-primary" id="btn-fact" onclick="runScript('ai-generate-fun-fact.js', getAllArgs())">📝 生成科普文案</button>
      <button class="btn btn-primary" id="btn-tts" onclick="runScript('ai-generate-tts.js', getAllArgs())">🔊 生成 TTS 朗读</button>
      <button class="btn btn-outline" id="btn-build" onclick="runScript('build-manifest.js', [])">📦 重建 Manifest</button>
    </div>
    <div class="action-row">
      <button class="btn btn-outline" style="background:#E65100;color:#fff" onclick="runFullPipeline()">🚀 一键全流程</button>
      <span style="font-size:0.75rem;color:#795548">文案 + TTS + 构建</span>
    </div>
  </div>

  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <h2 style="margin:0">🖥️ 终端输出</h2>
      <button class="btn btn-outline btn-sm" onclick="clearTerminal()">清空</button>
    </div>
    <div class="terminal" id="terminal">等待指令...</div>
  </div>
</div>

<script>
  let soundList = [];

  async function refreshStatus() {
    try {
      const res = await fetch('/api/status');
      const s = await res.json();
      // 状态徽章：LLM 和 TTS 都已配置才算 OK
      const llmOk = s.llmApiKey === '✅ 已配置';
      const ttsOk = s.ttsApiKey === '✅ 已配置';
      const allOk = llmOk && ttsOk;
      const badge = document.getElementById('api-status');
      badge.textContent = allOk ? '✅ LLM + TTS 已配置' : ('⚠️ LLM ' + (llmOk ? '✅' : '❌') + ' / TTS ' + (ttsOk ? '✅' : '❌'));
      badge.className = 'api-status ' + (allOk ? 'ok' : 'warn');

      document.getElementById('ver').textContent = s.version;
      document.getElementById('group-id').textContent = s.groupId ? s.groupId.slice(0,8) + '...' : '未配置';

      document.getElementById('st-total').textContent = s.totalSounds;
      document.getElementById('st-ai').textContent = s.aiFactCount;
      document.getElementById('st-tts').textContent = s.ttsCount;
      document.getElementById('st-todo').textContent = s.totalSounds - Math.max(s.aiFactCount, s.ttsCount);

      // 回填配置表单
      document.getElementById('group-id-input').value = s.groupId || '';
      document.getElementById('llm-endpoint-input').value = s.llmEndpoint || '';
      document.getElementById('llm-model-input').value = s.llmModel || 'deepseek-chat';
      document.getElementById('tts-endpoint-input').value = s.ttsEndpoint || '';
      document.getElementById('tts-model-input').value = s.ttsModel || 'Speech-2.8-HD';
      document.getElementById('voice-zh-input').value = s.voiceZh || '';
      document.getElementById('voice-en-input').value = s.voiceEn || '';
      // API Key 输入框留空（不回填明文 key）

      // 动态更新分类计数
      const catSel = document.getElementById('target-cat');
      const cats = { all: '全部', animals: '🐾 动物', nature: '🌳 自然', transport: '🚗 交通', life: '🏠 生活' };
      for (const [id, label] of Object.entries(cats)) {
        const opt = catSel.querySelector('option[value="' + id + '"]');
        if (opt) {
          const count = id === 'all' ? s.totalSounds : (s.catCounts?.[id] || 0);
          opt.textContent = label + ' (' + count + ')';
        }
      }

      // Load manifest for sound selector
      const mf = await fetch('/data/manifest.json').then(r => r.json());
      soundList = mf.sounds || [];
    } catch(e) {}
  }

  async function saveConfig() {
    const body = {
      groupId: document.getElementById('group-id-input').value.trim() || undefined,
      llmEndpoint: document.getElementById('llm-endpoint-input').value.trim() || undefined,
      llmApiKey: document.getElementById('llm-api-key-input').value.trim() || undefined,
      llmModel: document.getElementById('llm-model-input').value || undefined,
      ttsEndpoint: document.getElementById('tts-endpoint-input').value.trim() || undefined,
      ttsApiKey: document.getElementById('tts-api-key-input').value.trim() || undefined,
      ttsModel: document.getElementById('tts-model-input').value || undefined,
      voiceZh: document.getElementById('voice-zh-input').value.trim() || undefined,
      voiceEn: document.getElementById('voice-en-input').value.trim() || undefined,
    };
    await fetch('/api/save-config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    // 清空 key 输入框（不保留明文）
    document.getElementById('llm-api-key-input').value = '';
    document.getElementById('tts-api-key-input').value = '';
    refreshStatus();
    log('✅ 配置已保存', 'success');
  }

  function onTargetChange() {
    const cat = document.getElementById('target-cat').value;
    const sel = document.getElementById('target-sound');
    sel.style.display = cat === 'all' ? 'none' : 'block';
    sel.innerHTML = '<option value="">选择具体声音...</option>' + soundList
      .filter(s => cat === 'all' || s.category === cat)
      .map(s => '<option value="' + s.id + '">' + s.emoji + ' ' + s.name_zh + ' (' + s.id + ')</option>')
      .join('');
  }

  function getAllArgs() {
    const cat = document.getElementById('target-cat').value;
    const sound = document.getElementById('target-sound').value;
    const args = [];
    if (sound) args.push('--id', sound);
    else if (cat !== 'all') args.push('--category', cat);
    return args;
  }

  function log(text, className) {
    const term = document.getElementById('terminal');
    const span = document.createElement('span');
    span.className = className || '';
    span.textContent = text;
    term.appendChild(span);
    term.scrollTop = term.scrollHeight;
  }

  function clearTerminal() {
    document.getElementById('terminal').innerHTML = '';
  }

  function setButtons(enabled) {
    ['btn-fact','btn-tts','btn-build'].forEach(id => document.getElementById(id).disabled = !enabled);
  }

  async function runScript(script, args) {
    setButtons(false);
    clearTerminal();
    log('▶️ 开始执行: node scripts/' + script + ' ' + args.join(' ') + '\\n', 'info');

    const res = await fetch('/api/run', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ script, args })
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith('event:done')) { buffer=''; break; }
        if (line.startsWith('data:')) {
          try {
            const data = JSON.parse(line.slice(5));
            if (data.text) log(data.text, data.isError ? 'error' : '');
          } catch(e) {}
        }
      }
    }

    setButtons(true);
    log('\\n✅ 完成\\n', 'success');
    refreshStatus();
  }

  async function runFullPipeline() {
    setButtons(false);
    clearTerminal();
    log('🚀 一键全流程启动\\n', 'info');

    log('📝 第1步：AI 生成科普文案...\\n', 'info');
    const args = getAllArgs();
    await runSSE('ai-generate-fun-fact.js', args.length > 0 ? ['--force', ...args] : ['--force']);

    log('\\n🔊 第2步：生成 TTS 朗读...\\n', 'info');
    await runSSE('ai-generate-tts.js', args);

    log('\\n📦 第3步：重建 Manifest...\\n', 'info');
    await runSSE('build-manifest.js', []);

    setButtons(true);
    log('\\n🎉 全流程完成！\\n', 'success');
    refreshStatus();
  }

  async function runSSE(script, args) {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ script, args })
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith('event:done')) return;
        if (line.startsWith('data:')) {
          try {
            const data = JSON.parse(line.slice(5));
            if (data.text) log(data.text, data.isError ? 'error' : '');
          } catch(e) {}
        }
      }
    }
  }

  refreshStatus();
</script>
</body>
</html>`;
}

// ============================================================
// 主服务 — 仅绑定 127.0.0.1
// ============================================================

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/data/manifest.json') {
    if (!fs.existsSync(MANIFEST_PATH)) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    handleAPI(req, res).catch(err => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(getAdminHTML());
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🔊 声音大百科 · API 管理后台`);
  console.log(`   地址: http://localhost:${PORT}（仅本机访问）\n`);
});
