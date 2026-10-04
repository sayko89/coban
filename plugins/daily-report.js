// Keeps a Markdown report for each day under data/plugins/daily-report/.
// Lines are written in the language picked in the panel (coban.language).

const fs = require('fs');
const path = require('path');

const TEXT = {
  en: {
    title: d => `# Çoban daily report, ${d}`,
    risky: (a, l) => `**${a}** asked for approval of a risky command: \`${l}\``,
    source: { panel: 'from the panel', email: 'from email', auto: 'automatically by a rule', cli: 'from the CLI' },
    answered: (a, yes, how, s) => `**${a}**: ${yes ? 'approved' : 'rejected'} ${how} (waited ${s}s)`,
    done: a => `**${a}** finished its task`,
    status: f => `Last written: ${f}`,
  },
  tr: {
    title: d => `# Çoban günlük rapor, ${d}`,
    risky: (a, l) => `**${a}** riskli bir komut için onay istedi: \`${l}\``,
    source: { panel: 'panelden', email: 'e-postadan', auto: 'kuralla otomatik', cli: 'komut satırından' },
    answered: (a, yes, how, s) => `**${a}**: ${how} ${yes ? 'onaylandı' : 'reddedildi'} (${s} sn bekledi)`,
    done: a => `**${a}** görevini bitirdi`,
    status: f => `Son yazılan: ${f}`,
  },
  de: {
    title: d => `# Çoban Tagesbericht, ${d}`,
    risky: (a, l) => `**${a}** bat um Freigabe eines riskanten Befehls: \`${l}\``,
    source: { panel: 'im Panel', email: 'per E-Mail', auto: 'automatisch per Regel', cli: 'über die CLI' },
    answered: (a, yes, how, s) => `**${a}**: ${how} ${yes ? 'freigegeben' : 'abgelehnt'} (${s} s gewartet)`,
    done: a => `**${a}** hat seine Aufgabe erledigt`,
    status: f => `Zuletzt geschrieben: ${f}`,
  },
  es: {
    title: d => `# Informe diario de Çoban, ${d}`,
    risky: (a, l) => `**${a}** pidió aprobación para un comando arriesgado: \`${l}\``,
    source: { panel: 'desde el panel', email: 'desde el correo', auto: 'automáticamente por una regla', cli: 'desde la CLI' },
    answered: (a, yes, how, s) => `**${a}**: ${yes ? 'aprobado' : 'rechazado'} ${how} (esperó ${s} s)`,
    done: a => `**${a}** terminó su tarea`,
    status: f => `Último escrito: ${f}`,
  },
};

module.exports = {
  name: { en: 'Daily report', tr: 'Günlük rapor', de: 'Tagesbericht', es: 'Informe diario' },
  description: {
    en: 'Writes approvals, rejected commands and finished tasks to a Markdown file for each day.',
    tr: 'Onayları, reddedilen komutları ve biten görevleri her gün için bir Markdown dosyasına yazar.',
    de: 'Schreibt Freigaben, abgelehnte Befehle und erledigte Aufgaben täglich in eine Markdown-Datei.',
    es: 'Escribe aprobaciones, comandos rechazados y tareas terminadas en un archivo Markdown por día.',
  },

  start(coban) {
    const T = () => TEXT[coban.language] || TEXT.en;
    const pad = n => String(n).padStart(2, '0');
    const today = () => {
      const d = new Date();
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const clock = t => {
      const d = new Date(t);
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    function write(time, line) {
      fs.mkdirSync(coban.dataDir, { recursive: true });
      const file = path.join(coban.dataDir, `${today()}.md`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, `${T().title(today())}\n\n`, 'utf8');
      fs.appendFileSync(file, `- ${clock(time)} ${line}\n`, 'utf8');
      coban.setStatus({ en: TEXT.en.status(file), tr: TEXT.tr.status(file), de: TEXT.de.status(file), es: TEXT.es.status(file) });
    }

    coban.on('approval-requested', e => {
      if (e.risky) write(e.time, T().risky(e.agent, e.riskLine));
    });
    coban.on('answered', e => {
      write(e.time, T().answered(e.agent, e.answer === 'yes', T().source[e.source] || '', Math.round(e.waitMs / 1000)));
    });
    coban.on('done', e => write(e.time, T().done(e.agent)));
  },
};
