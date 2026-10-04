// Plugin system.
// Every .js file in the plugins/ folder is a plugin. A plugin looks like this:
//
//   module.exports = {
//     name: 'Display name',
//     description: 'What it does',
//     start(coban) {
//       coban.on('done', event => coban.toast(`${event.agent} finished`));
//     },
//   };
//
// name, description, setStatus() and toast() also accept an object of translations,
// e.g. { en: 'Daily report', tr: 'Günlük rapor' }; the panel shows the user's language.
// coban.language tells you which language the user picked.
//
// Events: created, removed, state, approval-requested, answered, done, exited, sent
// If a plugin throws, only that plugin is affected and Çoban keeps running.

const fs = require('fs');
const path = require('path');
const { coded } = require('./errors');
const I18N = require('./public/i18n');

function loadPlugins({ dir, dataDir, bus, settings, api }) {
  const stateFile = path.join(dataDir, 'plugins.json');
  let disabled = [];
  try { disabled = JSON.parse(fs.readFileSync(stateFile, 'utf8')).disabled || []; } catch { /* all enabled */ }
  const saveState = () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ disabled }, null, 2), 'utf8');
  };

  const plugins = [];
  if (!fs.existsSync(dir)) return { list: () => [], setEnabled() {} };

  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()) {
    const key = path.basename(file, '.js');
    const p = { key, name: key, description: '', enabled: !disabled.includes(key), error: null, status: null, log: [] };
    plugins.push(p);

    const log = (msg, level = 'info') => {
      p.log.push({ time: Date.now(), message: typeof msg === 'object' ? msg : String(msg), level });
      if (p.log.length > 30) p.log.shift();
      if (level === 'error') console.error(`  [${I18N.pick('en', p.name)}] ${I18N.pick('en', msg)}`);
    };
    const fail = err => { p.error = err.message; log(err.message, 'error'); };

    const coban = {
      on(event, fn) {
        bus.on(event, (...args) => {
          if (!p.enabled) return;
          try {
            const r = fn(...args);
            if (r && typeof r.catch === 'function') r.catch(fail);
          } catch (err) { fail(err); }
        });
      },
      // A timer that pauses while the plugin is disabled
      every(seconds, fn) {
        setInterval(() => {
          if (!p.enabled) return;
          try { fn(); } catch (err) { fail(err); }
        }, seconds * 1000);
      },
      log: msg => log(msg),
      setStatus: text => { p.status = text; },
      // text can be a string or an object of translations: { en: '…', tr: '…' }
      toast: (text, kind = 'info') => api.toast(typeof text === 'object' ? text : String(text), kind, p.name),
      // The language the user picked in the panel (en, tr, de, es…)
      get language() { return api.language(); },
      send: (agentName, text) => api.send(agentName, text),
      sessions: () => api.list(),
      config: (settings.plugins || {})[key] || {},
      dataDir: path.join(dataDir, 'plugins', key),
    };

    try {
      const mod = require(path.join(dir, file));
      p.name = mod.name || key;
      p.description = mod.description || '';
      if (typeof mod.start !== 'function') throw new Error('No start(coban) function found.');
      mod.start(coban);
      log({ en: 'Loaded.', tr: 'Yüklendi.', de: 'Geladen.', es: 'Cargado.' });
    } catch (err) {
      fail(err);
    }
  }

  return {
    list: () => plugins.map(({ log, ...rest }) => ({ ...rest, log: log.slice(-8).reverse() })),
    setEnabled(key, enabled) {
      const p = plugins.find(x => x.key === key);
      if (!p) throw coded('plugin_not_found');
      p.enabled = enabled;
      disabled = plugins.filter(x => !x.enabled).map(x => x.key);
      saveState();
      return p;
    },
  };
}

module.exports = { loadPlugins };
