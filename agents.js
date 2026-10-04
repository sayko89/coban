// Agent type detection and resuming conversations after a restart.

// For each agent: the first word of its command, a signature that appears on screen,
// and (if supported) the command that resumes the latest conversation.
// Note: Herdr reads the exact session id through official integrations. We resume the
// most recent conversation in that folder instead.
const AGENTS = [
  { kind: 'claude', label: 'Claude Code', bins: ['claude'], screen: /Claude Code|✻ Welcome to Claude/i, resume: 'claude --continue' },
  { kind: 'codex', label: 'Codex', bins: ['codex'], screen: /OpenAI Codex|>_ Codex/i, resume: 'codex resume --last' },
  { kind: 'opencode', label: 'OpenCode', bins: ['opencode'], screen: /\bopencode\b.*(zen|build|plan)|OpenCode Zen/i, resume: 'opencode --continue' },
  { kind: 'gemini', label: 'Gemini CLI', bins: ['gemini'], screen: /Gemini CLI|Using:.*gemini/i, resume: null },
  { kind: 'cursor', label: 'Cursor', bins: ['cursor-agent'], screen: /Cursor Agent/i, resume: null },
  { kind: 'copilot', label: 'Copilot', bins: ['copilot'], screen: /GitHub Copilot CLI/i, resume: null },
  { kind: 'aider', label: 'Aider', bins: ['aider'], screen: /^Aider v\d/m, resume: null },
  { kind: 'qwen', label: 'Qwen Code', bins: ['qwen'], screen: /Qwen Code/i, resume: null },
  { kind: 'grok', label: 'Grok', bins: ['grok'], screen: /Grok CLI/i, resume: null },
  { kind: 'demo', label: 'Demo agent', bins: ['demo-agent'], screen: /Demo Agent v\d/, resume: null },
];

function fromCommand(command) {
  if (!command) return null;
  if (command.includes('demo-agent')) return 'demo';
  const first = command.trim().split(/\s+/)[0].replace(/^.*[\\/]/, '').replace(/\.(cmd|exe|ps1)$/i, '');
  return AGENTS.find(a => a.bins.includes(first))?.kind || null;
}

function fromScreen(lines) {
  const text = lines.join('\n');
  return AGENTS.find(a => a.screen.test(text))?.kind || null;
}

function label(kind) {
  return AGENTS.find(a => a.kind === kind)?.label || null;
}

/**
 * The command to run on restore. If the agent was started by the start command, or was started
 * by hand in the terminal and recognized, returns the command that resumes its conversation.
 */
function resumeCommand(command, kind) {
  const k = fromCommand(command) || (!command ? kind : null);
  const agent = AGENTS.find(a => a.kind === k);
  if (!agent || !agent.resume) return null;
  // Leave it alone if the user already passed a resume flag
  if (/--continue|--resume|\bresume\b|-c\b/.test(command || '')) return null;
  return agent.resume;
}

module.exports = { fromCommand, fromScreen, label, resumeCommand, AGENTS };
