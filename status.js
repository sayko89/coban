// Agent status detection.
// Every terminal is rendered on the server by an invisible xterm, and we read its last lines.
// Reading the rendered screen instead of raw output matters: agents like Claude Code redraw
// the screen by moving the cursor, so the raw byte stream is almost impossible to interpret.

const { Terminal } = require('@xterm/headless');

const QUIET_FOR_PROMPT_MS = 600; // the screen must be quiet this long after a question appears
const WORKING_WINDOW_MS = 2000;  // output within this window means "working"
const ECHO_WINDOW_MS = 400;      // the echo of the user's own typing doesn't count as work

// Approval prompts. "answers" are the keys written to the terminal when Approve / Reject is pressed.
// "where": "last" looks only at the last non-empty line, "screen" at the bottom of the screen.
const PROMPTS = [
  { where: 'last', re: /(\(y\/n\)|\[y\/n\])\s*:?\s*$/i, answers: { yes: 'y\r', no: 'n\r' } },
  { where: 'last', re: /\(e\/h\)\s*:?\s*$/i, answers: { yes: 'e\r', no: 'h\r' } },
  // Claude Code: "Do you want to proceed?" + "❯ 1. Yes" menu. Enter picks the first option, Esc rejects.
  { where: 'screen', re: /Do you want to (proceed|make this edit|create|run)/i, also: /1\.\s*Yes/i, answers: { yes: '\r', no: '\x1b' } },
  // Codex: "Would you like to run the following command?"
  { where: 'screen', re: /Would you like to (run|make|apply)/i, answers: { yes: 'y', no: '\x1b' } },
  // Generic questions: the state is detected, but we don't know which key to press, so no buttons.
  { where: 'last', re: /(allow\b.*\?|approve\b.*\?|continue\?|proceed\?|are you sure\b.*\?)/i, answers: null },
];

// Risky commands: if the command awaiting approval looks like one of these, the user is warned.
const RISKS = [
  { re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, id: 'rmrf', label: 'Permanently deletes files (rm -rf)' },
  { re: /Remove-Item\b.*-Recurse|\bdel\s+\/s|\brmdir\s+\/s/i, id: 'deleteFolders', label: 'Permanently deletes folders' },
  { re: /git\s+push\b.*(--force|-f\b)/i, id: 'forcePush', label: 'Overwrites remote history (force push)' },
  { re: /git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f/i, id: 'discard', label: 'Discards uncommitted changes' },
  { re: /\b(drop|truncate)\s+(table|database|schema)\b/i, id: 'dropTable', label: 'Deletes database tables or data' },
  { re: /\bdelete\s+from\b(?!.*\bwhere\b)/i, id: 'deleteAll', label: 'Deletes every row in the table (no WHERE)' },
  { re: /(curl|wget|iwr|Invoke-WebRequest)\b.*\|\s*(sh|bash|iex|Invoke-Expression)\b/i, id: 'pipeShell', label: 'Runs a script downloaded from the internet' },
  { re: /\b(npm|pnpm|yarn)\s+publish\b/i, id: 'publish', label: 'Publishes the package publicly' },
  { re: /(deploy|release)\b.*\b(prod|production)\b|--env[ =](prod|production)\b/i, id: 'prodDeploy', label: 'Deploys to production' },
  { re: /\bsudo\b|\bchmod\s+(-R\s+)?777\b/i, id: 'admin', label: 'Runs as administrator or opens full permissions' },
  { re: /\b(mkfs|format\s+[a-z]:|diskpart|shutdown|Stop-Computer)\b/i, id: 'system', label: 'Affects the disk or the whole system' },
];

// Returns the matched risks. "ids" lets the panel and emails show the labels in the user's language.
function findRisk(lines) {
  const found = [];
  let first = null;
  for (const line of lines.slice(-12)) {
    for (const r of RISKS) {
      if (r.re.test(line)) {
        if (!found.includes(r)) found.push(r);
        first = first || line.trim();
      }
    }
  }
  return found.length ? { ids: found.map(r => r.id), label: found.map(r => r.label).join('; '), line: first } : null;
}

// "Finished" lines, also in the demo agent's other languages (Turkish, German, Spanish)
const DONE = /(✓|✔).*(done|complete|finished|tamamland|erledigt|abgeschlossen|completad)|task complete|all done/i;

function createScreen(cols, rows) {
  return new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
}

// Lines of the visible screen, with trailing empty lines removed
function visibleLines(screen) {
  const buf = screen.buffer.active;
  const lines = [];
  for (let i = buf.baseY; i < buf.baseY + screen.rows; i++) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true).trimEnd() : '');
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

// The last N lines including scrollback (for "coban read")
function recentLines(screen, count = 40) {
  const buf = screen.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true).trimEnd() : '');
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-count);
}

function findPrompt(lines) {
  const last = lines[lines.length - 1] || '';
  const bottom = lines.slice(-12).join('\n');
  for (const p of PROMPTS) {
    const text = p.where === 'last' ? last : bottom;
    if (p.re.test(text) && (!p.also || p.also.test(bottom))) {
      // If the question line is just "(y/n)", include the line above it for context
      let question = p.where === 'last' ? last : (bottom.match(p.re) || [last])[0];
      if (p.where === 'last' && last.replace(/\(.*?\)/g, '').trim().length < 25 && lines.length > 1) {
        question = `${lines[lines.length - 2].trim()}  ${last.trim()}`;
      }
      return { question: question.trim(), answers: p.answers };
    }
  }
  return null;
}

/**
 * Returns the current state of a session:
 * exited | blocked | working | done | idle
 */
function detect(s, now = Date.now()) {
  if (s.exited) return { state: 'exited' };

  const lines = visibleLines(s.screen);
  const quietFor = now - s.lastOutputAt;
  const prompt = findPrompt(lines);

  // While the same question is still on screen, stay blocked even if output arrives
  // (resizing the terminal makes many programs redraw their prompt).
  const sameQuestion = s.state === 'blocked' && prompt && prompt.question === s.prompt;
  if (prompt && (quietFor >= QUIET_FOR_PROMPT_MS || sameQuestion)) {
    return { state: 'blocked', prompt: prompt.question, answers: prompt.answers, risk: findRisk(lines) };
  }

  const isEcho = s.lastOutputAt - s.lastInputAt < ECHO_WINDOW_MS;
  if (quietFor < WORKING_WINDOW_MS && !isEcho) return { state: 'working' };

  if (lines.slice(-4).some(l => DONE.test(l))) return { state: 'done' };

  return { state: 'idle' };
}

module.exports = { createScreen, visibleLines, recentLines, detect, findRisk };
