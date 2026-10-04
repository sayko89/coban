#!/usr/bin/env node
// coban — control Çoban from the command line. Agents can use it to manage each other too.
// Works in Çoban terminals without installing anything; elsewhere use "node bin/coban.js" or "npm link".

const BASE = (process.env.COBAN_URL || 'http://127.0.0.1:4800').replace(/\/$/, '');

const HELP = `coban — Çoban command-line tool

Usage:
  coban list                                  Show all agents and their state
  coban read <agent> [--lines 40]             Print the last lines of an agent's screen
  coban send <agent> "<text>" [--wait]        Send an instruction to an agent (Enter included)
  coban wait <agent> [--until blocked|done|idle|working|exited]...
                                              Wait until the agent reaches one of the states
  coban keys <agent> <key>...                 Send keys: enter, esc, tab, up, down, ctrl+c, y, n…
  coban approve <agent>                       Approve the pending question
  coban reject <agent>                        Reject the pending question
  coban start <name> [--workspace <name>] [--cwd <path>] [--command "<command>"]
                                              Open a new tab
  coban close <agent>                         Close a tab

Options:
  --timeout <seconds>  Upper limit for wait / send --wait (default: no limit)
  --force              Send text even while the agent is waiting for approval
  --json               Print JSON output

Inside a Çoban terminal, "." as <agent> means the tab running the command.

Example, give an agent a task and read the result when it's done:
  coban send reviewer "review the latest changes" --wait
  coban read reviewer --lines 60`;

// ---------- Arguments ----------

function parseArgs(argv) {
  const pos = [];
  const opts = { until: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const key = a.slice(2);
    if (['wait', 'force', 'json', 'help'].includes(key)) { opts[key] = true; continue; }
    const val = argv[++i];
    if (val === undefined) fail(`--${key} needs a value.`);
    if (key === 'until') opts.until.push(val);
    else opts[key] = val;
  }
  return { pos, opts };
}

function fail(msg, code = 1) {
  process.stderr.write(`coban: ${msg}\n`);
  process.exit(code);
}

function agentArg(name) {
  if (!name) fail('Which agent? Example: coban read demo-agent-1', 2);
  if (name === '.') {
    if (!process.env.COBAN_AGENT) fail('"." only works inside a Çoban terminal.', 2);
    return process.env.COBAN_AGENT;
  }
  return name;
}

// ---------- API ----------

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(BASE + url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    fail(`Could not reach Çoban at ${BASE}. Is the server running? ("npm start")`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(data.error || `Request failed (${res.status})`);
  return data;
}

const enc = encodeURIComponent;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const STATES = { blocked: 'waiting for approval', working: 'working', done: 'done', idle: 'idle', exited: 'exited' };
const VALID = Object.keys(STATES);

/** Waits until the agent reaches one of the given states */
async function waitFor(name, states, timeoutSec, { sentAt = null } = {}) {
  const deadline = timeoutSec ? Date.now() + Number(timeoutSec) * 1000 : Infinity;
  let left = sentAt == null;
  const leaveDeadline = Date.now() + 5000;
  for (;;) {
    const s = await api('GET', `/api/sessions/${enc(name)}/read?lines=1`);
    // For "send --wait" we must first see the agent react to the instruction (output newer than the echo
    // of our own text), or a "done" left over from the previous task would match immediately
    if (!left && (s.state === 'working' || s.state === 'blocked') && s.lastOutputAt > sentAt + 400) left = true;
    if (!left && Date.now() > leaveDeadline) fail(`${name} did not start working after the instruction.`, 3);
    // A question that an auto-approve rule is about to answer is not really waiting for anyone
    const autoPending = s.state === 'blocked' && s.autoRule;
    if (left && states.includes(s.state) && !autoPending) return s;
    if (Date.now() > deadline) fail(`Timed out: ${name} is currently "${STATES[s.state] || s.state}".`, 3);
    await sleep(500);
  }
}

// ---------- Commands ----------

function pad(text, n) {
  text = String(text ?? '');
  return text.length >= n ? text.slice(0, n - 1) + '…' : text + ' '.repeat(n - text.length);
}

function gitText(g) {
  if (!g) return '';
  return `${g.branch}${g.dirty ? ' *' : ''}${g.ahead ? ` ↑${g.ahead}` : ''}`;
}

function describe(name, s) {
  return `${name}: ${STATES[s.state] || s.state}${s.state === 'blocked' && s.prompt ? ` (${s.prompt})` : ''}`;
}

async function main() {
  const { pos, opts } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = pos;
  const out = data => {
    if (opts.json) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return opts.json;
  };

  if (opts.help) { console.log(HELP); return; }

  switch (cmd) {
    case undefined:
    case 'help':
      console.log(HELP);
      return;

    case 'list':
    case 'ls': {
      const list = await api('GET', '/api/sessions');
      if (out(list)) return;
      if (!list.length) { console.log('No agents yet. Open one with: coban start <name> --command claude'); return; }
      console.log(`${pad('NAME', 20)}${pad('WORKSPACE', 18)}${pad('STATE', 22)}${pad('AGENT', 13)}BRANCH`);
      for (const s of list) {
        console.log(`${pad(s.name, 20)}${pad(s.workspace, 18)}${pad(STATES[s.state] || s.state, 22)}${pad(s.kindLabel || 'shell', 13)}${gitText(s.git)}`);
      }
      return;
    }

    case 'read': {
      const name = agentArg(rest[0]);
      const r = await api('GET', `/api/sessions/${enc(name)}/read?lines=${Number(opts.lines) || 40}`);
      if (out(r)) return;
      console.log(r.lines.join('\n'));
      return;
    }

    case 'send':
    case 'prompt': {
      const name = agentArg(rest[0]);
      const text = rest.slice(1).join(' ');
      if (!text) fail('Nothing to send. Example: coban send demo-agent-1 "run the tests"', 2);
      const sent = await api('POST', `/api/sessions/${enc(name)}/send`, { text, force: !!opts.force, source: 'cli' });
      if (!opts.wait) { if (!out({ ok: true })) console.log(`Sent to ${name}.`); return; }
      const s = await waitFor(name, ['idle', 'done', 'blocked', 'exited'], opts.timeout, { sentAt: sent.lastInputAt });
      if (!out(s)) console.log(describe(name, s));
      return;
    }

    case 'wait': {
      const name = agentArg(rest[0]);
      const states = opts.until.length ? opts.until : ['idle', 'done', 'blocked'];
      for (const st of states) if (!VALID.includes(st)) fail(`Unknown state "${st}". Valid: ${VALID.join(', ')}`, 2);
      const s = await waitFor(name, states, opts.timeout);
      if (!out(s)) console.log(describe(name, s));
      return;
    }

    case 'keys':
    case 'send-keys': {
      const name = agentArg(rest[0]);
      const keys = rest.slice(1);
      if (!keys.length) fail('Which key? Example: coban keys demo-agent-1 esc', 2);
      await api('POST', `/api/sessions/${enc(name)}/keys`, { keys });
      if (!out({ ok: true })) console.log(`${name}: sent ${keys.join(' ')}.`);
      return;
    }

    case 'approve':
    case 'reject': {
      const name = agentArg(rest[0]);
      const s = await api('POST', `/api/sessions/${enc(name)}/answer`, { answer: cmd === 'approve' ? 'yes' : 'no', source: 'cli' });
      if (!out(s)) console.log(`${name}: ${cmd === 'approve' ? 'approved' : 'rejected'}.`);
      return;
    }

    case 'start': {
      const name = rest[0];
      if (!name) fail('Missing tab name. Example: coban start reviewer --command claude', 2);
      const s = await api('POST', '/api/sessions', {
        name,
        workspace: opts.workspace || process.env.COBAN_WORKSPACE || name,
        cwd: opts.cwd || '',
        command: opts.command || '',
      });
      if (!out(s)) console.log(`Opened "${s.name}" (workspace: ${s.workspace}, folder: ${s.cwd}).`);
      return;
    }

    case 'close': {
      const name = agentArg(rest[0]);
      await api('DELETE', `/api/sessions/${enc(name)}`);
      if (!out({ ok: true })) console.log(`Closed "${name}".`);
      return;
    }

    default:
      fail(`Unknown command "${cmd}". For help: coban help`, 2);
  }
}

main();
