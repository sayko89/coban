// Auto-approval rules.
// Rules like "always approve npm test" are stored in data/rules.json.
// Risky commands are NEVER auto-approved by any rule (auto-rejecting them is allowed).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { coded } = require('./errors');

// A question that was already answered, e.g. "Proceed? (y/n) y"
const ANSWERED = /\((y\/n|e\/h)\)\s*\S/i;

/** Takes the lines of the most recent question from the bottom of the screen (stops at an earlier answered one). */
function promptContext(lines, max = 10) {
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
    if (out.length && ANSWERED.test(lines[i])) break;
    out.unshift(lines[i]);
  }
  return out.join('\n');
}

function createRules(dataDir) {
  const file = path.join(dataDir, 'rules.json');
  let rules = [];
  try { rules = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }

  const save = () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(rules, null, 2), 'utf8');
  };

  function tester(rule) {
    if (rule.match === 'regex') {
      const re = new RegExp(rule.pattern, 'i');
      return text => re.test(text);
    }
    const needle = rule.pattern.toLowerCase();
    return text => text.toLowerCase().includes(needle);
  }

  return {
    list: () => rules,

    add({ pattern, match, answer }) {
      pattern = String(pattern || '').trim();
      if (!pattern) throw coded('pattern_required');
      if (!['contains', 'regex'].includes(match)) match = 'contains';
      if (!['yes', 'no'].includes(answer)) answer = 'yes';
      if (match === 'regex') {
        try { new RegExp(pattern); } catch (err) { throw coded('bad_regex', { msg: err.message }); }
      }
      const rule = { id: crypto.randomUUID().slice(0, 8), pattern, match, answer, enabled: true, uses: 0, created: Date.now() };
      rules.push(rule);
      save();
      return rule;
    },

    update(id, patch) {
      const r = rules.find(x => x.id === id);
      if (!r) throw coded('rule_not_found');
      if (typeof patch.enabled === 'boolean') r.enabled = patch.enabled;
      save();
      return r;
    },

    remove(id) {
      const before = rules.length;
      rules = rules.filter(x => x.id !== id);
      if (rules.length === before) throw coded('rule_not_found');
      save();
    },

    /** Returns the first enabled rule matching the question on screen */
    match(lines) {
      const text = promptContext(lines);
      for (const r of rules) {
        if (!r.enabled) continue;
        try {
          if (tester(r)(text)) return r;
        } catch { /* skip a broken rule */ }
      }
      return null;
    },

    used(id) {
      const r = rules.find(x => x.id === id);
      if (r) { r.uses = (r.uses || 0) + 1; r.lastUsed = Date.now(); save(); }
    },
  };
}

module.exports = { createRules, promptContext };
