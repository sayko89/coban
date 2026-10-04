// Shows a short message in the panel when an agent finishes or its terminal exits.
// Shows how a plugin can speak every language: pass an object of translations instead of a string.

module.exports = {
  name: { en: 'Done toast', tr: 'Bitti haberi', de: 'Fertig-Meldung', es: 'Aviso de tarea terminada' },
  description: {
    en: 'Shows a short message in the panel when an agent finishes its task or its terminal exits.',
    tr: 'Ajan görevini bitirdiğinde veya terminali kapandığında panelde kısa bir mesaj gösterir.',
    de: 'Zeigt eine kurze Meldung im Panel, wenn ein Agent fertig ist oder sein Terminal beendet wird.',
    es: 'Muestra un aviso breve en el panel cuando un agente termina su tarea o su terminal se cierra.',
  },

  start(coban) {
    coban.on('done', e => coban.toast({
      en: `${e.agent} finished its task.`,
      tr: `${e.agent} görevini bitirdi.`,
      de: `${e.agent} hat seine Aufgabe erledigt.`,
      es: `${e.agent} terminó su tarea.`,
    }, 'success'));
    coban.on('exited', e => coban.toast({
      en: `${e.agent}'s terminal exited (code ${e.code}).`,
      tr: `${e.agent} terminali kapandı (çıkış kodu ${e.code}).`,
      de: `Terminal von ${e.agent} beendet (Code ${e.code}).`,
      es: `La terminal de ${e.agent} se cerró (código ${e.code}).`,
    }, 'warning'));
  },
};
