const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const BASE_URL = 'http://localhost:4800';
const VIDEO_DIR = path.join(__dirname, 'recordings');
const VIEWPORT = { width: 1440, height: 900 };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const startedAt = process.hrtime.bigint();

let browser;
let context;
let page;
let video;

function heading(number, title) {
  console.log(`\n${'='.repeat(72)}\n=== ${number}/9 ${title.toLocaleUpperCase('tr-TR')} ===\n${'='.repeat(72)}`);
}

async function api(route, method = 'GET', body) {
  let response;
  try {
    response = await fetch(new URL(route, BASE_URL), {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    throw new Error(`Cannot reach ${BASE_URL}. Keep the server running, then retry. (${error.message})`);
  }

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const message = data?.error || data?.message || text || response.statusText;
    throw new Error(`${method} ${route} failed (${response.status}): ${message}`);
  }
  return data;
}

const getSessions = () => api('/api/sessions');

async function waitForDemoPrompt(name, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const screen = await api(`/api/sessions/${encodeURIComponent(name)}/read?lines=30`);
    const lines = screen.lines.map(line => line.trimEnd()).filter(Boolean);
    if (['idle', 'done'].includes(screen.state) && lines.at(-1)?.trim() === '❯' && lines.some(line => line.includes('Demo Agent v1.0'))) return screen;
    await pause(500);
  }
  throw new Error(`${name} did not reach the demo-agent prompt.`);
}

async function waitForSession(name, predicate, description, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sessions = await getSessions();
    const session = sessions.find(item => item.name === name);
    if (session && predicate(session)) return session;
    await pause(500);
  }
  const last = (await getSessions()).find(item => item.name === name);
  throw new Error(`Timed out waiting for ${name} ${description}; last state: ${last?.state || 'missing'}`);
}

const waitForPrompt = name => waitForDemoPrompt(name, 30000);

async function sendDemoTask(name, text, timeoutMs = 45000) {
  const sent = await api(`/api/sessions/${encodeURIComponent(name)}/send`, 'POST', { text, source: 'cli' });
  const deadline = Date.now() + timeoutMs;
  let reacted = false;
  while (Date.now() < deadline) {
    const screen = await api(`/api/sessions/${encodeURIComponent(name)}/read?lines=30`);
    if (['working', 'blocked'].includes(screen.state) && screen.lastOutputAt > sent.lastInputAt + 400) reacted = true;
    if (reacted && screen.state === 'blocked') return screen;
    if (!reacted && Date.now() > sent.lastInputAt + 6000) {
      throw new Error(`${name} did not react to the sent task; no duplicate task was sent.`);
    }
    await pause(500);
  }
  const current = (await getSessions()).find(session => session.name === name);
  throw new Error(`Timed out waiting for ${name} to block; last state: ${current?.state || 'missing'}`);
}

async function showWorkspaceTab(workspace, name) {
  const workspaceRow = page.locator('.ws').filter({ hasText: workspace });
  await workspaceRow.locator('button').filter({ hasText: name }).click();
}

async function submitCli(args, commandLabel) {
  console.log(`\n> ${commandLabel}`);
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${commandLabel} exited with status ${result.status}`);
}

async function main() {
  fs.mkdirSync(VIDEO_DIR, { recursive: true });

  heading(1, 'KURULUM');
  const info = await api('/api/info');
  const existing = await getSessions();
  const sessionSpecs = [
    { name: 'agent-1', workspace: 'web-dashboard', cwd: info.home, command: 'demo-agent' },
    { name: 'dev-server', workspace: 'web-dashboard', cwd: info.home, command: 'ping -t localhost' },
    { name: 'agent-2', workspace: 'data-pipeline', cwd: info.home, command: 'demo-agent' },
    { name: 'agent-3', workspace: 'review', cwd: info.home, command: 'demo-agent' },
  ];
  const expected = new Map(sessionSpecs.map(spec => [spec.name, spec]));
  for (const session of existing) {
    const spec = expected.get(session.name);
    if (!spec) continue;
    const isExpectedCommand = spec.command === 'demo-agent'
      ? session.command.includes('demo-agent.js')
      : session.command === spec.command;
    if (session.workspace !== spec.workspace || !isExpectedCommand) {
      throw new Error(`Session ${session.name} exists with a different workspace or command; it was not changed.`);
    }
  }

  browser = await chromium.launch({ headless: false, slowMo: 350 });
  context = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: VIDEO_DIR, size: VIEWPORT } });
  page = await context.newPage();
  video = page.video();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#langSelect').waitFor({ state: 'visible' });

  const existingByName = new Map(existing.map(session => [session.name, session]));
  for (const spec of sessionSpecs) {
    const prior = existingByName.get(spec.name);
    if (prior) {
      console.log(`Resetting prior tour tab: ${spec.name}`);
      await api(`/api/sessions/${encodeURIComponent(prior.id)}/restart`, 'POST');
    } else {
      await api('/api/sessions', 'POST', spec);
    }
  }
  await page.locator('#langSelect').selectOption('tr');
  await page.locator('[data-view="herd"]').click();
  await pause(4000);
  await Promise.all(['agent-1', 'agent-2', 'agent-3'].map(name => waitForDemoPrompt(name)));
  console.log('Four tabs are visible; the herd overview is populated.');
  await pause(2500);

  heading(2, 'AYNI ANDA ÜÇ AJAN');
  const firstTasks = [
    ['agent-1', 'kullanım grafiği yaz'],
    ['agent-2', 'veri işini hızlandır'],
    ['agent-3', 'kodu incele'],
  ];
  const blockedTasks = Promise.all(firstTasks.map(([name, text]) => sendDemoTask(name, text)));
  console.log('All three task prompts were sent together; showing the working cards.');
  await pause(2500);
  await blockedTasks;
  console.log('All three demo agents are now waiting for approval.');
  await pause(2500);

  heading(3, 'ONAYLAR');
  let agent1State = (await getSessions()).find(session => session.name === 'agent-1');
  if (agent1State?.state !== 'blocked') {
    await sendDemoTask('agent-1', 'kullanım grafiğini onayla');
    agent1State = (await getSessions()).find(session => session.name === 'agent-1');
  }
  const agent1Card = page.locator('.card').filter({ hasText: 'agent-1' }).first();
  const cardApprove = agent1Card.locator('[data-act="yes"]');
  if (await cardApprove.count() && await cardApprove.isVisible()) {
    await cardApprove.click();
  } else {
    console.log('The current Sürü mock does not render .card controls; approving agent-1 in its terminal instead.');
    await showWorkspaceTab('web-dashboard', 'agent-1');
    await page.locator('#yesBtn').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#yesBtn').click();
  }
  await waitForPrompt('agent-1');

  let agent2State = (await getSessions()).find(session => session.name === 'agent-2');
  if (agent2State?.state !== 'blocked') await sendDemoTask('agent-2', 'ret örneği');
  await api('/api/sessions/agent-2/answer', 'POST', { answer: 'no', source: 'cli' });
  await waitForPrompt('agent-2');
  agent2State = (await getSessions()).find(session => session.name === 'agent-2');
  console.log('agent-1 approved in the visible UI; agent-2 rejected through the API; agent-3 is left to email approval.');
  await pause(2500);

  heading(4, 'TERMİNAL VE SEKME GEÇİŞLERİ');
  await showWorkspaceTab('web-dashboard', 'agent-1');
  await page.locator('#tabs .tab').filter({ hasText: 'dev-server' }).click();
  await pause(3000);
  await api('/api/sessions/dev-server/keys', 'POST', { keys: ['ctrl+c'] });
  await showWorkspaceTab('web-dashboard', 'agent-1');
  await pause(2500);

  heading(5, 'RİSKLİ KOMUT');
  await sendDemoTask('agent-1', 'testleri çalıştır');
  await api('/api/sessions/agent-1/answer', 'POST', { answer: 'yes', source: 'cli' });
  await waitForPrompt('agent-1');
  await sendDemoTask('agent-1', 'eski derleme dosyalarını temizle');
  await showWorkspaceTab('web-dashboard', 'agent-1');
  await page.locator('#ask.risky').waitFor({ state: 'visible', timeout: 10000 });
  console.log('The risky-command warning is visible.');
  await pause(4000);
  await page.locator('#yesBtn').click();
  await page.locator('#yesBtn.confirm-risk').waitFor({ state: 'visible', timeout: 2000 });
  await pause(1000);
  await page.locator('#yesBtn').click();
  await waitForPrompt('agent-1');
  await pause(2500);

  heading(6, 'OTOMATİK ONAY');
  await page.locator('[data-view="rules"]').click();
  await page.locator('#rPattern').fill('npm run deploy');
  const rulesBefore = await api('/api/rules');
  await page.locator('#ruleForm button[type="submit"]').click();
  let rulesAfter;
  const ruleDeadline = Date.now() + 10000;
  do {
    rulesAfter = await api('/api/rules');
    if (rulesAfter.length > rulesBefore.length) break;
    await pause(250);
  } while (Date.now() < ruleDeadline);
  const addedRule = rulesAfter.find(rule => !rulesBefore.some(old => old.id === rule.id) && rule.pattern === 'npm run deploy');
  if (!addedRule) throw new Error('The npm run deploy auto-approve rule was not added.');

  const priorIds = new Set((await getSessions()).map(session => session.id));
  await page.locator('#demoBtn').click();
  const demoDeadline = Date.now() + 15000;
  let autoAgent;
  while (Date.now() < demoDeadline) {
    autoAgent = (await getSessions()).find(session => !priorIds.has(session.id) && session.name.startsWith('demo-agent-'));
    if (autoAgent) break;
    await pause(500);
  }
  if (!autoAgent) throw new Error('The demo-agent button did not open a new terminal.');
  const terminalInput = page.getByRole('textbox', { name: 'Terminal input' });
  await terminalInput.waitFor({ state: 'visible', timeout: 10000 });
  await terminalInput.pressSequentially('yeni özellik');
  await terminalInput.press('Enter');
  const autoDeadline = Date.now() + 30000;
  while (Date.now() < autoDeadline) {
    rulesAfter = await api('/api/rules');
    const currentRule = rulesAfter.find(rule => rule.id === addedRule.id);
    if (currentRule?.uses > 0) break;
    await pause(500);
  }
  rulesAfter = await api('/api/rules');
  if (!(rulesAfter.find(rule => rule.id === addedRule.id)?.uses > 0)) {
    throw new Error('The new demo task did not use the auto-approve rule.');
  }
  console.log(`Rule auto-approved the deployment prompt for ${autoAgent.name}.`);
  await pause(2500);

  heading(7, 'MAİL ONAYI');
  await showWorkspaceTab('review', 'agent-3');
  console.log('MAİL GELDİ: telefonu göster, maildeki Onayla butonuna bas');
  const mailInfo = info.mail || {};
  const agent3State = (await getSessions()).find(session => session.name === 'agent-3');
  if (agent3State?.state !== 'blocked') {
    console.log('agent-3 was already answered outside the tour; no additional answer was sent.');
  } else if (mailInfo.enabled) {
    try {
      await waitForSession('agent-3', session => session.state !== 'blocked', 'to be approved by email', 60000);
    } catch {
      console.log('No email approval arrived within 60 seconds; approving agent-3 through the API.');
      await api('/api/sessions/agent-3/answer', 'POST', { answer: 'yes', source: 'cli' });
    }
  } else {
    console.log('Email delivery is not configured on the server; using the requested API fallback.');
    await pause(2500);
    await api('/api/sessions/agent-3/answer', 'POST', { answer: 'yes', source: 'cli' });
  }
  await waitForPrompt('agent-3');
  const testMail = page.locator('#testMail');
  if (await testMail.count()) {
    await testMail.click();
    await pause(2500);
  } else {
    console.log('The sidebar has no #testMail control because no recipient is configured.');
  }
  await pause(2500);

  heading(8, 'GEÇMİŞ VE EKLENTİLER');
  await page.locator('[data-view="history"]').click();
  await pause(1000);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 620);
    await pause(1200);
  }
  await page.locator('[data-view="plugins"]').click();
  await pause(2500);

  heading(9, 'DİLLER');
  await page.locator('[data-view="history"]').click();
  for (const language of ['en', 'de', 'es']) {
    await page.locator('#langSelect').selectOption(language);
    if (language === 'en') {
      await pause(1000);
      await page.locator('[data-view="herd"]').click();
      await pause(1000);
      await page.locator('[data-view="history"]').click();
      await pause(1000);
    } else {
      await pause(3000);
    }
  }
  await page.locator('#langSelect').selectOption('tr');
  await page.locator('[data-view="herd"]').click();
  await pause(10000);

  if (context) {
    await context.close();
    context = null;
  }
  if (browser) {
    await browser.close();
    browser = null;
  }

  if (video) console.log(`Browser recording: ${await video.path()}`);
  await submitCli(['bin/coban.js', 'list'], 'node bin/coban.js list');
  await submitCli(['bin/coban.js', 'read', 'agent-1', '--lines', '15'], 'node bin/coban.js read agent-1 --lines 15');
  const elapsedMinutes = Number(process.hrtime.bigint() - startedAt) / 60e9;
  console.log(`\nTour completed in ${elapsedMinutes.toFixed(1)} minutes.`);
}

main().catch(async error => {
  console.error(`\nTOUR FAILED: ${error.message}`);
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (video) {
    try { console.log(`Partial browser recording: ${await video.path()}`); } catch {}
  }
  process.exitCode = 1;
});