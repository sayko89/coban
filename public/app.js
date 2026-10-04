// Çoban web panel

const $ = id => document.getElementById(id);
const esc = t => String(t ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const THEME = {
  background: '#0d1116', foreground: '#c9ced6', cursor: '#929ba5', cursorAccent: '#0d1116',
  selectionBackground: '#303740',
  black: '#171c22', red: '#8f6868', green: '#718477', yellow: '#948366',
  blue: '#6f7e91', magenta: '#817985', cyan: '#718589', white: '#c9ced6',
  brightBlack: '#626b76', brightRed: '#a17a79', brightGreen: '#84978a', brightYellow: '#a59577',
  brightBlue: '#8593a5', brightMagenta: '#968d99', brightCyan: '#85989b', brightWhite: '#e0e3e8',
};

const state = {
  info: { home: '', mail: {} },
  view: 'herd',          // herd | terminal | history | rules | plugins
  selectedId: null,      // the tab open in the terminal view
  sessions: [],
  stats: null,
  history: [],
  rules: [],
  plugins: [],
  toastSeq: 0,
  toastsPrimed: false,
  serverDown: false,
};
const views = new Map();  // tab id -> { term, fit, ws, el, retry, alive }
const armed = new Map();  // tabs whose risky approval has received its first click

// ---------- Language ----------
// All texts live in i18n.js. The language is saved on the server so emails follow it too.

let lang = 'en';
const t = (key, vars) => I18N.translate(lang, key, vars);
const pick = value => I18N.pick(lang, value);

function applyStatic() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
}

/** Risk label in the current language (the server sends risk ids) */
function riskText(risk) {
  return risk.ids ? risk.ids.map(id => t(`risk.${id}`)).join('; ') : risk.label;
}

/** Error text in the current language (the server sends an error code) */
function errText(data, status) {
  if (data.code && I18N.STRINGS.en[`err.${data.code}`]) return t(`err.${data.code}`, data.vars || {});
  return data.error || t('err.request', { status });
}

function renderLangSelect() {
  const sel = $('langSelect');
  const langs = state.info.languages || I18N.LANGUAGES;
  sel.innerHTML = Object.entries(langs).map(([code, label]) => `<option value="${esc(code)}">${esc(label)}</option>`).join('');
  sel.value = lang;
}

async function setLanguage(code) {
  lang = I18N.resolve(code);
  try { localStorage.setItem('coban.lang', lang); } catch {}
  applyStatic();
  renderLangSelect();
  renderMail();
  renderDesk();
  go(state.view, state.selectedId); // rebuild the current page in the new language
  api('POST', '/api/language', { language: lang }).catch(() => {});
}

$('langSelect').onchange = ev => setLanguage(ev.target.value);

// ---------- Helpers ----------

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return t('time.now');
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'always', style: 'short' });
  if (s < 60) return rtf.format(-s, 'second');
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  return rtf.format(-Math.round(s / 3600), 'hour');
}

function duration(ms) {
  if (ms == null) return '–';
  // "5s" for one-letter units, "5 sn" for longer ones
  const u = key => { const unit = t(key); return n => `${n}${unit.length === 1 ? '' : ' '}${unit}`; };
  const [S, M, H] = [u('unit.s'), u('unit.m'), u('unit.h')];
  const s = Math.round(ms / 1000);
  if (s < 60) return S(s);
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${M(m)} ${S(s % 60)}` : M(m);
  return `${H(Math.floor(m / 60))} ${M(m % 60)}`;
}

function clock(time) {
  return new Date(time).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
}

function gitText(g) {
  if (!g) return '';
  return `⎇ ${g.branch}${g.dirty ? ' *' : ''}${g.ahead ? ` ↑${g.ahead}` : ''}${g.behind ? ` ↓${g.behind}` : ''}`;
}

/** Groups tabs by workspace (keeps first-seen order) */
function groups() {
  const map = new Map();
  for (const s of state.sessions) {
    if (!map.has(s.workspace)) map.set(s.workspace, []);
    map.get(s.workspace).push(s);
  }
  return [...map.entries()].map(([name, tabs]) => ({ name, tabs, git: tabs.find(t => t.git)?.git || null, cwd: tabs[0].cwd }));
}

const ordered = () => groups().flatMap(g => g.tabs);

function statusOf(s) {
  switch (s.state) {
    case 'blocked': return { cls: 'waiting', text: t(s.risk ? 'state.blockedRisky' : 'state.blocked', { d: duration(Date.now() - s.stateSince) }) };
    case 'working': return { cls: 'running', text: t('state.working') };
    case 'done': return { cls: 'done', text: t('state.done', { ago: ago(s.stateSince) }) };
    case 'exited': return { cls: 'closed', text: t('state.exited') };
    default: return { cls: 'quiet', text: t('state.idle', { ago: ago(s.lastOutputAt) }) };
  }
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errText(data, res.status));
  return data;
}

function toast(text, kind = 'info', source = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${source ? `<small>${esc(pick(source))}</small>` : ''}${esc(pick(text))}`;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 7000);
}

// ---------- Terminal views ----------

function ensureView(s) {
  if (views.has(s.id)) return views.get(s.id);
  const el = document.createElement('div');
  el.className = 'term';
  $('terms').appendChild(el);

  const term = new Terminal({
    fontFamily: 'JetBrains Mono, Consolas, "Cascadia Mono", monospace',
    fontSize: 14,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 5000,
    theme: THEME,
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  // Catch the shortcuts before they reach the terminal
  term.attachCustomKeyEventHandler(ev => !(ev.altKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyJ', 'KeyS', 'KeyT'].includes(ev.code)));

  const view = { term, fit, el, ws: null, retry: 0, alive: true };
  term.onData(data => {
    if (view.ws && view.ws.readyState === 1) view.ws.send(JSON.stringify({ type: 'input', data }));
  });
  views.set(s.id, view);
  connect(s.id, view);
  return view;
}

function connect(id, view) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws?id=${encodeURIComponent(id)}`);
  view.ws = ws;
  ws.onopen = () => {
    view.retry = 0;
    if (state.view === 'terminal' && id === state.selectedId) sendResize(view);
  };
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'snapshot') { view.term.reset(); view.term.write(msg.data); }
    else if (msg.type === 'output') view.term.write(msg.data);
  };
  ws.onclose = ev => {
    if (!view.alive || ev.code === 4004) return;
    const delay = Math.min(8000, 500 * 2 ** view.retry++);
    setTimeout(() => view.alive && connect(id, view), delay);
  };
}

function sendResize(view) {
  try { view.fit.fit(); } catch { return; }
  if (view.ws && view.ws.readyState === 1) {
    view.ws.send(JSON.stringify({ type: 'resize', cols: view.term.cols, rows: view.term.rows }));
  }
}

function dropView(id) {
  const v = views.get(id);
  if (!v) return;
  v.alive = false;
  try { v.ws?.close(); } catch {}
  v.term.dispose();
  v.el.remove();
  views.delete(id);
}

// ---------- Switching views ----------

let pageBuilt = false;

function go(view, id = null) {
  if (view === 'terminal' && !state.sessions.some(s => s.id === id)) view = 'herd';
  state.view = view;
  state.selectedId = view === 'terminal' ? id : state.selectedId;
  try { localStorage.setItem('coban.view', view); localStorage.setItem('coban.selected', state.selectedId || ''); } catch {}

  const isTerm = view === 'terminal';
  $('terms').hidden = !isTerm;
  $('page').hidden = isTerm;
  $('termTools').hidden = !isTerm;
  $('tabs').hidden = !isTerm;
  for (const [vid, v] of views) v.el.classList.toggle('show', isTerm && vid === state.selectedId);

  for (const b of $('nav').querySelectorAll('button')) b.setAttribute('aria-current', String(b.dataset.view === view));

  if (isTerm) {
    const v = views.get(state.selectedId);
    requestAnimationFrame(() => { sendResize(v); v.term.focus(); });
  } else {
    $('page').innerHTML = '';
    $('page').scrollTop = 0;
    pageBuilt = false;
  }
  renderAll();
  if (view === 'history') loadHistory();
  if (view === 'rules') loadRules();
  if (view === 'plugins') loadPlugins();
}

// ---------- Sidebar ----------

function renderSidebar() {
  const waiting = state.sessions.filter(s => s.state === 'blocked').length;
  document.title = waiting ? `(${waiting}) Çoban` : 'Çoban';
  $('queue').innerHTML = waiting
    ? `<button id="jumpBtn" title="Alt+J">${t('queue.waiting', { n: waiting })}</button>`
    : (state.sessions.length ? esc(t('queue.none')) : '');
  if (waiting) $('jumpBtn').onclick = jumpToWaiting;

  $('navHerd').textContent = state.sessions.length || '';
  $('navHerd').classList.toggle('hot', waiting > 0);
  $('navHistory').textContent = state.stats?.today.answered ? t('nav.historyCount', { n: state.stats.today.answered }) : '';
  const activeRules = state.rules.filter(r => r.enabled).length;
  $('navRules').textContent = activeRules || '';
  const activePlugins = state.plugins.filter(p => p.enabled).length;
  $('navPlugins').textContent = state.plugins.length ? `${activePlugins}/${state.plugins.length}` : '';

  const ul = $('herd');
  ul.replaceChildren();
  if (!state.sessions.length) {
    ul.innerHTML = `<li class="empty-herd">${esc(t('herd.noWorkspaces'))}</li>`;
    return;
  }
  for (const g of groups()) {
    const wsLi = document.createElement('li');
    wsLi.className = 'ws';
    wsLi.innerHTML = `<div class="ws-head" title="${esc(g.cwd)}"><span class="ws-name">${esc(g.name)}</span><span class="branch">${esc(gitText(g.git))}</span></div><ul></ul>`;
    const inner = wsLi.querySelector('ul');
    for (const s of g.tabs) {
      const st = statusOf(s);
      const li = document.createElement('li');
      li.innerHTML = `<button aria-current="${state.view === 'terminal' && s.id === state.selectedId}" title="${esc(s.cwd)}">
        <span class="dot ${st.cls}"></span>
        <span class="row1"><span class="name">${esc(s.name)}</span>${s.kindLabel ? `<span class="kind">${esc(s.kind)}</span>` : ''}</span>
        <span class="meta ${st.cls === 'waiting' ? 'waiting' : ''}">${esc(st.text)}</span></button>`;
      li.querySelector('button').onclick = () => go('terminal', s.id);
      inner.appendChild(li);
    }
    ul.appendChild(wsLi);
  }
}

// ---------- Header and approval bar ----------

const PAGES = ['herd', 'history', 'rules', 'plugins'];

function renderHeader() {
  const s = state.sessions.find(x => x.id === state.selectedId);
  if (state.view === 'terminal' && s) {
    $('curName').textContent = s.workspace;
    $('curSub').textContent = [s.cwd, gitText(s.git)].filter(Boolean).join('   ');
    $('curSub').classList.add('mono');
    renderTabs(s);
  } else {
    const page = PAGES.includes(state.view) ? state.view : 'herd';
    $('curName').textContent = t(`page.${page}`);
    $('curSub').textContent = t(`page.${page}Sub`);
    $('curSub').classList.remove('mono');
  }

  const asking = state.view === 'terminal' && s && s.state === 'blocked';
  $('ask').classList.toggle('show', !!asking);
  $('ask').classList.toggle('risky', !!(asking && s.risk));
  if (asking) {
    $('askTitle').textContent = s.risk ? t('ask.risky', { label: riskText(s.risk) }) : t('ask.waiting');
    let text = s.risk ? s.risk.line : (s.prompt || '');
    if (s.autoRule) text = t(s.autoRule.answer === 'yes' ? 'ask.autoYes' : 'ask.autoNo', { rule: s.autoRule.pattern });
    else if (!s.canAnswer) text += `  ${t('ask.inTerminal')}`;
    $('askText').textContent = text;
    $('askBtns').hidden = !s.canAnswer || !!s.autoRule;
    paintYes($('yesBtn'), s.id);
  }
}

// ---------- Tabs ----------

function renderTabs(cur) {
  const tabs = state.sessions.filter(x => x.workspace === cur.workspace);
  const nav = $('tabs');
  nav.setAttribute('role', 'tablist');
  nav.innerHTML = tabs.map(tb => {
    const st = statusOf(tb);
    return `<button class="tab" role="tab" data-id="${esc(tb.id)}" aria-selected="${tb.id === cur.id}" title="${esc(tb.command || t('tab.shell'))}">
      <span class="dot ${st.cls}"></span>${esc(tb.name)}${tb.kindLabel ? `<span class="kind">${esc(tb.kind)}</span>` : ''}</button>`;
  }).join('') + `<button class="add" id="addTab" title="Alt+T">${esc(t('btn.addTab'))}</button>`;
  for (const b of nav.querySelectorAll('button.tab')) b.onclick = () => go('terminal', b.dataset.id);
  $('addTab').onclick = () => openNew({ workspace: cur.workspace, cwd: cur.cwd });
}

function switchTab(step) {
  const cur = state.sessions.find(x => x.id === state.selectedId);
  if (!cur) return;
  const tabs = state.sessions.filter(x => x.workspace === cur.workspace);
  const i = tabs.findIndex(x => x.id === cur.id);
  go('terminal', tabs[(i + step + tabs.length) % tabs.length].id);
}

// ---------- Approvals ----------

function paintYes(btn, id) {
  const on = armed.has(id);
  btn.classList.toggle('confirm-risk', on);
  btn.classList.toggle('primary', !on);
  btn.textContent = on ? t('btn.sure') : t('btn.approve');
}

function approve(id) {
  const s = state.sessions.find(x => x.id === id);
  if (!s) return;
  // One click is not enough for risky commands: the first click turns the button into "I'm sure"
  if (s.risk && !armed.has(id)) {
    armed.set(id, setTimeout(() => { armed.delete(id); renderAll(); }, 4000));
    renderAll();
    return;
  }
  clearTimeout(armed.get(id));
  armed.delete(id);
  reply(id, 'yes');
}

function reject(id) {
  clearTimeout(armed.get(id));
  armed.delete(id);
  reply(id, 'no');
}

async function reply(id, answer) {
  try {
    await api('POST', `/api/sessions/${id}/answer`, { answer });
  } catch (err) {
    toast(err.message, 'warning');
  }
  await refresh();
  if (state.view === 'terminal') views.get(state.selectedId)?.term.focus();
}

$('yesBtn').onclick = () => approve(state.selectedId);
$('noBtn').onclick = () => reject(state.selectedId);

// ---------- Herd view ----------

const cardEls = new Map();

function buildHerd() {
  $('page').innerHTML = `
    <div class="tally" id="tally"></div>
    <div class="cards" id="cards"></div>
    <div class="empty" id="herdEmpty" hidden>
      <h3>${esc(t('herd.emptyTitle'))}</h3>
      ${esc(t('herd.emptyBody'))}
      <div class="row">
        <button class="btn primary" data-act="new">${esc(t('btn.newWorkspace'))}</button>
        <button class="btn" data-act="demo">${esc(t('btn.openDemo'))}</button>
      </div>
    </div>`;
  $('page').querySelector('[data-act=new]').onclick = () => openNew();
  $('page').querySelector('[data-act=demo]').onclick = openDemo;
  cardEls.clear();
}

function makeCard(s) {
  const el = document.createElement('article');
  el.className = 'card';
  el.tabIndex = 0;
  el.innerHTML = `
    <div class="card-head"><span class="dot"></span><h3></h3><span class="kind" hidden></span><span class="state"></span></div>
    <div class="where"></div>
    <pre></pre>
    <div class="card-foot"><span class="note"></span>
      <button class="btn small primary" data-act="yes">${esc(t('btn.approve'))}</button>
      <button class="btn small" data-act="no">${esc(t('btn.reject'))}</button>
      <button class="btn small" data-act="open">${esc(t('btn.openTerminal'))}</button>
    </div>`;
  el.addEventListener('click', ev => {
    const act = ev.target.closest('button')?.dataset.act;
    if (act === 'yes') approve(s.id);
    else if (act === 'no') reject(s.id);
    else go('terminal', s.id);
  });
  el.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && ev.target === el) go('terminal', s.id);
  });
  return el;
}

function updateCard(el, s) {
  const st = statusOf(s);
  el.classList.toggle('waiting', s.state === 'blocked' && !s.risk);
  el.classList.toggle('risky', s.state === 'blocked' && !!s.risk);
  el.querySelector('.dot').className = `dot ${st.cls}`;
  el.querySelector('h3').textContent = s.name;
  el.querySelector('.state').textContent = st.text;
  const kind = el.querySelector('.kind');
  kind.hidden = !s.kindLabel;
  kind.textContent = s.kind || '';
  el.querySelector('.where').textContent = [s.workspace !== s.name ? s.workspace : '', gitText(s.git), s.cwd].filter(Boolean).join('   ');
  el.querySelector('pre').textContent = (s.preview || []).join('\n');

  const asking = s.state === 'blocked';
  const canClick = asking && s.canAnswer && !s.autoRule;
  const note = el.querySelector('.note');
  note.classList.toggle('risk', asking && !!s.risk);
  if (asking && s.autoRule) note.textContent = t('card.auto', { rule: s.autoRule.pattern });
  else if (asking && s.risk) note.textContent = riskText(s.risk);
  else if (asking) note.textContent = s.canAnswer ? (s.prompt || '') : t('card.inTerminal');
  else note.textContent = s.viewers ? t('card.viewers', { n: s.viewers }) : '';

  const yes = el.querySelector('[data-act=yes]');
  yes.hidden = !canClick;
  el.querySelector('[data-act=no]').hidden = !canClick;
  el.querySelector('[data-act=open]').hidden = canClick;
  el.querySelector('.card-foot').classList.toggle('stack', canClick);
  if (canClick) paintYes(yes, s.id);
}

function renderHerd() {
  const page = $('page');
  const spaces = groups();
  const firstSpace = spaces[0]?.name || 'herdr';
  const spaceRows = (spaces.length ? spaces : [{ name: 'herdr' }, { name: 'web-dashboard' }, { name: 'data-pipeline' }])
    .slice(0, 3)
    .map((space, index) => {
      const active = index === 0 ? 'active' : 'muted';
      return `<div class="space-row ${active}"><span class="space-dot"></span><span>${esc(space.name || 'workspace')}</span></div>`;
    })
    .join('');

  const agents = (state.sessions.length ? ordered() : [
    { name: 'herdr', kind: 'claude', state: 'working' },
    { name: 'explore', kind: 'opencode', state: 'idle' },
    { name: 'web-dashboard', kind: 'claude', state: 'blocked' },
    { name: 'data-pipeline', kind: 'codex', state: 'done' },
  ]).slice(0, 4).map((agent) => {
    const stateClass = agent.state === 'working' ? 'running' : agent.state === 'blocked' ? 'waiting' : agent.state === 'done' ? 'done' : 'idle';
    const label = agent.kind ? `${agent.state === 'working' ? 'working' : agent.state === 'blocked' ? 'blocked' : agent.state === 'done' ? 'done' : 'idle'} · ${agent.kind}` : 'idle · opencode';
    return `<div class="agent-row ${stateClass === 'idle' ? 'muted-agent' : ''}"><span class="agent-dot ${stateClass}"></span><span class="agent-name">${esc(agent.name)}</span><small>${esc(label)}</small></div>`;
  }).join('');

  page.innerHTML = `
    <div class="dashboard-shell">
      <aside class="dashboard-side">
        <div class="mini-label">spaces</div>
        ${spaceRows}

        <div class="mini-label agent-zone">agents</div>
        ${agents}
      </aside>

      <div class="dashboard-main">
        <div class="terminal-window left-pane">
          <div class="window-header">
            <div class="title-badge">claude</div>
            <div class="window-controls"><span></span><span></span><span></span></div>
          </div>
          <div class="terminal-body">
            <div class="prompt-line"><span class="prompt">&gt;</span> make the herd dev hero mock look exactly like real claude code</div>
            <div class="prompt-line"><span class="prompt">•</span> I read the real pane over the socket — the mock was on v2.1.168...</div>
            <div class="prompt-line"><span class="prompt">•</span> Plan: index.html — swap the old layout and move the screen closer to the real thing.</div>
            <div class="prompt-line"><span class="prompt">•</span> perfect, and make the dialogue about this mock feel like a real terminal, not a generic app.</div>
            <div class="prompt-line warning">Baking... (13m 42s · esc to interrupt)</div>
          </div>
          <div class="input-row">
            <span class="prompt">~</span>
            <span class="command">bypass permissions on <span class="hot">shift+tab</span> to cycle</span>
          </div>
        </div>

        <div class="terminal-window right-pane">
          <div class="window-header">
            <div class="title-badge purple">bun</div>
            <div class="window-controls"><span></span><span></span><span></span></div>
          </div>
          <div class="terminal-body compact">
            <div class="mini-line">run dev</div>
            <div class="mini-line">Local http://localhost:4321/</div>
            <div class="mini-line"><span class="green">astro</span> v5.18.1 ready in 668 ms</div>
            <div class="mini-line">watching for file changes...</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ---------- History ----------

function describe(e) {
  const a = { agent: e.agent };
  switch (e.type) {
    case 'created': return { cls: 'quiet', text: t('ev.created', a), detail: e.command || '' };
    case 'approval-requested': return e.risky
      ? { cls: 'closed', text: t('ev.requestedRisky', a), detail: e.riskLine }
      : { cls: 'waiting', text: t('ev.requested', a), detail: e.question };
    case 'answered': return {
      cls: e.answer === 'yes' ? 'running' : 'closed',
      text: t(e.answer === 'yes' ? 'ev.approved' : 'ev.rejected', { ...a, source: t(`source.${e.source}`), wait: duration(e.waitMs) }),
      detail: e.rule ? t('ev.ruleDetail', { rule: e.rule }) : '',
    };
    case 'rule-blocked': return { cls: 'closed', text: t('ev.ruleBlocked', { ...a, rule: e.rule }), detail: e.riskIds ? riskText({ ids: e.riskIds }) : e.riskLabel };
    case 'done': return { cls: 'done', text: t('ev.done', a), detail: '' };
    case 'sent': return { cls: 'running', text: t(e.source === 'plugin' ? 'ev.sentPlugin' : 'ev.sentCli', a), detail: e.text };
    case 'exited': return { cls: 'closed', text: t('ev.exited', a), detail: t('ev.exitCode', { code: e.code }) };
    case 'removed': return { cls: 'quiet', text: t('ev.removed', a), detail: '' };
    case 'restarted': return { cls: 'quiet', text: t('ev.restarted', a), detail: '' };
    default: return { cls: 'quiet', text: `${e.agent || ''} ${e.type}`, detail: '' };
  }
}

async function loadHistory() {
  try {
    [state.stats, state.history] = await Promise.all([api('GET', '/api/stats'), api('GET', '/api/history?limit=60')]);
  } catch { return; }
  if (state.view === 'history') renderHistory();
  renderSidebar();
}

function renderHistory() {
  const d = state.stats?.today;
  if (!d) return;
  const tiles = [
    ['', d.requested, t('tile.requested')],
    ['good', d.answered, t('tile.answered')],
    ['hot', d.auto, t('tile.auto')],
    ['', duration(d.avgWaitMs), t('tile.avgWait')],
    ['risk', d.risky, t('tile.risky')],
    ['good', d.finished, t('tile.finished')],
  ];
  if (d.savedMs) tiles.push(['good', duration(d.savedMs), t('tile.saved')]);

  const agents = state.stats.agents;
  const maxWait = Math.max(1, ...agents.map(a => a.waitMs));
  const rows = agents.map(a => `<tr>
      <td>${esc(a.name)}</td>
      <td class="num">${a.requests}</td>
      <td class="num"><span class="bar" style="width:${Math.round((a.waitMs / maxWait) * 120)}px"></span>${duration(a.waitMs)}</td>
      <td class="num">${a.auto}</td>
      <td class="num">${a.finished}</td>
    </tr>`).join('');

  const events = state.history.map(e => {
    const d = describe(e);
    return `<li><time>${clock(e.time)}</time><span class="dot ${d.cls}"></span>
      <div>${esc(d.text)}${d.detail ? `<div class="detail">${esc(d.detail)}</div>` : ''}</div></li>`;
  }).join('');

  $('page').innerHTML = `
    <div class="tiles">${tiles.map(([cls, n, label]) => `<div class="tile ${cls}"><b>${esc(n)}</b><span>${esc(label)}</span></div>`).join('')}</div>
    <h3 class="block">${esc(t('hist.byAgent'))}</h3>
    ${agents.length ? `<div class="table-wrap"><table>
      <thead><tr><th>${esc(t('hist.agent'))}</th><th>${esc(t('hist.requests'))}</th><th>${esc(t('hist.totalWait'))}</th><th>${esc(t('hist.auto'))}</th><th>${esc(t('hist.finished'))}</th></tr></thead>
      <tbody>${rows}</tbody></table></div>` : `<p class="page-intro">${esc(t('hist.nothing'))}</p>`}
    <h3 class="block">${esc(t('hist.recent'))}</h3>
    ${events ? `<ul class="timeline">${events}</ul>` : `<p class="page-intro">${esc(t('hist.empty'))}</p>`}`;
}

// ---------- Auto-approve rules ----------

const SUGGESTIONS = ['npm test', 'npm run lint', 'pytest', 'git status', 'git diff', 'ls'];

async function loadRules() {
  try { state.rules = await api('GET', '/api/rules'); } catch { return; }
  if (state.view === 'rules') renderRules();
  renderSidebar();
}

function renderRules() {
  if (!pageBuilt) {
    $('page').innerHTML = `
      <p class="page-intro">${esc(t('rules.intro'))}</p>
      <p class="guard">${esc(t('rules.guard'))}</p>
      <form class="rule-form" id="ruleForm">
        <label class="grow">${esc(t('rules.pattern'))}
          <input type="text" id="rPattern" class="mono" placeholder="npm test" autocomplete="off" required></label>
        <label>${esc(t('rules.match'))}
          <select id="rMatch"><option value="contains">${esc(t('rules.contains'))}</option><option value="regex">${esc(t('rules.regex'))}</option></select></label>
        <label>${esc(t('rules.answer'))}
          <select id="rAnswer"><option value="yes">${esc(t('btn.approve'))}</option><option value="no">${esc(t('btn.reject'))}</option></select></label>
        <button class="btn primary" type="submit">${esc(t('rules.add'))}</button>
      </form>
      <div class="chips">${esc(t('rules.suggestions'))} ${SUGGESTIONS.map(x => `<button class="chip" type="button" data-s="${esc(x)}">${esc(x)}</button>`).join('')}</div>
      <ul class="rules" id="rulesList"></ul>`;
    $('ruleForm').onsubmit = async ev => {
      ev.preventDefault();
      try {
        await api('POST', '/api/rules', { pattern: $('rPattern').value, match: $('rMatch').value, answer: $('rAnswer').value });
        $('rPattern').value = '';
        toast(t('rules.added'), 'success');
        loadRules();
      } catch (err) { toast(err.message, 'warning'); }
    };
    for (const chip of $('page').querySelectorAll('.chip')) {
      chip.onclick = () => { $('rPattern').value = chip.dataset.s; $('rPattern').focus(); };
    }
    pageBuilt = true;
  }

  const list = $('rulesList');
  if (!state.rules.length) {
    list.innerHTML = `<li style="display:block;color:var(--mist)">${esc(t('rules.empty'))}</li>`;
    return;
  }
  list.innerHTML = state.rules.map(r => `
    <li class="${r.enabled ? '' : 'off'}" data-id="${esc(r.id)}">
      <label class="switch" title="${esc(t(r.enabled ? 'sw.off' : 'sw.on'))}"><input type="checkbox" ${r.enabled ? 'checked' : ''} aria-label="${esc(t('rules.toggle'))}"><span></span></label>
      <div><code>${esc(r.pattern)}</code>
        <div class="info">${esc(t(r.match === 'regex' ? 'rules.infoRegex' : 'rules.infoContains'))}, ${esc(r.uses ? t('rules.used', { n: r.uses, ago: ago(r.lastUsed) }) : t('rules.notUsed'))}</div></div>
      <span class="badge ${r.answer === 'yes' ? 'yes' : 'no'}">${esc(t(r.answer === 'yes' ? 'rules.approves' : 'rules.rejects'))}</span>
      <button class="btn small danger" data-act="del">${esc(t('btn.delete'))}</button>
    </li>`).join('');
  for (const li of list.querySelectorAll('li[data-id]')) {
    const id = li.dataset.id;
    li.querySelector('input').onchange = async ev => {
      await api('PATCH', `/api/rules/${id}`, { enabled: ev.target.checked }).catch(err => toast(err.message, 'warning'));
      loadRules();
    };
    li.querySelector('[data-act=del]').onclick = async () => {
      await api('DELETE', `/api/rules/${id}`).catch(err => toast(err.message, 'warning'));
      loadRules();
    };
  }
}

// ---------- Plugins ----------

async function loadPlugins() {
  try { state.plugins = await api('GET', '/api/plugins'); } catch { return; }
  if (state.view === 'plugins') renderPlugins();
  renderSidebar();
}

const PLUGIN_EXAMPLE = `// plugins/hello.js
module.exports = {
  name: 'Hello',
  description: 'Shows a message in the panel when an agent finishes.',
  start(coban) {
    coban.on('done', event => {
      coban.toast(\`\${event.agent} finished, nice work!\`);
    });
  },
};`;

function renderPlugins() {
  const cards = state.plugins.map(p => `
    <div class="plugin ${p.enabled ? '' : 'off'}" data-key="${esc(p.key)}">
      <div class="plugin-head"><h3>${esc(pick(p.name))}</h3>
        <label class="switch" title="${esc(t(p.enabled ? 'sw.off' : 'sw.on'))}"><input type="checkbox" ${p.enabled ? 'checked' : ''} aria-label="${esc(t('plugins.toggle', { name: pick(p.name) }))}"><span></span></label></div>
      <p>${esc(pick(p.description))}</p>
      ${p.status ? `<div class="status">${esc(pick(p.status))}</div>` : ''}
      ${p.error ? `<div class="err">${esc(t('plugins.error', { msg: p.error }))}</div>` : ''}
      ${p.log.length ? `<ul>${p.log.slice(0, 4).map(k => `<li>${clock(k.time)} ${esc(pick(k.message))}</li>`).join('')}</ul>` : ''}
    </div>`).join('');

  $('page').innerHTML = `
    <p class="page-intro">${t('plugins.intro')}</p>
    <div class="plugins">${cards || `<p class="page-intro">${esc(t('plugins.none'))}</p>`}</div>
    <h3 class="block">${esc(t('plugins.writeOwn'))}</h3>
    <p class="page-intro">${t('plugins.writeIntro')}</p>
    <div class="code">${esc(PLUGIN_EXAMPLE)}</div>`;

  for (const card of $('page').querySelectorAll('.plugin')) {
    card.querySelector('input').onchange = async ev => {
      await api('PATCH', `/api/plugins/${card.dataset.key}`, { enabled: ev.target.checked }).catch(err => toast(err.message, 'warning'));
      loadPlugins();
    };
  }
}

// ---------- Render everything ----------

function renderAll() {
  renderSidebar();
  renderHeader();
  if (state.view === 'herd') renderHerd();
}

async function refresh() {
  try {
    state.sessions = await api('GET', `/api/sessions${state.view === 'herd' ? '?preview=1' : ''}`);
    if (state.serverDown) { state.serverDown = false; $('banner').classList.remove('show'); }
  } catch {
    state.serverDown = true;
    $('banner').classList.add('show');
    return;
  }
  notifyWaiting();
  const ids = new Set(state.sessions.map(s => s.id));
  for (const id of [...views.keys()]) if (!ids.has(id)) dropView(id);
  for (const s of state.sessions) ensureView(s);
  if (state.view === 'terminal' && !ids.has(state.selectedId)) { go('herd'); return; }
  renderAll();
}

async function pollToasts() {
  try {
    const r = await api('GET', `/api/toasts?after=${state.toastSeq}`);
    // Don't show old messages on first load, only new ones from now on
    if (state.toastsPrimed) for (const m of r.toasts) toast(m.key ? t(m.key, m.vars || {}) : m.text, m.kind, m.source);
    state.toastSeq = r.last;
    state.toastsPrimed = true;
  } catch { /* server down, stay quiet */ }
}

// ---------- Actions ----------

function openNew(preset = {}) {
  $('newTitle').textContent = preset.workspace ? t('dlg.newTab', { ws: preset.workspace }) : t('dlg.newWorkspace');
  $('newSubmit').textContent = preset.workspace ? t('btn.openTab') : t('btn.openWorkspace');
  $('fWs').value = preset.workspace || '';
  $('wsList').innerHTML = groups().map(g => `<option value="${esc(g.name)}">`).join('');
  $('fName').placeholder = preset.workspace ? t('dlg.namePh', { ws: preset.workspace }) : 'web-dashboard';
  $('fName').value = preset.name || '';
  $('fCwd').value = preset.cwd || '';
  $('fCwd').placeholder = state.info.home;
  $('fCmd').value = preset.command || '';
  $('fError').textContent = '';
  $('newDialog').showModal();
  $('fName').focus();
}

async function createWorkspace(body) {
  const s = await api('POST', '/api/sessions', body);
  await refresh();
  go('terminal', s.id);
}

async function openDemo() {
  let n = 1;
  const names = new Set(state.sessions.map(s => s.name));
  while (names.has(`demo-agent-${n}`)) n++;
  try {
    await createWorkspace({ name: `demo-agent-${n}`, cwd: '', command: 'demo-agent' });
  } catch (err) {
    toast(err.message, 'warning');
  }
}

$('newForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  $('fError').textContent = '';
  try {
    await createWorkspace({ name: $('fName').value, workspace: $('fWs').value, cwd: $('fCwd').value, command: $('fCmd').value });
    $('newDialog').close();
  } catch (err) {
    $('fError').textContent = err.message;
  }
});
$('cancelBtn').onclick = () => $('newDialog').close();
$('newBtn').onclick = () => openNew();
$('demoBtn').onclick = openDemo;
for (const b of $('nav').querySelectorAll('button')) b.onclick = () => go(b.dataset.view);

$('restartBtn').onclick = async () => {
  if (!state.selectedId) return;
  await api('POST', `/api/sessions/${state.selectedId}/restart`).catch(err => toast(err.message, 'warning'));
  refresh();
};
$('deleteBtn').onclick = async () => {
  const s = state.sessions.find(x => x.id === state.selectedId);
  if (!s) return;
  if (!confirm(t('confirm.close', { name: s.name }))) return;
  await api('DELETE', `/api/sessions/${s.id}`).catch(err => toast(err.message, 'warning'));
  go('herd');
  refresh();
};

// ---------- Shortcuts ----------

function jumpToWaiting() {
  const waiting = ordered().filter(s => s.state === 'blocked');
  if (!waiting.length) return;
  const i = state.view === 'terminal' ? waiting.findIndex(s => s.id === state.selectedId) : -1;
  go('terminal', waiting[(i + 1) % waiting.length].id);
}

window.addEventListener('keydown', ev => {
  if (!ev.altKey || $('newDialog').open) return;
  if (ev.code === 'KeyJ') { ev.preventDefault(); jumpToWaiting(); return; }
  if (ev.code === 'KeyS') { ev.preventDefault(); go('herd'); return; }
  if (ev.code === 'KeyT') {
    ev.preventDefault();
    const cur = state.sessions.find(x => x.id === state.selectedId);
    if (state.view === 'terminal' && cur) openNew({ workspace: cur.workspace, cwd: cur.cwd });
    else openNew();
    return;
  }
  if (ev.code === 'ArrowLeft' || ev.code === 'ArrowRight') {
    if (state.view !== 'terminal') return;
    ev.preventDefault();
    switchTab(ev.code === 'ArrowRight' ? 1 : -1);
    return;
  }
  if (ev.code !== 'ArrowUp' && ev.code !== 'ArrowDown') return;
  ev.preventDefault();
  const list = ordered();
  if (!list.length) return;
  const cur = state.view === 'terminal' ? list.findIndex(s => s.id === state.selectedId) : -1;
  const step = ev.code === 'ArrowDown' ? 1 : -1;
  const next = cur === -1 ? (step === 1 ? 0 : list.length - 1) : (cur + step + list.length) % list.length;
  go('terminal', list[next].id);
}, true);

// ---------- Email and desktop notifications ----------

function renderMail() {
  const m = state.info.mail || {};
  const box = $('mail');
  if (!m.enabled) {
    box.innerHTML = `<span>${esc(t('mail.off'))}</span>`;
    return;
  }
  box.innerHTML = `<span>${esc(t('mail.to', { to: m.to }))}</span><button class="linkish" id="testMail">${esc(t('mail.test'))}</button>`;
  box.title = t('mail.title', { n: m.waitSeconds });
  $('testMail').onclick = async () => {
    $('testMail').textContent = t('mail.sending');
    try {
      await api('POST', '/api/test-email');
      $('testMail').textContent = t('mail.sent');
    } catch (err) {
      $('testMail').textContent = t('mail.test');
      toast(t('mail.failed', { msg: err.message }), 'warning');
    }
  };
}

const notified = new Set();
function deskEnabled() {
  try { return 'Notification' in window && Notification.permission === 'granted' && localStorage.getItem('coban.desk') !== 'off'; }
  catch { return false; }
}
function renderDesk() {
  const box = $('desk');
  if (!('Notification' in window)) { box.hidden = true; return; }
  const on = deskEnabled();
  box.innerHTML = `<span>${esc(t('desk.label', { state: t(on ? 'desk.on' : 'desk.off') }))}</span><button class="linkish" id="deskBtn">${esc(t(on ? 'sw.off' : 'sw.on'))}</button>`;
  $('deskBtn').onclick = async () => {
    if (on) { try { localStorage.setItem('coban.desk', 'off'); } catch {} }
    else if (await Notification.requestPermission() === 'granted') { try { localStorage.removeItem('coban.desk'); } catch {} }
    renderDesk();
  };
}
function notifyWaiting() {
  for (const s of state.sessions) {
    const key = `${s.id}:${s.stateSince}`;
    if (s.state !== 'blocked' || s.autoRule || notified.has(key)) continue;
    notified.add(key);
    if (!deskEnabled() || (document.hasFocus() && state.view === 'terminal' && s.id === state.selectedId)) continue;
    const n = new Notification(t('notif.title', { name: s.name }), {
      body: s.risk ? t('notif.risky', { line: s.risk.line }) : (s.prompt || ''),
      tag: s.id,
    });
    n.onclick = () => { window.focus(); go('terminal', s.id); n.close(); };
  }
}

new ResizeObserver(() => {
  if (state.view !== 'terminal') return;
  const v = views.get(state.selectedId);
  if (v) sendResize(v);
}).observe($('terms'));

// ---------- Start ----------

(async () => {
  state.info = await api('GET', '/api/info').catch(() => state.info);
  // The server's saved language wins, so emails and the panel always match
  // On the very first run, follow the browser's language and tell the server
  const saved = (() => { try { return localStorage.getItem('coban.lang'); } catch { return null; } })();
  lang = I18N.resolve(state.info.language || saved || navigator.language);
  if (!state.info.language) api('POST', '/api/language', { language: lang }).catch(() => {});
  applyStatic();
  renderLangSelect();
  renderMail();
  renderDesk();
  let view = 'herd';
  let selected = null;
  try { view = localStorage.getItem('coban.view') || 'herd'; selected = localStorage.getItem('coban.selected') || null; } catch {}
  if (!['herd', 'terminal', 'history', 'rules', 'plugins'].includes(view)) view = 'herd';
  state.view = view === 'terminal' ? 'herd' : view; // load the tabs first, then open the terminal
  await Promise.all([refresh(), loadRules(), loadPlugins(), loadHistory(), pollToasts()]);
  go(view, selected);

  setInterval(refresh, 1500);
  setInterval(pollToasts, 2000);
  setInterval(() => (state.view === 'history' ? loadHistory() : api('GET', '/api/stats').then(s => { state.stats = s; renderSidebar(); }).catch(() => {})), 4000);
  setInterval(() => { if (state.view === 'rules') loadRules(); }, 5000);
  setInterval(() => { if (state.view === 'plugins') loadPlugins(); }, 5000);
})();
