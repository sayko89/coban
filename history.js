// Activity history and statistics.
// Important events (approval requested, answered, task done…) are appended to data/history.jsonl.

const fs = require('fs');
const path = require('path');

const KEEP_IN_MEMORY = 3000;

function createHistory(dataDir) {
  const file = path.join(dataDir, 'history.jsonl');
  let events = [];
  try {
    events = fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-KEEP_IN_MEMORY)
      .map(line => JSON.parse(line));
  } catch { /* no file yet */ }

  function add(type, data) {
    const ev = { time: Date.now(), type, ...data };
    events.push(ev);
    if (events.length > KEEP_IN_MEMORY) events.shift();
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(file, JSON.stringify(ev) + '\n', 'utf8');
    } catch (err) {
      console.error('Could not write history:', err.message);
    }
    return ev;
  }

  function recent(limit = 100) {
    return events.slice(-limit).reverse();
  }

  function stats() {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const today = events.filter(e => e.time >= dayStart.getTime());

    const answers = today.filter(e => e.type === 'answered');
    const waits = answers.map(e => e.waitMs).filter(Number.isFinite);
    const bySource = src => answers.filter(e => e.source === src).length;

    const agents = new Map();
    const agent = name => {
      if (!agents.has(name)) agents.set(name, { name, requests: 0, waitMs: 0, finished: 0, auto: 0 });
      return agents.get(name);
    };
    for (const e of today) {
      if (!e.agent) continue;
      if (e.type === 'approval-requested') agent(e.agent).requests++;
      if (e.type === 'answered') {
        if (Number.isFinite(e.waitMs)) agent(e.agent).waitMs += e.waitMs;
        if (e.source === 'auto') agent(e.agent).auto++;
      }
      if (e.type === 'done') agent(e.agent).finished++;
    }

    // Time saved by auto-approvals: average manual wait × number of auto-approvals
    const manual = answers.filter(e => e.source !== 'auto' && Number.isFinite(e.waitMs));
    const avgManual = manual.length ? manual.reduce((a, e) => a + e.waitMs, 0) / manual.length : null;

    return {
      today: {
        requested: today.filter(e => e.type === 'approval-requested').length,
        answered: answers.length,
        auto: bySource('auto'),
        panel: bySource('panel'),
        email: bySource('email'),
        rejected: answers.filter(e => e.answer === 'no').length,
        risky: today.filter(e => e.type === 'approval-requested' && e.risky).length,
        finished: today.filter(e => e.type === 'done').length,
        avgWaitMs: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null,
        savedMs: avgManual == null ? null : Math.round(avgManual * bySource('auto')),
      },
      agents: [...agents.values()].sort((a, b) => b.waitMs - a.waitMs),
    };
  }

  return { add, recent, stats };
}

module.exports = { createHistory };
