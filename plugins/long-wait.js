// Reminds you in the panel when an agent has been waiting for approval for a long time.
// The threshold can be changed in config.json:  "plugins": { "long-wait": { "thresholdSeconds": 60 } }

module.exports = {
  name: { en: 'Long wait reminder', tr: 'Uzun bekleme hatırlatıcısı', de: 'Erinnerung bei langer Wartezeit', es: 'Recordatorio de espera larga' },
  description: {
    en: 'Shows a reminder in the panel when an agent waits for approval longer than a threshold.',
    tr: 'Bir ajan belirlenen süreden uzun onay beklerse panelde hatırlatma gösterir.',
    de: 'Zeigt eine Erinnerung im Panel, wenn ein Agent länger als eine Schwelle auf Freigabe wartet.',
    es: 'Muestra un recordatorio en el panel cuando un agente espera aprobación más de un límite.',
  },

  start(coban) {
    const seconds = coban.config.thresholdSeconds || 60;
    const reminded = new Set();
    coban.setStatus({ en: `Threshold: ${seconds}s`, tr: `Eşik: ${seconds} sn`, de: `Schwelle: ${seconds} s`, es: `Límite: ${seconds} s` });

    coban.every(5, () => {
      for (const s of coban.sessions()) {
        const key = `${s.id}:${s.stateSince}`;
        if (s.state === 'blocked' && Date.now() - s.stateSince > seconds * 1000 && !reminded.has(key)) {
          reminded.add(key);
          const min = Math.max(1, Math.round((Date.now() - s.stateSince) / 60000));
          coban.toast({
            en: `${s.name} has been waiting for your approval for ${min === 1 ? 'a minute' : `${min} minutes`}.`,
            tr: `${s.name} ${min} dakikadır senden onay bekliyor.`,
            de: `${s.name} wartet seit ${min === 1 ? 'einer Minute' : `${min} Minuten`} auf deine Freigabe.`,
            es: `${s.name} lleva ${min === 1 ? 'un minuto' : `${min} minutos`} esperando tu aprobación.`,
          }, 'warning');
        }
      }
    });
  },
};
