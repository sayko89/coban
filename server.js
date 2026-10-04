// Çoban — a persistent terminal server for coding agents.
// Terminals live in this server, not in the browser: close the tab and they keep running.

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const { createScreen, visibleLines, recentLines, detect } = require('./status');
const agents = require('./agents');
const { gitInfo } = require('./git');
const { createNotifier, riskLabel } = require('./notifier');
const { createHistory } = require('./history');
const { createRules } = require('./rules');
const { loadPlugins } = require('./plugins');
const { coded, errBody } = require('./errors');
const I18N = require('./public/i18n');

let pty;
try {
  pty = require('@homebridge/node-pty-prebuilt-multiarch');
} catch {
  pty = require('node-pty');
}

const PORT = Number(process.env.PORT) || 4800;
// Only reachable from this computer by default. Terminal access is dangerous; think before exposing it.
const HOST = process.env.HOST || '127.0.0.1';
const IS_WIN = process.platform === 'win32';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'workspaces.json');
const SCREENS_DIR = path.join(DATA_DIR, 'screens');
const BIN_DIR = path.join(__dirname, 'bin');
const BUFFER_LIMIT = 300 * 1024; // history replayed when a client reconnects (characters)
const DEMO_AGENT_CMD = `node "${path.join(__dirname, 'demo-agent.js')}"`;

// ---------- Settings (config.json) ----------

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return 'localhost';
}

function loadSettings() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read config.json:', err.message);
  }
  const approval = cfg.approval || {};
  const port = approval.port || 4801;
  return {
    ...cfg,
    approval: {
      port,
      host: approval.host || '0.0.0.0',
      url: (approval.url || `http://${lanIp()}:${port}`).replace(/\/$/, ''),
      waitSeconds: approval.waitSeconds ?? 20,
    },
  };
}

const settings = loadSettings();

// ---------- Language ----------
// The language picked in the panel is saved in data/ui.json. Emails, the phone approval page and
// the demo agent follow it. Default: "language" in config.json, otherwise English.

const UI_FILE = path.join(DATA_DIR, 'ui.json');
let uiLang = I18N.resolve(settings.language || 'en');
let langChosen = Boolean(settings.language); // false until someone picks a language: the browser's language is used then
try { uiLang = I18N.resolve(JSON.parse(fs.readFileSync(UI_FILE, 'utf8')).language || uiLang); langChosen = true; } catch { /* first run */ }
const getLang = () => uiLang;
const tr = (key, vars) => I18N.translate(uiLang, key, vars);

const notifier = createNotifier(settings, getLang);

// ---------- Events, history, rules ----------

const bus = new EventEmitter();
bus.setMaxListeners(100);
const history = createHistory(DATA_DIR);
const rules = createRules(DATA_DIR);
const AUTO_DELAY_MS = 1200; // short pause before an auto-answer so the user can see what happens

/** Writes an important event to history and announces it to plugins */
function record(type, s, data = {}) {
  const ev = history.add(type, { agent: s.name, agentId: s.id, ...data });
  bus.emit(type, ev);
  return ev;
}

// Short messages shown in the panel (plugins use these too)
const toasts = [];
let toastSeq = 0;
// "key"/"vars" let the panel translate Çoban's own messages; plugin messages may be { en: '…', tr: '…' } objects.
function toast(text, kind = 'info', source = 'Çoban', key = null, vars = null) {
  toasts.push({ id: ++toastSeq, time: Date.now(), text, kind, source, key, vars });
  if (toasts.length > 50) toasts.shift();
}

/** @type {Map<string, any>} */
const sessions = new Map();

// ---------- Persistence ----------

function saveWorkspaces() {
  const list = [...sessions.values()].map(s => ({
    id: s.id, name: s.name, workspace: s.workspace, cwd: s.cwd, command: s.command,
    agentKind: s.kind || null, createdAt: s.createdAt,
  }));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function loadWorkspaces() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}

// ---------- Terminal sessions ----------

function shellSpec() {
  if (IS_WIN) {
    // Switch output to UTF-8 so non-ASCII characters render correctly; -NoExit keeps the shell open.
    return {
      file: 'powershell.exe',
      args: ['-NoLogo', '-NoExit', '-Command', '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8'],
    };
  }
  return { file: process.env.SHELL || 'bash', args: ['-l'] };
}

function appendBuffer(s, data) {
  s.buffer += data;
  if (s.buffer.length > BUFFER_LIMIT) s.buffer = s.buffer.slice(-BUFFER_LIMIT);
}

function broadcast(s, msg) {
  const text = JSON.stringify(msg);
  for (const ws of s.clients) if (ws.readyState === 1) ws.send(text);
}

function ptyEnv(s) {
  const env = { ...process.env, COBAN_URL: `http://127.0.0.1:${PORT}`, COBAN_AGENT: s.name, COBAN_WORKSPACE: s.workspace, COBAN_LANG: uiLang };
  // Make the "coban" command available in Çoban terminals without installing anything
  const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
  env[pathKey] = `${BIN_DIR}${path.delimiter}${env[pathKey] || ''}`;
  return env;
}

function spawnPty(s, startCommand = s.command) {
  const { file, args } = shellSpec();
  const proc = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: s.cols,
    rows: s.rows,
    cwd: s.cwd,
    env: ptyEnv(s),
  });
  s.kind = agents.fromCommand(startCommand) || null;
  s.pty = proc;
  s.screen?.dispose();
  s.screen = createScreen(s.cols, s.rows);
  s.exited = false;
  s.exitCode = null;
  s.startedAt = Date.now();

  proc.onData(data => {
    s.lastOutputAt = Date.now();
    s.bufferDirty = true;
    appendBuffer(s, data);
    s.screen.write(data);
    broadcast(s, { type: 'output', data });
  });

  proc.onExit(({ exitCode }) => {
    if (s.pty !== proc) return; // an old process that was restarted
    s.exited = true;
    s.exitCode = exitCode;
    const note = `\r\n\x1b[2m[Terminal exited with code ${exitCode}. Use "Restart" to open it again.]\x1b[0m\r\n`;
    appendBuffer(s, note);
    broadcast(s, { type: 'output', data: note });
    broadcast(s, { type: 'exit', exitCode });
    record('exited', s, { code: exitCode });
  });

  // Type the start command once the shell is ready
  if (startCommand) {
    setTimeout(() => {
      if (s.pty === proc && !s.exited) proc.write(startCommand + '\r');
    }, IS_WIN ? 1200 : 300);
  }
}

function createSession({ id, name, workspace, cwd, command, createdAt }, { persist = true, initialBuffer = '', startCommand } = {}) {
  const s = {
    id: id || crypto.randomUUID().slice(0, 8),
    name,
    workspace: workspace || name,
    cwd,
    command: command || '',
    createdAt: createdAt || Date.now(),
    buffer: initialBuffer,
    clients: new Set(),
    cols: 120,
    rows: 32,
    lastOutputAt: Date.now(),
    lastInputAt: 0,
    state: 'idle',
    stateSince: Date.now(),
    prompt: null,
    answers: null,
    risk: null,
    approval: null, // { token, mailed, auto } — one-time link created while waiting for approval
  };
  sessions.set(s.id, s);
  spawnPty(s, startCommand ?? s.command);
  if (persist) {
    saveWorkspaces();
    record('created', s, { command: s.command, cwd: s.cwd });
  }
  return s;
}

function killSession(s) {
  try { s.pty?.kill(); } catch { /* already gone */ }
}

function publicView(s, { preview = false } = {}) {
  return {
    preview: preview && s.screen ? visibleLines(s.screen).slice(-10) : undefined,
    autoRule: s.approval?.auto ? { pattern: s.approval.auto.rule.pattern, answer: s.approval.auto.rule.answer } : null,
    id: s.id,
    name: s.name,
    workspace: s.workspace,
    kind: s.kind || null,
    kindLabel: agents.label(s.kind),
    git: gitInfo(s.cwd),
    cwd: s.cwd,
    command: s.command,
    createdAt: s.createdAt,
    startedAt: s.startedAt,
    exited: s.exited,
    exitCode: s.exitCode,
    viewers: s.clients.size,
    lastOutputAt: s.lastOutputAt,
    lastInputAt: s.lastInputAt,
    state: s.state,
    stateSince: s.stateSince,
    prompt: s.prompt,
    canAnswer: Boolean(s.answers),
    risk: s.risk || null,
  };
}

// ---------- State tracking and approvals ----------

function answer(s, ans, source = 'panel', rule = null) {
  if (s.state !== 'blocked' || !s.answers) throw coded('not_blocked');
  if (!['yes', 'no'].includes(ans)) throw coded('bad_answer');
  if (ans === 'yes' && source === 'auto' && s.risk) throw coded('risky_no_auto');
  s.pty.write(s.answers[ans]);
  record('answered', s, {
    answer: ans,
    source,
    waitMs: Date.now() - s.stateSince,
    question: s.prompt,
    risky: Boolean(s.risk),
    rule: rule ? rule.pattern : undefined,
  });
  if (rule) rules.used(rule.id);
  s.lastInputAt = Date.now();
  // Don't ask about the same question again until the agent produces new output
  s.state = 'working';
  s.stateSince = Date.now();
  s.approval = null;
}

function tick() {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (!s.screen) continue;
    // Right after an answer the screen may not have changed yet; give it a moment
    if (s.state === 'working' && now - s.lastInputAt < 1500 && s.lastOutputAt < s.lastInputAt) continue;

    // Recognize the agent from the screen (it may have been started by hand in the terminal)
    if (now - (s.kindCheckedAt || 0) > 2000) {
      s.kindCheckedAt = now;
      const k = agents.fromScreen(visibleLines(s.screen));
      if (k && k !== s.kind) { s.kind = k; saveWorkspaces(); }
    }

    const r = detect(s, now);
    const changed = r.state !== s.state || (r.state === 'blocked' && r.prompt !== s.prompt);
    if (changed) {
      const prev = s.state;
      s.state = r.state;
      s.stateSince = now;
      s.prompt = r.prompt || null;
      s.answers = r.answers || null;
      s.risk = r.risk || null;
      s.approval = r.state === 'blocked' ? { token: crypto.randomBytes(18).toString('hex'), mailed: false } : null;
      bus.emit('state', { time: now, agent: s.name, agentId: s.id, from: prev, to: s.state });

      if (s.state === 'blocked') {
        record('approval-requested', s, {
          question: s.prompt,
          risky: Boolean(s.risk),
          riskLabel: s.risk?.label,
          riskLine: s.risk?.line,
        });
        // Is there an auto-approval rule for this?
        const rule = s.answers ? rules.match(visibleLines(s.screen)) : null;
        if (rule) {
          if (rule.answer === 'yes' && s.risk) {
            record('rule-blocked', s, { rule: rule.pattern, riskLabel: s.risk.label, riskIds: s.risk.ids });
            toast(tr('toast.ruleBlocked', { rule: rule.pattern, agent: s.name }), 'warning', 'Çoban', 'toast.ruleBlocked', { rule: rule.pattern, agent: s.name });
          } else {
            s.approval.auto = { rule, at: now + AUTO_DELAY_MS };
          }
        }
      } else if (prev === 'working' && s.state === 'done') {
        record('done', s);
      }
    }

    // Apply a pending auto-answer once its time has come
    if (s.state === 'blocked' && s.approval?.auto && now >= s.approval.auto.at) {
      const { rule } = s.approval.auto;
      try {
        answer(s, rule.answer, 'auto', rule);
      } catch (err) {
        s.approval.auto = null;
        toast(tr('toast.autoFailed', { msg: err.message }), 'warning', 'Çoban', 'toast.autoFailed', { msg: err.message });
      }
      continue;
    }
    if (s.approval?.auto) continue; // an auto-answer is coming, don't send an email

    const waitMs = settings.approval.waitSeconds * 1000;
    if (s.state === 'blocked' && s.approval && !s.approval.mailed && notifier.enabled && now - s.stateSince >= waitMs) {
      s.approval.mailed = true;
      const link = `${settings.approval.url}/approve/${s.approval.token}`;
      console.log(`  ⚠  "${s.name}" is waiting for approval: ${link}`);
      notifier.send({
        name: s.name,
        question: s.prompt,
        lines: visibleLines(s.screen),
        link,
        canAnswer: Boolean(s.answers),
        risk: s.risk,
        panelUrl: `http://localhost:${PORT}`,
      }).then(
        () => console.log(`  ✉  Approval email sent for "${s.name}".`),
        err => console.error(`  ✉  Could not send email: ${err.message}`),
      );
    }
  }
}
setInterval(tick, 500);

// ---------- Screen history (restored after a restart) ----------

const screenFile = s => path.join(SCREENS_DIR, `${s.id}.txt`);
const keepScreens = settings.screenHistory !== false;

function saveScreens(force = false) {
  if (!keepScreens) return;
  for (const s of sessions.values()) {
    if (!s.bufferDirty && !force) continue;
    s.bufferDirty = false;
    try {
      fs.mkdirSync(SCREENS_DIR, { recursive: true });
      fs.writeFileSync(screenFile(s), s.buffer, 'utf8');
    } catch (err) {
      console.error(`Could not save screen (${s.name}):`, err.message);
    }
  }
}
setInterval(saveScreens, 10000);

function findSession(key) {
  if (sessions.has(key)) return sessions.get(key);
  return [...sessions.values()].find(s => s.name === key) || null;
}

const KEYS = {
  enter: '\r', esc: '\x1b', escape: '\x1b', tab: '\t', space: ' ', backspace: '\x7f',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  'ctrl+c': '\x03', 'ctrl+d': '\x04', 'ctrl+z': '\x1a', 'ctrl+l': '\x0c', 'shift+tab': '\x1b[Z',
};

// ---------- HTTP API ----------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/vendor/addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));

app.get('/api/info', (req, res) => {
  res.json({
    platform: process.platform,
    home: os.homedir(),
    demoCommand: DEMO_AGENT_CMD,
    mail: { enabled: notifier.enabled, to: notifier.to, waitSeconds: settings.approval.waitSeconds },
    language: langChosen ? uiLang : null,
    languages: I18N.LANGUAGES,
  });
});

app.post('/api/language', (req, res) => {
  uiLang = I18N.resolve(req.body.language);
  langChosen = true;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(UI_FILE, JSON.stringify({ language: uiLang }, null, 2), 'utf8');
  } catch (err) {
    console.error('Could not save the language:', err.message);
  }
  res.json({ language: uiLang });
});

app.post('/api/test-email', async (req, res) => {
  try {
    await notifier.test();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json(errBody(err));
  }
});

app.get('/api/sessions', (req, res) => {
  const preview = req.query.preview === '1';
  res.json([...sessions.values()].map(s => publicView(s, { preview })));
});

app.get('/api/history', (req, res) => {
  res.json(history.recent(Math.min(500, Number(req.query.limit) || 100)));
});

app.get('/api/stats', (req, res) => {
  res.json(history.stats());
});

app.get('/api/toasts', (req, res) => {
  const after = Number(req.query.after) || 0;
  res.json({ last: toastSeq, toasts: toasts.filter(t => t.id > after) });
});

app.get('/api/rules', (req, res) => res.json(rules.list()));
app.post('/api/rules', (req, res) => {
  try { res.status(201).json(rules.add(req.body)); } catch (err) { res.status(400).json(errBody(err)); }
});
app.patch('/api/rules/:id', (req, res) => {
  try { res.json(rules.update(req.params.id, req.body)); } catch (err) { res.status(404).json(errBody(err)); }
});
app.delete('/api/rules/:id', (req, res) => {
  try { rules.remove(req.params.id); res.json({ ok: true }); } catch (err) { res.status(404).json(errBody(err)); }
});

app.get('/api/plugins', (req, res) => res.json(plugins.list()));
app.patch('/api/plugins/:key', (req, res) => {
  try {
    const p = plugins.setEnabled(req.params.key, Boolean(req.body.enabled));
    res.json({ key: p.key, enabled: p.enabled });
  } catch (err) {
    res.status(404).json(errBody(err));
  }
});

app.post('/api/sessions/:id/answer', (req, res) => {
  const s = findSession(req.params.id);
  if (!s) return res.status(404).json(errBody(coded('tab_not_found')));
  try {
    answer(s, req.body.answer, req.body.source === 'cli' ? 'cli' : 'panel');
    res.json(publicView(s));
  } catch (err) {
    res.status(409).json(errBody(err));
  }
});

app.post('/api/sessions', (req, res) => {
  let name = String(req.body.name || '').trim();
  const workspace = String(req.body.workspace || '').trim() || name;
  let cwd = String(req.body.cwd || '').trim();
  let command = String(req.body.command || '').trim();

  // When adding a tab to an existing workspace, default to that workspace's folder
  const sibling = [...sessions.values()].find(s => s.workspace === workspace);
  if (!cwd) cwd = sibling ? sibling.cwd : os.homedir();
  if (!name && workspace) {
    let n = 2;
    while ([...sessions.values()].some(s => s.name === `${workspace}-${n}`)) n++;
    name = `${workspace}-${n}`;
  }

  if (!name) return res.status(400).json(errBody(coded('name_required')));
  if (/\s/.test(name)) return res.status(400).json(errBody(coded('name_spaces')));
  if ([...sessions.values()].some(s => s.name === name)) {
    return res.status(400).json(errBody(coded('name_taken', { name })));
  }
  if (cwd.startsWith('~')) cwd = path.join(os.homedir(), cwd.slice(1));
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    return res.status(400).json(errBody(coded('folder_not_found', { cwd })));
  }
  if (command === 'demo-agent') command = DEMO_AGENT_CMD;

  try {
    const s = createSession({ name, workspace, cwd, command });
    res.status(201).json(publicView(s));
  } catch (err) {
    res.status(500).json(errBody(coded('pty_failed', { msg: err.message })));
  }
});

app.get('/api/sessions/:id/read', (req, res) => {
  const s = findSession(req.params.id);
  if (!s) return res.status(404).json(errBody(coded('agent_not_found')));
  const n = Math.max(1, Math.min(2000, Number(req.query.lines) || 40));
  res.json({ ...publicView(s), lines: s.screen ? recentLines(s.screen, n) : [] });
});

app.post('/api/sessions/:id/send', (req, res) => {
  const s = findSession(req.params.id);
  if (!s) return res.status(404).json(errBody(coded('agent_not_found')));
  if (!s.pty || s.exited) return res.status(409).json(errBody(coded('terminal_exited')));
  if (s.state === 'blocked' && !req.body.force) {
    return res.status(409).json(errBody(coded('agent_blocked', { name: s.name })));
  }
  const text = String(req.body.text ?? '');
  s.lastInputAt = Date.now();
  // Write the text first and Enter a moment later: some agents treat a pasted Enter differently
  s.pty.write(text);
  if (req.body.enter !== false) setTimeout(() => s.pty && !s.exited && s.pty.write('\r'), 60);
  record('sent', s, { text: text.slice(0, 200), source: req.body.source || 'cli' });
  res.json(publicView(s));
});

app.post('/api/sessions/:id/keys', (req, res) => {
  const s = findSession(req.params.id);
  if (!s) return res.status(404).json(errBody(coded('agent_not_found')));
  if (!s.pty || s.exited) return res.status(409).json(errBody(coded('terminal_exited')));
  const keys = [].concat(req.body.keys || []);
  const seq = keys.map(k => KEYS[String(k).toLowerCase()] ?? String(k)).join('');
  s.lastInputAt = Date.now();
  s.pty.write(seq);
  res.json(publicView(s));
});

app.post('/api/sessions/:id/restart', (req, res) => {
  const s = findSession(req.params.id);
  if (!s) return res.status(404).json(errBody(coded('tab_not_found')));
  const old = s.pty;
  s.pty = null;
  try { old?.kill(); } catch { /* ignore */ }
  const note = '\r\n\x1b[2m[Terminal restarted]\x1b[0m\r\n';
  appendBuffer(s, note);
  broadcast(s, { type: 'output', data: note });
  spawnPty(s);
  record('restarted', s);
  res.json(publicView(s));
});

app.delete('/api/sessions/:id', (req, res) => {
  const s = findSession(req.params.id);
  if (!s) return res.status(404).json(errBody(coded('tab_not_found')));
  const proc = s.pty;
  s.pty = null;
  try { proc?.kill(); } catch { /* ignore */ }
  for (const ws of s.clients) ws.close(4004, 'deleted');
  s.screen?.dispose();
  s.screen = null;
  sessions.delete(s.id);
  try { fs.unlinkSync(screenFile(s)); } catch { /* fine if missing */ }
  record('removed', s);
  saveWorkspaces();
  res.json({ ok: true });
});

// ---------- WebSocket: attaching to a terminal ----------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const id = new URL(req.url, 'http://x').searchParams.get('id');
  const s = sessions.get(id);
  if (!s) return ws.close(4004, 'not found');

  s.clients.add(ws);
  // Send every new client the screen so far: pick up exactly where you left off.
  ws.send(JSON.stringify({ type: 'snapshot', data: s.buffer, exited: s.exited }));

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'input' && s.pty && !s.exited) {
      s.lastInputAt = Date.now();
      s.pty.write(msg.data);
    } else if (msg.type === 'resize') {
      const cols = Math.max(20, Math.min(500, msg.cols | 0));
      const rows = Math.max(5, Math.min(200, msg.rows | 0));
      s.cols = cols;
      s.rows = rows;
      try { s.pty?.resize(cols, rows); s.screen?.resize(cols, rows); } catch { /* process may have exited */ }
    }
  });

  ws.on('close', () => s.clients.delete(ws));
});

// ---------- Approval server (links in emails) ----------
// Runs on a separate port and serves ONLY approval pages. Exposing this port to your network
// so your phone can reach it does not expose your terminals.

const approvalApp = express();
approvalApp.use(express.urlencoded({ extended: false }));

const escHtml = t => String(t).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

function approvalPage(title, body) {
  return `<!doctype html><html lang="${uiLang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escHtml(title)} · Çoban</title>
<style>
  body{margin:0;background:#172029;color:#ece6d6;font:16px/1.5 "Segoe UI",system-ui,sans-serif;padding:24px}
  main{max-width:560px;margin:0 auto}
  h1{font-size:22px;margin:0 0 6px} p{color:#8c9aa6;margin:0 0 16px}
  pre{background:#1f2c37;padding:14px;border-radius:8px;font-size:13px;white-space:pre-wrap;overflow-x:auto}
  form{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
  button{font:inherit;font-weight:700;padding:12px 22px;border-radius:6px;border:1px solid #2c3d4a;background:transparent;color:#ece6d6;cursor:pointer}
  button.main{background:#e9a93a;border-color:#e9a93a;color:#1b1408}
  .risk{border:1px solid #d9695f;background:#3a1f1d;border-radius:8px;padding:12px 14px;margin:0 0 14px}
  .risk strong{color:#ee8a80;display:block;margin-bottom:4px}
  .risk code{font-size:13px;word-break:break-all}
</style></head><body><main>${body}</main></body></html>`;
}

function findByToken(token) {
  for (const s of sessions.values()) if (s.approval && s.approval.token === token) return s;
  return null;
}

const expiredPage = () => approvalPage(tr('page.expiredTitle'),
  `<h1>${escHtml(tr('page.expired'))}</h1><p>${escHtml(tr('page.expiredBody'))}</p>`);

approvalApp.get('/approve/:token', (req, res) => {
  const s = findByToken(req.params.token);
  if (!s) return res.status(410).send(expiredPage());
  // Mail apps may open links to build previews, so the answer is never given by GET; it takes a button press here.
  const pick = req.query.answer === 'no' ? 'no' : 'yes';
  const buttons = s.answers
    ? `<form method="post">
         <button name="answer" value="yes" class="${pick === 'yes' ? 'main' : ''}">${escHtml(tr('btn.approve'))}</button>
         <button name="answer" value="no" class="${pick === 'no' ? 'main' : ''}">${escHtml(tr('btn.reject'))}</button>
       </form>`
    : `<p>${escHtml(tr('email.inTerminal'))}</p>`;
  const riskBox = s.risk
    ? `<div class="risk"><strong>${escHtml(tr('email.risky', { label: riskLabel(uiLang, s.risk) }))}</strong><code>${escHtml(s.risk.line)}</code></div>`
    : '';
  res.send(approvalPage(s.name, `<h1>${escHtml(tr('page.waiting', { name: s.name }))}</h1><p>${escHtml(s.prompt || '')}</p>${riskBox}
    <pre>${escHtml(visibleLines(s.screen).slice(-14).join('\n'))}</pre>${buttons}`));
});

approvalApp.post('/approve/:token', (req, res) => {
  const s = findByToken(req.params.token);
  if (!s) return res.status(410).send(expiredPage());
  try {
    const ans = req.body.answer;
    answer(s, ans, 'email');
    const msg = tr(ans === 'yes' ? 'page.approved' : 'page.rejected');
    res.send(approvalPage(msg, `<h1>${escHtml(msg)}</h1><p>${escHtml(tr('page.carryOn', { name: s.name }))}</p>`));
  } catch (err) {
    const detail = err.code ? tr(`err.${err.code}`, err.vars) : err.message;
    res.status(409).send(approvalPage(tr('page.errorTitle'), `<h1>${escHtml(tr('page.error'))}</h1><p>${escHtml(detail)}</p>`));
  }
});

// ---------- Plugins ----------

const plugins = loadPlugins({
  dir: path.join(__dirname, 'plugins'),
  dataDir: DATA_DIR,
  bus,
  settings,
  api: {
    toast,
    language: getLang,
    list: () => [...sessions.values()].map(s => publicView(s)),
    send(name, text) {
      const s = [...sessions.values()].find(x => x.name === name);
      if (!s || !s.pty || s.exited) throw new Error(`No running agent named "${name}".`);
      s.lastInputAt = Date.now();
      s.pty.write(String(text) + '\r');
      record('sent', s, { text: String(text).slice(0, 200), source: 'plugin' });
    },
  },
});

// ---------- Start ----------

const restored = loadWorkspaces();
const resumeAgents = settings.resumeAgents !== false;
let resumedCount = 0;
for (const w of restored) {
  try {
    const cwd = fs.existsSync(w.cwd) ? w.cwd : os.homedir();

    // Bring back the previous screen.
    let initialBuffer = '';
    if (keepScreens) {
      try { initialBuffer = fs.readFileSync(path.join(SCREENS_DIR, `${w.id}.txt`), 'utf8'); } catch { /* nothing saved */ }
    }

    const resume = resumeAgents ? agents.resumeCommand(w.command, w.agentKind) : null;
    if (initialBuffer || resume) {
      const what = resume
        ? `Resuming the previous conversation with "${resume}".`
        : 'The previous screen is above; processes were restarted.';
      // Full-screen agents (like Claude Code) may have left the terminal in the alternate screen, so we
      // leave it, reset colors and show the cursor. Then the old screen is pushed into scrollback and the
      // screen is cleared: the new shell (especially on Windows) positions the cursor from the top of the
      // screen, and leftover content would overlap the new output.
      initialBuffer += `\x1b[?1049l\x1b[0m\x1b[?25h\r\n\x1b[2m── Çoban restarted. ${what} ──\x1b[0m`
        + '\r\n'.repeat(80) + '\x1b[H\x1b[2J';
    }
    if (resume) resumedCount++;

    createSession({ ...w, cwd }, { persist: false, initialBuffer, startCommand: resume || w.command });
  } catch (err) {
    console.error(`Could not restore "${w.name}":`, err.message);
  }
}

function shutdown() {
  saveScreens(true);
  saveWorkspaces();
  for (const s of sessions.values()) killSession(s);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  console.log(`\n  Çoban is running:  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (restored.length) {
    console.log(`  Restored ${restored.length} tab${restored.length === 1 ? '' : 's'}${resumedCount ? `, resuming ${resumedCount} agent conversation${resumedCount === 1 ? '' : 's'}` : ''}.`);
  }
  console.log('  Your terminals stay alive as long as this window is open.');
  console.log(notifier.enabled
    ? `  Email notifications on: ${notifier.to} (after ${settings.approval.waitSeconds}s of waiting)`
    : '  Email notifications off. To turn them on, copy config.example.json to config.json and fill it in.');
});

http.createServer(approvalApp).listen(settings.approval.port, settings.approval.host, () => {
  if (notifier.enabled) console.log(`  Approval links: ${settings.approval.url}\n`);
});
