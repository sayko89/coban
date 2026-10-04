// Email notifications: sends an email when an agent is waiting for approval.
// Emails are written in the language picked in the panel.

const nodemailer = require('nodemailer');
const I18N = require('./public/i18n');
const { coded } = require('./errors');

const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/** Risk label in the given language, built from the risk ids */
function riskLabel(lang, risk) {
  return risk.ids ? risk.ids.map(id => I18N.translate(lang, `risk.${id}`)).join('; ') : risk.label;
}

function createNotifier(cfg, getLang = () => 'en') {
  const mail = cfg.email || {};
  const enabled = Boolean(mail.user && mail.appPassword && mail.to);
  if (!enabled) {
    return {
      enabled: false,
      to: null,
      async send() {},
      async test() { throw coded('email_not_configured'); },
    };
  }

  const port = mail.port || 465;
  const transport = nodemailer.createTransport({
    host: mail.host || 'smtp.gmail.com',
    port,
    secure: port === 465,
    auth: { user: mail.user, pass: String(mail.appPassword).replace(/\s/g, '') },
  });

  async function deliver(subject, html, text) {
    await transport.sendMail({ from: `"Çoban" <${mail.user}>`, to: mail.to, subject, html, text });
  }

  return {
    enabled: true,
    to: mail.to,

    /** Email for an agent waiting for approval */
    async send({ name, question, lines, link, canAnswer, risk, panelUrl }) {
      const lang = getLang();
      const t = (key, vars) => I18N.translate(lang, key, vars);
      const tail = lines.slice(-14).join('\n');
      const label = risk ? riskLabel(lang, risk) : '';
      const button = (href, text, bg, fg) =>
        `<a href="${esc(href)}" style="display:inline-block;padding:12px 22px;margin:0 8px 8px 0;border-radius:6px;background:${bg};color:${fg};font-weight:bold;text-decoration:none;font-family:Arial,sans-serif">${esc(text)}</a>`;

      const actions = canAnswer
        ? button(`${link}?answer=yes`, t('btn.approve'), '#e9a93a', '#1b1408') + button(`${link}?answer=no`, t('btn.reject'), '#2c3d4a', '#ece6d6')
        : `<p style="font-family:Arial,sans-serif;color:#555">${esc(t('email.inTerminal'))}</p>`;

      const html = `
        <div style="max-width:620px;font-family:Arial,sans-serif;color:#1f2c37">
          <h2 style="margin:0 0 6px">🐑 ${esc(t('email.heading', { name }))}</h2>
          <p style="margin:0 0 14px;color:#555">${esc(question)}</p>
          ${risk ? `<div style="border:1px solid #d9695f;background:#fbeceb;border-radius:8px;padding:10px 12px;margin:0 0 14px">
            <strong style="color:#b3443a">🚨 ${esc(t('email.risky', { label }))}</strong><br>
            <code style="font-size:13px">${esc(risk.line)}</code></div>` : ''}
          <pre style="background:#172029;color:#ece6d6;padding:14px;border-radius:8px;font-size:13px;line-height:1.4;white-space:pre-wrap;overflow-x:auto">${esc(tail)}</pre>
          <div style="margin:16px 0">${actions}</div>
          <p style="font-size:12px;color:#888">${esc(t('email.footer'))}${panelUrl ? ` ${esc(t('email.panel', { url: panelUrl }))}` : ''}</p>
        </div>`;

      const text = `${t('email.heading', { name })}\n\n${question}\n` +
        (risk ? `\n${t('email.riskyText')}: ${label}\n${risk.line}\n` : '') + `\n${tail}\n\n` +
        (canAnswer ? `${t('btn.approve')}: ${link}?answer=yes\n${t('btn.reject')}: ${link}?answer=no\n` : `${t('email.inTerminal')}\n`);

      await deliver(t(risk ? 'email.subjectRisky' : 'email.subject', { name }), html, text);
    },

    async test() {
      const lang = getLang();
      const body = I18N.translate(lang, 'email.testBody');
      await deliver(I18N.translate(lang, 'email.testSubject'), `<p>${esc(body)}</p>`, body);
    },
  };
}

module.exports = { createNotifier, riskLabel };
