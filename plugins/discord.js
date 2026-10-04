// Posts agents that are waiting for approval or finished to a Discord channel.
// In Discord: channel settings > Integrations > Create webhook, then add the URL to config.json:
//   "plugins": { "discord": { "webhook": "https://discord.com/api/webhooks/..." } }
// Messages are written in the language picked in the panel.

const TEXT = {
  en: { risky: (a, l) => `🚨 **${a}** needs approval for a risky command: \`${l}\``, waiting: (a, q) => `⚠️ **${a}** is waiting for approval: ${q}`, done: a => `✅ **${a}** finished its task.` },
  tr: { risky: (a, l) => `🚨 **${a}** riskli bir komut için onay bekliyor: \`${l}\``, waiting: (a, q) => `⚠️ **${a}** onay bekliyor: ${q}`, done: a => `✅ **${a}** görevini bitirdi.` },
  de: { risky: (a, l) => `🚨 **${a}** braucht eine Freigabe für einen riskanten Befehl: \`${l}\``, waiting: (a, q) => `⚠️ **${a}** wartet auf Freigabe: ${q}`, done: a => `✅ **${a}** hat seine Aufgabe erledigt.` },
  es: { risky: (a, l) => `🚨 **${a}** necesita aprobación para un comando arriesgado: \`${l}\``, waiting: (a, q) => `⚠️ **${a}** espera aprobación: ${q}`, done: a => `✅ **${a}** terminó su tarea.` },
};

module.exports = {
  name: { en: 'Discord notifications', tr: 'Discord bildirimi', de: 'Discord-Benachrichtigungen', es: 'Notificaciones de Discord' },
  description: {
    en: 'Posts agents that are waiting for approval or finished their task to a Discord channel.',
    tr: 'Onay bekleyen ve görevini bitiren ajanları bir Discord kanalına mesaj olarak gönderir.',
    de: 'Postet Agenten, die auf Freigabe warten oder fertig sind, in einen Discord-Kanal.',
    es: 'Publica en un canal de Discord los agentes que esperan aprobación o terminaron su tarea.',
  },

  start(coban) {
    const url = coban.config.webhook;
    if (!url) {
      coban.setStatus({
        en: 'No webhook URL configured; not posting.',
        tr: 'Webhook adresi ayarlanmadı, mesaj gönderilmiyor.',
        de: 'Keine Webhook-URL konfiguriert; es wird nichts gepostet.',
        es: 'No hay URL de webhook configurada; no se publica nada.',
      });
      return;
    }
    coban.setStatus({ en: 'Connected.', tr: 'Bağlı.', de: 'Verbunden.', es: 'Conectado.' });
    const T = () => TEXT[coban.language] || TEXT.en;

    async function post(content) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'Çoban', content }),
      });
      if (!res.ok) throw new Error(`Discord returned ${res.status}`);
    }

    coban.on('approval-requested', e => post(e.risky ? T().risky(e.agent, e.riskLine) : T().waiting(e.agent, e.question)));
    coban.on('done', e => post(T().done(e.agent)));
  },
};
